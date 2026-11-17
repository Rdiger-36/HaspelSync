import AdmZip from "adm-zip";
import fs from "fs-extra";
import os from "os";
import path from "path";

import { version, dataDir, logsDir, serverLogFilePath, mappingsPath, supervised } from "./config.js";
import { deprecatedConfig } from "./deprecation.js";
import { legacyImageNotice } from "./imagenotice.js";
import { logFileSet } from "./logger.js";
import { printers } from "./printers.js";
import { parseStoredFile } from "./mappings.js";
import { allLearnedPresets } from "./presets.js";
import { apiKeyCount } from "./apikeys.js";
import { getSettingsView, legacyMode } from "./settings.js";
import { state } from "./state.js";
import {
    exportPrinters,
    exportSettings,
    maskCodes,
    maskPath,
    maskSerial,
    maskText,
} from "./anonymize.js";

/**
 * The support bundle and the system facts behind it.
 *
 * Every bug report starts with the same four questions: which version, which
 * platform, what does the configuration look like and what do the logs say. The
 * bundle answers all of them in one download, and the anonymised variant does it
 * without publishing the user's network. See `anonymize.js` for what "anonymised"
 * covers and what it deliberately leaves alone.
 */

/**
 * The facts the Service card shows and the bundle carries.
 *
 * @param {boolean} [anonymize] - shorten the data and log paths
 * @returns {object} version, runtime, platform and the state of the service
 */
export function systemInfo(anonymize = false) {
    const view = getSettingsView();
    const notice = deprecatedConfig();
    const image = legacyImageNotice();

    return {
        version,
        // The name the image was published under, null for a checkout, and
        // whether that name is the deprecated one
        image: image.image,
        imageDeprecated: image.active,
        imageStopsAt: image.stopsAt,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        os: `${os.type()} ${os.release()}`,
        // Seconds, formatted by whoever displays it
        uptime: Math.round(process.uptime()),
        supervised,
        // What the process is actually doing, which is not always what the
        // stored setting says: legacy mode is frozen at startup
        tracking: legacyMode() ? "legacy (AMS RFID remain %)" : "G-code",
        mode: view.values.MODE,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        printers: printers.length,
        // How many keys exist, never which. The keys live in their own file and
        // no variant of the bundle carries it, the way the password hash is
        // stripped from the settings; the count is what a support question about
        // "something is writing to Spoolman" actually needs.
        apiKeys: apiKeyCount(),
        // The AMS units as each printer named them in its get_version answer,
        // which is the one place the family is stated. A unit missing here is
        // a printer that has not answered yet, or a family this service does
        // not know; an original AMS shown as a 2 Pro was the report that made
        // this line worth carrying.
        amsUnits: printers.map(printer => ({
            printer: printer.name,
            units: Object.entries(printer.amsModels || {}).map(([unit, model]) =>
                `${unit}: ${model.model}${model.hardware ? ` (${model.hardware})` : ""}`),
        })),
        spoolman: state.spoolmanStatus,
        dataDir: anonymize ? maskPath(dataDir) : dataDir,
        logsDir: anonymize ? maskPath(logsDir) : logsDir,
        // Says whether this installation is still driven by the environment,
        // which explains a surprising number of "my change did nothing" reports
        environmentConfigured: notice.active,
        environmentVariables: notice.variables,
    };
}

/** Reads a JSON file, returning null rather than throwing when it is not there. */
function readJsonOrNull(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
        return null;
    }
}

/**
 * Everything the masking needs to know about this installation.
 *
 * Exported because the plain log download masks with exactly the same set; the
 * two downloads must not disagree about what counts as identifying.
 *
 * @returns {{codes: string[], serials: string[], hosts: string[]}}
 */
