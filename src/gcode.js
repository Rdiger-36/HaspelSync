import * as ftp from "basic-ftp";
import AdmZip from "adm-zip";
import { Readable, Writable } from "stream";
import { createInterface } from "readline";
import { createHash } from "crypto";
import { createInflateRaw, inflateRawSync } from "zlib";

import { EXTERNAL_SLOT, SECOND_EXTERNAL_SLOT, convertAMSandSlot, describeConnectionError, connectionErrorCode } from "./utils.js";
import { debug, trace } from "./logger.js";
import { normColor } from "../public/shared.js";

/**
 * TLS options for BambuLab's self-signed certificate. The printer presents a
 * cert with CN = serial number; we don't validate it (same as the MQTT
 * connection, which also uses rejectUnauthorized:false).
 *
 * Built fresh for every connection on purpose. basic-ftp writes the host into
 * the object it is given, and for implicit TLS that stored host wins over the
 * one passed to access(), so a shared object sends every later connection to
 * the printer that used it first.
 */
export function bambuTlsOptions() {
    return { rejectUnauthorized: false };
}

/**
 * Logs in to a printer's FTPS server, the way every fetch and the connection
 * test do: vsftpd with implicit TLS on port 990, user bblp, the access code as
 * the password, and the printer's self signed certificate accepted.
 *
 * @param {object} client - a basic-ftp client
 * @param {{ip: string, code: string}} printer - address and access code
 */
function ftpsAccess(client, printer) {
    return client.access({
        host: printer.ip,
        port: 990,
        user: "bblp",
        password: printer.code,
        secure: "implicit",
        secureOptions: bambuTlsOptions(),
    });
}

/**
 * Downloads the sliced 3MF of the active print via FTPS and extracts only
 * Metadata/slice_info.config (~2-3 KB). The rest of the archive is discarded
 * immediately after extraction.
 *
 * BambuLab printers run vsftpd with implicit TLS on port 990, login bblp /
 * <access code>. The sliced file lives in /cache, under the name the job was
 * sent with; see `resolveRemotePaths()` for the two spellings of that name.
 *
 * What was tried and what came of it is written to `printer.lastSliceFetch`,
 * because the two ways this returns null are two different problems for the
 * person reading the log: no file under any of the names, or a file that is
 * not a sliced one. The callers log from that record, and `/api/print` reads
 * it to not try the same names again every few seconds for the whole print.
 *
 * When none of the names holds the file and the print's start is known, the
 * printer's storage is listed and the file of the running print is picked by
 * its time and confirmed by its content, see `findSlicedFileByTime()`.
 *
 * @param {object} printer  - printer object with .ip and .code
 * @param {string} jobName  - subtask_name from MQTT
 * @param {string|null} [gcodeFile] - gcode_file from MQTT, when the report carries one
 * @param {string|null} [fileName] - the file name from the printer's own project_file command, see resolveRemotePaths()
 * @param {object|null} [running] - what the printer reports about the running print: `startedAt` in epoch milliseconds, `gcodeFile` and `totalLayers`, plus `filePath` when the process before a restart found the file; null leaves the listing out
 * @returns {object|null} parsed slice info or null if not found
 */
export async function fetchSliceInfo(printer, jobName, gcodeFile = null, fileName = null, running = null) {
    const client = new ftp.Client(20000); // 20 s timeout
    client.ftp.verbose = false;

    // The path the service read before a restart comes first: after a reprint
    // from the printer's screen nothing else leads to it, see printstate.js
    const named = resolveRemotePaths(jobName, gcodeFile, fileName);
    const candidates = running?.filePath && !named.includes(running.filePath)
        ? [running.filePath, ...named]
        : named;
    // The attempt counts on from the last fetch of the same job, so a retry
    // knows how many came before it. See sliceFetchRetryDue(). A look before
    // the print runs is free: the dashboard asks for the file as soon as the
    // job has a name, seconds before the printer has written it, and that look
    // used to be the first of the three attempts. A cloud print on a P2S had
    // two left once it ran, and the first never reached the log.
    const previous = printer.lastSliceFetch;
    const counted = !running?.beforeRunning;
    const attempt = (previous?.jobName === jobName ? previous.attempt || 0 : 0) + (counted ? 1 : 0);
    const record = { jobName, attempt, beforeRunning: !counted, tried: candidates, reasons: {}, error: null, path: null, sliceInfo: false, at: Date.now() };
    printer.lastSliceFetch = record;

    try {
        try {
            await ftpsAccess(client, printer);
        } catch (err) {
            // Nothing was tried: the printer did not let us in. Kept apart from
            // "not at any path", because that is a file missing and this is a
            // printer busy or unreachable, which a retry can outwait.
            record.error = err.message;
            throw err;
        }

        debug("gcode", printer.name, printer.logFilePath,
            `[Print] Looking for the sliced file as ${candidates.join(" or ")}`);

        let buf = null;
        for (const path of candidates) {
            try {
                const chunks = [];
                const writable = new Writable({
                    write(chunk, _, cb) { chunks.push(chunk); cb(); },
                });
                await client.downloadTo(writable, path);
                buf = Buffer.concat(chunks);
                record.path = path;
                debug("gcode", printer.name, printer.logFilePath,
                    `[Print] Downloaded ${path}, ${buf.length} bytes`);
                if (path === running?.filePath && !named.includes(path)) {
                    console.log(printer.name, printer.logFilePath,
                        `[Print] Sliced file read from where it was found before the restart: ${path}`);
                }
                break;
            } catch (err) {
                // Trying the next candidate is the normal path, not a failure:
                // where the file sits depends on how the job was sent. The
                // reason is still worth having, because "no slice info" with
                // every attempt silent is the hardest version of this to answer.
                // Kept on the record as well, so the ordinary log can say it
                // when every candidate fails: a 550 from a printer without a
                // USB stick and a broken data connection read the same without.
                record.reasons[path] = err.message;
                debug("gcode", printer.name, printer.logFilePath,
                    `[Print] Not at ${path}: ${err.message}`);
            }
        }

        if (!buf && running?.startedAt) {
            const found = await findSlicedFileByTime(client, printer, candidates, { gcodeFile, ...running }, record);
            if (found) {
                buf = found.buf;
                record.path = found.path;
                console.log(printer.name, printer.logFilePath,
                    `[Print] Sliced file found on the stick: ${found.path}, written ${describeOffset(found.modifiedAt - running.startedAt)} the start, ${found.reason}`);
            }
        }

        if (!buf) {
            debug("gcode", printer.name, printer.logFilePath,
                "[Print] None of the candidate paths held the sliced file");
            return null;
        }

        const zip = new AdmZip(buf);
        trace("gcode", printer.name, printer.logFilePath,
            `[Print] Archive entries: ${JSON.stringify(zip.getEntries().map(e => e.entryName))}`);

        const entry = zip.getEntry("Metadata/slice_info.config");
        if (!entry) {
            debug("gcode", printer.name, printer.logFilePath,
                "[Print] The archive carries no Metadata/slice_info.config");
            return null;
        }

        // The whole archive is already in memory, so the second entry costs
        // nothing on the wire. It is the only place the colour set of a multi
        // colour filament appears: slice_info.config keeps one colour per
        // filament, the first of the set. Missing on older slicers, and then
        // the single colour is all there is, exactly as before.
        const settings = zip.getEntry("Metadata/project_settings.config");
        if (!settings) {
            // Older slicers do not write it, and then the single colour per
            // filament is all there is. Worth naming, because it is what a
            // multi colour spool matching as a plain one comes down to.
            debug("gcode", printer.name, printer.logFilePath,
                "[Print] No project_settings.config, so no multi colour sets for this print");
        }

        const parsed = parseSliceInfo(
            entry.getData().toString("utf8"),
            settings ? settings.getData().toString("utf8") : null,
        );
        // A MakerWorld model printed through one of its print profiles is
        // named after the profile in every report, "0.2mm layer, 2 walls, 15%
        // infill". The model's own title is in the file and nowhere else.
        const model = zip.getEntry("3D/3dmodel.model");
        parsed.modelTitle = model ? modelTitleFor(jobName, parseModelNames(model.getData().toString("utf8"))) : null;
        parsed.extrusion = await readPlateExtrusion(zip, gcodeFile, parsed, printer);
        record.sliceInfo = true;

        trace("gcode", printer.name, printer.logFilePath,
            `[Print] Parsed slice info: ${JSON.stringify(parsed)}`);

        return parsed;
    } finally {
        client.close();
    }
}

/**
 * Where the sliced file is looked for when its name cannot be worked out.
 * The root and `/cache` are the two places a printer has been seen to keep it.
 */
const LISTED_DIRECTORIES = ["/", "/cache"];

/**
 * How far the time a 3MF was written may lie from the print's start for it to
 * count as that print's file, either way. Wide enough for a slow upload over
 * the cloud and for a printer clock that is a few minutes off, narrow enough
 * that yesterday's print on the same stick is never taken.
 */
export const SLICED_FILE_TIME_WINDOW_MS = 10 * 60 * 1000;

/**
 * How much of the end of a 3MF is read to check a file the time does not
 * vouch for, see `findSlicedFileByTime()`. Bambu Studio writes
 * `Metadata/slice_info.config` after the G-code, so it sits in the last few
 * kilobytes next to the zip's central directory; 128 KB holds both with room
 * for the small files written after it.
 */
export const SLICED_FILE_TAIL_BYTES = 128 * 1024;

