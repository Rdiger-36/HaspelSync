import mqtt from "mqtt";
import * as net from "node:net";
import { serverLogFilePath } from "./config.js";
import { settings, spoolmanUrl, legacyMode } from "./settings.js";
import { originalConsoleLog, debug, trace, appendTrace } from "./logger.js";
import { state } from "./state.js";
import { sleep, formatDate, formatInterval, offlineBackoff, convertAMSandSlot, activeSlotFromReport, connectionErrorCode, spoolIsEmpty, externalSlotLabel, EXTERNAL_SPOOL_ID, SLOT_OPTIONS, ACTIVE_PRINT_STATES, describeConnectionError, decodePrintMapping } from "./utils.js";
import {
    getSpoolmanSpools,
    getArchivedSpoolmanSpools,
    getSpoolmanInternalFilaments,
    getSpoolmanExternalFilaments,
    createSpool,
    createFilamentAndSpool,
    mergeSpool,
    checkSpoolmanHealth,
    patchSpoolWeight,
    useSpoolWeight,
    setSpoolArchived,
    logSpoolmanFailure,
} from "./spoolman.js";
import { fetchSliceInfo, calcFullConsumption, calcPartialConsumption, completedLayerIndex, resolveSliceSlots, orderedAmsSlots, decodeStudioMapping, sliceFetchRetryDue, refillsBetween, splitAtRefills, SLICE_FETCH_RETRY_MS, SLICE_FETCH_ATTEMPTS } from "./gcode.js";
import { getMapping, clearMapping, setMapping, spoolIdsAssignedElsewhere } from "./mappings.js";
import { learnPresets } from "./presets.js";
import { rememberPrintStart, recallPrintStart, forgetPrintStart, rememberSlicedFile, recallSlicedFile, rememberPrintSlots, recallPrintSlots } from "./printstate.js";
import { uniqueSpoolForSlot } from "../public/match.js";
import { humanLayers } from "../public/shared.js";
import { describePrintError, describePrintErrorInAll } from "./printerrors.js";
import { createLocationSync, releaseSlotLocation } from "./location.js";
import {
    processData,
    extractAmsEnvironment,
    amsModelsFromVersion,
    extractComparableTrayData,
    correctRemainInt,
    slotIsOccupied,
    slotIsBusy,
    findExistingSpool,
    findMatchingExternalFilament,
    findMatchingInternalFilament,
    findMergeableSpool,
    haveSpoolDataChanged,
    hasTrayDataChanged,
    hasSpoolUiChanged,
    consumptionCandidate,
    matchConsumption,
    spoolTag,
    modelCanDry,
} from "./ams.js";
import { toClientSpool, loadedSlotIds } from "./uispool.js";
import { traceEnabled } from "./printers.js";

/**
 * Sends an event to every connected SSE client. A payload that cannot be
 * serialised is dropped with a log line rather than taking the handler down.
 */
export function broadcastSSE(data) {
    let payload;
    try {
        payload = `data: ${JSON.stringify(data)}\n\n`;
    } catch (err) {
        originalConsoleLog(`[ERROR] broadcastSSE: failed to serialize data - ${err.message}`);
        return;
    }
    state.clients.forEach(client => client.write(payload));
}

/** Pushes one slot's new state to the dashboard. */
export function broadcastSlotUpdate(printerId, spool) {
    broadcastSSE({ type: "slot_update", printer: printerId, spool: toClientSpool(spool) });
}

/**
 * How long two AMS environment broadcasts have to be apart, in milliseconds.
 *
 * Humidity and temperature are the two values the printer reports on every
 * report and that never sit still, which is why they are kept out of the tray
 * comparison entirely (see extractComparableTrayData in ams.js). They are shown
 * now, so they have to travel, but a tenth of a degree is not worth a push to
 * every browser every few seconds.
 */
const AMS_ENV_BROADCAST_INTERVAL = 30_000;

/**
 * Keeps the AMS environment readings current and pushes them to the dashboard.
 *
 * Deliberately outside the slot update interval and outside the tray change
 * detection: the readings are display only, they never touch Spoolman, and a
 * user watching a unit dry wants them sooner than the next spool update. The
 * in-memory value is refreshed on every report, so /api/status answers with what
 * arrived last; only the broadcast is throttled, and only a changed reading is
 * sent at all.
 *
 * @param {object} printer - the printer runtime object
 * @param {object[]} amsUnits - `print.ams.ams` from the report
 * @param {Date} now - the time the report was processed
 */
function broadcastAmsEnvironment(printer, amsUnits, now) {
    const amsEnv = extractAmsEnvironment(amsUnits, printer.amsModels);
    const serialised = JSON.stringify(amsEnv);
    printer.amsEnv = amsEnv;

    if (serialised === printer.lastAmsEnvBroadcast) return;
    if (now.getTime() - (printer.lastAmsEnvBroadcastTime || 0) < AMS_ENV_BROADCAST_INTERVAL) return;

    printer.lastAmsEnvBroadcast = serialised;
    printer.lastAmsEnvBroadcastTime = now.getTime();
    broadcastSSE({ type: "ams_env", printer: printer.id, amsEnv });
}

/**
 * Fetches the sliced file of a job and learns what it names.
 *
 * The names behind the preset hashes of chipless slots are in that file and
 * nowhere else, so they are kept whenever a file is read, by the print handler
 * when a print starts and by the manual `?job=` test of `/api/print` alike.
 * The next slot update shows them.
 *
 * @param {object} printer - the printer runtime object
 * @param {string} jobName - `subtask_name` of the job
 * @param {string|null} [gcodeFile] - `gcode_file` of the job, when reported
 * @param {string|null} [fileName] - the file name the printer itself gave the job, when it did
 * @param {object|null} [running] - the running print as `runningPrint()` describes it, for finding the file by its time
 * @returns {Promise<object|null>} what `fetchSliceInfo()` returned
 */
export async function loadSliceInfo(printer, jobName, gcodeFile = null, fileName = null, running = null) {
    const sliceInfo = await fetchSliceInfo(printer, jobName, gcodeFile, fileName, running);
    if (!sliceInfo) return null;

    for (const preset of learnPresets(sliceInfo, jobName)) {
        console.log(printer.name, printer.logFilePath,
            `[Print] Learned the preset ${preset.id}: "${preset.name}"${preset.vendor ? ` by ${preset.vendor}` : ""}`);
    }
    return sliceInfo;
}

/**
 * The slice info of the printer's current job, fetched at most once.
 *
 * Two callers want it: the print handler when the state reaches RUNNING, and
 * `/api/print`, which the dashboard asks every few seconds and which starts
 * asking as soon as the job has a name, in PREPARE. Each used to download the
 * file for itself, so every print cost two FTPS downloads three seconds apart,
 * and the second one also logged "Learned the preset" a second time. Now the
 * first caller's result is kept on the printer and a fetch still in flight is
 * shared rather than started again.
 *
 * The outcome is logged here, once, whoever asked. The dashboard's look while
 * the job prepared used to fail without a line, and the print handler's own
 * fetch at RUNNING then read "attempt 3 of 3" right after its first.
 *
 * `freshStart` in `handlePrintStateChange()` clears both, so a cached file
 * never outlives the job it belongs to.
 *
 * @param {object} printer - the printer runtime object
 * @param {string} jobName - `subtask_name` of the job
 * @param {string|null} [gcodeFile] - `gcode_file` of the job, when reported
 * @param {string|null} [fileName] - the file name the printer itself gave the job, when it did
 * @param {object|null} [running] - the running print as `runningPrint()` describes it, for finding the file by its time
 * @returns {Promise<object|null>} what `fetchSliceInfo()` returned
 */
export function ensureSliceInfo(printer, jobName, gcodeFile = null, fileName = null, running = null) {
    if (printer.currentSliceInfo) return Promise.resolve(printer.currentSliceInfo);
    if (printer.sliceFetchInFlight?.jobName === jobName) return printer.sliceFetchInFlight.promise;

    const promise = loadSliceInfo(printer, jobName, gcodeFile, fileName, running)
        .then(sliceInfo => {
            if (sliceInfo) {
                printer.currentSliceInfo = sliceInfo;
                // So a restart of the service during this print reads the same
                // file again, whatever the job is called by then
                if (printer.lastSliceFetch?.path) rememberSlicedFile(printer.id, printer.lastSliceFetch.path);
                console.log(printer.name, printer.logFilePath, `[Print] Slice info loaded: ${describeSliceInfo(sliceInfo)}`);
            } else {
                console.log(printer.name, printer.logFilePath, `[Print] ${sliceFetchFailure(printer.lastSliceFetch)}, ${sliceFetchOutlook(printer.lastSliceFetch)}`);
            }
            return sliceInfo;
        }, err => {
            console.error(printer.name, printer.logFilePath, `[Print] Could not fetch slice info: ${err.message}, ${sliceFetchOutlook(printer.lastSliceFetch)}`);
            throw err;
        })
        .finally(() => {
            if (printer.sliceFetchInFlight?.promise === promise) printer.sliceFetchInFlight = null;
        });
    printer.sliceFetchInFlight = { jobName, promise };
    return promise;
}

/**
 * What the printer reports about its running print that a sliced file found
 * by listing is checked against, see `findSlicedFileByTime()` in gcode.js.
 *
 * @param {object} printer - the printer runtime object
 * @returns {{startedAt: number|null, totalLayers: number|null, identity: object|null}}
 */
export function runningPrint(printer) {
    return {
        startedAt: printer.printStartedAt ?? null,
        totalLayers: printer.currentTotalLayers ?? null,
        identity: printer.currentIdentity ?? null,
        filePath: printer.currentFilePath ?? null,
    };
}

/**
 * The slice info in one clause for the log: "1 filament(s), 15 layers".
 *
 * `totalLayers` is the last layer's 0-based index, which the booking maths
 * counts with, and read "0 layers" for a one layer plate. The count is what
 * the dashboard shows, through the same helper.
 *
 * @param {object} sliceInfo - what `fetchSliceInfo()` returned
 * @returns {string} the clause
 */
function describeSliceInfo(sliceInfo) {
    const model = sliceInfo.modelTitle ? `, model "${sliceInfo.modelTitle}" (the job is named after its print profile)` : "";
    // What a cancel will be booked by, which is what someone checking a
    // partial booking asks first
    const read = Object.keys(sliceInfo.extrusion?.shares || {}).length;
    const perLayer = read ? `, layers weighed from the G-code for ${read} filament(s)` : ", layers counted evenly";
    return `${sliceInfo.filaments.length} filament(s), ${humanLayers(0, sliceInfo.totalLayers).total} layers${perLayer}${model}`;
}

/**
 * One fetch of the running print's sliced file, for the print handler.
 *
 * Shared by the fetch at RUNNING and the retries after it. The outcome is in
 * the log either way, written by `ensureSliceInfo()`, and a failure is not the
 * handler's to deal with: the print goes on, tracked or not.
 *
 * @param {object} printer - the printer runtime object
 * @param {string} jobName - `subtask_name` of the job
 */
async function fetchSliceInfoForPrint(printer, jobName) {
    try {
        await ensureSliceInfo(printer, jobName, printer.currentGcodeFile, printer.currentFileName, runningPrint(printer));
    } catch {
        // Already in the log, see ensureSliceInfo()
    }
}

/**
 * What happens after a failed fetch, for the end of its log line.
 *
 * @param {object|null} record - `printer.lastSliceFetch`
 * @returns {string} one clause, without a full stop
 */
function sliceFetchOutlook(record) {
    // The look before the print runs does not count, see fetchSliceInfo()
    if (record?.beforeRunning) return "looking again once the print runs";
    const attempt = record?.attempt || 1;
    if (record && !record.path && attempt < SLICE_FETCH_ATTEMPTS) {
        return `trying again in ${Math.round(SLICE_FETCH_RETRY_MS / 1000)} seconds`;
    }
    return "consumption tracking unavailable for this print";
}

/**
 * Why the last slice info fetch came back empty, for the log.
 *
 * Two different problems used to share one sentence, "slice_info.config not
 * found in 3MF", and the one that was actually happening, no file under that
 * name at all, was the one the sentence did not say.
 *
 * @param {object|null} record - `printer.lastSliceFetch`
 * @returns {string} one clause, without a full stop
 */
export function sliceFetchFailure(record) {
    if (!record) return "No sliced file was fetched";
    if (record.error) {
        // Nothing was tried: the login itself failed. The FTPS service of a
        // P2S had hung on 2026-10-02 and answered the TLS handshake with plain
        // text; the card then said "No sliced file on the printer" about a
        // file that sat right under the first path, and the printer was
        // rebooted for the file's name
        return `FTPS login to the printer failed: ${record.error}`;
    }
    if (!record.path) {
        // The printer's answer per path, when the fetch recorded one: a 550
        // from a printer without a USB stick and a data connection that never
        // opened used to read the same, and telling them apart took a debug log
        const reasons = record.reasons || {};
        const tried = record.tried.map(path => (reasons[path] ? `${path} (${reasons[path]})` : path));
        // Only when the storage was listed at all, which needs the print's start
        const listed = typeof record.listed === "number"
            ? `. Listed ${record.listed} 3MF files on the printer: ${record.settled || "no 3MF was written at the start"}`
            : "";
        return `No sliced file on the printer under ${tried.join(", ")}${listed}`;
    }
    return `${record.path} carries no Metadata/slice_info.config`;
}

/**
 * Asks the printer which modules it is made of, the AMS units among them.
 *
 * Sent once per connection, right after the subscription, on the request
 * topic. The answer comes back on the report topic as an `info` message and is
 * read by `noteVersionInfo()`. A printer that does not answer costs nothing:
 * the units keep the plain "AMS" label until it does.
 *
 * @param {object} client - the connected MQTT client
 * @param {object} printer - the printer runtime object
 */
function requestVersion(client, printer) {
    const request = JSON.stringify({ info: { command: "get_version", sequence_id: "0" } });
    try {
        client.publish(`device/${printer.id}/request`, request);
        debug("mqtt", printer.name, printer.logFilePath, "Asked the printer for its module list (get_version)");
    } catch (err) {
        debug("mqtt", printer.name, printer.logFilePath, `Could not ask for the module list: ${err?.message}`);
    }
}

/**
 * Asks the printer for a full report right away.
 *
 * Sent once per connection, next to `requestVersion()`. Between full reports
 * a printer sends deltas without the AMS block and the external holder, and an
 * A1 mini sends a full one only about every five minutes, so after a restart
 * the slots and a running print stayed unknown for that long (issue #212).
 * Never sent on a timer: a P1P is known to stall when asked too often.
 *
 * @param {object} client - the connected MQTT client
 * @param {object} printer - the printer runtime object
 */
function requestFullReport(client, printer) {
    const request = JSON.stringify({ pushing: { command: "pushall", sequence_id: "0" } });
    try {
        client.publish(`device/${printer.id}/request`, request);
        debug("mqtt", printer.name, printer.logFilePath, "Asked the printer for a full report (pushall)");
    } catch (err) {
        debug("mqtt", printer.name, printer.logFilePath, `Could not ask for a full report: ${err?.message}`);
    }
}

/**
 * Reads the printer's `get_version` answer for the AMS units it names.
 *
 * Called ahead of `handleMqttMessage()` and outside it on purpose: that handler
 * returns without reading while a previous report is still being processed and
 * while Spoolman is down, and the answer arrives exactly once per connection.
 * Anything that is not a `get_version` answer is ignored.
 *
 * The readings on the dashboard carry the model, so they are re-sent with it
 * right away rather than at the next throttled broadcast.
 *
 * @param {object} printer - the printer runtime object
 * @param {Buffer|string} message - the raw MQTT message
 * @returns {boolean} whether the message was a `get_version` answer
 */