export function knownValues() {
    const view = getSettingsView();
    return {
        codes: printers.map(printer => printer.code),
        serials: printers.map(printer => printer.id),
        hosts: [view.values.SPOOLMAN_ENDPOINT, view.values.SPOOLMAN_FQDN, view.values.SPOOLMAN_IP]
            .filter(Boolean)
            .map(value => {
                try {
                    return new URL(value).hostname;
                } catch {
                    return value;
                }
            }),
    };
}

/** The scope name of the server log in a `scope` query. */
const SERVER_SCOPE = "server";

/**
 * Which logs a bundle is asked to carry.
 *
 * The bundle carried every log of the installation, and with the raw MQTT
 * trace at 22 MB an hour per printer that stopped being the right default for
 * an installation with several printers where one of them is the question.
 * The configuration files are small and are what a bug report needs first, so
 * they are in every bundle; the choice is over the logs alone.
 *
 * A printer has two logs, its own and the raw MQTT trace, and the scope can
 * name either: `<serial>/log`, `<serial>/trace`, or the bare `<serial>` for
 * both. That is what the export at the bottom of a printer's log detail
 * dialog uses, where the trace is the one file worth leaving out.
 *
 * @param {string|undefined} raw - the `scope` query, comma separated: `server`, serial numbers,
 *   `<serial>/log` and `<serial>/trace`; absent means everything
 * @param {object[]} known - the printers of this installation
 * @returns {{server: boolean, printers: {id: string, log: boolean, trace: boolean}[]}|{error: string}}
 *   what to include, or why the query is refused
 */
export function parseDiagnosticsScope(raw, known) {
    if (raw === undefined) {
        return { server: true, printers: known.map(printer => ({ id: printer.id, log: true, trace: true })) };
    }

    const wanted = String(raw).split(",").map(part => part.trim()).filter(Boolean);
    if (!wanted.length) return { error: "The scope names nothing to include" };

    const byPrinter = new Map();
    const unknown = [];
    for (const part of wanted) {
        if (part === SERVER_SCOPE) continue;
        const [id, file] = part.split("/");
        if (!known.some(printer => printer.id === id) || (file !== undefined && file !== "log" && file !== "trace")) {
            unknown.push(part);
            continue;
        }
        const entry = byPrinter.get(id) ?? { id, log: false, trace: false };
        if (file === undefined || file === "log") entry.log = true;
        if (file === undefined || file === "trace") entry.trace = true;
        byPrinter.set(id, entry);
    }
    if (unknown.length) return { error: `Unknown printer or log in scope: ${unknown.join(", ")}` };

    return {
        server: wanted.includes(SERVER_SCOPE),
        // In the installation's order, whatever order the query had
        printers: known.filter(printer => byPrinter.has(printer.id)).map(printer => byPrinter.get(printer.id)),
    };
}