/**
 * Lists the printer's storage and downloads the 3MF of the running print, for
 * a job whose name does not lead to its file.
 *
 * Seen on an X2D with a USB stick on 2026-09-26 (issue #179): a MakerWorld
 * model opened in Bambu Studio, changed and sent through the cloud is named
 * after the print profile, "0.2mm layer, 3 walls, 15% infill", in every
 * report, while the file on the stick is `/CartPicker.gcode.3mf`, named after
 * the project and in the root. Nothing the printer reports carries the project
 * name, and the cloud url in the project_file echo names an upload object, not
 * the file.
 *
 * The time a file was written only picks the candidates, see
 * `slicedFileCandidates()`. Each is then downloaded, closest to the start
 * first, and its content decides, see `judgeSlicedFile()` and
 * `settleSlicedFile()`: a stick keeps the files of earlier prints, and two
 * sent a minute apart are both close to the start.
 *
 * `LIST` on the printer's vsftpd gives the time to the minute only, and in the
 * printer's local notation, so every 3MF is asked for its time with `MDTM`,
 * which answers in UTC to the second. A directory or a file that cannot be
 * read is skipped: this is a last resort after the names, never a reason to
 * fail a fetch that would otherwise have failed anyway.
 *
 * @param {object} client - the logged in basic-ftp client
 * @param {object} printer - the printer, for the log
 * @param {string[]} tried - the paths already tried by name, left out here
 * @param {object} running - what the printer reports about the print, see `fetchSliceInfo()`
 * @param {object} record - `printer.lastSliceFetch`, which gets `listed` and `judged`
 * @returns {Promise<{path: string, modifiedAt: number, buf: Buffer, reason: string}|null>}
 */
async function findSlicedFileByTime(client, printer, tried, running, record) {
    const files = [];
    for (const dir of LISTED_DIRECTORIES) {
        let entries;
        try {
            entries = await client.list(dir);
        } catch (err) {
            debug("gcode", printer.name, printer.logFilePath, `[Print] Could not list ${dir}: ${err.message}`);
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile || !/\.3mf$/i.test(entry.name)) continue;
            const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
            if (tried.includes(path)) continue;
            try {
                files.push({ path, modifiedAt: (await client.lastMod(path)).getTime() });
            } catch (err) {
                debug("gcode", printer.name, printer.logFilePath, `[Print] No time for ${path}: ${err.message}`);
            }
        }
    }

    record.listed = files.length;
    debug("gcode", printer.name, printer.logFilePath,
        `[Print] 3MF files on the printer: ${files.length ? files.map(f => `${f.path} (${new Date(f.modifiedAt).toISOString()})`).join(", ") : "none"}`);

    const identity = running.identity || {};
    const expected = {
        jobName: record.jobName,
        plate: reportedPlate(running.gcodeFile) ?? identity.plate ?? null,
        layers: Number(running.totalLayers) > 0 ? Number(running.totalLayers) : null,
        md5: identity.md5 ?? null,
        modelId: identity.modelId ?? null,
        profileId: identity.profileId ?? null,
    };

    const judged = [];
    const buffers = new Map();

    /** Downloads one file whole and judges it by everything it says. */
    const judgeWhole = async file => {
        let buf;
        try {
            const chunks = [];
            const writable = new Writable({
                write(chunk, _, cb) { chunks.push(chunk); cb(); },
            });
            await client.downloadTo(writable, file.path);
            buf = Buffer.concat(chunks);
        } catch (err) {
            record.reasons[file.path] = err.message;
            debug("gcode", printer.name, printer.logFilePath, `[Print] Not at ${file.path}: ${err.message}`);
            return null;
        }

        let facts;
        try {
            facts = { ...readSlicedFileFacts(new AdmZip(buf)), fileMd5: createHash("md5").update(buf).digest("hex") };
        } catch (err) {
            debug("gcode", printer.name, printer.logFilePath, `[Print] ${file.path} is not a readable archive: ${err.message}`);
            return null;
        }

        const verdict = judgeSlicedFile(facts, expected);
        judged.push({ ...file, ...verdict });
        buffers.set(file.path, buf);
        debug("gcode", printer.name, printer.logFilePath,
            `[Print] ${file.path}, written ${describeOffset(file.modifiedAt - running.startedAt)} the start: ${verdict.verdict}, ${verdict.reason}`);
        return verdict;
    };

    const atStart = slicedFileCandidates(files, running.startedAt);
    for (const file of atStart) {
        const verdict = await judgeWhole(file);
        // A confirmed file is the answer, the rest need not be downloaded
        if (verdict?.verdict === "confirmed") break;
    }

    let scope = "written at the start";
    let settled = settleSlicedFile(judged, scope);

    // Nothing was written at the start, or everything that was is ruled out:
    // the file may be older. A reprint started on the printer's screen takes a
    // file that has been on the stick for days, and a restart of the service
    // during it has lost the echo that named the file (P2S, 2026-10-02). The
    // other files are checked by their tail first, which holds the layer count
    // and the plates and costs a few kilobytes each, and only what that does
    // not rule out is downloaded whole and judged by its title and ids. Two
    // files nothing rules out are still a guess, and none is taken then.
    if (!settled.file && !judged.some(file => file.verdict === "possible")) {
        const rest = files
            .filter(file => !atStart.includes(file))
            .sort((a, b) => b.modifiedAt - a.modifiedAt);
        if (rest.length) {
            debug("gcode", printer.name, printer.logFilePath,
                `[Print] No file written at the start is the print's, checking the other ${rest.length} by their tail`);
        }
        const kept = [];
        for (const file of rest) {
            const tail = await readSlicedFileTail(client, file.path);
            if (!tail) {
                debug("gcode", printer.name, printer.logFilePath, `[Print] ${file.path}: tail not readable, left out`);
                continue;
            }
            // No md5 without the whole file; the ids and the titles may be there
            const verdict = judgeSlicedFile(tail.facts, { ...expected, md5: null });
            debug("gcode", printer.name, printer.logFilePath, `[Print] ${file.path}, by its tail: ${verdict.verdict}, ${verdict.reason}`);
            if (verdict.verdict === "rejected") continue;
            kept.push({ file, confirmed: verdict.verdict === "confirmed" });
        }
        // A file the tail already proves goes first: it is read whole for its
        // slice info and ends the search, so the rest costs nothing
        kept.sort((a, b) => Number(b.confirmed) - Number(a.confirmed));
        for (const { file } of kept) {
            const verdict = await judgeWhole(file);
            if (verdict?.verdict === "confirmed") break;
        }
        if (kept.length) {
            scope = "on the printer";
            settled = settleSlicedFile(judged, scope);
        }
    }

    record.judged = judged.map(({ path, verdict, reason }) => ({ path, verdict, reason }));
    record.settled = settled.reason;
    if (!settled.file) return null;
    return { ...settled.file, buf: buffers.get(settled.file.path), reason: settled.reason };
}

/**
 * Reads the end of a 3MF on the printer and what `slice_info.config` in it
 * says, without downloading the G-code in front of it.
 *
 * FTP resumes a download at an offset (`REST`), which is what the tail read
 * is. A file shorter than the tail is read whole and judged as such. Read
 * off the P2S's stick on 2026-10-02: 26 files in four seconds, where the
 * three Handy files alone would have been nine megabytes.
 *
 * @param {object} client - the logged in FTPS client
 * @param {string} path - the file on the printer
 * @returns {Promise<{facts: object}|null>} the facts the tail holds, null when it cannot be read
 */
async function readSlicedFileTail(client, path) {
    let size;
    try {
        size = await client.size(path);
    } catch {
        return null;
    }
    const start = Math.max(0, size - SLICED_FILE_TAIL_BYTES);
    const chunks = [];
    const writable = new Writable({
        write(chunk, _, cb) { chunks.push(chunk); cb(); },
    });
    try {
        await client.downloadTo(writable, path, start);
    } catch {
        return null;
    }
    const buf = Buffer.concat(chunks);
    if (start === 0) {
        try {
            return { facts: readSlicedFileFacts(new AdmZip(buf)) };
        } catch {
            return null;
        }
    }
    // Two layouts have been seen. Bambu Studio writes slice_info.config after
    // the G-code, so the tail holds the plates and the layer count. A file
    // sliced by MakerWorld for Bambu Handy writes it in front and the
    // thumbnails after the G-code, and its tail holds 3dmodel.model instead,
    // with the titles and the ids: that is the file's identity, which proves
    // more than the layer count rules out. Whatever is there is judged.
    const sliceInfo = readZipTailEntry(buf, start, "Metadata/slice_info.config");
    const model = readZipTailEntry(buf, start, "3D/3dmodel.model");
    if (!sliceInfo && !model) return null;
    const xml = sliceInfo ? sliceInfo.toString("utf8") : "";
    const head = model ? model.subarray(0, 65536).toString("utf8") : "";
    const ids = parseModelIds(head);
    return {
        facts: {
            titles: parseModelTitles(head),
            plates: parsePlateIndices(xml),
            layers: countPrintedLayers(xml),
            modelId: ids.modelId,
            profileId: ids.profileId,
        },
    };
}

/**
 * One entry out of the tail of a zip file, when the tail holds it.
 *
 * The central directory sits at the end of a zip and says where each entry's
 * local header is, so the tail of a file is enough to read the entries that
 * were written last. Entries in front of the tail, zip64 archives and
 * compression methods other than deflate and stored give null.
 *
 * @param {Buffer} tail - the last bytes of the file
 * @param {number} tailStart - the file offset the tail begins at
 * @param {string} name - the entry name, as the archive spells it
 * @returns {Buffer|null} the entry's content
 */
export function readZipTailEntry(tail, tailStart, name) {
    // End of central directory record: signature, then the directory's size
    // and offset, with a comment of up to 64 KB after it
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0 && i >= tail.length - 22 - 65535; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null;
    let at = cdOffset - tailStart;
    if (at < 0 || at + cdSize > tail.length) return null;

    const end = at + cdSize;
    while (at + 46 <= end && tail.readUInt32LE(at) === 0x02014b50) {
        const method = tail.readUInt16LE(at + 10);
        const compressedSize = tail.readUInt32LE(at + 20);
        const nameLength = tail.readUInt16LE(at + 28);
        const extraLength = tail.readUInt16LE(at + 30);
        const commentLength = tail.readUInt16LE(at + 32);
        const localOffset = tail.readUInt32LE(at + 42);
        const entryName = tail.toString("utf8", at + 46, at + 46 + nameLength);
        at += 46 + nameLength + extraLength + commentLength;
        if (entryName !== name) continue;

        const local = localOffset - tailStart;
        if (local < 0 || local + 30 > tail.length || tail.readUInt32LE(local) !== 0x04034b50) return null;
        const dataAt = local + 30 + tail.readUInt16LE(local + 26) + tail.readUInt16LE(local + 28);
        if (dataAt + compressedSize > tail.length) return null;
        const data = tail.subarray(dataAt, dataAt + compressedSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) {
            try {
                return inflateRawSync(data);
            } catch {
                return null;
            }
        }
        return null;
    }
    return null;
}