export function noteVersionInfo(printer, message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch {
        return false;
    }
    if (data?.info?.command !== "get_version" || !Array.isArray(data.info.module)) return false;

    const models = amsModelsFromVersion(data.info.module);
    const changed = JSON.stringify(models) !== JSON.stringify(printer.amsModels || {});
    printer.amsModels = models;

    if (changed) {
        const named = Object.entries(models)
            .map(([amsId, unit]) => `${amsId} ${unit.model}${unit.hardware ? ` (${unit.hardware})` : ""}`);
        console.log(printer.name, printer.logFilePath,
            `[AMS] Units as the printer names them: ${named.length ? named.join(", ") : "none"}`);
    }

    if (Array.isArray(printer.amsEnv) && printer.amsEnv.length) {
        // The model also settles whether the unit has a dryer, which the
        // readings guessed from the report until now.
        printer.amsEnv = printer.amsEnv.map(entry => {
            const model = models[entry.amsId]?.model ?? null;
            return { ...entry, model, drying: modelCanDry(model) === false ? null : entry.drying };
        });
        printer.lastAmsEnvBroadcast = JSON.stringify(printer.amsEnv);
        broadcastSSE({ type: "ams_env", printer: printer.id, amsEnv: printer.amsEnv });
    }

    return true;
}

/**
 * Keeps the slots Bambu Studio sent a job to, from the `project_file` command
 * the printer echoes on its report topic.
 *
 * Read ahead of `handleMqttMessage()` like the `get_version` answer, and for
 * the same reason: the echo arrives once, two seconds before the state changes
 * to PREPARE, and the handler may not be reading at that moment. It is kept on
 * the printer until the print starts, where `handlePrintStateChange()` takes it
 * as the mapping for a job of that name; a printer that reports `print.mapping`
 * itself overrides it, so a P2S loses nothing.
 *
 * @param {object} printer - the printer runtime object
 * @param {Buffer|string} message - the raw MQTT message
 * @returns {boolean} whether the message was a `project_file` echo
 */
export function notePrintCommand(printer, message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch {
        return false;
    }
    const command = data?.print;
    if (command?.command !== "project_file") return false;

    const slots = decodeStudioMapping(command);
    const jobName = typeof command.subtask_name === "string" ? command.subtask_name : "";
    const fileName = localFileName(command.url);

    // The P2S sends the echo twice within a second, both with the same
    // sequence id, so the second one is kept quiet when it says the same.
    const pending = printer.pendingMapping;
    const repeated = !!slots && !!pending && pending.jobName === jobName
        && JSON.stringify(pending.slots) === JSON.stringify(slots);
    printer.pendingMapping = slots ? { jobName, slots, at: Date.now() } : null;
    printer.pendingFileName = fileName ? { jobName, fileName } : null;
    const identity = printIdentity(command);
    printer.pendingIdentity = identity ? { jobName, ...identity } : null;

    // A file:// url means the printer sent this command to itself, for a job
    // started on its screen from its storage. Bambu Studio's are https:// for
    // a cloud print and ftp:// for a LAN print.
    const sender = fileName ? `The printer started "${jobName || "the job"}" from ${fileName}` : `Bambu Studio sent "${jobName || "the job"}"`;

    if (repeated) {
        debug("print", printer.name, printer.logFilePath, `[Print] ${sender} a second time, same slots`);
    } else if (slots) {
        console.log(printer.name, printer.logFilePath, `[Print] ${sender} to the slots ${JSON.stringify(slots)}`);
    } else {
        debug("print", printer.name, printer.logFilePath, `[Print] ${sender} without a slot mapping`);
    }
    return true;
}

/**
 * What a `project_file` command says about the file it sends, for telling that
 * file apart from the others on the stick. See `judgeSlicedFile()` in gcode.js.
 *
 * `md5` is the md5 of the whole 3MF, `model_id` and `profile_id` are
 * MakerWorld's ids of a print from MakerWorld, and `plate_idx` the plate.
 * Measured on a P2S printing from Bambu Handy on 2026-09-26, where all of them
 * matched the file on the stick. A "0" or an empty string is what a print
 * without a cloud project sends, and counts as nothing.
 *
 * @param {object} command - the `print` block of the command
 * @returns {{md5: string|null, modelId: string|null, profileId: string|null, plate: number|null}|null}
 */
export function printIdentity(command) {
    const text = value => (value == null || value === "" || String(value) === "0" ? null : String(value));
    const plate = Number(command?.plate_idx);
    const identity = {
        md5: text(command?.md5),
        modelId: text(command?.model_id),
        profileId: text(command?.profile_id),
        plate: Number.isInteger(plate) && plate > 0 ? plate : null,
    };
    return Object.values(identity).some(v => v != null) ? identity : null;
}

/**
 * The file a `project_file` command names on the printer's own storage.
 *
 * A print started on the printer's screen is announced by the printer itself,
 * with `url` "file:///userdata/model/history/A1mini.gcode.3mf": the copy it
 * made of the file on the USB stick. Its `subtask_name` is the model's title
 * from inside the 3MF, so the basename here is the only place the file's real
 * name appears. A cloud or LAN print names a remote object instead, which says
 * nothing about the name on the printer, and yields null.
 *
 * @param {unknown} url - the `url` of the command
 * @returns {string|null} the basename, or null when the url is not a local file
 */