/**
 * Builds the support bundle.
 *
 * The whole archive is built in memory, the same way the log download already
 * is: its size is bounded by the log settings, and log text compresses well.
 *
 * @param {object} [options]
 * @param {boolean} [options.anonymize] - mask addresses, serials and paths
 * @param {{server: boolean, printers: string[]}} [options.scope] - which logs to carry, from `parseDiagnosticsScope()`; everything when absent
 * @param {boolean} [options.config] - carry the configuration files and the facts; false is the
 *   log download of the log page, which is the logs alone under another name
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function buildDiagnosticsBundle({ anonymize = true, scope = null, config = true } = {}) {
    const included = scope ?? parseDiagnosticsScope(undefined, printers);
    const zip = new AdmZip();
    const known = knownValues();
    // Even the full bundle loses the access codes. The service does not write
    // them to a log on purpose, and "on purpose" is not a guarantee worth
    // handing out.
    const mask = text => (anonymize ? maskText(text, known) : maskCodes(text, known.codes));

    const info = {
        generated: new Date().toISOString(),
        anonymized: anonymize,
        // Which logs this bundle was asked to carry, so an archive without a
        // printer's log reads as a choice rather than as a printer that
        // never logged. The serials are masked like the file names are.
        logs: {
            server: included.server,
            printers: included.printers.map(entry => ({ ...entry, id: anonymize ? maskSerial(entry.id) : entry.id })),
        },
        ...systemInfo(anonymize),
    };
    if (config) zip.addFile("info.json", Buffer.from(JSON.stringify(info, null, 4)));

    if (config) await addConfigFiles(zip, anonymize);

    if (included.server) await addLogFiles(zip, "logs/server", serverLogFilePath, mask);

    for (const wanted of included.printers) {
        const printer = printers.find(entry => entry.id === wanted.id);
        if (!printer) continue;
        const base = `logs/${anonymize ? maskSerial(printer.id) : printer.id}`;
        if (wanted.log) await addLogFiles(zip, base, printer.logFilePath, mask);
        // The raw MQTT trace, when one was captured. Masked like every other
        // file, and simply absent for a printer the trace was never on for.
        if (wanted.trace) await addLogFiles(zip, `${base}.mqtt`, printer.traceFilePath, mask);
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "_");
    return {
        buffer: zip.toBuffer(),
        filename: `${config ? "haspelsync-diagnostics" : "haspelsync-logs"}_${stamp}${anonymize ? "" : "_full"}.zip`,
    };
}

/**
 * The configuration files of the bundle: the settings with the origin of
 * each value, the printer list, the assignments and the learned presets.
 *
 * @param {AdmZip} zip - the archive
 * @param {boolean} anonymize - mask addresses, serials and paths
 */
async function addConfigFiles(zip, anonymize) {
    const view = getSettingsView();
    zip.addFile("settings.json", Buffer.from(JSON.stringify({
        values: exportSettings(view.values, anonymize),
        // Which of them the environment still decides, the single most useful
        // thing to know about a configuration that behaves unexpectedly
        sources: view.sources,
        revision: view.revision,
    }, null, 4)));

    zip.addFile("printers.json", Buffer.from(JSON.stringify(
        exportPrinters(printers.map(({ id, ip, name, code }) => ({ id, ip, name, code })), anonymize),
        null,
        4,
    )));

    const mappings = readJsonOrNull(mappingsPath);
    if (mappings) {
        // Read through the mapping module's own parser, so the wrapper the file
        // carries stays intact and only the assignments inside it are masked
        const { printers: assignments, schemaVersion } = parseStoredFile(mappings);
        // Keyed by serial number, so the keys need masking as well
        const exported = anonymize
            ? Object.fromEntries(Object.entries(assignments).map(([serial, value]) => [maskSerial(serial), value]))
            : assignments;
        zip.addFile("mappings.json", Buffer.from(JSON.stringify({ schemaVersion, printers: exported }, null, 4)));
    }
    // Preset names carry no serial and no address, so they go in as they are:
    // which hash a slot shows and what it was learned as is exactly what a
    // "wrong preset name" report needs.
    const learned = allLearnedPresets();
    if (Object.keys(learned).length) {
        zip.addFile("presets.json", Buffer.from(JSON.stringify({ schemaVersion: 1, presets: learned }, null, 4)));
    }
}

/**
 * Adds a log file and its rotated history to the archive, oldest last.
 *
 * The numbering matches the download of a single log: the current file first,
 * `.rotated.1` behind it, so a listing that sorts by name keeps the order.
 *
 * @param {AdmZip} zip - the archive
 * @param {string} base - path and base name inside the archive
 * @param {string} filePath - the current log file
 * @param {function(string): string} mask - applied to the contents
 */
async function addLogFiles(zip, base, filePath, mask) {
    const files = await logFileSet(filePath);

    files.forEach((file, index) => {
        const suffix = index === 0 ? "current" : `rotated.${index}`;
        try {
            zip.addFile(`${base}.${suffix}.log`, Buffer.from(mask(fs.readFileSync(file, "utf-8"))));
        } catch {
            // A file that rotated away between the listing and the read is
            // normal and not worth failing the whole bundle for
        }
    });
}