/**
 * The 3MF files written close enough to the print's start to be its file,
 * closest first.
 *
 * Closest rather than latest, because a stick keeps the files of earlier
 * prints and a file sent after this one started belongs to the next.
 *
 * @param {{path: string, modifiedAt: number}[]} files - the 3MF files and when each was written
 * @param {number|null} startedAt - when the print started, epoch milliseconds
 * @param {number} [windowMs] - how far either way still counts
 * @returns {{path: string, modifiedAt: number}[]}
 */
export function slicedFileCandidates(files, startedAt, windowMs = SLICED_FILE_TIME_WINDOW_MS) {
    if (!startedAt) return [];
    return files
        .filter(file => Number.isFinite(file.modifiedAt) && Math.abs(file.modifiedAt - startedAt) <= windowMs)
        .sort((a, b) => Math.abs(a.modifiedAt - startedAt) - Math.abs(b.modifiedAt - startedAt));
}

/**
 * The plate number the printer names in `gcode_file`, "/data/Metadata/plate_2.gcode"
 * being 2, or null when it names none.
 *
 * @param {string|null|undefined} gcodeFile - `gcode_file` from the report
 * @returns {number|null}
 */
export function reportedPlate(gcodeFile) {
    const match = typeof gcodeFile === "string" ? /plate_(\d+)\.gcode$/i.exec(gcodeFile) : null;
    return match ? Number(match[1]) : null;
}

/**
 * What a sliced 3MF says about itself, for telling it apart from the other
 * files on the stick.
 *
 * `3D/3dmodel.model` carries MakerWorld's metadata at its top: `Title`, the
 * model's title, and `ProfileTitle`, the print profile's. A job is named after
 * one of them in exactly the cases the fallback exists for. Read off the P2S
 * on 2026-09-26: "CLIPPY - Filament clip" (Handy) carries ProfileTitle
 * "0.2mm layer - 10 clips", and the plate started on the screen as "Perfectly
 * clean bed for perfect prints!" carries that as its Title. A project of one's
 * own leaves both empty. Only the head of the entry is read, the metadata
 * comes before the meshes.
 *
 * Next to the titles it carries `DesignModelId` and `DesignProfileId`, the
 * `model_id` and `profile_id` of a print from MakerWorld.
 *
 * The layer count is counted over the layer lists that name a filament only.
 * A P2S plate sliced by MakerWorld on 2026-09-26 listed its 248 layers as
 * "0 247" plus an empty list over "248 249", and its G-code header and the
 * printer's `total_layer_num` both said 248.
 *
 * @param {object} zip - the opened archive, an AdmZip
 * @returns {{titles: string[], plates: number[], layers: number|null, modelId: string|null, profileId: string|null}}
 */
export function readSlicedFileFacts(zip) {
    const model = zip.getEntry("3D/3dmodel.model");
    const head = model ? model.getData().subarray(0, 65536).toString("utf8") : "";
    const sliceInfo = zip.getEntry("Metadata/slice_info.config");
    const xml = sliceInfo ? sliceInfo.getData().toString("utf8") : "";
    const ids = parseModelIds(head);
    return {
        titles: parseModelTitles(head),
        plates: parsePlateIndices(xml),
        layers: countPrintedLayers(xml),
        modelId: ids.modelId,
        profileId: ids.profileId,
    };
}

/**
 * The number of layers a `slice_info.config` prints filament on, null when
 * it lists none. See `readSlicedFileFacts()` for why an empty list is skipped.
 *
 * @param {string} xml - the raw slice_info.config
 * @returns {number|null}
 */
export function countPrintedLayers(xml) {
    let last = -1;
    const re = /<layer_filament_list\s+([^>]+?)\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const a = parseAttrs(m[1]);
        if (!(a.filament_list || "").trim()) continue;
        for (const [, end] of parseLayerRanges(a.layer_ranges || "")) {
            if (end > last) last = end;
        }
    }
    return last >= 0 ? last + 1 : null;
}

/**
 * MakerWorld's `DesignModelId` and `DesignProfileId` of a `3dmodel.model`,
 * null where the file carries none.
 *
 * @param {string} xml - the entry, or its head
 * @returns {{modelId: string|null, profileId: string|null}}
 */
export function parseModelIds(xml) {
    const read = name => {
        const m = new RegExp(`<metadata\\s+name="${name}"\\s*>([^<]*)</metadata>`).exec(xml);
        const value = m ? unescapeXml(m[1]).trim() : "";
        return value && value !== "0" ? value : null;
    };
    return { modelId: read("DesignModelId"), profileId: read("DesignProfileId") };
}

/**
 * The non empty `Title` and `ProfileTitle` of a `3dmodel.model`, unescaped.
 *
 * @param {string} xml - the entry, or its head
 * @returns {string[]}
 */
export function parseModelTitles(xml) {
    const titles = [];
    const re = /<metadata\s+name="(Title|ProfileTitle)"\s*>([^<]*)<\/metadata>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const value = unescapeXml(m[2]).trim();
        if (value) titles.push(value);
    }
    return titles;
}

/**
 * The `Title` and `ProfileTitle` of a `3dmodel.model` by name, unescaped,
 * null where empty or missing.
 *
 * `parseModelTitles()` gives both as one list for comparing against a job
 * name; this keeps them apart for telling which one the job was named after.
 *
 * @param {string} xml - the entry, or its head
 * @returns {{title: string|null, profileTitle: string|null}}
 */
export function parseModelNames(xml) {
    const read = name => {
        const m = new RegExp(`<metadata\\s+name="${name}"\\s*>([^<]*)</metadata>`).exec(xml);
        const value = m ? unescapeXml(m[1]).trim() : "";
        return value || null;
    };
    return { title: read("Title"), profileTitle: read("ProfileTitle") };
}

/**
 * The model's title when the job is named after its print profile, else null.
 *
 * Bambu Studio names the job of a MakerWorld model printed through one of its
 * print profiles after that profile, so the dashboard and the summary read
 * "0.2mm layer, 2 walls, 15% infill" where the model is "Darts Holder and
 * Storage". Read off a P2S on 2026-10-02: the job name is the file's
 * `ProfileTitle` to the letter, and `Title` is the model. A job that carries
 * the model's name, or a project of the user's own, which has neither, gets
 * nothing: the printer's name is the name then.
 *
 * @param {string} jobName - `subtask_name` as the printer reports it
 * @param {{title: string|null, profileTitle: string|null}} names - from parseModelNames()
 * @returns {string|null}
 */
export function modelTitleFor(jobName, names) {
    if (!names?.title || !names.profileTitle) return null;
    if (names.profileTitle !== jobName || names.title === jobName) return null;
    return names.title;
}

/**
 * The plate numbers a `slice_info.config` holds sliced G-code for.
 *
 * @param {string} xml - the raw slice_info.config
 * @returns {number[]}
 */
export function parsePlateIndices(xml) {
    const plates = [];
    const re = /<plate>\s*<metadata\s+key="index"\s+value="(\d+)"/g;
    let m;
    while ((m = re.exec(xml)) !== null) plates.push(Number(m[1]));
    return plates;
}

/**
 * The five entities XML escapes with, for a title written by Bambu Studio.
 *
 * @param {string} text
 * @returns {string}
 */