export function localFileName(url) {
    if (typeof url !== "string" || !/^file:\/\//i.test(url)) return null;
    let name = url.replace(/^file:\/\/+/i, "").split("/").pop();
    try {
        name = decodeURIComponent(name);
    } catch {
        // Kept as it came: a name the printer did not encode is still a name
    }
    return name || null;
}

// Print states that signal the end of a print job
const TERMINAL_STATES = new Set(["FINISH", "FAILED", "CANCEL"]);
// Print states that indicate an active or paused job. Built from the list in
// public/shared.js, because the dashboard has to answer the same question
// before it offers to correct a weight this side would then overwrite.
export const ACTIVE_STATES = new Set(ACTIVE_PRINT_STATES);

/**
 * The fields of a report that `handlePrintStateChange()` reads next to
 * `gcode_state`. A report carrying none of them has nothing to say about the
 * print, whatever else is in it.
 */
const PRINT_DELTA_FIELDS = [
    "layer_num", "subtask_name", "gcode_file", "stg_cur", "mc_remaining_time",
    "print_error", "mc_print_error_code", "fail_reason", "mapping",
];

/**
 * A delta report completed with the state the printer last named, or null
 * when it is not one the print tracking should see.
 *
 * A P1S or an A1 sends a full report every one to five minutes and, in
 * between, only what changed: `layer_num` on its own, `gcode_file` on its
 * own, and `subtask_name` not at all when the job has the same name as the
 * last one. A P2S or an X1 repeats the whole print block every time. The
 * tracking used to run on reports with a `gcode_state` only, which dropped
 * every one of those deltas. Measured on a P1S through the raw trace on
 * 2026-09-09: FINISH was logged at "layer 17" while the deltas had counted to
 * 38, so a cancel would have booked a layer minutes old, and the dashboard's
 * layer, stage and remaining time stood still between the full reports.
 *
 * An omitted field means "unchanged" on those printers, so a delta is read as
 * one more report of the state last seen. Nothing is known before the first
 * report with a state, and that first report has a rule of its own (it may
 * find a print already running), so a delta ahead of it is dropped as before.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} print - the `print` block of the report, without a state
 * @returns {object|null} the block with the last known state, or null
 */
export function deltaAsReport(printer, print) {
    if (!print || typeof print !== "object" || print.gcode_state) return null;
    if (!printer.stateSeenSinceStart || !printer.currentGcodeState) return null;
    if (!PRINT_DELTA_FIELDS.some(field => print[field] !== undefined)) return null;
    return { ...print, gcode_state: printer.currentGcodeState };
}

/**
 * Notes whether the printer's removable storage is in, from `print.sdcard`.
 *
 * The field means the microSD card on an X1, a P1 or an A1 and the USB stick
 * on a P2S, an H2 series printer or an X2D, and in every case it is the one
 * storage the printer's FTPS server shows: without it no sliced file can be
 * read and nothing is booked. The second generation printers keep printing
 * from internal storage without it, which is what makes the case silent, see
 * issue #179. A report without the field, such as a delta, says nothing about
 * it and leaves the last value alone; a report with it replaces the value.
 *
 * Logged once per change rather than per report, and only in G-code tracking,
 * because legacy mode never reads the file. The dashboard reads the value off
 * `/api/print` and says it on the print card.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} print - the `print` block of the report
 * @returns {boolean} whether the value changed
 */
export function noteStorage(printer, print) {
    if (!print || typeof print.sdcard !== "boolean") return false;
    if (printer.storagePresent === print.sdcard) return false;

    const wasKnown = typeof printer.storagePresent === "boolean";
    printer.storagePresent = print.sdcard;

    if (!legacyMode()) {
        if (!print.sdcard) {
            console.log(printer.name, printer.logFilePath, "[Print] No USB stick or SD card in the printer. The sliced file of a print cannot be read from it, so nothing will be booked until one is in.");
        } else if (wasKnown) {
            console.log(printer.name, printer.logFilePath, "[Print] USB stick or SD card is in the printer again, the next print will be tracked.");
        }
    }

    return true;
}

/**
 * Keeps the slot whose filament is in the printing nozzle, for `/api/status`.
 *
 * Nothing in this service decides anything by it: the booking reads the slots
 * a print reports in `print.mapping`. It is carried for a client that shows
 * which spool is feeding right now, the Home Assistant integration first. A
 * report that says nothing about it leaves the last value alone, see
 * `activeSlotFromReport()`.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} print - the `print` block of the report
 * @returns {boolean} whether the slot changed
 */
export function noteActiveSlot(printer, print) {
    const found = activeSlotFromReport(print, printer.activeNozzle ?? 0);
    if (!found) return false;
    printer.activeNozzle = found.nozzle;
    if (printer.activeSlot === found.slot) return false;
    printer.activeSlot = found.slot;
    return true;
}

/**
 * Tracks gcode_state transitions and triggers filament consumption tracking.
 * Called on every MQTT message that contains a gcode_state field.
 *
 * The slice info is fetched once, on the transition into RUNNING, because that
 * is the first point at which the sliced file is reliably present in the
 * printer's /cache. Consumption is booked once, on the transition from an
 * active state into a terminal one: the full slicer estimate for FINISH, and a
 * layer proportional share for FAILED and CANCEL.
 *
 * Both steps are guarded by a flag on the printer, since the printer repeats
 * its state in every report. Entering an active state resets those flags, so a
 * reprint of the same file is tracked again.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} print - the `print` object from the MQTT report
 */
export async function handlePrintStateChange(printer, print) {
    const newState    = print.gcode_state;
    const prevState   = printer.currentGcodeState || "IDLE";
    // The first report after the service started is the one that may find a
    // print already running, whose start was measured by the process before.
    const firstSinceStart = !printer.stateSeenSinceStart;
    printer.stateSeenSinceStart = true;

    // A fresh print starts when we transition from a non-active state into an
    // active one. Reset tracking there (even on a reprint of the same file) so
    // consumption gets booked again for the new run.
    const freshStart = ACTIVE_STATES.has(newState) && !ACTIVE_STATES.has(prevState);

    // subtask_name is the job name used for the FTP file (/cache/<name>.gcode.3mf).
    // gcode_file (e.g. /data/Metadata/plate_1.gcode) is an internal path NOT
    // exposed over FTP, so we only fall back to its basename as a last resort.
    //
    // A P1S leaves subtask_name out of the report that starts a job when the
    // job has the same name as the last one, because it only sends what
    // changed. After a restart of the service nothing remembers that name, and
    // the job was "unnamed" until the next full report minutes later, with the
    // slice fetch waiting on it. The project_file echo Bambu Studio's job
    // arrived with names it, so that is the second source at a start.
    const jobName = print.subtask_name
        || (freshStart ? printer.pendingMapping?.jobName : null)
        || printer.currentJobName
        || null;

    // The layer for the partial booking and the dashboard, read off every
    // report with three rules measured on a P2S through the raw trace:
    //
    //   - the report that starts a job still carries the previous job's last
    //     layer, 11 from a finished cube five seconds before the 0 of the new
    //     one, so a job starts at 0. The exception is the first report after
    //     the service came up, which may find a print already running at
    //     layer 7 and takes that
    //   - within a job the counter only goes up: 4, 3, 4 and 9, 8, 9 within a
    //     second, a stale value in one report type next to the current one in
    //     the other, and a cancel right after the stale one would book a layer
    //     too few
    //   - the previous job's number is not only in the report that starts the
    //     job. Seen on a P2S on 2026-09-20: a 36 layer print left 37 behind,
    //     the next job started at 0 in the tracking, and the reports of the
    //     following seconds still said 37, which the "only goes up" rule then
    //     took for the current layer. The dashboard showed 37 of 69 through
    //     the whole preparation while the printer sent 0, and a cancel there
    //     would have booked half the print. So the number the start report
    //     carried is remembered and ignored until the printer has reported
    //     something else, which is the 0 or 1 the new job begins with
    //   - outside a job the report is taken as it stands
    if (freshStart) {
        printer.currentLayerNum = firstSinceStart ? (print.layer_num ?? 0) : 0;
        printer.staleLayerNum = firstSinceStart ? null : (print.layer_num ?? null);
        printer.currentTotalLayers = null;
        printer.staleTotalLayers = firstSinceStart ? null : (print.total_layer_num ?? null);
    } else if (print.layer_num != null) {
        const stale = ACTIVE_STATES.has(prevState)
            && printer.staleLayerNum != null
            && print.layer_num === printer.staleLayerNum;
        if (!stale) {
            printer.staleLayerNum = null;
            printer.currentLayerNum = ACTIVE_STATES.has(prevState)
                ? Math.max(printer.currentLayerNum ?? 0, print.layer_num)
                : print.layer_num;
        }
    }
    const layerNum = printer.currentLayerNum ?? 0;

    // What the printer says about the job right now. Read on every report, not
    // only on a transition: these are the values that move while the state
    // stays RUNNING, and they are what the dashboard shows next to the layer
    // progress.
    if (print.stg_cur != null)          printer.currentStage = Number(print.stg_cur);
    if (print.mc_remaining_time != null) printer.currentRemainingMinutes = Number(print.mc_remaining_time);
    // Only what a sliced file found by listing is checked against. Like
    // layer_num above, it goes on naming the previous job after a start: a P2S
    // on 2026-09-26 reported the 248 of the last print through SLICING and
    // PREPARE and switched to the new 7 only with RUNNING, and a check against
    // the 248 rules out the right file. The number the start report carried is
    // ignored until the printer reports another one. A job with the same count
    // as the last is then not checked at all, which costs nothing.
    if (print.total_layer_num != null && (printer.staleTotalLayers == null || print.total_layer_num !== printer.staleTotalLayers)) {
        printer.staleTotalLayers = null;
        printer.currentTotalLayers = Number(print.total_layer_num);
    }

    // A fresh print starts when we transition from a non-active state into an
    // active one. Reset tracking here (even on a reprint of the same file) so
    // consumption gets booked again for the new run.
    if (newState !== prevState) {
        // Every transition, not only the two that do something. A print that
        // booked nothing usually took a path through the states nobody expected,
        // and the ordinary log only names the two ends of it.
        debug("print", printer.name, printer.logFilePath,
            `[Print] State ${prevState} to ${newState}, layer ${layerNum}, job ${jobName ?? "unnamed"}`);
    }

    if (freshStart) {
        printer.currentJobName    = jobName;
        printer.currentGcodeFile  = print.gcode_file || null;
        printer.currentSliceInfo  = null;
        printer.lastSliceFetch    = null;
        printer.sliceFetchInFlight = null;
        printer.currentMapping    = null;
        printer.refills           = [];
        printer.printSlotSpools   = {};
        printer.consumptionBooked = false;
        printer.sliceFetchDone    = false;

        // The slots Bambu Studio sent this job to, echoed by the printer just
        // before the state changed. Taken for a job of that name only: an echo
        // left over from a job that never started, or a reprint started on the
        // printer's screen, must not name the slots of a different plate. A
        // printer that reports print.mapping replaces it below on every report.
        const pendingFile = printer.pendingFileName;
        printer.pendingFileName = null;
        printer.currentFileName = pendingFile && (!pendingFile.jobName || !jobName || pendingFile.jobName === jobName)
            ? pendingFile.fileName
            : null;

        // What Bambu Studio's command says about the file, taken the same way
        const pendingIdentity = printer.pendingIdentity;
        printer.pendingIdentity = null;
        printer.currentIdentity = pendingIdentity && (!pendingIdentity.jobName || !jobName || pendingIdentity.jobName === jobName)
            ? pendingIdentity
            : null;

        const pending = printer.pendingMapping;
        printer.pendingMapping = null;
        if (pending && (!pending.jobName || !jobName || pending.jobName === jobName)) {
            printer.currentMapping = pending.slots;
            console.log(printer.name, printer.logFilePath,
                `[Print] Slots as Bambu Studio sent the job: ${JSON.stringify(pending.slots)}`);
        } else if (pending) {
            debug("print", printer.name, printer.logFilePath,
                `[Print] The slots Bambu Studio sent were for "${pending.jobName}", not for "${jobName}", so they are not used`);
        }

        // The result of the previous print goes here, not on the terminal
        // state: it stays readable for as long as nothing new is printing,
        // which is what makes the summary worth keeping after the card itself
        // has returned to idle.
        // Measured here, because no printer reports it. A restart of the
        // service mid print finds the job running on its first report and
        // takes the start it wrote before, so "Running for" and the report's
        // duration count from the print, not from the restart.
        const recalled = firstSinceStart ? recallPrintStart(printer.id, jobName) : null;
        printer.printStartedAt = recalled ?? Date.now();
        // The file the process before the restart read, when it got that far
        printer.currentFilePath = recalled ? recallSlicedFile(printer.id, jobName) : null;
        if (recalled) {
            console.log(printer.name, printer.logFilePath,
                `[Print] Found "${jobName ?? "the job"}" already running, started ${new Date(recalled).toISOString()}${printer.currentFilePath ? `, its sliced file was read from ${printer.currentFilePath}` : ""}`);
            restorePrintSlots(printer, jobName);
        } else {
            rememberPrintStart(printer.id, jobName, printer.printStartedAt);
        }
        printer.lastPrintSummary       = null;
        printer.printResultDismissed   = false;
        printer.printResetAt           = null;
        printer.lastPrintError         = null;
        printer.lastPrintErrorDetails  = null;

        // The printer does not clear its previous complaint when the state
        // changes. Measured on a P2S through the raw MQTT capture: the report
        // that first said RUNNING still carried fail_reason 50348044 from a
        // print that had failed two days earlier, and only the next report,
        // five seconds later, had it back at 0. Collecting it here blamed this
        // print for the previous one's failure, and the summary of a clean
        // FINISH said "Fail reason 50348044".
        //
        // This is the mirror image of the late arrival at the end of a print,
        // which the collection below exists for. Both are the same hardware
        // habit: the field lags the state by a report.
        printer.staleErrorText = printErrorText(print);
    }

    // Whatever the printer names as an error belongs to the print that was
    // running, so it is collected on every report rather than read once.
    //
    // It does not arrive with the report that ends the job. Measured on a P2S
    // stopped by hand: the state went to FAILED first, `print_error` 50348044
    // came one report later, and the report after that had it back at 0. A
    // summary built from the terminal report alone said nothing had gone wrong,
    // and a user stop is worth naming too.
    const reported = printErrorText(print);

    // Held back for as long as the printer keeps repeating the complaint it
    // already carried when this print started. The moment it reports anything
    // else, including nothing at all, it has moved on and whatever comes after
    // belongs to this print. An identical error really happening again inside
    // this print is only missed while the old one has not been cleared once.
    //
    // Only a report that names the error fields at all can say the printer has
    // moved on. A P1S delta leaves them out when they did not change, which
    // must not read as "cleared".
    const namesError = "print_error" in print || "mc_print_error_code" in print || "fail_reason" in print;
    if (printer.staleErrorText && namesError && reported !== printer.staleErrorText) {
        printer.staleErrorText = null;
    }

    const errorNow = printer.staleErrorText ? null : reported;
    if (errorNow) {
        printer.lastPrintError = errorNow;
        printer.lastPrintErrorDetails = printErrorDetails(print);
        // The summary may already be built, and it is the record of this very
        // print until the next one starts, so it takes the late arrival.
        if (printer.lastPrintSummary && !printer.lastPrintSummary.printError) {
            printer.lastPrintSummary.printError = errorNow;
            printer.lastPrintSummary.printErrorDetails = printer.lastPrintErrorDetails;
        }
    }

    // The file name the printer reports for the job, which says whether the
    // sliced file is a .3mf (cloud) or a .gcode.3mf (LAN). Read on every report
    // like the job name: it can arrive a report or two after the state does.
    if (print.gcode_file) printer.currentGcodeFile = print.gcode_file;

    // A cloud print repeats the ids of its command in every report, which is
    // all a restart mid print has left of them. The md5 is in the command only.
    //
    // Only while the printer says the print is a cloud print. A P2S started a
    // job from its own screen on 2026-09-26 right after a cloud print and went
    // on reporting that print's model_id with print_type "local", and taking it
    // proved the previous print's file for a job whose file was not on the
    // stick at all.
    if (ACTIVE_STATES.has(newState) && print.print_type === "cloud") {
        const reported = printIdentity({ model_id: print.model_id, profile_id: print.profile_id });
        if (reported) {
            const known = printer.currentIdentity || {};
            printer.currentIdentity = { ...known, modelId: known.modelId ?? reported.modelId, profileId: known.profileId ?? reported.profileId };
        }
    }

    // Fetch slice info once we reach RUNNING (the sliced file is reliably present
    // in /cache by then). Guarded so we only attempt it once per print.
    if (newState === "RUNNING" && jobName && !printer.sliceFetchDone) {
        printer.sliceFetchDone = true;
        printer.currentJobName = jobName;

        if (printer.currentSliceInfo) {
            // The dashboard asked /api/print while the job was preparing, and
            // that request already fetched the file. See ensureSliceInfo().
            console.log(printer.name, printer.logFilePath, `[Print] Print running: "${jobName}", slice info already loaded: ${describeSliceInfo(printer.currentSliceInfo)}`);
        } else {
            console.log(printer.name, printer.logFilePath, `[Print] Print running: "${jobName}", fetching slice info via FTPS...`);
            await fetchSliceInfoForPrint(printer, jobName);
        }
    } else if (ACTIVE_STATES.has(newState) && jobName && printer.sliceFetchDone && !printer.currentSliceInfo
        && sliceFetchRetryDue(printer.lastSliceFetch, Date.now())) {
        // The first fetch found nothing, see sliceFetchRetryDue() for why that
        // is not the last word. Driven by the reports, which arrive every few
        // seconds, so the wait is what the constant says plus one report.
        console.log(printer.name, printer.logFilePath,
            `[Print] Looking for the sliced file again, attempt ${(printer.lastSliceFetch.attempt || 1) + 1} of ${SLICE_FETCH_ATTEMPTS}...`);
        await fetchSliceInfoForPrint(printer, jobName);
    }

    // Followed for as long as the print is active rather than read once, and
    // never on a terminal report, which may already describe the next job.
    // Measured on a P2S: the value settles a moment after the print starts, and
    // one report carried the slot the job was configured with before the user
    // changed it. Reading only the first would have booked onto that one. A
    // change once the first layer is printing is an AMS refill, see
    // refillsBetween(): the last value names the slot the print finished
    // from, and the refill remembers the one before it.
    if (ACTIVE_STATES.has(newState)) {
        let slotsChanged = rememberPrintSlotSpools(printer);
        const reported = decodePrintMapping(print.mapping);
        if (reported && JSON.stringify(reported) !== JSON.stringify(printer.currentMapping)) {
            for (const refill of refillsBetween(printer.currentMapping, reported, layerNum)) {
                const spool = printer.printSlotSpools?.[refill.from] ?? null;
                (printer.refills ||= []).push({ ...refill, layer: layerNum });
                // The mapping was restored from before a restart and the
                // printer moved on while nobody was listening, so the switch
                // happened somewhere in the layers that went unseen
                const unseen = printer.mappingRestored
                    ? `, while the service was not running: the switch is taken as this layer, the first one seen since, so ${refill.from} carries the layers in between`
                    : "";
                console.log(printer.name, printer.logFilePath,
                    `[Print] Filament ${refill.index + 1} moved from ${refill.from} to ${refill.to} at layer ${layerNum}, an AMS refill${unseen}: layers 1 to ${layerNum - 1} go to ${spool ? `spool ${spool.id}` : `${refill.from}, which held no known spool`}`);
            }
            printer.currentMapping = reported;
            slotsChanged = true;
            console.log(printer.name, printer.logFilePath, `[Print] The printer reports its slots as ${JSON.stringify(reported)}`);
        }
        printer.mappingRestored = false;
        if (slotsChanged) {
            rememberPrintSlots(printer.id, { mapping: printer.currentMapping, refills: printer.refills, slotSpools: printer.printSlotSpools });
        }
    }

    // Update tracked state
    printer.currentGcodeState = newState;

    // Book consumption on transition into a terminal state
    if (TERMINAL_STATES.has(newState) && ACTIVE_STATES.has(prevState) && !printer.consumptionBooked) {
        printer.consumptionBooked = true;
        forgetPrintStart(printer.id);

        // Built before the booking so that the run is summarised even when
        // there is nothing to book. A print whose slice info never arrived is
        // exactly the case somebody opens the summary for.
        const summary = {
            state:       newState,
            jobName:     printer.currentJobName || null,
            modelTitle:  printer.currentSliceInfo?.modelTitle ?? null,
            endedAt:     Date.now(),
            startedAt:   printer.printStartedAt,
            durationMs:  printer.printStartedAt ? Date.now() - printer.printStartedAt : null,
            layerNum,
            totalLayers: printer.currentSliceInfo?.totalLayers ?? null,
            printError:  errorNow ?? printer.lastPrintError ?? null,
            printErrorDetails: errorNow ? printErrorDetails(print) : (printer.lastPrintErrorDetails ?? null),
            rows:        [],
            note:        null,
        };
        printer.lastPrintSummary = summary;
        armPrintResultReset(printer);

        if (!printer.currentSliceInfo) {
            summary.note = "No slice info was cached for this print, so nothing could be booked.";
            console.log(printer.name, printer.logFilePath, `[Print] ${newState}, no slice info cached, skipping consumption tracking`);
            return;
        }

        // Which of the two sums ran, and on what. A partial booking that looks
        // wrong is nearly always the layer this was handed, and the ordinary log
        // prints the result without ever naming the input.
        debug("print", printer.name, printer.logFilePath, newState === "FINISH"
            ? `[Print] FINISH, taking the full consumption of ${humanLayers(0, printer.currentSliceInfo.totalLayers).total} layers`
            : `[Print] ${newState}, taking the consumption up to layer ${layerNum} of ${humanLayers(0, printer.currentSliceInfo.totalLayers).total}`);

        const consumption = newState === "FINISH"
            ? calcFullConsumption(printer.currentSliceInfo)
            : calcPartialConsumption(printer.currentSliceInfo, completedLayerIndex(layerNum));

        const outcome = await bookConsumption(printer, consumption, newState);
        summary.rows = outcome.rows;
        summary.note = outcome.note;
    }
}

/**
 * The printer's own complaint about the print, as text, or null when it is
 * happy.
 *
 * A P2S reports `print_error` as a number and `mc_print_error_code` as the same
 * value in a string, both 0 on a clean run. `fail_reason` is a string that is
 * "0" rather than empty when nothing failed, which is why it is compared
 * against both.
 *
 * The number is kept and the catalogue's sentence is put behind it, see
 * `printerrors.js`: "Printer error 50348044: The task was canceled." A code
 * the catalogue does not know stays the bare number, which is honest where a
 * guessed description would not be, and the number is what a bug report and
 * Bambu's own lookup go by either way.
 *
 * `fail_reason` carries the same code as `print_error` when both are set,
 * measured on a P2S, so the two are said once rather than twice.
 *
 * @param {object} print - the `print` object from the MQTT report
 * @returns {string|null} the error text, or null when there is none
 */
export function printErrorText(print) {
    const code = Number(print?.print_error ?? print?.mc_print_error_code ?? 0);
    const reason = print?.fail_reason;
    const failed = reason && reason !== "0" && reason !== 0;

    const describe = (label, value) => {
        const sentence = describePrintError(value);
        return sentence ? `${label} ${value}: ${sentence}` : `${label} ${value}`;
    };

    if (!code && !failed) return null;
    if (code && failed && String(reason) !== String(code)) {
        return `${describe("Printer error", code)}, ${describe("fail reason", reason)}`;
    }
    if (code) return describe("Printer error", code);
    return describe("Fail reason", reason);
}

/**
 * The same error as `printErrorText()`, as parts a client can put into words
 * of its own: which field said it, the number, and the catalogue's sentence in
 * every shipped language. The Web UI builds its line from this in the viewer's
 * language; `printError` next to it stays the English line of the log.
 *
 * @param {object} print - the `print` object from the MQTT report
 * @returns {{kind: "printer"|"fail", code: string, texts: object|null}[]|null}
 */
export function printErrorDetails(print) {
    const code = Number(print?.print_error ?? print?.mc_print_error_code ?? 0);
    const reason = print?.fail_reason;
    const failed = reason && reason !== "0" && reason !== 0;
    const part = (kind, value) => ({ kind, code: String(value), texts: describePrintErrorInAll(value) });

    if (!code && !failed) return null;
    if (code && failed && String(reason) !== String(code)) return [part("printer", code), part("fail", reason)];
    if (code) return [part("printer", code)];
    return [part("fail", reason)];
}

/**
 * Starts the countdown after which the finished print leaves the dashboard.
 *
 * `PRINT_RESET_MINUTES` of 0 means the result stays until somebody clears it,
 * so no deadline is set and the Web UI offers the button without a countdown.
 *
 * Nothing is scheduled with a timer: the deadline is a timestamp the dashboard
 * and the API compare against the clock. A timer would have to be cancelled on
 * every printer removal and would fire into a process that may have restarted,
 * while a timestamp survives being read from anywhere and needs no cleanup.
 *
 * @param {object} printer - the runtime printer
 */
function armPrintResultReset(printer) {
    const minutes = Number(settings.PRINT_RESET_MINUTES);
    printer.printResetAt = minutes > 0 ? Date.now() + minutes * 60_000 : null;
}

/**
 * Whether the finished print should no longer be shown on the card.
 *
 * True once it has been cleared by hand, or once its deadline has passed. The
 * deadline is evaluated on read rather than on a timer, so this is the single
 * place that decides it and every reader agrees.
 *
 * @param {object} printer - the runtime printer
 * @returns {boolean} whether the result is cleared
 */
export function printResultCleared(printer) {
    if (printer.printResultDismissed) return true;

    // A terminal state this process never witnessed is not a result. The
    // printer repeats its last gcode_state for as long as it sits on it, so a
    // service started after a print ended is handed a FINISH it knows nothing
    // else about: no job name, no summary, no booking. The card then put a
    // green FINISH badge next to "No active print", which is two answers to
    // the same question. Nothing to show means there is nothing to keep.
    //
    // Guarded on the state, because an active print is not a result and must
    // never be cleared: a job whose name the printer left empty would
    // otherwise blank the card while it is printing.
    if (!ACTIVE_STATES.has(printer.currentGcodeState)
        && !printer.currentJobName
        && !printer.lastPrintSummary) {
        return true;
    }

    return printer.printResetAt != null && Date.now() >= printer.printResetAt;
}

/**
 * The external spool holder as one more AMS unit, or nothing.
 *
 * The printer reports the holder outside the AMS block, as `print.vir_slot`, an
 * array whose entry is field for field a chipless AMS tray: an all zero
 * `tray_uuid`, empty `tray_sub_brands`, `tray_weight` "0" and `remain` 0. That
 * is why it is handed to the same pipeline as a unit of its own rather than
 * given a branch: `processSlot` then classifies it as the 3rd party spool it
 * is, and it becomes assignable like any other.
 *
 * `vt_tray` is the same thing on older firmware, a single object rather than an
 * array. The P2S measured here no longer sends the key at all.
 *
 * This reads one report and nothing else. Whether a report that does not
 * mention the holder means "nothing there" or "nothing changed" is not this
 * function's to decide, see `rememberedExternalSpoolUnits()`.
 *
 * Only emitted for a holder that actually carries something. An empty holder is
 * still reported, and reported in full: measured on a P2S with nothing on it,
 * every field is there and only the three that name a material are empty. The
 * whole record would otherwise reach `slotIsOccupied()` carrying its
 * temperature fields and read as a loaded spool nobody can identify.
 *
 * The material is the test and the colour is not. An empty holder reports
 * `cols` as `["FFFFFF00"]`, fully transparent, which is the printer saying
 * there is nothing rather than that the filament is clear. Reading that as a
 * colour put an invisible swatch on a row for a spool that was not there.
 *
 * @param {object} print - `data.print` from an MQTT report
 * @returns {object[]} one unit per loaded holder, shaped like entries of `print.ams.ams`
 */
export function externalSpoolUnits(print) {
    const reported = Array.isArray(print?.vir_slot)
        ? print.vir_slot
        : (print?.vt_tray ? [print.vt_tray] : []);

    // One unit per holder, not one unit carrying every holder as a tray: a
    // dual nozzle printer reports two entries, 254 and 255, and they are two
    // slots with two labels and two assignments. An entry with an id this
    // service does not know is dropped rather than labelled "Z": nothing
    // observed reports one, and a third holder would need a label of its own
    // before it could be assigned anything.
    const holders = reported
        .filter(tray => tray && externalSlotLabel(tray.id) !== null)
        .sort((a, b) => Number(b.id) - Number(a.id));

    // The id says which holder only where there are two. A printer with one
    // holder reports it under either number depending on the model: 255 on a
    // P2S and an X1C, 254 on an A1, a P1P and a P1S, all in
    // test/fixtures/reports and in the P1S log of issue 131. So one reported
    // holder is "External" whatever its id, and only a second reported entry
    // takes the second label. Reported, not loaded: a dual nozzle printer
    // lists both entries whether or not a spool sits on them, so an empty
    // first holder does not move the second one's label.
    const unitIds = holders.length >= 2
        ? holders.map(tray => String(tray.id))
        : holders.map(() => String(EXTERNAL_SPOOL_ID));

    return holders
        .map((tray, index) => ({ id: unitIds[index], tray: [tray] }))
        .filter(unit => unit.tray[0].tray_type || unit.tray[0].tray_info_idx);
}

/**
 * The external spool holder as the printer last described it.
 *
 * A P2S puts `vir_slot` into every report that carries AMS data, measured in
 * all 24 of them, so reading the report at hand was enough there. A P1S does
 * not: it sends delta reports that carry the AMS block and leave `vt_tray` out.
 * Read on their own, those said the holder was empty, so the External slot was
 * released and its location cleared, and the next full report created it again.
 * Issue #131 is that, a spool that showed and vanished every few reports.
 *
 * So a report that does not mention the holder at all leaves what the last one
 * said in place, and a report that carries the key replaces it, an empty holder
 * included. "Nothing changed" and "nothing there" look the same in the AMS
 * data, and only the printer's own key tells them apart.
 *
 * The memory starts empty on every connection: what an earlier connection
 * remembered may describe a holder that was emptied while nobody was listening,
 * and the first report that names the holder fills it again. A stale memory
 * is therefore bounded by one full report, not by the process lifetime.
 *
 * Confirmed by the raw trace of #131, a P1S with a first generation AMS: 167
 * delta reports carried the AMS block and no `vt_tray` at all, 27 full reports
 * all carried it with the spool on it, and not one report carried the key
 * with nothing behind it. A full report and one of the deltas are in
 * test/fixtures/reports/p1s.json.
 *
 * @param {object} printer - the printer runtime object, which carries the memory
 * @param {object} print - `data.print` from an MQTT report
 * @returns {object[]} zero or one unit, shaped like an entry of `print.ams.ams`
 */
export function rememberedExternalSpoolUnits(printer, print) {
    const mentioned = print != null && ("vir_slot" in print || "vt_tray" in print);
    if (mentioned) printer.lastExternalUnits = externalSpoolUnits(print);
    return printer.lastExternalUnits ?? [];
}

/**
 * Archives a spool that has just run empty, when the setting asks for it.
 *
 * Runs on the two places a weight is written: the consumption booking of a
 * finished print and the legacy mode weight patch. Both already know what the
 * spool holds afterwards, so nothing is read back and no AMS percentage is
 * consulted, see `spoolIsEmpty()`.
 *
 * The location is cleared first. An archived spool drops out of
 * `getSpoolmanSpools()`, so no later AMS update sees it in a slot and nothing
 * would ever release the location it was given while it was in one.
 *
 * Failures are logged and swallowed: the weight it archives is already written,
 * and losing the archive flag must not lose the booking.
 *
 * @param {object} printer - the runtime printer, for the log
 * @param {object|null} spool - the Spoolman record as it is after the write
 * @returns {Promise<boolean>} whether the spool was archived
 */
async function archiveWhenEmpty(printer, spool) {
    if (!settings.ARCHIVE_EMPTY_SPOOLS) return false;
    if (!spool?.id || spool.archived) return false;
    if (!spoolIsEmpty(spool.remaining_weight, settings.EMPTY_SPOOL_THRESHOLD)) return false;

    try {
        await releaseSlotLocation(printer, spool);
        await setSpoolArchived(spool.id, true);
        spool.archived = true;
        console.log(printer.name, printer.logFilePath, `    Spool-ID ${spool.id} is empty (${Math.round(spool.remaining_weight)}g left), archived in Spoolman`);
        return true;
    } catch (err) {
        console.error(printer.name, printer.logFilePath, `    Failed to archive empty Spool-ID ${spool.id}:`, err.message);
        return false;
    }
}

/**
 * Remembers which spool sits in each slot while a print runs, for a refill to
 * book the layers before it on.
 *
 * By the time the printer moves a filament to its backup slot, the slot it
 * ran out of reports empty: on the P2S trace of 2026-10-07 from layer 5,
 * while the tube went on feeding until layer 88. The AMS no longer says which
 * spool that was, so the last one seen there during the print is kept. Only a
 * slot with a bookable spool overwrites its entry, an emptied one leaves it.
 *
 * @param {object} printer - the runtime printer
 */
function rememberPrintSlotSpools(printer) {
    let changed = false;
    for (const uiSpool of printer.spoolData || []) {
        if (!uiSpool.connectedViaMapping && !uiSpool.connectedViaTag) continue;
        const candidate = consumptionCandidate(uiSpool);
        if (!candidate.id) continue;
        const spools = printer.printSlotSpools ||= {};
        if (spools[candidate.amsId]?.id !== candidate.id) changed = true;
        // The part of the Spoolman record the dashboard names the spool of an
        // emptied slot by, see emptiedPrintSlots(), kept small because it is
        // written to printstate.json as well
        spools[candidate.amsId] = { ...candidate, spool: spoolSnapshot(uiSpool.existingSpool) };
    }
    return changed;
}

/**
 * What of a Spoolman spool record is kept for a slot of the running print.
 *
 * @param {object|null} sp - the spool as Spoolman returned it
 * @returns {object|null}
 */
function spoolSnapshot(sp) {
    if (!sp) return null;
    const f = sp.filament || {};
    return {
        id: sp.id,
        remaining_weight: sp.remaining_weight ?? null,
        initial_weight: sp.initial_weight ?? null,
        filament: {
            name: f.name ?? null,
            material: f.material ?? null,
            color_hex: f.color_hex ?? null,
            multi_color_hexes: f.multi_color_hexes ?? null,
            vendor: f.vendor?.name ? { name: f.vendor.name } : null,
        },
    };
}

/**
 * Takes back the slots of a print the service finds already running after a
 * restart, see `recallPrintSlots()` in printstate.js.
 *
 * The mapping is restored so the first report can be compared with it: a
 * printer that moved a filament to its backup slot while the service was down
 * reports the new slot, and that is still a refill.
 *
 * @param {object} printer - the runtime printer
 * @param {string|null} jobName - `subtask_name` of the job
 */
function restorePrintSlots(printer, jobName) {
    const slots = recallPrintSlots(printer.id, jobName);
    if (!slots) return;
    printer.printSlotSpools = slots.slotSpools;
    printer.refills = slots.refills;
    if (slots.mapping && !printer.currentMapping) {
        printer.currentMapping = slots.mapping;
        printer.mappingRestored = true;
    }
    const spools = Object.values(slots.slotSpools).map(c => `${c.amsId} spool ${c.id}`);
    console.log(printer.name, printer.logFilePath,
        `[Print] Slots taken back from before the restart: ${JSON.stringify(slots.mapping)}, ${slots.refills.length} refill(s), ${spools.length ? spools.join(", ") : "no spools"}`);
}

/**
 * The spools a print ran from that the AMS no longer reports, so the booking
 * can still reach them.
 *
 * A spool that runs out reports its slot empty long before the print stops
 * taking filament from it: on the P2S the AMS sensor sits a tube's length
 * before the nozzle, and with a long tube that was 82 layers. A print that
 * ends in that time, or one that refilled and moved on, has its last layers
 * from a slot with no spool in it, and without this the colour stages of
 * matchConsumption() found the backup spool instead, which holds the same
 * filament and had printed none of it.
 *
 * Only slots the printer named for this print qualify, through its mapping or
 * as the slot a refill left. A slot emptied by hand that the print never used
 * stays out, so its spool cannot be found by colour for some other filament.
 * A slot that holds a spool again is answered by that spool.
 *
 * @param {object} printer - the runtime printer
 * @param {object[]} live - the candidates from the slots as the AMS reports them now
 * @returns {object[]} the remembered candidates to add
 */
export function rememberedSlotCandidates(printer, live) {
    const named = new Set([
        ...(printer.currentMapping || []),
        ...(printer.refills || []).map(refill => refill.from),
    ].filter(Boolean));
    return Object.values(printer.printSlotSpools || {})
        .filter(candidate => named.has(candidate.amsId) && !live.some(c => c.amsId === candidate.amsId));
}

/**
 * The slots of the running print that ran empty while it went on, with the
 * spool each held, for the dashboard.
 *
 * Exactly the slots `rememberedSlotCandidates()` adds, so the dashboard warns
 * about the same slots the booking reaches past the AMS for. The refill a
 * slot was left by, when there was one, says where the print went on from.
 *
 * @param {object} printer - the runtime printer
 * @param {object[]} live - the candidates from the slots as the AMS reports them now
 * @returns {{amsId: string, spool: object|null, refill: {to: string, layer: number}|null}[]}
 */
export function emptiedPrintSlots(printer, live) {
    return rememberedSlotCandidates(printer, live).map(candidate => {
        const refill = (printer.refills || []).find(r => r.from === candidate.amsId);
        const sp = candidate.spool;
        return {
            amsId: candidate.amsId,
            spool: sp ? {
                id: sp.id,
                name: sp.filament?.name ?? null,
                vendor: sp.filament?.vendor?.name ?? null,
                material: sp.filament?.material ?? null,
                colorHex: sp.filament?.color_hex ?? null,
                multiColorHexes: sp.filament?.multi_color_hexes ?? null,
                remainingWeight: sp.remaining_weight ?? null,
                initialWeight: sp.initial_weight ?? null,
            } : { id: candidate.id },
            refill: refill ? { to: refill.to, layer: refill.layer } : null,
        };
    });
}

/**
 * The sentence a summary row carries when its filament was split at a refill.
 *
 * @param {object} info - one entry of a consumption map, after splitAtRefills()
 * @returns {string|null}
 */
export function refillNote(info) {
    const r = info.refill;
    if (!r) return null;
    // The layer the switch was reported in is booked on the new slot, see
    // splitAtRefills(), so the old one is named up to the layer before it
    return r.before
        ? `Printed from ${r.from} through layer ${r.layer - 1}. The AMS ran out during layer ${r.layer} and switched to ${r.to}.`
        : `Printed from ${r.to} from layer ${r.layer} on, after the AMS switched over from ${r.from}.`;
}

/**
 * Books the consumed grams in Spoolman for each filament of a finished print.
 *
 * A slot is only booked when we actually know which physical spool sits in it:
 * either through the Spoolman extra.tag field (= the slot's tray_uuid, Bambu Lab
 * spools only) or through a manual assignment made in the UI. Filament
 * candidates that merely match by type are never touched, which is why only
 * those slots become candidates here.
 *
 * Which filament belongs to which of them is `matchConsumption()` in ams.js,
 * shared with the dashboard route so both answer the question the same way.
 *
 * Returns what it did rather than only logging it, because the same account has
 * to reach the summary dialog in the Web UI. The rows carry the outcome of
 * every filament of the print, the skipped ones included: a filament that was
 * not booked is the thing a user opens that dialog to understand.
 *
 * @param {object} printer - the runtime printer
 * @param {object} consumption - a map from calcFullConsumption or the partial one
 * @param {string} state - the terminal state that triggered this, for the log
 * @returns {Promise<{rows: object[], note: string|null}>} one row per filament,
 *   and a note when nothing could be booked at all
 */
async function bookConsumption(printer, consumption, state) {
    if (!printer.spoolData?.length) {
        console.log(printer.name, printer.logFilePath, "[Print] No spool data available for consumption booking");
        return { rows: [], note: "No spool data was available, so nothing could be booked." };
    }

    // What the printer said its slots were beats working them out from the
    // slicer's list order, which only holds while the project is synchronised
    // with the printer and cannot tell when it is not. Without it, the position
    // in the list is all there is.
    const reported = printer.currentMapping;
    const slots = reported ?? orderedAmsSlots(loadedSlotIds(printer.spoolData));

    // Which of the two sources named the slots, and what it named. This is the
    // decision behind every booking landing where it did: the printer's own
    // mapping is followed as it stands, the slicer's list order is only an
    // estimate and has to be confirmed against the slot.
    debug("print", printer.name, printer.logFilePath, reported
        ? `[Print] Slots as the printer or Bambu Studio named them: ${JSON.stringify(slots)}`
        : `[Print] Nobody named the slots, estimating from the slicer's list order: ${JSON.stringify(slots)}`);

    resolveSliceSlots(consumption, slots, { reportedByPrinter: !!reported });
    consumption = splitAtRefills(consumption, printer.currentSliceInfo, printer.refills);

    // Logged from here rather than from the caller, which ran before the slots
    // were named and therefore printed every `amsId` as null, which is the one
    // field somebody reading this line is looking for.
    console.log(printer.name, printer.logFilePath, `[Print] ${state}, booking filament consumption:`, JSON.stringify(consumption));

    // Only a slot whose physical spool is known can carry a booking, so nothing
    // else is offered to the matcher.
    const candidates = printer.spoolData
        .filter(uiSpool => uiSpool.connectedViaMapping || uiSpool.connectedViaTag)
        .map(consumptionCandidate)
        .filter(candidate => candidate.id);
    candidates.push(...rememberedSlotCandidates(printer, candidates));

    // The slots a booking could possibly land on, and why each one qualified.
    // A filament that goes unbooked is usually a slot that never got into this
    // list, and the ordinary log says only that nothing matched.
    debug("print", printer.name, printer.logFilePath,
        `[Print] ${candidates.length} slot(s) may carry a booking: ${JSON.stringify(
            candidates.map(c => `${c.amsId} spool ${c.id}${c.mapped ? " (assigned)" : " (tag)"}`))}`);
    trace("print", printer.name, printer.logFilePath,
        `[Print] Booking candidates in full: ${JSON.stringify(candidates)}`);

    if (!candidates.length) {
        console.log(printer.name, printer.logFilePath, "[Print] No connected or assigned spools, nothing to book");
        return {
            rows: Object.values(consumption).map(info => summaryRow(printer, info, "skipped", unbookedReason(info))),
            note: "No slot held a spool this service could identify, so nothing was booked.",
        };
    }

    const lastUsed = new Date().toISOString();
    const entries = Object.values(consumption);
    const matched = matchConsumption(entries, candidates);
    const rows = [];

    for (const info of entries) {
        const { tray_info_idx: idx, color, type, grams } = info;
        if (grams <= 0) {
            // Zero gram filaments are skipped rather than written as zero, and
            // the summary says so instead of leaving the filament out: a plate
            // that used none of a loaded colour is a result, not an omission.
            rows.push(summaryRow(printer, info, "unused",
                "The sliced file lists this filament, but the plate used none of it."));
            continue;
        }

        const matches = matched.get(info) ?? [];

        // What the one matching decision answered, per filament. Reading this
        // next to the candidate list above is what turns "nothing was booked"
        // into which stage of matchConsumption() let the filament through.
        debug("print", printer.name, printer.logFilePath,
            `[Print] ${idx} ${type} (${color}), ${grams}g from ${info.amsId ?? "no slot"}: ${
                matches.length ? `matched ${matches.map(m => `spool ${m.id} in ${m.amsId}`).join(", ")}` : "no match"}`);

        if (!matches.length) {
            console.log(printer.name, printer.logFilePath, `[Print] No connected or assigned Spoolman spool for ${idx} ${type} (${color}), skipping ${grams}g (assign the spool in the Web UI to track it)`);
            rows.push(summaryRow(printer, info, "skipped", unbookedReason(info)));
            continue;
        }

        if (matches.length > 1) {
            // console.error rather than console.warn: logger.js overrides log,
            // error and debug, and a warn call lands on raw stdout with the two
            // routing arguments printed as text, so the one line that admits to
            // a guess never reached the log file it belongs in.
            //
            // Splitting is not on offer here, whatever is assigned. Two spools
            // reach this point only when the sliced file could not separate
            // them either, and their grams were added together before anything
            // looked at the AMS. Assigning one of them decides which spool
            // carries the total instead of leaving it to the slot order.
            console.error(printer.name, printer.logFilePath, `[Print] ${matches.length} spools are indistinguishable for ${idx} ${type} (${color}), booking the full ${grams}g to spool ${matches[0].id} (${matches[0].amsId}); assign one of them in the Web UI to choose which spool carries it`);
        }

        const { id: spoolId } = matches[0];
        const ambiguous = matches.length > 1
            ? `${matches.length} spools were indistinguishable; the full amount went to this one.`
            : null;

        try {
            const booked = await useSpoolWeight(spoolId, grams, lastUsed);
            console.log(printer.name, printer.logFilePath, `[Print] Booked ${grams}g for spool ${spoolId} (${matches[0].amsId}, ${idx} ${type} ${color}${matches[0].mapped ? ", manually assigned" : ""})`);
            rows.push({
                ...summaryRow(printer, info, ambiguous ? "ambiguous" : "booked", ambiguous ?? refillNote(info)),
                spoolId,
                // The three fields the dashboard names a filament by. Taken
                // from the record the booking wrote, so the summary keeps
                // saying what was booked even after the spool is edited or
                // taken out of the slot.
                vendor: booked?.filament?.vendor?.name ?? null,
                material: booked?.filament?.material ?? null,
                spoolName: booked?.filament?.name ?? null,
                mapped: !!matches[0].mapped,
                remainingWeight: booked?.remaining_weight ?? null,
            });
            await archiveWhenEmpty(printer, booked);
        } catch (err) {
            console.error(printer.name, printer.logFilePath, `[Print] Failed to book consumption for spool ${spoolId}: ${err.message}`);
            rows.push({
                ...summaryRow(printer, info, "failed", `Spoolman refused the booking: ${err.message}`),
                spoolId,
                mapped: !!matches[0].mapped,
            });
        }
    }

    return { rows, note: null };
}

/**
 * Why a filament of the sliced file carries no booking.
 *
 * Both halves are worth saying and they are different failures. A filament
 * without a slot was in the plate and nothing on the printer ran it, which is
 * the case the dashboard lists as required but not loaded. A filament with a
 * slot did run, and the spool in that slot is simply not linked to a Spoolman
 * record, which is the one a user can fix.
 *
 * The sliced file is named in both, because everything in this table came from
 * it and a row that only says "not booked" reads like the service lost it.
 *
 * @param {object} info - one entry of a consumption map, after resolveSliceSlots
 * @returns {string} the reason, as a sentence
 */
export function unbookedReason(info) {
    if (!info.amsId) {
        return "The sliced file lists this filament, but no slot of the printer carried it during this print.";
    }
    return `The sliced file lists this filament and ${info.amsId} printed it, but no Spoolman spool is connected by tag or assigned to that slot, so nothing could be booked. Assign it in the Web UI to track it.`;
}

/**
 * The Spoolman record sitting in the slot a filament ran from, when the slot is
 * the printer's own answer rather than an estimate.
 *
 * `amsIdFromPrinter` is the whole condition. Where it is set, the slot came out
 * of `print.mapping` or of the `project_file` command Bambu Studio sent (see
 * `notePrintCommand()`), so the sliced file and the printer name the same slot
 * and the spool in it is the one that really printed this filament. Where it is
 * not, the slot is `orderedAmsSlots()` guessing from the slicer's list order,
 * which is exactly the guess `matchConsumption()` refuses to book on without
 * confirming, and naming a spool off it would put a filament on a slot nobody
 * established it ran from.
 *
 * Read for the naming only. A row that was not booked keeps its empty spool
 * column, because that column says what carried the booking and this spool
 * carried none.
 *
 * @param {object} printer - the runtime printer
 * @param {object} info - one entry of a consumption map, after resolveSliceSlots
 * @returns {object|null} the Spoolman filament record, or null
 */
export function slotFilament(printer, info) {
    if (!info.amsId || !info.amsIdFromPrinter) return null;

    const uiSpool = (printer.spoolData || []).find(spool => spool.amsId === info.amsId);
    return uiSpool?.existingSpool?.filament ?? null;
}

/**
 * One filament of a print as the summary dialog shows it.
 *
 * `amsId` is set by resolveSliceSlots(), which runs before anything is booked,
 * so the slot is named even for a filament that was never booked at all.
 *
 * @param {object} printer - the runtime printer, for the slot lookup
 * @param {object} info - one entry of a consumption map
 * @param {string} status - booked, ambiguous, skipped, unused or failed
 * @param {string|null} note - why, for everything that is not a plain booking
 * @returns {object} the row
 */
function summaryRow(printer, info, status, note = null) {
    // What sits in the slot, for a row the booking will not name itself. A
    // booked row overwrites these three from the record the booking wrote,
    // which is the same filament by a stricter route.
    const filament = slotFilament(printer, info);

    return {
        amsId: info.amsId ?? null,
        trayInfoIdx: info.tray_info_idx ?? null,
        type: info.type ?? null,
        color: info.color ?? null,
        // The whole colour set when the slice named one, so a multi colour
        // filament is drawn the way it is everywhere else in this UI rather
        // than as its first colour alone.
        colors: info.colors ?? null,
        grams: info.grams ?? 0,
        status,
        note,
        // Set when the filament was split at an AMS refill, so the dialog can
        // mark the row, see splitAtRefills() in gcode.js
        refill: info.refill ?? null,
        spoolId: null,
        // Null where neither the booking nor a printer named slot could say
        // what the filament is. The dialog then falls back to what the sliced
        // file knew, which is a material and a hex code.
        vendor: filament?.vendor?.name ?? null,
        material: filament?.material ?? null,
        spoolName: filament?.name ?? null,
    };
}

/**
 * Handles one MQTT report from a printer.
 *
 * Three things happen here, in order: the reception timestamp is refreshed and
 * throttled out over SSE, print state changes are forwarded to the consumption
 * tracking (G-code mode only), and AMS data is processed against Spoolman.
 *
 * The AMS part is rate limited by the printer's update interval and skipped
 * entirely when neither the Spoolman spools nor the tray data actually changed,
 * because the printer sends a full report every few seconds. Reentry is blocked
 * through printer.blockMqttUpdates, so a report arriving while the previous one
 * is still being processed is dropped rather than queued.
 *
 * @param {object} printer - the printer runtime object
 * @param {string} topic - the MQTT topic, unused
 * @param {Buffer|string} message - the raw report payload
 */
async function handleMqttMessage(printer, topic, message) {
    if (printer.blockMqttUpdates || state.spoolmanStatus === "Disconnected") return;
    printer.blockMqttUpdates = true;

    if (printer.monitoringEnabled) {
        try {
            printer.mqttStatus = "Connected";
            const data = JSON.parse(message);
            debug("mqtt", printer.name, printer.logFilePath, `Processing MQTT message for Printer: ${printer.id}`);

            // Reception freshness: every received message proves the connection is
            // live, regardless of the AMS processing interval below. Update the
            // timestamp in-memory always, but throttle the SSE broadcast to ~1/s.
            printer.lastMqttUpdate = new Date();
            if (printer.lastMqttUpdate.getTime() - (printer.lastMqttBroadcast || 0) > 1000) {
                printer.lastMqttBroadcast = printer.lastMqttUpdate.getTime();
                broadcastSSE({
                    type: "status",
                    printer: printer.id,
                    lastMqttUpdate: printer.lastMqttUpdate.toISOString(),
                    lastMqttAmsUpdate: printer.lastMqttAmsUpdate
                        ? printer.lastMqttAmsUpdate.toISOString()
                        : null,
                });
            }

            noteStorage(printer, data?.print);
            noteActiveSlot(printer, data?.print);

            // Legacy mode derives the weight from the RFID remain percentage, so
            // the G-code tracking must stay out of it entirely. Running both
            // would download the sliced file on every print and book consumption
            // that the next AMS update then overwrites again.
            if (!legacyMode()) {
                const report = data?.print?.gcode_state ? data.print : deltaAsReport(printer, data?.print);
                if (report) await handlePrintStateChange(printer, report);
            }

            debug("mqtt", printer.name, printer.logFilePath, "Check if message contains AMS Data");

            if (data?.print?.ams?.ams) {
                const currentTime = new Date();
                broadcastAmsEnvironment(printer, data.print.ams.ams, currentTime);
                debug("mqtt", printer.name, printer.logFilePath, "Check next Update Interval");

                const intervalElapsed = currentTime.getTime() - printer.lastUpdateTime.getTime() > printer.update_interval;
                if (intervalElapsed || printer.first_run) {
                    const wasFirstRun = printer.first_run;
                    printer.first_run = false;
                    // An incomplete report, which the firmware signals by sending
                    // the environment fields as empty strings. They used to be
                    // read off the AMS block, where a P2S never puts them: the
                    // check compared undefined against "" and passed every time.
                    // They sit on the units, and a unit that reports none at all
                    // is an AMS Lite rather than an incomplete report, so a
                    // missing field still counts as valid.
                    const isValidAmsData = data.print.ams.ams.every(unit =>
                        unit?.humidity !== "" && unit?.temp !== ""
                    );

                    debug("spoolman", printer.name, printer.logFilePath, "Fetch Data from Spoolman");
                    let spools = await getSpoolmanSpools();

                    if (state.spoolmanStatus !== "Disconnected") {
                        trace("spoolman", printer.name, printer.logFilePath, "Registered Spools:");
                        trace("spoolman", printer.name, printer.logFilePath, JSON.stringify(spools));

                        // Seed the baseline on the very first pass only. Testing for an
                        // empty array here re-seeded it on every pass for as long as
                        // Spoolman held no spools, so the first spool ever created was
                        // compared against itself and never registered as a change,
                        // exactly what happens on a fresh Spoolman install.
                        if (state.lastSpoolData === null) state.lastSpoolData = spools;

                        let externalFilaments = await getSpoolmanExternalFilaments();
                        let internalFilaments = await getSpoolmanInternalFilaments();
                        // Only fetched when the setting can produce archived
                        // spools in the first place, so an install that does not
                        // archive pays nothing for the guard.
                        let archivedSpools = settings.ARCHIVE_EMPTY_SPOOLS ? await getArchivedSpoolmanSpools() : [];

                        const spoolsChanged = await haveSpoolDataChanged(spools, state.lastSpoolData);
                        // Legacy mode leaves the holder out. Its weight comes
                        // from the RFID remain percentage and the holder has no
                        // chip, so there would be nothing to write, which is the
                        // same reason a 3rd party slot is read-only there.
                        const externalUnits = legacyMode() ? [] : rememberedExternalSpoolUnits(printer, data.print);
                        const processedAmsData = processData([...data.print.ams.ams, ...externalUnits]);
                        const newTrayData = extractComparableTrayData(processedAmsData);
                        const lastTrayData = extractComparableTrayData(printer.lastAmsData || []);
                        const trayDataChanged = hasTrayDataChanged(newTrayData, lastTrayData);

                        if (isValidAmsData && (spoolsChanged || trayDataChanged)) {
                            trace("ams", printer.name, printer.logFilePath, "Loaded AMS Spools:");
                            trace("ams", printer.name, printer.logFilePath, JSON.stringify(processedAmsData));

                            const prevByAmsId = Object.fromEntries(
                                (printer.spoolData || []).map(s => [s.amsId, s])
                            );
                            printer.spoolData = [];

                            // Collected across every slot and applied below, so a
                            // spool moved between two slots is not cleared by the
                            // slot it left after the slot it entered claimed it.
                            const locationSync = createLocationSync(printer);

                            for (const ams of processedAmsData) {
                                if (!Array.isArray(ams.tray)) {
                                    debug("ams", printer.name, printer.logFilePath, "Data from Slots are not valid");
                                    continue;
                                }

                                for (const slot of ams.tray) {
                                    const mutated = await processSlot(printer, ams, slot, spools, archivedSpools, externalFilaments, internalFilaments, prevByAmsId, currentTime, locationSync);

                                    // Only refetch when this slot actually created/merged a
                                    // spool or filament in Spoolman. Otherwise the cached
                                    // lists from the top of this AMS update are still valid,
                                    // avoiding redundant HTTP calls for every slot.
                                    if (mutated) {
                                        spools = await getSpoolmanSpools();
                                        externalFilaments = await getSpoolmanExternalFilaments();
                                        internalFilaments = await getSpoolmanInternalFilaments();
                                        if (settings.ARCHIVE_EMPTY_SPOOLS) archivedSpools = await getArchivedSpoolmanSpools();
                                    }
                                }
                            }

                            releaseVanishedSlots(locationSync, prevByAmsId, printer.spoolData, spools);

                            await locationSync.flush();

                            state.lastSpoolData = spools;
                            printer.lastMqttAmsUpdate = new Date();
                            printer.lastAmsData = processedAmsData;
                            // The interval counts from the pass that ran, whatever it
                            // found. Only the "nothing changed" branch and the legacy
                            // patch used to set this, so a pass that processed a change
                            // in G-code mode left the clock alone and the very next
                            // report fetched Spoolman again for a comparison that the
                            // interval is there to space out.
                            printer.lastUpdateTime = currentTime;
                            console.log(printer.name, printer.logFilePath, "");

                            broadcastSSE({
                                type: "status",
                                printer: printer.id,
                                lastMqttUpdate: new Date().toISOString(),
                                lastMqttAmsUpdate: printer.lastMqttAmsUpdate.toISOString(),
                            });

                            if (wasFirstRun) {
                                broadcastSSE({ type: "refresh", printer: printer.id });
                            }
                        } else {
                            const UpdateIntSec = printer.update_interval / 1000;
                            const nextUpdateTime = new Date(currentTime.getTime() + printer.update_interval);
                            const nextUpdate = formatDate(nextUpdateTime);
                            console.log(printer.name, printer.logFilePath, `No new slot data or changes in Spoolman found. Processing slot data for this printer will be paused until ${nextUpdate} (${UpdateIntSec} seconds)...`);
                            printer.lastUpdateTime = new Date();
                        }

                        printer.lastMqttUpdate = new Date();
                        broadcastSSE({
                            type: "status",
                            printer: printer.id,
                            lastMqttUpdate: printer.lastMqttUpdate.toISOString(),
                            lastMqttAmsUpdate: printer.lastMqttAmsUpdate
                                ? printer.lastMqttAmsUpdate.toISOString()
                                : null,
                        });
                    } else {
                        console.error("Server", serverLogFilePath, "Spoolman is currently unreachable. A background check will automatically attempt to reconnect...");
                    }
                } else {
                    debug("mqtt", printer.name, printer.logFilePath, "Data will not be processed because of manually set interval");
                }
            } else {
                debug("mqtt", printer.name, printer.logFilePath, `No processable Data found for JSON filter data.printer.ams.ams`);
            }
        } catch (error) {
            console.error(printer.name, printer.logFilePath, `Error processing message for Printer: ${printer.id} - ${error.message}`);
        }
    }

    printer.blockMqttUpdates = false;
}

/**
 * Hands the location sync the spool a slot used to hold, so it is released
 * unless some slot of this AMS update claims it again.
 *
 * The cached record is only used for its id: its `location` is whatever
 * Spoolman said when the record was fetched, and the ownership check that
 * decides whether the location may be cleared has to read the current one.
 *
 * @param {object} locationSync - the collector for this AMS update
 * @param {string} amsId - slot label
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {object[]} spools - Spoolman spools, as fetched for this AMS update
 */
function releasePreviousSpool(locationSync, amsId, prevByAmsId, spools) {
    const prevSpoolId = prevByAmsId[amsId]?.existingSpool?.id ?? null;
    if (!prevSpoolId) return;

    const current = (spools || []).find(s => s.id === prevSpoolId);
    locationSync.release(current ?? prevByAmsId[amsId].existingSpool);
}

/**
 * Releases the spools of slots the report no longer contains at all.
 *
 * `releasePreviousSpool()` only runs from inside `processSlot()`, so it can
 * only clear a location when the slot it belonged to is still in the report. A
 * slot can also disappear outright: taking the spool off the external holder
 * makes `externalSpoolUnits()` emit no unit, and an unplugged AMS drops out of
 * `print.ams.ams` the same way. Nothing then walked that slot, nothing released
 * it, and the spool kept "Printer - External" in Spoolman forever.
 *
 * Compared against the slots this update actually built, not against the
 * report, so a slot that was skipped as invalid counts as gone as well.
 *
 * @param {object} locationSync - the collector for this AMS update
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {object[]} spoolData - the UI spools this update built
 * @param {object[]} spools - Spoolman spools, as fetched for this AMS update
 */
export function releaseVanishedSlots(locationSync, prevByAmsId, spoolData, spools) {
    const seen = new Set((spoolData || []).map(s => s.amsId));

    for (const amsId of Object.keys(prevByAmsId)) {
        if (seen.has(amsId)) continue;
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
    }
}

// How many AMS updates a slot may wait for its remain reading before a spool is
// created without one. The reading arrived between 17 and 74 seconds after the
// spool went in across every insert captured on a P2S, so at the default 15
// second interval five updates cover that with room to spare, and a spool whose
// chip never reports still ends up in Spoolman rather than being skipped in
// silence.
const MAX_REMAIN_WAITS = 5;

/**
 * Whether a slot has waited long enough to be created without a remain reading.
 *
 * Counts consecutive AMS updates in which the printer reported no percentage
 * for this slot. The count is kept per slot and reset as soon as a reading
 * arrives or a different spool shows up, so it measures this spool in this
 * slot and nothing else.
 *
 * Creating without a reading is not free: `usedWeightFromSlot()` then treats
 * the spool as brand new, which is wrong for a partly used one. Waiting is the
 * better default, giving up eventually is better than never creating the spool
 * at all.
 *
 * @param {object} printer - the printer runtime object, holding the counters
 * @param {string} amsId - the slot label
 * @param {object} slot - the normalised slot
 * @returns {boolean} true once the wait is over, so the caller stops holding back
 */
export function waitedLongEnoughForRemain(printer, amsId, slot) {
    if (!printer.remainWaits) printer.remainWaits = {};

    if (slot.remain != null) {
        delete printer.remainWaits[amsId];
        return true;
    }

    const previous = printer.remainWaits[amsId];
    const waits = previous?.uuid === slot.tray_uuid ? previous.waits + 1 : 1;
    printer.remainWaits[amsId] = { uuid: slot.tray_uuid, waits };

    return waits > MAX_REMAIN_WAITS;
}

/**
 * Classifies one AMS slot, acts on it in Spoolman, and records the result for
 * the UI.
 *
 * The branches are tried in order and the order matters: an invalid slot, then
 * a genuinely empty one, then a slot the printer could not identify (a 3rd
 * party spool, which can only be linked by a manual assignment), and finally a
 * fully identified Bambu Lab spool.
 *
 * For that last case the slot is connected to an existing tagged spool, or
 * offered for merge or creation depending on what Spoolman already holds. In
 * automatic mode the offered action is carried out right away; in manual mode
 * it is only surfaced in the UI. Legacy mode additionally patches the remaining
 * weight from the AMS remain percentage here, which G-code mode leaves to the
 * consumption booking after a print.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} ams - the AMS unit the slot belongs to
 * @param {object} slot - the normalised slot
 * @param {object[]} spools - Spoolman spools, as fetched for this AMS update
 * @param {object[]} archivedSpools - the archived spools, empty unless the
 *     archive setting is on
 * @param {object[]} externalFilaments - the SpoolmanDB catalogue
 * @param {object[]} internalFilaments - filaments in this Spoolman instance
 * @param {object} prevByAmsId - the previous UI spools, keyed by slot label
 * @param {Date} currentTime - timestamp shared across this AMS update
 * @param {object} locationSync - collects the location changes of this update,
 *   which are applied once every slot has been seen
 * @returns {Promise<boolean>} whether Spoolman was mutated, which tells the
 *   caller its cached lists are stale and have to be refetched
 */
async function processSlot(printer, ams, slot, spools, archivedSpools, externalFilaments, internalFilaments, prevByAmsId, currentTime, locationSync) {
    const amsId = convertAMSandSlot(ams.id, slot.id);
    const validSlot = Object.keys(slot).length > 6;

    // Two ways for a slot to be empty: a payload too short to carry a tray
    // record at all, and a full record whose fields are all placeholders. An
    // unidentified spool shares every placeholder field with the second one, so
    // an occupied slot must not be swallowed by it. Only `slotIsOccupied()`
    // tells the two apart.
    const emptyWithPlaceholders = (slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A")
        && (slot.tray_weight === 0 || slot.tray_weight === "0")
        && (!slot.tray_type || slot.tray_type === "")
        && !slotIsOccupied(slot);

    if (!validSlot || emptyWithPlaceholders) {
        debug("ams", printer.name, printer.logFilePath, validSlot
            ? "No Data found in Slots (empty slot with N/A values)"
            : "No Data found in Slots");
        const newUiSpool = buildEmptySpool(printer, amsId, slot);
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
        pushSlotUpdate(printer, newUiSpool, prevByAmsId);
        return false;
    }

    // Reached by anything the printer could not identify, including a slot whose
    // only sign of life is `state`, which the empty branch above no longer takes.
    if (slot.tray_uuid === "N/A" || slot.tray_sub_brands === "N/A") {
        debug("ams", printer.name, printer.logFilePath, "Slot is read-only (3rd party spool)");
        // `tray_sub_brands` used to be overwritten with the material here, so
        // the slot had a name at all. The projection now drops the "N/A"
        // placeholder on its own, and the dashboard builds the name from the
        // material anyway, so copying it produced "PLA . PLA". It also wrote
        // into the record kept as `printer.lastAmsData`, which is the baseline
        // the next report is compared against.

        // No RFID chip means no extra.tag link in Spoolman, so the only way to
        // know which spool sits here is a manual assignment made in the UI.
        // Legacy mode has no use for one: it takes the weight from the RFID
        // percentage, which a chipless spool does not report, so the slot stays
        // read-only exactly as it was before assignments existed.
        const mappedSpool = legacyMode()
            ? null
            : resolveMappedSpool(printer, amsId, slot, spools, archivedSpools)
                ?? autoAssignThirdPartySpool(printer, amsId, slot, spools);
        const newUiSpool = buildThirdPartySpool(printer, amsId, slot, mappedSpool);
        // The assignment is the only link a chipless spool has, so it is also
        // the only thing that can give it a location. Nothing did before, which
        // is why an assigned 3rd party spool never got one at all. An archived
        // spool is left without one on purpose: archiving cleared it, and no
        // later update would clear it a second time.
        if (!mappedSpool?.archived) locationSync.claim(amsId, mappedSpool);
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
        if (hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
            broadcastSlotUpdate(printer.id, newUiSpool);
            // No uuid to print, so the line says what the slot is instead: the
            // material and colour set on the printer, and the assignment that
            // decides whether consumption can be booked onto it.
            const assignment = mappedSpool ? `=> Spool-ID ${mappedSpool.id} (assigned)` : "(3rd party, not assigned)";
            console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_type || "Unknown material"} ${slot.tray_color} ${assignment}`);
        }
        printer.spoolData.push(newUiSpool);
        return false;
    }

    // Valid Bambu Lab spool
    let found = false;
    let mergeableSpool = null;
    let matchingExternalFilament = null;
    let matchingInternalFilament = null;
    let existingSpool = null;
    let option = SLOT_OPTIONS.NONE;
    let enableButton = "false";
    let error = false;
    let mutated = false;
    const automatic = settings.MODE === "automatic";

    matchingExternalFilament = findMatchingExternalFilament(slot, externalFilaments);
    matchingInternalFilament = findMatchingInternalFilament(matchingExternalFilament, internalFilaments);

    if (spools.length !== 0) {
        for (const spool of spools) {
            if (spoolTag(spool) === slot.tray_uuid) {
                trace("spoolman", printer.name, printer.logFilePath, " Connected Spool found: " + JSON.stringify(spool));
                found = true;

                // Normalize remain for comparison; slot.remain itself is left
                // untouched (raw, as received from MQTT) so it stays comparable
                // with the next message's raw value in the outer change-detection
                // (extractComparableTrayData / printer.lastAmsData). Mutating it in
                // place here used to desync that comparison for any spool whose
                // tray_weight != 1000g (e.g. 250g support spools), causing the AMS
                // data to look "changed" on every single message forever.
                const prevSlot = prevByAmsId[amsId]?.slot;
                const prevRemain = prevSlot ? correctRemainInt(prevSlot.remain, prevSlot.tray_weight, prevSlot.tray_type) : null;
                const currRemain = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
                // slotChanged includes remain (relevant for legacy weight patching);
                // meaningfulChange ignores remain (spool identity only) and gates
                // logging/location in G-code mode so remain ticks don't spam.
                const meaningfulChange = !prevSlot ||
                    slot.tray_uuid       !== prevSlot?.tray_uuid ||
                    slot.tray_info_idx   !== prevSlot?.tray_info_idx ||
                    slot.tray_color      !== prevSlot?.tray_color ||
                    slot.tray_sub_brands !== prevSlot?.tray_sub_brands ||
                    slot.tray_weight     !== prevSlot?.tray_weight;
                const slotChanged = meaningfulChange || currRemain !== prevRemain;

                existingSpool = spool;

                if (legacyMode()) {
                    // Legacy: derive remaining weight from the AMS RFID remain %
                    if (!slotChanged) {
                        debug("spoolman", printer.name, printer.logFilePath, " No change for connected spool; skipping PATCH");
                        break;
                    }

                    // The whole mode rests on the percentage, so there is
                    // nothing to patch until the AMS has read one. It arrives
                    // within about 20 seconds of the spool going in.
                    if (currRemain === null) {
                        debug("spoolman", printer.name, printer.logFilePath, " Remain not reported yet; skipping PATCH until the AMS has read it");
                        break;
                    }

                    const remainingWeight = Math.round((currRemain / 100) * slot.tray_weight);

                    debug("spoolman", printer.name, printer.logFilePath, "    Sending PATCH request to:", `${spoolmanUrl()}/api/v1/spool/${spool.id}`);
                    trace("spoolman", printer.name, printer.logFilePath, "    Payload:", JSON.stringify({ remaining_weight: remainingWeight, last_used: currentTime }));

                    try {
                        await patchSpoolWeight(spool.id, remainingWeight, currentTime);
                        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${currRemain}%) [[ ${slot.tray_uuid} ]]`);
                        console.log(printer.name, printer.logFilePath, `    Updated Spool-ID ${spool.id} => ${spool.filament.name}`);
                        // The record is the one this pass keeps working with, so
                        // what was just written has to be on it before anything
                        // decides whether the spool is empty.
                        spool.remaining_weight = remainingWeight;
                        await archiveWhenEmpty(printer, spool);
                    } catch (err) {
                        logSpoolmanFailure({ printerName: printer.name, logFilePath: printer.logFilePath }, "Spool update", err);
                    }

                    printer.lastUpdateTime = currentTime;
                } else {
                    // Default: weight is tracked from the sliced G-code on print
                    // completion (see handlePrintStateChange). Nothing is written
                    // here, and the line is held back on remain ticks so a spool
                    // that only reports a new percentage does not repeat itself.
                    // The location is claimed once for the whole update below.
                    if (meaningfulChange) {
                        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} [[ ${slot.tray_uuid} ]] => Spool-ID ${spool.id} (G-code mode)`);
                    }
                }

                break;
            }
        }
    }

    // What the AMS says is on the spool, from the RFID percentage and the
    // tray weight. Both stay null while the AMS has not reported a percentage
    // yet, so the dashboard shows a dash instead of a confident "0 g". What
    // Spoolman says is on the spool travels in existingSpool; the dashboard
    // picks between the two by mode and by whether the spool is linked.
    // Computed before the automatic actions below, because their preview of
    // the slot has to carry them as well.
    const correctedRemain = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    const amsWeight = correctedRemain === null
        ? null
        : Math.round((correctedRemain / 100) * slot.tray_weight);

    // An archived spool is gone from `spools`, which is what archiving is for,
    // and the slot it still sits in would therefore look like a spool Spoolman
    // has never seen: automatic mode would create a second record for the same
    // tag on the very next update. The archived list is checked before any of
    // that, and the slot is left alone.
    const archivedSpool = found ? null : spoolWithTag(archivedSpools, slot.tray_uuid);

    if (archivedSpool) {
        const newUiSpool = buildArchivedSpool(printer, amsId, slot, archivedSpool);
        releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);
        if (hasSpoolUiChanged(newUiSpool, prevByAmsId[amsId])) {
            console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} [[ ${slot.tray_uuid} ]] => Spool-ID ${archivedSpool.id} (archived, empty)`);
        }
        pushSlotUpdate(printer, newUiSpool, prevByAmsId);
        return false;
    }

    if (!found) {
        debug("spoolman", printer.name, printer.logFilePath, " Connected Spool not found, process with merging and creation logic");
        console.log(printer.name, printer.logFilePath, ` [${amsId}] ${slot.tray_sub_brands} ${slot.tray_color} (${slot.remain == null ? "remain unknown" : `${slot.remain}%`}) [[ ${slot.tray_uuid} ]]`);

        // The three automatic actions differ only in the option they stand for
        // and the Spoolman call they make, so they are run through one place.
        // The preview is what the slot's entry looked like after the last pass
        // ran this same action: a slot that has not changed since then must not
        // be written a second time, which is what would create the same spool
        // twice when the lookup after a creation missed the new spool, and what
        // would retry a failed write on every pass. It has to carry every field
        // the real entry below carries, because `hasSpoolUiChanged()` compares
        // the whole projection: with `slotState: ""` and six fields missing it
        // never matched, and the guard never held.
        //
        // Answers whether Spoolman was mutated, which is what tells the caller
        // its cached lists are stale.
        const runAutomatically = async (chosen, action) => {
            if (!automatic) return false;

            const prev = prevByAmsId[amsId];
            const preview = {
                amsId,
                slot,
                mergeableSpool,
                matchingInternalFilament,
                matchingExternalFilament,
                existingSpool,
                connectedViaTag: false,
                connectedViaMapping: false,
                assignedAutomatically: false,
                archived: false,
                option: chosen,
                enableButton,
                slotState: "Loaded (Bambu Lab)",
                error,
                correctedRemain,
                amsWeight,
            };
            if (prev && !hasSpoolUiChanged(preview, prev)) return false;

            const result = await action({ amsId, slot, mergeableSpool, matchingInternalFilament, matchingExternalFilament, printerName: printer.name, logFilePath: printer.logFilePath });

            // Only a write that happened makes the cached Spoolman lists stale.
            // A failed one used to count as one, which sent the caller off to
            // refetch a list that had not changed and let this slot look up a
            // spool that was never created.
            return result?.ok !== false;
        };

        mergeableSpool = spools.length !== 0 ? findMergeableSpool(slot, spools) : null;

        if (!mergeableSpool) {
            existingSpool = spools.length !== 0 ? findExistingSpool(slot, spools) : null;

            // Creating a spool writes its used weight, and that comes from the
            // AMS remain percentage, which is not there for the first seconds
            // after a spool goes in. Creating in that window stores a brand new
            // spool for a partly used one, and in G-code mode nothing corrects
            // the weight afterwards. Merging is deliberately not held back: it
            // only writes the tag, never a weight.
            const waitingForRemain = !existingSpool && !waitedLongEnoughForRemain(printer, amsId, slot);

            if (!existingSpool && waitingForRemain) {
                // Logged rather than debugged, and in both modes: in automatic
                // nobody is looking at the button, so without this line the
                // service just appears to ignore the slot for a minute.
                const waits = printer.remainWaits?.[amsId]?.waits ?? 0;
                console.log(printer.name, printer.logFilePath, `    Waiting for the AMS to report how much is left before creating a spool (${waits}/${MAX_REMAIN_WAITS})`);
                option = SLOT_OPTIONS.WAITING;
                enableButton = "false";
            } else if (!existingSpool) {
                if (matchingInternalFilament) {
                    console.log(printer.name, printer.logFilePath, "    Filament exists, create a Spool with this Data");
                    console.log(printer.name, printer.logFilePath, `    Material: ${matchingInternalFilament.material}, Color: ${matchingInternalFilament.name}`);
                    if (await runAutomatically(SLOT_OPTIONS.CREATE, createSpool)) mutated = true;
                    option = SLOT_OPTIONS.CREATE;
                } else if (matchingExternalFilament) {
                    console.log(printer.name, printer.logFilePath, "    Filament does not exist. Create a new Filament");
                    console.log(printer.name, printer.logFilePath, `    Material: ${matchingExternalFilament.material}, Color: ${matchingExternalFilament.name}`);
                    if (await runAutomatically(SLOT_OPTIONS.CREATE_WITH_FILAMENT, createFilamentAndSpool)) mutated = true;
                    option = SLOT_OPTIONS.CREATE_WITH_FILAMENT;
                } else {
                    console.error(printer.name, printer.logFilePath, "    No matching Filament found in Database, please check manually!");
                    error = true;
                }
            }
        } else {
            console.log(printer.name, printer.logFilePath, `    Found mergeable Spool => Spoolman Spool ID: ${mergeableSpool.id}, Material: ${mergeableSpool.filament.material}, Color: ${mergeableSpool.filament.name}`);
            if (await runAutomatically(SLOT_OPTIONS.MERGE, mergeSpool)) mutated = true;
            option = SLOT_OPTIONS.MERGE;
        }

        if (!automatic && option !== SLOT_OPTIONS.WAITING) enableButton = "true";
        printer.lastUpdateTime = new Date();

        // A create/merge just happened, so look the spool back up right away so
        // the UI reflects the real connection immediately. Without this, the
        // overview would stay on the pending "Create Spool" state until some
        // unrelated change happens to trigger reprocessing of this slot (the
        // creation itself doesn't count as a change once state.lastSpoolData
        // has already been refreshed to include it).
        if (mutated) {
            const freshSpools = await getSpoolmanSpools();
            const linked = freshSpools.find(s => spoolTag(s) === slot.tray_uuid);
            if (linked) {
                existingSpool = linked;
                found = true;
                option = SLOT_OPTIONS.NONE;
            }
        }
    }

    // A manual assignment wins over the automatic tag match: it is the only way
    // for the user to resolve two tagged spools that are identical in
    // tray_info_idx and color, which the tag match alone cannot tell apart.
    //
    // Legacy mode skips this entirely. An assignment exists to tell the G-code
    // booking which spool to charge, and legacy books nothing: it writes the
    // weight straight onto the tag-connected spool. Offering it there would be
    // a button that changes nothing.
    const mappedSpool = legacyMode() ? null : resolveMappedSpool(printer, amsId, slot, spools, archivedSpools);
    if (mappedSpool) {
        existingSpool = mappedSpool;
        option = SLOT_OPTIONS.UNASSIGN;
        enableButton = "true";
    } else if (!legacyMode() && !found && option === SLOT_OPTIONS.NONE) {
        // Nothing to create or merge, and no tag link, so offer a manual assignment
        option = SLOT_OPTIONS.ASSIGN;
        enableButton = "true";
    }

    // Only a spool this slot is really connected to may claim it. `existingSpool`
    // can also be a mere merge/creation candidate found by filament match, which
    // is not in the AMS at all and must not be given its location.
    if ((found || mappedSpool) && !existingSpool?.archived) locationSync.claim(amsId, existingSpool);
    releasePreviousSpool(locationSync, amsId, prevByAmsId, spools);

    const newUiSpool = {
        amsId,
        slot,
        mergeableSpool,
        matchingInternalFilament,
        matchingExternalFilament,
        existingSpool,
        // True only when the spool is physically connected to this slot via the
        // Spoolman extra.tag (= tray_uuid) match. Consumption is only booked to
        // these spools and to manually assigned ones, never to mere filament
        // candidates (findExistingSpool).
        connectedViaTag: found,
        connectedViaMapping: !!mappedSpool,
        // Never chosen by the colour match for a tagged spool, but the field is
        // carried so every builder sets the same set.
        assignedAutomatically: !!mappedSpool && !!getMapping(printer.id, amsId)?.automatic,
        archived: !!existingSpool?.archived,
        option,
        enableButton,
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (Bambu Lab)",
        error,
        correctedRemain,
        amsWeight,
    };

    pushSlotUpdate(printer, newUiSpool, prevByAmsId);
    return mutated;
}