function unescapeXml(text) {
    return text
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Whether a candidate file belongs to the running print, as far as its
 * content can tell.
 *
 * Two kinds of evidence, in this order:
 *
 *   - exclusion, which is always available and can only rule a file out: the
 *     plate the printer reports has to be in the file, and the layer count
 *     has to match `total_layer_num`. The count is the last layer's 0-based
 *     index plus one, see `completedLayerIndex()`
 *   - identity, where the first piece both sides carry decides: the md5 of the
 *     whole file against the one in Bambu Studio's command, then the
 *     MakerWorld profile id, then the model id, then the job name against the
 *     file's titles. A project of one's own carries no ids and no titles
 *
 * Measured on a P2S printing a MakerWorld model from Bambu Handy on
 * 2026-09-26: the command's `md5` was the md5 of the whole 3MF on the stick,
 * lowercase, and its `model_id` and `profile_id` were the file's
 * `DesignModelId` and `DesignProfileId`. The md5 therefore decides both ways.
 * The ids only confirm: an X2D printing a MakerWorld model that was changed in
 * Bambu Studio sent ids of the user's own cloud copy, which the file does not
 * carry, so a mismatch there proves nothing and the next piece decides. The
 * title decides both ways, ProfileTitle being the job name on that X2D.
 *
 * @param {object} facts - see `readSlicedFileFacts()`
 * @param {{jobName: string|null, plate: number|null, layers: number|null, md5?: string|null, modelId?: string|null, profileId?: string|null}} expected - what the printer reports
 * @returns {{verdict: "confirmed"|"rejected"|"possible", reason: string}}
 */
export function judgeSlicedFile(facts, expected) {
    if (expected.plate != null && facts.plates.length && !facts.plates.includes(expected.plate)) {
        return { verdict: "rejected", reason: `plate ${expected.plate} is not in it` };
    }
    if (expected.layers != null && facts.layers != null && facts.layers !== expected.layers) {
        return { verdict: "rejected", reason: `${facts.layers} layers where the printer reports ${expected.layers}` };
    }
    const unproven = [];
    if (expected.md5 && facts.fileMd5) {
        return facts.fileMd5.toLowerCase() === expected.md5.toLowerCase()
            ? { verdict: "confirmed", reason: "its md5 is the one Bambu Studio sent" }
            : { verdict: "rejected", reason: "its md5 is not the one Bambu Studio sent" };
    }
    for (const [key, label] of [["profileId", "MakerWorld profile id"], ["modelId", "MakerWorld model id"]]) {
        if (expected[key] && facts[key]) {
            if (facts[key] === expected[key]) return { verdict: "confirmed", reason: `its ${label} is the print's` };
            unproven.push(`its ${label} ${facts[key]} differs from ${expected[key]}`);
        }
    }
    const note = unproven.length ? `, although ${unproven.join(" and ")}` : "";

    const jobName = (expected.jobName || "").trim();
    if (facts.titles?.length && jobName) {
        return facts.titles.includes(jobName)
            ? { verdict: "confirmed", reason: `its title is the job name${note}` }
            : { verdict: "rejected", reason: `its titles ${facts.titles.map(t => `"${t}"`).join(" and ")} are not the job name${note ? `, and ${unproven.join(" and ")}` : ""}` };
    }
    return { verdict: "possible", reason: `nothing in it names the job, and nothing rules it out${note}` };
}

/**
 * The one file to take out of the judged candidates, or why none is taken.
 *
 * A confirmed file wins. Without one, a file nothing ruled out is taken only
 * when it is the only one: two possible files close to the start would be a
 * guess, and a booking on the wrong file is worse than no booking.
 *
 * @param {{path: string, verdict: string}[]} judged - in the order they were tried
 * @param {string} [scope] - which files were judged, for the reason: "written at the start" or "on the printer"
 * @returns {{file: object|null, reason: string}}
 */
export function settleSlicedFile(judged, scope = "written at the start") {
    const confirmed = judged.find(file => file.verdict === "confirmed");
    if (confirmed) return { file: confirmed, reason: confirmed.reason };
    const possible = judged.filter(file => file.verdict === "possible");
    if (possible.length === 1) return { file: possible[0], reason: `the only file ${scope} that nothing rules out` };
    if (possible.length > 1) return { file: null, reason: `${possible.length} files ${scope} could be it, so none is taken` };
    return { file: null, reason: judged.length ? `every file ${scope} was ruled out` : "no 3MF was written at the start" };
}

/**
 * A time difference in words, for "written ... the start":
 * "12 seconds before", "3 minutes after".
 *
 * @param {number} ms - the file's time minus the start
 * @returns {string}
 */
function describeOffset(ms) {
    const seconds = Math.round(Math.abs(ms) / 1000);
    const amount = seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
    return `${amount} ${ms < 0 ? "before" : "after"}`;
}

/**
 * Normalises a color to a bare 6-digit uppercase hex (no "#", no alpha) so
 * slice colors ("#000000") and AMS slot colors ("000000FF") compare equal.
 *
 * Defined in `public/shared.js`, because the dashboard normalises the same
 * colors out of the same payloads, and re-exported here so that every caller
 * keeps importing it from where the consumption keys are built.
 */
export { normColor } from "../public/shared.js";

/**
 * Identity of a filament for consumption matching: tray_info_idx alone is the
 * material profile (e.g. "GFA00" = PLA Basic) and does NOT distinguish colors,
 * so we combine it with the normalised color. This separates e.g. PLA Black
 * from PLA Jade White even though both share tray_info_idx.
 *
 * `colors` extends that with the whole colour set of a multi colour filament,
 * which the two fields above cannot separate: a gradient spool is not a profile
 * of its own (Bambu Studio slices PLA Basic Gradient as GFA00, the same as
 * plain PLA Basic) and `color` is only the first colour of the set. Arctic
 * Whisper, Solar Breeze and an ordinary white PLA Basic were one key.
 *
 * The set is sorted, because the sources disagree on order: Bambu Studio writes
 * Cotton Candy Cloud as "#8EC9E9 #E7C1D5" and SpoolmanDB stores it the other
 * way round. Comparing unsorted would match nothing at all rather than match
 * the wrong thing.
 *
 * A single colour produces the key it always did, byte for byte, so nothing
 * changes for the spools that were never ambiguous.
 *
 * @param {string|null} trayInfoIdx - the filament profile
 * @param {string|null} color - the first colour, as either side reports it
 * @param {string[]} [colors] - every colour of the filament, any order
 */
export function consumptionKey(trayInfoIdx, color, colors = null) {
    const set = (colors || []).map(normColor).filter(Boolean);
    const suffix = set.length > 1 ? `|${[...new Set(set)].sort().join("+")}` : "";
    return `${trayInfoIdx || "?"}|${normColor(color)}${suffix}`;
}

/**
 * Names the AMS slot each consumption entry was sliced for, in place.
 *
 * Bambu Studio's filament list is the printer's slot list, so the position in
 * it is the slot: the fifth entry is the fifth slot. Verified against a print
 * sliced for a P2S with two AMS units, where the ids 5, 7 and 8 were B1, B3
 * and B4.
 *
 * The position is resolved against the slots the printer actually reports,
 * never against a computed geometry. A second file settled that: with two AMS
 * units and a spool on the external holder the list holds nine entries, and
 * arithmetic on "four slots per unit" turns the ninth into "C1", a unit that
 * printer does not have. The list length is no help either, it is the project's
 * filament count and not the printer's: the same P2S produced files with six,
 * eight and nine entries.
 *
 * Only the four slot units are passed in by the callers. An AMS HT, an external
 * holder or a second extruder sit somewhere in that list that no observed file
 * pins down, so a filament beyond the known slots is left unnamed rather than
 * placed on a real slot the print never touched.
 *
 * The result is a suggestion, never a conclusion. The printer can remap slots
 * when a job is sent and slice_info.config is written before that, so whoever
 * reads `amsId` has to confirm it against what the slot actually holds.
 *
 * `reportedByPrinter` records where the slots came from, because the answer is
 * trusted differently depending on that: what the printer reports is what it
 * will run, while the list order is an estimate that has to be confirmed
 * against the slot before anything is booked on it.
 *
 * @param {object} consumption - a map from calcFullConsumption or the partial one
 * @param {string[]} amsIds - the printer's slots, in the order the slicer lists them
 * @param {object} [options]
 * @param {boolean} [options.reportedByPrinter] - whether `amsIds` came from `print.mapping`
 * @returns {object} the same map, for chaining
 */
export function resolveSliceSlots(consumption, amsIds, { reportedByPrinter = false } = {}) {
    for (const entry of Object.values(consumption)) {
        entry.amsId = amsIds?.[entry.index] ?? null;
        entry.amsIdFromPrinter = entry.amsId !== null && reportedByPrinter;
    }
    return consumption;
}

/**
 * The slots Bambu Studio sent a job to, read off the `project_file` command
 * the printer echoes on its report topic.
 *
 * A P1 or an A1 never reports `print.mapping`, and until now the only answer
 * for them was the estimate from the slicer's list order, which cannot be right
 * for a project that was not synchronised with the printer before slicing:
 * Bambu Studio then remaps the filaments by colour when the job is sent, and
 * the list order says nothing about where they went. The command carrying that
 * remapping is echoed back by the printer, seen on three P1S prints and an X1E
 * print through issue #146, cloud and LAN alike, two seconds before PREPARE.
 *
 * Two fields say the same thing and both are read, `ams_mapping2` first:
 *
 *   - `ams_mapping2` is one `{ams_id, slot_id}` per project filament, both
 *     counting from 0, with 255/255 for a filament the plate does not use. It
 *     names the unit outright, so an AMS HT at 128 needs no arithmetic
 *   - `ams_mapping` is a flat index per filament, `unit * 4 + slot` for the four
 *     slot units and 16 to 23 for an AMS HT, the way ha-bambulab reads it, with
 *     -1 for an unused filament
 *
 * Read off an X1E where the echo said [0, 1, 3] and `print.mapping` said the
 * same for the whole print, and off a P1S where the echo said [0, 3, 2] for a
 * plate whose list order was blue, orange, red while the slots were blue, red,
 * orange: the printer ran 0, 3, 2 in that order. How the external holder is
 * encoded here has not been seen, so a unit outside the ranges above yields
 * null, which the caller treats as unknown rather than booking onto "Z".
 *
 * @param {object} command - the `print` block of the echoed `project_file` command
 * @returns {string[]|null} slot labels by filament index, null when the command carries none
 */
export function decodeStudioMapping(command) {
    const label = (unit, slot) => {
        const u = Number(unit);
        const sl = Number(slot);
        if (!Number.isInteger(u) || !Number.isInteger(sl) || u < 0 || sl < 0) return null;
        if (u === 255 && sl === 255) return null;
        const named = convertAMSandSlot(u, sl);
        return named === "Z" ? null : named;
    };

    if (Array.isArray(command?.ams_mapping2) && command.ams_mapping2.length) {
        return command.ams_mapping2.map(entry => label(entry?.ams_id, entry?.slot_id));
    }

    if (Array.isArray(command?.ams_mapping) && command.ams_mapping.length) {
        return command.ams_mapping.map(value => {
            const index = Number(value);
            if (!Number.isInteger(index) || index < 0) return null;
            if (index < 16) return label(Math.floor(index / 4), index % 4);
            if (index < 24) return label(128 + (index - 16), 0);
            return null;
        });
    }

    return null;
}

/**
 * The printer's slots in the order Bambu Studio lists them: the four slot units
 * by ascending unit id and then by slot, then the external holder, then an
 * AMS HT.
 *
 * Only a slot that holds something takes a position. Bambu Studio builds its
 * filament list by synchronising with the AMS, and an empty slot contributes no
 * filament to synchronise, so the list is as long as the number of loaded slots
 * and every position after a gap moves up by one. The callers therefore pass
 * the loaded slots and not every slot the printer has.
 *
 * Every part of that order is measured:
 *
 *   - a P2S with two full AMS units and a spool on the external holder produced
 *     a nine entry list whose colours matched the reported slots position for
 *     position, the holder last
 *   - the same P2S with A3 and B2 emptied produced a seven entry list, and its
 *     seven colours were A1, A2, A4, B1, B3, B4 and the holder in that order.
 *     Both gaps are simply absent
 *   - an X1E with one original AMS, loaded at A1, A2 and A4, produced a three
 *     entry list, and the printer's own `print.mapping` for that print read
 *     [0, 1, 3]: the third filament ran from A4, the empty A3 took no position.
 *     The only measurement where the printer confirmed the estimate itself
 *   - a P1S with two AMS units, an AMS HT and a spool on the holder produced a
 *     nine entry list reading A1 to A4, B1 to B3, the holder, then the AMS HT.
 *     B4 was empty and absent, and the holder comes before the HT although the
 *     printer numbers the holder 254 and the HT 128, so this is not a sort by
 *     unit id
 *
 * The result stays a suggestion, and a dual nozzle printer does not follow it
 * at all: an H2C with two AMS units, an AMS HT and a spool on the holder listed
 * its four filaments as HT-A, the holder, B2 and A3, because Bambu Studio
 * groups the list by extruder there (`filament_maps` in that file says
 * "1 2 2 2"). Being wrong costs nothing, because `slotConfirmsSlice` refuses a
 * position whose slot does not hold the expected profile and colours, and the
 * stages below it then decide exactly as they did before positions were used at
 * all. See `test/gcode.dualnozzle.test.js`.
 *
 * This is the fallback for a printer that does not report `print.mapping`,
 * which answers the same question and is right where this is only sometimes:
 * measured on a P2S, it named the right slots for a project synchronised with
 * the printer and none of them for a project holding fewer filaments than the
 * printer has slots.
 *
 * @param {string[]} amsIds - labels of the loaded slots, as `convertAMSandSlot`
 *   produces them. An empty slot must not be passed, it takes no position
 * @returns {string[]} the positions, ordered
 */
export function orderedAmsSlots(amsIds) {
    const ids = (amsIds || []).filter(id => typeof id === "string");

    // One letter and one digit, so lexicographic order is by unit id and then
    // by slot within the unit.
    const fourSlotUnits = ids.filter(id => /^[A-D][1-4]$/.test(id)).sort();

    const highTemperature = ids.filter(id => /^HT-[A-H]$/.test(id)).sort();
    // 255 before 254, which is the order the printer numbers them in and the
    // order of the extruders they feed. Not measured against a slice file,
    // like the HT, and covered by the same refusal in slotConfirmsSlice.
    const external = [EXTERNAL_SLOT, SECOND_EXTERNAL_SLOT].filter(id => ids.includes(id));

    return [...fourSlotUnits, ...external, ...highTemperature];
}

/**
 * The key one sliced filament is accumulated under, and the entry it seeds.
 *
 * The position in the slicer's filament list, which is one slot, so two
 * filaments never merge. They used to be accumulated under their identity, and
 * two identical black spools in two slots were therefore one number before
 * anything looked at the AMS; the sum could not be split afterwards however the
 * spools were identified. Keeping them apart costs nothing where the printer
 * cannot tell them apart either: both then match the same spool and book
 * separately, which adds up to the same total.
 *
 * The key is deliberately not the slot label. Which slot a position is depends
 * on the printer the print is booked against, and that is not known here.
 */
function consumptionEntry(f) {
    return {
        key: `filament${f.index}`,
        entry: {
            index: f.index,
            tray_info_idx: f.tray_info_idx,
            color: f.color,
            colors: f.colors || null,
            type: f.type,
            // Both filled in by resolveSliceSlots, which needs the printer this
            // is going to be matched against and is therefore not known here.
            amsId: null,
            amsIdFromPrinter: false,
            grams: 0,
        },
    };
}

/**
 * Calculates consumed grams per sliced filament for a complete print. Purge is
 * already included in used_g from the slicer.
 *
 * Run the result through `resolveSliceSlots()` to name the slots before
 * matching it against a printer.
 *
 * @param {object} sliceInfo - result of fetchSliceInfo
 * @returns {{ [key]: { index, tray_info_idx, color, colors, type, amsId, grams } }}
 */
export function calcFullConsumption(sliceInfo) {
    const result = {};
    for (const f of sliceInfo.filaments) {
        if (!f.tray_info_idx) continue;
        const { key, entry } = consumptionEntry(f);
        if (!result[key]) result[key] = entry;
        result[key].grams += f.used_g;
    }
    return roundEntries(result);
}

/**
 * The last completed layer, as `calcPartialConsumption()` counts, from the
 * `layer_num` a printer reports.
 *
 * `layer_num` is the layer being printed, counted from 1, and `total_layer_num`
 * is the layer count: measured on a P2S on 2026-09-08 through the raw trace,
 * `layer_num` went from 0 to 1 in the same second `stg_cur` went to 0
 * (printing), after two and a half minutes of calibration at 0, and a ten
 * layer plate ended at 11 with `total_layer_num` 11 while the sliced file's
 * layer ranges ran 0 to 10. So at `layer_num` N, N-1 layers are complete and
 * the last of them has the 0-based index N-2; nothing is complete at 0 or 1.
 *
 * The booking used to hand `layer_num` over as it stood and count it as a
 * completed 0-based index, which booked one layer that was still printing and
 * one more that had not begun: a cancel at layer 0, before the first layer,
 * booked 1/85 of the plate.
 *
 * @param {number|null|undefined} layerNum - `layer_num` from the report
 * @returns {number} the 0-based index of the last completed layer, -1 for none
 */
export function completedLayerIndex(layerNum) {
    const n = Number(layerNum);
    if (!Number.isFinite(n)) return -1;
    return Math.max(-1, Math.floor(n) - 2);
}

/**
 * How far the filament the G-code extrudes may lie from `used_m` in
 * `slice_info.config` before the G-code is not trusted for that filament.
 *
 * The slicer leaves the purge line of the start G-code out of `used_m`, and
 * that line is about 0.14 m on every Bambu Lab start G-code read so far. On a
 * plate of 0.29 m that is a third of the whole, so the absolute allowance has
 * to cover it. Measured on three P1S plates sliced by Bambu Studio 1.9 and
 * 2.0: 27.29 m against 27.16, 1.50 against 1.40, 0.39 against 0.29.
 */
export const EXTRUSION_TOLERANCE = { metres: 0.35, share: 0.1 };

/**
 * Counts the filament a G-code extrudes, per filament and per layer, one line
 * at a time.
 *
 * Fed line by line so the caller can stream a G-code of a few hundred
 * megabytes without holding it, see `readPlateExtrusion()`.
 *
 * - The layer is the `L` of `M73 L<n>`, which is the command that sets the
 *   layer the printer reports as `layer_num`, so both count the same way:
 *   1 is the first layer, and 0 is everything before it, the start G-code
 *   with its purge line.
 * - The filament is the `n` of `T<n>`, 0-based like the indices of
 *   `layer_filament_list`, so filament id 3 of `slice_info.config` is `T2`.
 *   `T255` and `T1000` unload and select nothing, so the filament stays what
 *   it was. Extrusion before the first `T` belongs to the first filament.
 * - The flush after a filament change is counted where the G-code extrudes
 *   it. A P1S and an X1 flush in G-code after the `T`, so it counts for the
 *   new filament on the layer of the change. A P2S leaves the flush to the
 *   firmware, `M620.10 ... L<mm>` with the extrusion lines commented out, so
 *   there it is not counted at all: 79 mm on the two colour fixture, which
 *   the slicer splits between both filaments in a way not worked out here.
 *   `checkLayerExtrusion()` scales the layers to the slicer's amount anyway,
 *   so the flush is still booked, only spread over the filament's layers.
 * - `M83` and `M82` switch between relative and absolute extrusion, and `G92 E`
 *   resets the absolute position. Bambu Studio writes relative extrusion, the
 *   absolute branch is there for a G-code that does not.
 * - A retraction is negative extrusion and is counted as such, so it cancels
 *   against the move that pushes the filament back.
 *
 * @returns {{line: (text: string) => void, result: () => {[index: number]: number[]}}}
 *   `result()` gives millimetres per layer for every filament that extruded anything
 */
export function createExtrusionCounter() {
    const byFilament = {};
    let filament = null;
    let layer = 0;
    let relative = true;
    let position = 0;
    let beforeFirst = 0;

    return {
        line(text) {
            const cut = text.indexOf(";");
            const code = (cut === -1 ? text : text.slice(0, cut)).trim();
            if (!code) return;
            const command = code.split(/\s+/, 1)[0];

            if (command === "M83") { relative = true; return; }
            if (command === "M82") { relative = false; return; }
            if (command === "G92") {
                const reset = /\bE(-?[\d.]+)/.exec(code);
                if (reset) position = Number(reset[1]);
                return;
            }
            if (command === "M73") {
                const next = /\bL(\d+)/.exec(code);
                if (next) layer = Number(next[1]);
                return;
            }
            const tool = /^T(\d+)$/.exec(command);
            if (tool) {
                const index = Number(tool[1]);
                if (index >= 255) return;
                if (filament === null && beforeFirst) {
                    (byFilament[index] ||= [])[0] = beforeFirst;
                    beforeFirst = 0;
                }
                filament = index;
                return;
            }
            if (!/^G[0-3]$/.test(command)) return;

            const e = /\bE(-?[\d.]+)/.exec(code);
            if (!e) return;
            let amount = Number(e[1]);
            if (!Number.isFinite(amount)) return;
            if (!relative) {
                const absolute = amount;
                amount = absolute - position;
                position = absolute;
            }
            if (filament === null) {
                beforeFirst += amount;
                return;
            }
            const layers = byFilament[filament] ||= [];
            layers[layer] = (layers[layer] || 0) + amount;
        },
        result() {
            const out = {};
            for (const [index, layers] of Object.entries(byFilament)) {
                out[index] = Array.from(layers, mm => mm || 0);
            }
            return out;
        },
    };
}

/**
 * Turns the millimetres per layer of `createExtrusionCounter()` into the share
 * of each filament that is used up by the end of every layer, for the
 * filaments whose total agrees with `slice_info.config`.
 *
 * The slicer's `used_g` stays the amount that is booked. The G-code only says
 * how that amount spreads over the layers, which is what the layer count alone
 * cannot: the flush of a filament change lands on the layer of the change, and
 * a layer of infill weighs more than a layer of a thin spire. A filament whose
 * G-code total does not agree is left out and keeps the even spread over its
 * layers, see `EXTRUSION_TOLERANCE`. That is the safety net for a G-code this
 * counter reads wrongly, a dual nozzle printer's tool changes among them,
 * which no file here has shown yet.
 *
 * @param {{[index: number]: number[]}} perLayer - millimetres per layer and filament
 * @param {object[]} filaments - `sliceInfo.filaments`
 * @returns {{shares: {[index: number]: number[]}, rejected: {id: number, gcodeMetres: number, slicedMetres: number}[]}}
 *   `shares[index][L]` is the share used up once layer L is complete, the last entry 1
 */
export function checkLayerExtrusion(perLayer, filaments) {
    const shares = {};
    const rejected = [];
    for (const f of filaments) {
        if (!(f.used_m > 0)) continue;
        const layers = perLayer[f.index] || [];
        const total = layers.reduce((sum, mm) => sum + mm, 0);
        const metres = total / 1000;
        const allowed = Math.max(EXTRUSION_TOLERANCE.metres, f.used_m * EXTRUSION_TOLERANCE.share);
        if (!(total > 0) || Math.abs(metres - f.used_m) > allowed) {
            rejected.push({ id: f.id, gcodeMetres: Math.round(metres * 100) / 100, slicedMetres: f.used_m });
            continue;
        }
        let running = 0;
        shares[f.index] = layers.map(mm => {
            running += mm;
            return Math.min(1, Math.max(0, running / total));
        });
        shares[f.index][layers.length - 1] = 1;
    }
    return { shares, rejected };
}

/**
 * The G-code entry of the plate being printed, or null when the archive does
 * not say which one it is.
 *
 * @param {object} zip - the opened archive, an AdmZip
 * @param {string|null} gcodeFile - `gcode_file` from the report
 * @returns {object|null} the AdmZip entry
 */
function plateGcodeEntry(zip, gcodeFile) {
    const plate = reportedPlate(gcodeFile);
    if (plate !== null) return zip.getEntry(`Metadata/plate_${plate}.gcode`);
    const plates = zip.getEntries().filter(e => /^Metadata\/plate_\d+\.gcode$/.test(e.entryName));
    return plates.length === 1 ? plates[0] : null;
}

/**
 * Runs a G-code entry of the archive through `createExtrusionCounter()`.
 *
 * The archive is already in memory, but the G-code in it is up to a few
 * hundred megabytes once inflated. Inflating it in one call would hold all of
 * it and block the event loop for as long as that takes, so it is inflated as
 * a stream and counted line by line. 23 MB of G-code took a third of a second.
 *
 * @param {object} entry - the AdmZip entry of the G-code
 * @returns {Promise<{[index: number]: number[]}>} millimetres per layer and filament
 */
export async function countPlateExtrusion(entry) {
    const source = Readable.from([entry.getCompressedData()]);
    // 8 is deflate, 0 is stored, the two methods a sliced 3MF has been seen with
    const stream = entry.header.method === 8 ? source.pipe(createInflateRaw()) : source;
    const counter = createExtrusionCounter();
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        counter.line(line);
    }
    return counter.result();
}

/**
 * Reads the plate's G-code out of the sliced file and works out how each
 * filament's consumption spreads over the layers, see `checkLayerExtrusion()`.
 *
 * Never throws: without the G-code the booking spreads evenly over the
 * layers, as it did before this existed.
 *
 * @param {object} zip - the opened archive, an AdmZip
 * @param {string|null} gcodeFile - `gcode_file` from the report
 * @param {object} sliceInfo - what `parseSliceInfo()` made of the same archive
 * @param {object} printer - the printer runtime object, for the log
 * @returns {Promise<{shares: object, rejected: object[]}|null>}
 */
async function readPlateExtrusion(zip, gcodeFile, sliceInfo, printer) {
    const entry = plateGcodeEntry(zip, gcodeFile);
    if (!entry) {
        debug("gcode", printer.name, printer.logFilePath,
            "[Print] No G-code in the archive for this plate, consumption is spread evenly over the layers");
        return null;
    }
    try {
        const checked = checkLayerExtrusion(await countPlateExtrusion(entry), sliceInfo.filaments);
        for (const r of checked.rejected) {
            console.log(printer.name, printer.logFilePath,
                `[Print] Filament ${r.id}: the G-code extrudes ${r.gcodeMetres} m where the slicer says ${r.slicedMetres} m, its consumption is spread evenly over the layers`);
        }
        debug("gcode", printer.name, printer.logFilePath,
            `[Print] Read ${entry.entryName}, consumption per layer known for filament(s) ${Object.keys(checked.shares).map(i => Number(i) + 1).join(", ") || "none"}`);
        return checked;
    } catch (err) {
        console.log(printer.name, printer.logFilePath,
            `[Print] Could not read ${entry.entryName}: ${err.message}, consumption is spread evenly over the layers`);
        return null;
    }
}