/**
 * Builds the UI entry for an empty slot: nothing matched, no action offered.
 *
 * A slot the AMS is currently reading looks exactly like an empty one until the
 * tray record arrives, so it is still built here, but it says "Waiting for
 * data" rather than claiming there is nothing to do. See `slotIsBusy()`.
 */
function buildEmptySpool(printer, amsId, slot) {
    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: null,
        connectedViaTag: false,
        connectedViaMapping: false,
        assignedAutomatically: false,
        archived: false,
        correctedRemain: null,
        amsWeight: null,
        option: slotIsBusy(slot) ? SLOT_OPTIONS.WAITING : SLOT_OPTIONS.NONE,
        enableButton: "false",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Empty",
        error: false,
    };
}

/**
 * Builds the UI entry for a slot holding a spool the printer could not
 * identify. Nothing about it can be matched automatically, so the only action
 * offered is assigning a Spoolman spool by hand, and the displayed weight comes
 * from that assignment rather than from the AMS, which knows nothing about it.
 */
function buildThirdPartySpool(printer, amsId, slot, mappedSpool = null) {
    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: mappedSpool,
        // Never true for a chipless spool. The link comes from the manual
        // assignment below, not from an RFID tag.
        connectedViaTag: false,
        connectedViaMapping: !!mappedSpool,
        // The colour match chose the spool rather than the user, which the
        // dashboard says next to the assignment.
        assignedAutomatically: !!mappedSpool && !!getMapping(printer.id, amsId)?.automatic,
        archived: !!mappedSpool?.archived,
        // A chipless spool reports no percentage, so the AMS knows no weight.
        correctedRemain: null,
        amsWeight: null,
        // Legacy mode offers nothing here. Its weight comes from the RFID
        // percentage, which this spool does not report, so there is no action
        // that would do anything.
        option: legacyMode() ? SLOT_OPTIONS.NONE : (mappedSpool ? SLOT_OPTIONS.UNASSIGN : SLOT_OPTIONS.ASSIGN),
        enableButton: legacyMode() ? "false" : "true",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (3rd party)",
        error: false,
    };
}

/**
 * Assigns a chipless slot the one Spoolman spool that fits it, when the user
 * has opted in and there is exactly one. Returns the spool, or null when the
 * slot stays unassigned.
 *
 * The printer cannot tell two spools of the same material and colour apart, so
 * this only ever acts where there is nothing to tell apart: one spool without a
 * tag, of that material and those colours, assigned to no other slot. The
 * assignment is the same record a hand made one is, and is dropped the same
 * way when the slot's filament changes.
 *
 * @param {object} printer - the printer the slot belongs to
 * @param {string} amsId - slot label
 * @param {object} slot - the AMS slot record
 * @param {object[]} spools - the Spoolman spools
 * @returns {object|null} the assigned spool
 */
function autoAssignThirdPartySpool(printer, amsId, slot, spools) {
    if (!settings.AUTO_ASSIGN_THIRD_PARTY) return null;

    const spool = uniqueSpoolForSlot(slot, spools, spoolIdsAssignedElsewhere(printer.id, amsId));
    if (!spool) return null;

    setMapping(printer.id, amsId, spool.id, slot, { automatic: true });
    console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId} assigned automatically to Spoolman spool ${spool.id} (${spool.filament?.name ?? "?"}): the only spool of that material and colour`);
    return spool;
}

/**
 * The spool in `list` whose Spoolman `extra.tag` holds this slot's `tray_uuid`.
 *
 * The tag is stored JSON encoded, and a hand edited one that is not decodes to
 * nothing rather than throwing here, which would otherwise take down the whole
 * AMS update for one bad record.
 *
 * @param {object[]} list - Spoolman spools to search
 * @param {string} trayUuid - the slot's tag
 * @returns {object|null}
 */
function spoolWithTag(list, trayUuid) {
    if (!trayUuid) return null;

    return (list || []).find(spool => spoolTag(spool) === trayUuid) || null;
}

/**
 * Builds the UI entry for a slot still holding a spool that was archived
 * because it ran empty.
 *
 * No action is offered: creating or merging would give the same physical spool
 * a second record, and assigning another spool to a slot that reports its own
 * tag is not what the mapping is for. Taking the spool out is the answer, and
 * restoring it in Spoolman is what brings the slot back to normal.
 */
function buildArchivedSpool(printer, amsId, slot, archivedSpool) {
    // The tag still reports a percentage, and the dashboard shows what the
    // AMS reads off the spool the same way it does for a linked one.
    const correctedRemain = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    const amsWeight = correctedRemain === null
        ? null
        : Math.round((correctedRemain / 100) * slot.tray_weight);

    return {
        amsId,
        slot,
        mergeableSpool: null,
        matchingInternalFilament: null,
        matchingExternalFilament: null,
        existingSpool: archivedSpool,
        // Deliberately not a connection: a booking onto an archived spool would
        // bring it back into the numbers the user just archived away, and the
        // location sync would hand it the slot it is sitting in again.
        connectedViaTag: false,
        connectedViaMapping: false,
        assignedAutomatically: false,
        archived: true,
        correctedRemain,
        amsWeight,
        option: SLOT_OPTIONS.NONE,
        enableButton: "false",
        printerName: printer.name,
        logFilePath: printer.logFilePath,
        slotState: "Loaded (archived)",
        error: false,
    };
}

/**
 * Looks up the manually assigned Spoolman spool for a slot. Returns null when
 * nothing is assigned, when the assignment went stale (different filament in
 * the slot now, getMapping drops it), or when the assigned spool no longer
 * exists in Spoolman.
 */
function resolveMappedSpool(printer, amsId, slot, spools, archivedSpools) {
    const mapping = getMapping(printer.id, amsId, slot);
    if (!mapping) return null;

    // The archived list is searched as well, or archiving an assigned spool
    // would read as "the spool is gone from Spoolman" and throw the assignment
    // away, which is not something the user asked for and cannot be undone by
    // restoring the spool.
    const spool = [...(spools || []), ...(archivedSpools || [])].find(s => s.id === mapping.spoolId);
    if (!spool) {
        console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId}: assigned spool ${mapping.spoolId} no longer exists in Spoolman, dropping assignment`);
        clearMapping(printer.id, amsId);
        return null;
    }

    return spool;
}