/**
 * Calculates consumed grams per tray_info_idx up to a given layer (for
 * failed/cancelled prints).
 *
 * Each filament is scaled by the fraction of ITS active layers that were
 * printed. A filament's active layers are the union of all layer_filament_list
 * ranges that reference it. When a filament spans the whole print (the common
 * case) this reduces to completedLayers / totalLayers; when a filament is
 * restricted to certain layers (e.g. a different top color) the estimate is
 * more accurate.
 *
 * When the plate's G-code was read, `sliceInfo.extrusion` says how much of
 * each filament is used up by the end of every layer, and that share replaces
 * the layer count: the flush of a filament change then lands on the layer it
 * happens in, rather than being spread over every layer of the filament. A
 * filament the G-code was not trusted for keeps the layer count, see
 * `checkLayerExtrusion()`.
 *
 * `upToLayer` is the last completed layer as a 0-based index into the sliced
 * file's layers, which is not what the printer reports: see
 * `completedLayerIndex()` for the conversion from `layer_num`.
 *
 * @param {object} sliceInfo  - result of fetchSliceInfo
 * @param {number} upToLayer  - last completed layer, 0-based; -1 when none is
 * @returns {{ [key]: { tray_info_idx, color, type, grams } }}
 */
export function calcPartialConsumption(sliceInfo, upToLayer) {
    const result = {};

    for (const f of sliceInfo.filaments) {
        if (!f.tray_info_idx) continue;

        const ranges = sliceInfo.rangesByFilamentIdx[f.index] || [];
        const shares = sliceInfo.extrusion?.shares?.[f.index];

        // No layer data → fall back to global progress fraction
        let proportion;
        if (shares?.length) {
            // Index 0 of the shares is the start G-code, so the last
            // completed layer as a 0-based index is one further along
            proportion = shares[Math.min(upToLayer + 1, shares.length - 1)];
        } else if (ranges.length === 0) {
            proportion = sliceInfo.totalLayers > 0
                ? Math.min(1, (upToLayer + 1) / (sliceInfo.totalLayers + 1))
                : 0;
        } else {
            const total = ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
            let done = 0;
            for (const [start, end] of ranges) {
                if (upToLayer < start) continue;
                done += Math.min(upToLayer, end) - start + 1;
            }
            proportion = total > 0 ? done / total : 0;
        }

        const { key, entry } = consumptionEntry(f);
        if (!result[key]) result[key] = entry;
        result[key].grams += f.used_g * proportion;
    }

    return roundEntries(result);
}

/**
 * The filaments a print moved to another slot while it was printing, from two
 * consecutive `print.mapping` values, which is what an AMS refill looks like.
 *
 * When a spool runs out and the AMS takes over from a slot of the same
 * filament, the printer rewrites the mapping of the running job to the new
 * slot. Traced on a P2S on 2026-10-07: `[65535, 65535, 2]` became
 * `[65535, 65535, 3]` at layer 88 of 235, twenty seconds before the new slot
 * was loaded, with the state RUNNING throughout. An X2D did the same in issue
 * 225, from A3 to A1, where A1 held a different spool than A3 and the backup
 * group was the printer's own decision. That is why nothing here compares the
 * two slots' filaments.
 *
 * A change before the first layer is not a refill. The mapping settles while
 * the job prepares, and one P2S report carried the slot the job was
 * configured with before the user changed it.
 *
 * Neither `tray_now` nor `filam_bak` is used. The same P2S trace had
 * `tray_now` at 0 for the 82 layers in which the tube emptied, while slot A1
 * was never loaded, and the backup group of A3 and A4 vanished from
 * `filam_bak` the moment A3 ran out.
 *
 * @param {(string|null)[]|null} previous - the slots before, as `decodePrintMapping()` gives them
 * @param {(string|null)[]|null} reported - the slots now
 * @param {number} layerNum - `layer_num` as the printer reports it, 1 for the first layer
 * @returns {{index: number, from: string, to: string}[]} one entry per filament that moved
 */
export function refillsBetween(previous, reported, layerNum) {
    if (!previous || !reported || !(layerNum >= 1)) return [];
    const moved = [];
    for (let index = 0; index < reported.length; index++) {
        const from = previous[index];
        const to = reported[index];
        if (from && to && from !== to) moved.push({ index, from, to });
    }
    return moved;
}

/**
 * Splits the filaments of a consumption map at the refills the print went
 * through, so each spool is booked what came out of it.
 *
 * A refill at `layer_num` N means the old slot fed every layer before N: the
 * filament still in the tube printed on after the AMS had found the spool
 * empty, 82 layers of it on the P2S that settled this, and the printer moved
 * the mapping only once the tube was empty. So the old slot gets the
 * consumption through the last completed layer, by `calcPartialConsumption()`
 * and therefore weighed from the G-code where it was read, and the slot the
 * map already names gets the rest.
 *
 * The parts before a refill are added as entries of their own, named after
 * the slot they came from and marked as reported by the printer, because they
 * were. Each carries `refill` so the summary can say why one filament is
 * booked on two spools. A filament that refilled twice is cut at both.
 *
 * @param {object} consumption - a map from `calcFullConsumption()` or the partial one, after `resolveSliceSlots()`
 * @param {object} sliceInfo - what the consumption was calculated from
 * @param {{index: number, from: string, to: string, layer: number}[]} refills - in the order they happened
 * @returns {object} a new consumption map
 */