/**
 * Records a UI spool for this AMS update and broadcasts it, but only when
 * something the user sees actually changed.
 *
 * A slot with no previous entry counts as changed, so the first pass sends
 * everything. There used to be a second condition, holding back every slot the
 * printer had not fully identified, which meant an emptied slot never reached
 * the UI and its row kept showing the spool that had been taken out. It was
 * guarding against sparse payloads overwriting a populated row, which was the
 * old occupancy bug rather than a real case, and `hasSpoolUiChanged` already
 * suppresses everything that would not change the display.
 */
function pushSlotUpdate(printer, newUiSpool, prevByAmsId) {
    if (hasSpoolUiChanged(newUiSpool, prevByAmsId[newUiSpool.amsId])) {
        broadcastSlotUpdate(printer.id, newUiSpool);
    }
    printer.spoolData.push(newUiSpool);
}

/**
 * Opens the MQTT connection to a printer and subscribes to its report topic.
 *
 * Guarded against concurrent and rapid retries: an attempt is skipped while one
 * is already running, while the connection is up, or within a 30 second
 * cooldown of the last attempt. With a retry limit set, repeated failures disable
 * monitoring for that printer instead of retrying forever.
 *
 * Neither the close nor the error handler reschedules itself. monitorPrinters
 * is the only place that retries.
 *
 * @param {object} printer - the printer runtime object
 */
/**
 * Closes the MQTT connection of a printer on purpose.
 *
 * Every deliberate disconnect goes through here, so that the "close" handler can
 * tell one from a connection the printer or the network dropped. Without that it
 * announced that the monitor loop would retry within the offline check interval,
 * which is wrong whenever a reconnect has already been started or the process is
 * shutting down, and the line then sits in the log directly above the successful
 * reconnect reading as though nothing had happened.
 *
 * @param {object} printer - the runtime printer
 * @param {string} reason - completes "Connection closed, ..." in the log
 * @param {boolean} [force] - end the client without waiting for the broker
 */
export function closeMqtt(printer, reason, force = false) {
    printer.closingReason = reason;

    if (printer.mqttClient) {
        printer.mqttClient.end(force);
        printer.mqttClient = null;
    }

    printer.mqttRunning = false;
}

export async function setupMqtt(printer) {
    const now = Date.now();
    const COOLDOWN_PERIOD = 30000;

    printer.lastReconnectAttempt = printer.lastReconnectAttempt || 0;
    printer.reconnectAttempts = printer.reconnectAttempts || 0;

    if (printer.mqttRunning || printer.isReconnecting || (now - printer.lastReconnectAttempt < COOLDOWN_PERIOD)) {
        return;
    }

    printer.isReconnecting = true;
    printer.lastReconnectAttempt = now;

    try {
        console.log(printer.name, printer.logFilePath, `Setting up MQTT connection for Printer: ${printer.id}...`);

        const client = await mqtt.connectAsync(`tls://bblp:${printer.code}@${printer.ip}:8883`, {
            rejectUnauthorized: false,
        });

        printer.mqttStatus = "Connected";
        printer.mqttRunning = true;
        printer.mqttClient = client;
        printer.reconnectAttempts = 0;
        printer.isReconnecting = false;
        // What the previous connection knew about the external spool holder
        // may be stale by now. See rememberedExternalSpoolUnits().
        printer.lastExternalUnits = null;

        console.log(printer.name, printer.logFilePath, `MQTT client connected for Printer: ${printer.id}`);
        await client.subscribeAsync(`device/${printer.id}/report`);
        requestVersion(client, printer);
        requestFullReport(client, printer);

        client.on("message", (topic, message) => {
            // Ahead of the handler, and deliberately outside it: handleMqttMessage
            // returns immediately while a previous report is still being
            // processed and while Spoolman is down, and those are exactly the
            // reports an analysis afterwards is missing. Writing is queued and
            // not awaited, so it costs the handler nothing.
            if (traceEnabled(printer)) appendTrace(printer.traceFilePath, message);

            // The get_version answer, and only that, is read here for the same
            // reason: the handler below may not be reading when it arrives. The
            // string check keeps the parse off the reports that come every
            // second or two.
            if (message.includes("get_version") && noteVersionInfo(printer, message)) return;
            // The project_file echo the same way. It carries no state and no AMS
            // block, so the handler has nothing to read off it afterwards.
            if (message.includes("project_file") && notePrintCommand(printer, message)) return;

            handleMqttMessage(printer, topic, message);
        });

        client.on("close", () => {
            // A deliberate reconnect ends this client and builds a new one right
            // away, so this can arrive when the printer already has a newer
            // connection. Resetting the state then would tear down the live one
            // and leave the monitor loop to pick the printer up again.
            if (printer.mqttClient && printer.mqttClient !== client) return;

            printer.mqttStatus = "Disconnected";
            printer.mqttRunning = false;
            printer.mqttClient = null;

            // Set by closeMqtt() when this close was asked for. Saying the
            // monitor loop will retry is wrong then: either something is already
            // reconnecting, or the process is on its way out.
            const reason = printer.closingReason;
            printer.closingReason = null;

            if (reason) {
                console.log(printer.name, printer.logFilePath, ` Connection closed, ${reason}`);
                return;
            }

            // No self-rescheduling here. monitorPrinters() is the single
            // place driving reconnect attempts (polls every offline check interval
            // and calls setupMqtt() again once mqttRunning is false). Having
            // both this handler and that loop independently retry used to
            // race and made the actual retry cadence hard to reason about.
            if (printer.monitoringEnabled) {
                console.log(printer.name, printer.logFilePath, ` Connection closed, will retry within ${formatInterval(settings.OFFLINE_CHECK_INTERVAL)} via the monitor loop...`);
            }
        });

        client.on("error", async (error) => {
            console.error(printer.name, printer.logFilePath, `MQTT error for Printer: ${printer.id} - ${error.message}`);
            client.end();
        });

        console.log(printer.name, printer.logFilePath, `Waiting for MQTT messages for Printer: ${printer.id}...`);
    } catch (error) {
        printer.mqttStatus = "Error";
        printer.mqttRunning = false;
        printer.reconnectAttempts++;
        printer.isReconnecting = false;

        if (!printer.monitoringEnabled) return;

        console.error(printer.name, printer.logFilePath, `Error in setupMqtt for Printer: ${printer.id} - ${error.message}`);

        if (retryLimitReached(printer)) {
            disableAfterRetries(printer, `Max retries (${settings.MAX_RETRIES}) reached -> disabling monitoring!`);
            return;
        }

        // No self-rescheduling here either, see the comment in the "close"
        // handler above. monitorPrinters() will retry within the offline check interval.
        console.log(printer.name, printer.logFilePath, ` Connection failed, will retry within ${formatInterval(settings.OFFLINE_CHECK_INTERVAL)} via the monitor loop...`);
    }
}