export function splitAtRefills(consumption, sliceInfo, refills) {
    if (!refills?.length) return consumption;
    const result = {};
    for (const [key, entry] of Object.entries(consumption)) {
        const own = refills.filter(r => r.index === entry.index);
        if (!own.length || entry.grams <= 0) {
            result[key] = entry;
            continue;
        }
        let booked = 0;
        for (const r of own) {
            const through = calcPartialConsumption(sliceInfo, completedLayerIndex(r.layer))[key]?.grams ?? 0;
            const part = Math.round((Math.min(entry.grams, through) - booked) * 100) / 100;
            if (part <= 0) continue;
            booked += part;
            result[`${key}@${r.from}`] = {
                ...entry,
                amsId: r.from,
                amsIdFromPrinter: true,
                grams: part,
                refill: { before: true, from: r.from, to: r.to, layer: r.layer },
            };
        }
        const last = own[own.length - 1];
        result[key] = {
            ...entry,
            grams: Math.round((entry.grams - booked) * 100) / 100,
            refill: { before: false, from: last.from, to: last.to, layer: last.layer },
        };
    }
    return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** How long a failed slice fetch waits before the print handler tries again. */
export const SLICE_FETCH_RETRY_MS = 30000;
/** How many fetches a print gets in all, the first one included. */
export const SLICE_FETCH_ATTEMPTS = 3;

/**
 * Whether the sliced file of the running print should be fetched again.
 *
 * The file was fetched exactly once, when the print reached RUNNING, and a
 * printer that did not answer just then lost the whole print: a P2S recovering
 * from an extruder error on 2026-09-23 let the FTPS login time out for 20
 * seconds, and the job was never booked although the file was there a minute
 * later. A file that is not there yet is the same story from the other side,
 * a printer copying the job to its USB stick after it has started.
 *
 * So a fetch that found nothing is repeated, `SLICE_FETCH_RETRY_MS` after the
 * last one and up to `SLICE_FETCH_ATTEMPTS` times in all. A file that was
 * found but carried no slice info is not retried: the file will not change.
 *
 * @param {object|null} record - `printer.lastSliceFetch`
 * @param {number} now - the current time, `Date.now()`
 * @returns {boolean} whether another fetch is due
 */
export function sliceFetchRetryDue(record, now) {
    if (!record || record.path) return false;
    if ((record.attempt || 1) >= SLICE_FETCH_ATTEMPTS) return false;
    return now - record.at >= SLICE_FETCH_RETRY_MS;
}

/**
 * The FTPS paths the sliced 3MF of a job may sit under, most likely first.
 *
 * The file is named after the job, but the extension depends on how the job
 * reached the printer, and the printer says which in `gcode_file`:
 *
 *   - sent from the slicer over the LAN, it is `<job>.gcode.3mf`, which is the
 *     name "Export sliced file" gives it. Read off a P2S, a P1S and an X1E
 *   - sent through the Bambu cloud, from Bambu Studio or the Handy app, it is
 *     `<job>.3mf`. Read off a P1S whose seven cloud prints of September 2026
 *     all reported `gcode_file` "<job>.3mf" and answered 550 for the
 *     `.gcode.3mf` spelling, so not one of them was ever booked (issue #146)
 *   - `gcode_file` can also be the printer's internal `/data/Metadata/plate_1.gcode`,
 *     seen on the X1E, which names no file at all and is ignored
 *
 * So the name the printer reports comes first when it names a 3MF, then both
 * spellings under /cache, then both in the FTP root, where older firmware was
 * seen to keep the file.
 *
 * A print started on the printer's screen breaks the rule that the job is
 * named after the file: a P2S printing `A1mini.gcode.3mf` off its USB stick
 * reported the model's title as `subtask_name`, "Perfectly clean bed for
 * perfect prints!", and the four paths built from it all answered 550. The
 * `project_file` command the printer sends itself for such a start carries
 * `file:///userdata/model/history/A1mini.gcode.3mf`, and that basename is
 * `fileName`, tried before everything else. Measured on 2026-09-23.
 *
 * @param {string} jobName - `subtask_name` from MQTT
 * @param {string|null} [gcodeFile] - `gcode_file` from MQTT
 * @param {string|null} [fileName] - the file name from the printer's own `project_file` command
 * @returns {string[]} candidate paths, without duplicates
 */
export function resolveRemotePaths(jobName, gcodeFile = null, fileName = null) {
    const candidates = [];

    // The name the printer itself gave the file, when it named one: a print
    // started on the printer's screen carries it in the project_file echo,
    // while its job name is the model's title. Tried in both places first.
    if (typeof fileName === "string" && /\.3mf$/i.test(fileName)) {
        candidates.push(`/cache/${fileName}`, `/${fileName}`);
    }

    const reported = typeof gcodeFile === "string" ? gcodeFile.split("/").pop() : "";
    if (/\.3mf$/i.test(reported)) candidates.push(`/cache/${reported}`);

    if (jobName) {
        // Normalise to the bare job name without extensions, whichever it came with
        const name = jobName.split("/").pop()
            .replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, "").replace(/\.gcode$/i, "");
        candidates.push(`/cache/${name}.gcode.3mf`, `/cache/${name}.3mf`, `/${name}.gcode.3mf`, `/${name}.3mf`);
    }

    return [...new Set(candidates)];
}

/**
 * Parses `Metadata/slice_info.config` into the shape the consumption maths
 * expects.
 *
 * Two things are read out of it: the filament list, where each entry carries
 * the material profile, colour and the grams the slicer predicted, and the
 * layer_filament_list entries, which say over which layer ranges each filament
 * is actually used. Filament ids are 1 based and may be non contiguous, while
 * the layer lists reference a 0 based index, so both are kept.
 *
 * `projectSettings` is the sibling entry of the same archive. It is optional
 * and adds two things this file does not carry: the whole colour set of a
 * multi colour filament, and nothing else. slice_info.config keeps only the
 * first colour of a set, which is why a gradient spool and a plain spool of
 * the same first colour were one filament as far as this service could tell.
 *
 * Exported for tests; fetchSliceInfo is the normal entry point.
 *
 * @param {string} xml - the raw slice_info.config contents
 * @param {string|null} [projectSettings] - raw project_settings.config
 * @returns {{filaments: object[], totalLayers: number, rangesByFilamentIdx: object}}
 */
export function parseSliceInfo(xml, projectSettings = null) {
    const colorSets = parseMultiColours(projectSettings);
    const presets = parsePresets(projectSettings);

    // --- filaments ---
    const filaments = [];
    const filamentRe = /<filament\s+([^>]+?)\/>/g;
    let m;
    while ((m = filamentRe.exec(xml)) !== null) {
        const a = parseAttrs(m[1]);
        const id = parseInt(a.id, 10);
        if (!Number.isFinite(id)) continue;
        filaments.push({
            id,                       // 1-based, may be non-contiguous
            index: id - 1,            // 0-based index used in layer_filament_list
            tray_info_idx: a.tray_info_idx || null,
            type: a.type || null,
            color: a.color || null,
            colors: colorSets[id - 1] || null,
            used_m: parseFloat(a.used_m) || 0,
            used_g: parseFloat(a.used_g) || 0,
        });
    }

    // --- layer_filament_list: each entry lists the filament indices used over
    //     one or more layer ranges. Build per-filament-index merged ranges. ---
    const rangesByFilamentIdx = {};
    let totalLayers = 0;

    const listRe = /<layer_filament_list\s+([^>]+?)\/>/g;
    while ((m = listRe.exec(xml)) !== null) {
        const a = parseAttrs(m[1]);
        const indices = (a.filament_list || "")
            .trim().split(/\s+/).filter(s => s !== "").map(Number);
        const ranges = parseLayerRanges(a.layer_ranges || "");

        // A list without a filament prints nothing and does not count. A P2S
        // plate sliced by MakerWorld on 2026-09-26 carried one over "248 249"
        // after its 248 layers, which made the log say 250 and the partial
        // booking of a cancelled print divide by 250.
        if (!indices.length) continue;
        for (const [, end] of ranges) {
            if (end > totalLayers) totalLayers = end;
        }
        for (const idx of indices) {
            (rangesByFilamentIdx[idx] ||= []).push(...ranges);
        }
    }

    return { filaments, totalLayers, rangesByFilamentIdx, presets };
}

/**
 * The presets a project names, one per filament of the project, id, preset
 * name and vendor side by side.
 *
 * `project_settings.config` is JSON, and `filament_ids`, `filament_settings_id`
 * and `filament_vendor` are three lists in the same order. The id is what a
 * slot reports as `tray_info_idx` when that preset is chosen for it; for a
 * preset from Studio's cloud library that is a hash, and this is the only place
 * its name is written down. The "@BBL P2S 0.6 nozzle" tail of a preset name
 * says which printer profile it was made for and is dropped.
 *
 * @param {string|null} json - the file's text
 * @returns {{id: string, name: string|null, vendor: string|null}[]} empty when
 *   the file is missing or names no ids
 */
function parsePresets(json) {
    if (!json) return [];
    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    const ids = Array.isArray(parsed?.filament_ids) ? parsed.filament_ids : [];
    const names = Array.isArray(parsed?.filament_settings_id) ? parsed.filament_settings_id : [];
    const vendors = Array.isArray(parsed?.filament_vendor) ? parsed.filament_vendor : [];

    return ids.map((id, index) => {
        const rawName = typeof names[index] === "string" ? names[index].trim() : "";
        const name = rawName.replace(/\s*@.*$/, "").trim() || null;
        const vendor = typeof vendors[index] === "string" && vendors[index].trim() ? vendors[index].trim() : null;
        return { id: String(id ?? "").trim(), name, vendor };
    }).filter(preset => preset.id);
}