/**
 * Checks whether a printer accepts an MQTT connection and actually reports on
 * the topic of the configured serial number, without touching the connection
 * the monitor loop maintains.
 *
 * Uses its own short lived client, so a printer that is already being monitored
 * keeps running while the test is made. Subscribing alone proves nothing: the
 * printer accepts a subscription to any topic, including the one of a serial
 * number that is not its own. Only an arriving report does, which is why the
 * test waits for one. A connection without a report is reported as a warning
 * rather than a failure, because a printer really can stay silent for a moment.
 *
 * @param {{id: string, ip: string, code: string}} printer - what to try
 * @param {number} [timeout] - milliseconds before the connection is given up
 * @param {number} [listenTimeout] - milliseconds to wait for the first report
 * @returns {Promise<{ok: boolean, error?: string, warning?: string, detail?: string}>}
 */
export async function testMqttConnection(printer, timeout = 8000, listenTimeout = 6000) {
    let client = null;

    try {
        client = await mqtt.connectAsync(`tls://bblp:${printer.code}@${printer.ip}:8883`, {
            rejectUnauthorized: false,
            connectTimeout: timeout,
            reconnectPeriod: 0,
        });

        const topic = `device/${printer.id}/report`;
        await client.subscribeAsync(topic);

        const reported = await waitForFirstMessage(client, listenTimeout);
        if (reported) return { ok: true };

        return {
            ok: true,
            warning: `Connected, but nothing arrived on ${topic}. Check the serial number if this stays empty.`,
            code: "mqttNothingArrived",
            params: { topic },
        };
    } catch (err) {
        const detail = err?.message || String(err);
        return { ok: false, error: describeMqttError(err), ...mqttErrorCode(err), detail };
    } finally {
        // force close, the test must not linger as a second session
        client?.end(true);
    }
}

/**
 * Resolves true on the first message the client receives, false when the wait
 * runs out. Always removes its listener, so the client can be closed cleanly.
 *
 * @returns {Promise<boolean>} whether a message arrived in time
 */
function waitForFirstMessage(client, timeout) {
    return new Promise(resolve => {
        const done = (result) => {
            clearTimeout(timer);
            client.removeListener("message", onMessage);
            resolve(result);
        };
        const onMessage = () => done(true);
        const timer = setTimeout(() => done(false), timeout);

        client.on("message", onMessage);
    });
}

/**
 * Turns an MQTT failure into something a user can act on. A rejected access
 * code and an unreachable address both surface as a connection error, but they
 * need completely different fixes.
 */
function describeMqttError(err) {
    const message = err?.message || String(err);
    if (/Not authorized|Bad username or password|code: [45]/.test(message)) return "The printer rejected the access code";
    return describeConnectionError(err, { port: 8883, timeoutHint: "Is LAN mode enabled?" }) ?? message;
}

/** The same as describeMqttError(), as a code for the Web UI. */
function mqttErrorCode(err) {
    const message = err?.message || String(err);
    if (/Not authorized|Bad username or password|code: [45]/.test(message)) return { code: "accessCodeRejected", params: {} };
    return connectionErrorCode(err, 8883) ?? {};
}

/**
 * Drops the growing wait between the reachability checks of an offline printer.
 *
 * The backoff exists to stop the monitor loop asking a printer that is switched
 * off every twenty seconds. A user who pressed a button is not the monitor loop,
 * so resuming monitoring, reconnecting or editing a printer clears it, exactly
 * as they clear the reconnect cooldown of `setupMqtt()`. Without this, a printer
 * switched back on would wait out a five minute backoff before anything tried.
 *
 * @param {object} printer - the runtime printer
 */
/**
 * Whether the printer has failed to connect as often as MAX_RETRIES allows.
 * 0 retries forever, which is the default.
 */
function retryLimitReached(printer) {
    return settings.MAX_RETRIES > 0 && printer.reconnectAttempts >= settings.MAX_RETRIES;
}

/**
 * Switches a printer's monitoring off after the retry limit, and tells the
 * dashboard. Three places used to do this with three slightly different
 * sets of fields.
 */
function disableAfterRetries(printer, why) {
    printer.monitoringEnabled = false;
    printer.mqttRunning = false;
    printer.mqttStatus = "Disabled";
    console.log(printer.name, printer.logFilePath, why);
    broadcastSSE({ type: "monitoring_update", printer: printer.id, enabled: false });
}

export function resetOfflineBackoff(printer) {
    printer.offlineChecks = 0;
    printer.nextCheckAt = 0;
    printer.offlineWaitLogged = null;
}

/**
 * Records that a printer answered, and says whether it had been away.
 *
 * @param {object} printer - the runtime printer
 * @returns {boolean} whether this is the first answer after failed checks
 */
function printerIsBack(printer) {
    const wasOffline = (printer.offlineChecks || 0) > 0;
    resetOfflineBackoff(printer);
    return wasOffline;
}

/**
 * Records a failed reachability check and schedules the next one.
 *
 * The wait grows with every failure, up to the configured limit, which is what
 * keeps a printer that is switched off most of the time from being asked every
 * twenty seconds for hours. It also decides whether this failure is worth a log
 * line: only a wait that differs from the one already announced is, so a printer
 * that stays off produces one line per backoff step and then nothing, instead of
 * the same line forever.
 *
 * @param {object} printer - the runtime printer
 * @param {number} now - the current timestamp
 */
function printerStillOffline(printer, now) {
    const wait = offlineBackoff(printer.offlineChecks || 0, settings.OFFLINE_CHECK_INTERVAL, settings.OFFLINE_MAX_INTERVAL);

    printer.offlineChecks = (printer.offlineChecks || 0) + 1;
    printer.nextCheckAt = now + wait;
    printer.mqttStatus = "Disconnected";
    printer.mqttRunning = false;

    if (printer.offlineWaitLogged === wait) {
        debug("mqtt", printer.name, printer.logFilePath, `Printer ${printer.id} is still unreachable, next try in ${formatInterval(wait)}`);
        return;
    }

    printer.offlineWaitLogged = wait;
    console.error(printer.name, printer.logFilePath, `Printer ${printer.id} with IP ${printer.ip} is unreachable. Next try in ${formatInterval(wait)}...`);
}

/**
 * Runs forever, reconnecting printers that are reachable but not connected.
 *
 * This is the single retry driver for MQTT. On every offline check interval each
 * enabled printer is probed with a plain TCP connect before setupMqtt is
 * attempted, so an unreachable printer costs one short timeout rather than a
 * hanging MQTT handshake.
 *
 * It keeps running while Spoolman is down. It used to idle instead, on the
 * grounds that there would be nothing to write AMS data to, and because this is
 * the only thing that reconnects MQTT that made a printer connection hostage to
 * an unrelated service. Measured on 2026-09-05: a network drop took both down
 * within nine seconds, the close handler promised a retry "within 20 seconds
 * via the monitor loop", and for the five minutes until the process was
 * restarted there was not one reconnect attempt and not one reachability check,
 * while the printer answered on port 8883 the whole time.
 *
 * Nothing is written to Spoolman by keeping the connection up:
 * `handleMqttMessage()` refuses to process a report while Spoolman is down, and
 * always did. That guard is what the idling was really for, and it sits where
 * it belongs. Staying connected also means the printer is already there when
 * Spoolman comes back, rather than waiting out another interval first.
 *
 * A printer that does not answer is asked again on a growing interval rather
 * than on every tick, see `printerStillOffline()`. The loop keeps ticking at the
 * check interval, because the printers are on their own schedules and a printer
 * added or re-enabled in the Web UI has to be picked up quickly.
 *
 * @param {object[]} printers - the printer list
 */
export async function monitorPrinters(printers) {
    while (true) {
        await servicePrinters(printers);
        await sleep(settings.OFFLINE_CHECK_INTERVAL);
    }
}

/**
 * One pass of the monitor loop over the printer list.
 *
 * Split out of `monitorPrinters()` so that a pass can be run and asserted on.
 * The loop itself never returns, so a test could only start it and hope; what
 * needs proving is what one pass does, and in particular that it does it while
 * Spoolman is down.
 *
 * @param {object[]} printers - the printer list
 */
export async function servicePrinters(printers) {
    for (const printer of printers) {
        if (!printer.monitoringEnabled) {
            printer.mqttRunning = false;
            printer.mqttStatus = "Disabled";
            continue;
        }

        const now = Date.now();
        // Not yet due: this printer failed its last check and is waiting out
        // its backoff. A connected one has no wait, so it is never skipped.
        if (printer.nextCheckAt && now < printer.nextCheckAt) continue;

        try {
            const isAlive = await checkPrinterAvailability(printer.ip, 8883);

            if (isAlive) {
                if (printerIsBack(printer)) {
                    console.log(printer.name, printer.logFilePath, `Printer ${printer.id} with IP ${printer.ip} is reachable again`);
                }

                if (!printer.mqttRunning && !printer.isReconnecting) {
                    if (retryLimitReached(printer)) {
                        disableAfterRetries(printer, "Monitoring disabled (max retries reached).");
                        continue;
                    }
                    console.log(printer.name, printer.logFilePath, `MQTT not running for Printer: ${printer.id}, attempting to reconnect...`);
                    setupMqtt(printer);
                }
            } else {
                if (retryLimitReached(printer)) {
                    disableAfterRetries(printer, "Printer is unreachable and the retry limit is exceeded, monitoring disabled.");
                    continue;
                }
                printerStillOffline(printer, now);
            }
        } catch (error) {
            console.error(printer.name, printer.logFilePath, `Error monitoring Printer: ${printer.id} - ${error.message}`);
        }
    }
}

/**
 * Names why a request to Spoolman failed, in one short phrase.
 *
 * The health checks used to discard the error entirely, so an outage produced a
 * run of identical lines that said only "unreachable". These are different
 * problems: no route to the host is a network question, a refused connection
 * means the address is right and nothing is listening, a timeout means something
 * answered too slowly to be usable, and a parse failure means the endpoint is
 * not the Spoolman anybody thinks it is.
 *
 * The code is preferred over the message because `got` wraps the message in its
 * own text, and the code is what a search engine and the user's router agree on.
 *
 * @param {Error} err - whatever the request threw
 * @returns {string} a short reason, never empty
 */
export function describeRequestError(err) {
    const code = err?.code || err?.cause?.code;
    if (code) return code;
    if (err instanceof SyntaxError) return "the answer was not JSON";
    return err?.message || "no reason given";
}

/**
 * Checks Spoolman's health and keeps `state.spoolmanStatus` in step with it.
 *
 * Two callers with one difference: the bootstrap waits until Spoolman answers
 * once and then goes on (`untilConnected`), while the background monitor runs
 * for the life of the process and marks Spoolman disconnected the moment a
 * check fails, which is what stops every AMS update from trying to write.
 *
 * @param {object} [options]
 * @param {boolean} [options.untilConnected] - return after the first healthy answer
 * @param {number} [options.intervalMs] - pause between two checks
 */
/**
 * How long one health probe of the monitor may take. The settings page test
 * waits five seconds; the monitor is patient with a slow Spoolman, because a
 * probe that times out marks Spoolman disconnected and stops every AMS update.
 */
const SPOOLMAN_MONITOR_TIMEOUT_MS = 15000;

export async function monitorSpoolman({ untilConnected = false, intervalMs = untilConnected ? 30000 : 60000 } = {}) {
    while (true) {
        // The same check the settings page runs, so Spoolman is reached from
        // spoolman.js alone and an outage reads the same in both places. It
        // never throws: a refused or unhealthy answer comes back as `ok: false`
        // with the sentence that says why.
        const health = await checkSpoolmanHealth(spoolmanUrl(), SPOOLMAN_MONITOR_TIMEOUT_MS);
        if (health.ok) {
            if (state.spoolmanStatus !== "Connected") {
                console.log("Server", serverLogFilePath, untilConnected ? "Spoolman connected successfully!" : "Spoolman reconnected successfully!");
            }
            state.spoolmanStatus = "Connected";
            if (untilConnected) return;
        } else {
            console.error("Server", serverLogFilePath,
                `Spoolman is unreachable (${health.error}). Retrying in ${Math.round(intervalMs / 1000)} seconds...`);
            if (!untilConnected) state.spoolmanStatus = "Disconnected";
        }
        await sleep(intervalMs);
    }
}

/** The background health check, for the life of the process. */
export function monitorSpoolmanBackground() {
    return monitorSpoolman({ untilConnected: false });
}

/**
 * Whether a plain TCP connection to the printer succeeds within the timeout.
 * Used as a cheap reachability probe before attempting an MQTT handshake.
 *
 * @returns {Promise<boolean>} always resolves, never rejects
 */
function checkPrinterAvailability(host, port, timeout = 5000) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;

        socket.setTimeout(timeout);
        socket.on("connect", () => { done = true; socket.destroy(); resolve(true); });
        socket.on("timeout", () => { if (!done) { done = true; socket.destroy(); resolve(false); } });
        socket.on("error", () => { if (!done) { done = true; resolve(false); } });
        socket.connect(port, host);
    });
}