/**
 * Reads `filament_multi_colour` out of project_settings.config, indexed the way
 * the slicer indexes its filament list, so entry `id - 1` belongs to filament
 * `id`.
 *
 * The file is JSON, but it is parsed with a regular expression on purpose: it
 * is the slicer's whole configuration, tens of thousands of characters of
 * gcode templates and per filament arrays, and one key out of it does not
 * justify holding all of that as objects. A file that cannot be read at all
 * yields nothing, and the single colour each filament also carries stays the
 * only thing known about it.
 *
 * Studio writes a set as one space separated string, "#8EC9E9 #E7C1D5", and a
 * single colour filament as its one colour, so a set of one is not a set.
 *
 * @param {string|null} json - raw project_settings.config
 * @returns {string[][]} colour sets by filament index, sparse
 */
function parseMultiColours(json) {
    if (!json) return [];

    const match = /"filament_multi_colour"\s*:\s*\[([^\]]*)\]/.exec(json);
    if (!match) return [];

    return match[1]
        .split(",")
        .map(entry => {
            const colors = (entry.match(/"([^"]*)"/)?.[1] || "")
                .trim()
                .split(/\s+/)
                .map(normColor)
                .filter(Boolean);
            return colors.length > 1 ? colors : null;
        });
}

/**
 * Parses the `key="value"` attributes of one XML tag into an object. The slice
 * info file is small and machine generated, so this is used instead of pulling
 * in an XML parser.
 */
function parseAttrs(str) {
    const result = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) result[m[1]] = m[2];
    return result;
}

/**
 * Parses a `layer_ranges` attribute into inclusive layer pairs.
 *
 * "0 127" yields [[0, 127]], "0 50,60 127" yields [[0, 50], [60, 127]].
 * Malformed pairs are dropped rather than producing NaN ranges.
 */
function parseLayerRanges(str) {
    // "0 127" → [[0,127]];  "0 50,60 127" → [[0,50],[60,127]]
    return str.split(",")
        .map(pair => pair.trim().split(/\s+/).map(Number))
        .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
        .map(([s, e]) => [s, e]);
}

/** Rounds every consumption entry to two decimals, in place. */
function roundEntries(result) {
    for (const k of Object.keys(result)) {
        result[k].grams = Math.round(result[k].grams * 100) / 100;
    }
    return result;
}

/**
 * Checks whether the FTPS server of a printer accepts the access code.
 *
 * Same connection the consumption tracking uses, so a green result here means
 * the sliced file can actually be downloaded. Nothing is transferred beyond the
 * login itself.
 *
 * @param {{ip: string, code: string}} printer - address and access code to try
 * @param {number} [timeout] - milliseconds before the attempt is given up
 * @returns {Promise<{ok: boolean, error?: string, detail?: string}>}
 */
export async function testFtpsConnection(printer, timeout = 8000) {
    const client = new ftp.Client(timeout);
    client.ftp.verbose = false;

    try {
        await ftpsAccess(client, printer);
        return { ok: true };
    } catch (err) {
        const detail = err?.message || String(err);
        return { ok: false, error: describeFtpsError(err), ...ftpsErrorCode(err), detail };
    } finally {
        client.close();
    }
}

/**
 * Turns an FTPS failure into something a user can act on. The library reports
 * a rejected login as a 530 reply code and an unreachable host as a socket
 * error, which are two very different things to fix.
 */
function describeFtpsError(err) {
    const message = err?.message || String(err);
    if (err?.code === 530 || /530/.test(message)) return "The printer rejected the access code";
    return describeConnectionError(err, { port: 990, refusedHint: "Is FTP access enabled on the printer?" }) ?? message;
}

/** The same as describeFtpsError(), as a code for the Web UI. */
function ftpsErrorCode(err) {
    const message = err?.message || String(err);
    if (err?.code === 530 || /530/.test(message)) return { code: "accessCodeRejected", params: {} };
    return connectionErrorCode(err, 990) ?? {};
}

/**
 * What the printer is doing inside a running print, by the number it reports
 * as `print.stg_cur`.
 *
 * These names are not published by Bambu Lab in a form this project can carry.
 * The table is the one the community has settled on, and it is treated as a
 * lead rather than a fact: an unknown number is shown as the number, so a
 * firmware that adds a stage says "Stage 78" instead of a wrong name or an
 * empty field. A P2S was seen announcing stages 51 and 54 for an ordinary
 * plate before either was in the table, so the gaps are real and not
 * hypothetical.
 *
 * 36 to 77 follow the codes ha-bambulab carries in its const.py, which is the
 * fullest list around; the wording is this project's. Most of them belong to
 * one printer family, the laser and cutter stages of the H2 series and the
 * hotend swap of the X2D, so a P2S never shows them, but a printer that does
 * report one says what it is doing rather than a number.
 *
 * -1 is what the printer reports when it is in no stage at all, which is every
 * report outside a print and most reports during one: the stage is only set
 * while something other than plain printing is going on. A P1 says the same
 * thing as 255, seen in the P1P report of test/fixtures/reports, and 0 is the
 * printer laying down filament.
 */
const PRINT_STAGES = {
    1:  "Auto bed levelling",
    2:  "Heatbed preheating",
    3:  "Sweeping XY mech mode",
    4:  "Changing filament",
    5:  "M400 pause",
    6:  "Paused, filament runout",
    7:  "Heating hotend",
    8:  "Calibrating extrusion",
    9:  "Scanning bed surface",
    10: "Inspecting first layer",
    11: "Identifying build plate",
    12: "Calibrating micro lidar",
    13: "Homing toolhead",
    14: "Cleaning nozzle tip",
    15: "Checking extruder temperature",
    16: "Paused by user",
    17: "Paused, front cover falling",
    18: "Calibrating lidar response",
    19: "Calibrating extrusion flow",
    20: "Paused, nozzle temperature malfunction",
    21: "Paused, heatbed temperature malfunction",
    22: "Unloading filament",
    23: "Paused, skipped step",
    24: "Loading filament",
    25: "Calibrating motor noise",
    26: "Paused, AMS lost",
    27: "Paused, heat break fan too slow",
    28: "Paused, chamber temperature control error",
    29: "Cooling chamber",
    30: "Paused by user G-code",
    31: "Motor noise showoff",
    32: "Paused, filament on nozzle detected",
    33: "Paused, cutter error",
    34: "Paused, first layer error",
    35: "Paused, nozzle clog",
    36: "Checking absolute accuracy before calibration",
    37: "Calibrating absolute accuracy",
    38: "Checking absolute accuracy after calibration",
    39: "Calibrating nozzle offset",
    40: "Levelling bed at high temperature",
    41: "Checking quick release",
    42: "Checking door and cover",
    43: "Calibrating laser",
    44: "Checking platform",
    45: "Checking bird's eye camera position",
    46: "Calibrating bird's eye camera",
    47: "Levelling bed, phase 1",
    48: "Levelling bed, phase 2",
    49: "Heating chamber",
    50: "Cooling heatbed",
    // 51 and 54 are the two a P2S announces on an ordinary plate, which is
    // why they were the ones showing up as a bare number before the rest of
    // the range was named.
    51: "Printing calibration lines",
    52: "Checking material",
    53: "Calibrating live view camera",
    54: "Heating heatbed to target",
    55: "Checking material position",
    56: "Calibrating cutter model offset",
    57: "Measuring surface",
    58: "Thermal preconditioning",
    59: "Homing blade holder",
    60: "Calibrating camera offset",
    61: "Calibrating blade holder position",
    62: "Testing hotend pick and place",
    63: "Waiting for chamber temperature to equalise",
    64: "Preparing hotend",
    65: "Calibrating nozzle clump detection",
    66: "Purifying chamber air",
    67: "Measuring rotary attachment",
    68: "Moving toolhead above purge chute",
    69: "Cooling nozzle",
    70: "Moving toolhead to centre of heatbed",
    71: "Fitting active arc",
    72: "Detecting hotend type",
    73: "Detecting build plate alignment",
    74: "Detecting foreign object on heatbed surface",
    75: "Detecting foreign object under heatbed",
    76: "Pre-extruding before printing",
    77: "Preparing AMS",
};

/** What a P1 reports for no stage at all, where the other printers report -1. */
const NO_STAGE_P1 = 255;

/**
 * The stage of a running print as text, or null when the printer is in none.
 *
 * @param {number|null|undefined} code - `print.stg_cur` from an MQTT report
 * @returns {string|null} the stage, or null when there is no stage to name
 */
export function printStageName(code) {
    // 0 is the printer laying down filament, which the state badge next to this
    // one already says. Measured on a P2S: it sits on 0 for the whole body of a
    // print, so naming it would put "RUNNING" and "Printing" side by side for
    // almost the entire job. -1 is the same answer from the other end, no stage
    // at all, which is what it reports outside a print.
    if (code == null || code <= 0 || code === NO_STAGE_P1) return null;
    return PRINT_STAGES[code] ?? `Stage ${code}`;
}

/**
 * Whether a stage means the printer is getting ready rather than laying down
 * filament.
 *
 * Used for the badge that says a print has started but is not printing yet.
 * Everything that heats, homes, levels, calibrates, cleans or loads counts;
 * the paused stages do not, because a pause is its own state the printer
 * already reports as PAUSE.
 *
 * @param {number|null|undefined} code - `print.stg_cur` from an MQTT report
 * @returns {boolean} whether this stage is preparation
 */
export function isPreparingStage(code) {
    // 51 and 54 belong here for the same reason as the rest: the printer is
    // busy with something that comes before the model. The calibration lines
    // are laid down next to the plate, not on it, and a bed still coming up to
    // temperature has not started either. 36 to 77 are checks, calibrations
    // and heating of the same kind, except the two that cool something down,
    // 50 and 69, which sit at the end of a job like 29 does.
    // 4 and 22, changing and unloading filament, are what a job does before
    // its first layer when the nozzle holds the wrong spool, and read as
    // RUNNING next to "Changing filament" on a P2S until they were added.
    // In the middle of a print they are the same stages; the card keeps
    // RUNNING there on its own, by the layer count.
    const number = Number(code);
    if (number >= 36 && number <= 77) return number !== 50 && number !== 69;
    return [1, 2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 18, 19, 22, 24, 25].includes(number);
}
