import fs from "fs-extra";
import path from "path";
import { rotateLogFile, setLogDetail, debug, TRACE_SUFFIX } from "./logger.js"; // importing it also activates the console overrides
import { configPath, serverLogFilePath, envPrinterSeed, logsDir } from "./config.js";
import { settings, LOG_LEVELS, LOG_CATEGORIES } from "./settings.js";
import { formatDateLog } from "./utils.js";

/**
 * The fields of a printer that live in printers.json. Everything else is runtime
 * state.
 *
 * `logDetail` is optional and every field inside it is too, which is what
 * "inherit the global setting" looks like on disk. It is checked separately
 * from these four, because they are all required strings and it is neither.
 */
const PERSISTED_FIELDS = ["id", "code", "ip", "name"];

// Whether this start built the printer list from PRINTER_ID, PRINTER_CODE and
// PRINTER_IP. Read by the deprecation notice, which has to tell "the variables
// are seeding the list right now" apart from "they are set but printers.json
// already owns the list" — and cannot do that by looking at the file, because
// the seed is written to it during this very import.
let seededFromEnvironment = false;

// Whether printers.json was there when this process started, before the seed
// above may have written it. Read by the upgrade notice: a 1.2.x installation
// has the file, a fresh one does not.
let fileExisted = false;

/**
 * Reads a stored per-printer log override, dropping anything unusable.
 *
 * Every field is optional and an unset one means "inherit the global setting",
 * so an unrecognised level or category is dropped rather than rejected: an
 * entry written by a newer version, or edited by hand, must not be able to stop
 * a printer from loading. An empty category list is a legitimate value and is
 * kept, which is how "no debug output from this printer" is stored.
 *
 * @param {*} raw - the stored `logDetail`, or anything else
 * @returns {{level?: string, categories?: string[], mqttTrace?: boolean}} the usable fields
 */
export function normalizeLogDetail(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

    const detail = {};

    if (typeof raw.level === "string" && LOG_LEVELS.includes(raw.level)) {
        detail.level = raw.level;
    }

    if (Array.isArray(raw.categories)) {
        detail.categories = [...new Set(
            raw.categories
                .map(entry => String(entry).trim().toLowerCase())
                .filter(entry => LOG_CATEGORIES.includes(entry)),
        )];
    }

    if (typeof raw.mqttTrace === "boolean") detail.mqttTrace = raw.mqttTrace;

    return detail;
}

/**
 * Whether the raw MQTT trace is on for a printer: its own setting when it has
 * one, the global switch otherwise.
 */
export function traceEnabled(printer) {
    return printer.logDetail?.mqttTrace ?? settings.MQTT_TRACE;
}

/**
 * Pushes a printer's level and category override into the logger.
 *
 * The logger cannot read it from here, because this module imports it. Called
 * whenever a printer is created or its override changes, and with an empty
 * override to go back to inheriting the global settings.
 *
 * @param {object} printer - the runtime printer object
 */
function applyLogDetail(printer) {
    const { level, categories } = printer.logDetail || {};
    setLogDetail(printer.logFilePath, level || categories ? { level, categories } : null);
}

/**
 * Builds the mutable runtime object every other module works with from a
 * printers.json entry.
 *
 * Everything beyond the user's four fields is runtime state: connection status,
 * the update interval bookkeeping, and the print consumption tracking that
 * `handlePrintStateChange` in `mqtt.js` advances.
 *
 * @param {object} entry - the stored printer entry
 * @returns {object} the runtime printer object
 */
function createRuntimePrinter(entry) {
    return {
        id: entry.id,
        code: entry.code,
        ip: entry.ip,
        name: entry.name,
        logFilePath: path.join(logsDir, `${entry.id}.log`),
        // The raw MQTT trace, next to the ordinary log and with its own size
        // budget. Written only while the trace is switched on for this printer.
        traceFilePath: path.join(logsDir, `${entry.id}${TRACE_SUFFIX}`),
        // Per-printer override of the log level, the categories and the trace.
        // Every field is optional; a missing one inherits the global setting.
        logDetail: normalizeLogDetail(entry.logDetail),
        mqttStatus: "Disconnected",
        mqttRunning: false,
        // The live MQTT client, and the bookkeeping around connecting to it:
        // whether a connect is in flight, when the last attempt was, how many
        // failed in a row, and why a close was asked for. See setupMqtt().
        mqttClient: null,
        isReconnecting: false,
        lastReconnectAttempt: 0,
        reconnectAttempts: 0,
        closingReason: null,
        // Set while a report is being processed, so the next one is dropped
        // rather than queued behind it. See handleMqttMessage().
        blockMqttUpdates: false,
        // When the last report arrived, when the last one with AMS data was
        // processed, and when the reception timestamp was last broadcast.
        lastMqttUpdate: null,
        lastMqttAmsUpdate: null,
        lastMqttBroadcast: 0,
        // The slots as the last processed report described them, which the
        // next report is compared against, and what the dashboard was built
        // from. Null forces the next report to be processed in full.
        lastAmsData: null,
        spoolData: [],
        update_interval: settings.UPDATE_INTERVAL,
        lastUpdateTime: new Date(),
        first_run: true,
        // The external spool holder as the last report that mentioned it
        // described it, see rememberedExternalSpoolUnits() in mqtt.js. Null
        // until a report names the holder, and again on every connection.
        lastExternalUnits: null,
        monitoringEnabled: true,
        // The growing wait between two reachability checks of a printer that
        // does not answer. See monitorPrinters() in mqtt.js.
        offlineChecks: 0,
        nextCheckAt: 0,
        offlineWaitLogged: null,
        // print consumption tracking
        currentGcodeState: "IDLE",
        currentJobName: null,
        // gcode_file as the printer reports it, which says whether the sliced
        // file is a .3mf (cloud) or a .gcode.3mf (LAN). See resolveRemotePaths().
        currentGcodeFile: null,
        // The file name the printer itself gave the job, from the project_file
        // command it sends for a print started on its screen. Null for a job
        // Bambu Studio sent. See localFileName() in mqtt.js.
        currentFileName: null,
        currentSliceInfo: null,
        // Whether the printer has its removable storage in, the USB stick of a
        // P2S, an H2 or an X2D and the microSD card of the others, from
        // print.sdcard. Null until a report carries the field. That storage is
        // what FTPS shows, so without it no sliced file can be read. See
        // noteStorage() in mqtt.js.
        storagePresent: null,
        // The slot whose filament is in the printing nozzle, and which nozzle
        // that is on a printer with two. Null until a report says. See
        // noteActiveSlot() in mqtt.js.
        activeSlot: null,
        activeNozzle: 0,
        // What the last slice info fetch tried and found. See fetchSliceInfo().
        lastSliceFetch: null,
        // The slots the printer says the running print is taking its filaments
        // from, decoded from print.mapping. Null until a print reports them.
        currentMapping: null,
        // The AMS refills of the running print, each a filament the printer
        // moved to another slot mid print, with the layer and the spool it
        // left. See refillsBetween() in gcode.js.
        refills: [],
        // The last bookable spool seen in each slot during the running print,
        // for a refill whose old slot reports empty by the time it happens.
        printSlotSpools: {},
        // A slice info download still running for the current job, shared
        // between the print handler and /api/print. See ensureSliceInfo().
        sliceFetchInFlight: null,
        // Where the sliced file of the running job was read from before a
        // restart of the service, from printstate.json. Tried first by the
        // next fetch, because nothing else may lead to it, see printstate.js.
        currentFilePath: null,
        // The slots Bambu Studio sent the next job to, from the project_file
        // command the printer echoes before the print starts. Consumed by the
        // start of that print, see notePrintCommand() in mqtt.js.
        pendingMapping: null,
        // The file name from that same command, taken by the print of that
        // name the way pendingMapping is.
        pendingFileName: null,
        // What that same command says about the file: md5, MakerWorld ids and
        // plate. See printIdentity() in mqtt.js.
        pendingIdentity: null,
        currentIdentity: null,
        currentLayerNum: 0,
        staleLayerNum: null,
        // total_layer_num as last reported, which a sliced file found by
        // listing has to match. See findSlicedFileByTime() in gcode.js.
        currentTotalLayers: null,
        // The previous job's total_layer_num, repeated after a start and
        // ignored until the printer reports another, like staleLayerNum.
        staleTotalLayers: null,
        consumptionBooked: false,
        sliceFetchDone: false,
        // When the running print became active, in epoch milliseconds. Measured
        // here because the printer reports no start time of its own: a P2S
        // carries neither `gcode_start_time` nor anything like it in its 98
        // report fields. A restart mid print therefore loses it, and the
        // summary says the duration is unknown rather than inventing one.
        printStartedAt: null,
        // Whether a report with a state has been read since the process started;
        // the first one may find a print already running. See handlePrintStateChange().
        stateSeenSinceStart: false,
        // The last error the printer named during this print. Collected across
        // reports rather than read from the one that ends the job: a P2S
        // stopped by hand reports the code one report after the state, and
        // clears it the report after that.
        lastPrintError: null,
        lastPrintErrorDetails: null,
        // The complaint the printer was already carrying when this print
        // started. It lags the state by a report, so it has to be held back
        // until the printer clears it. See handlePrintStateChange in mqtt.js.
        staleErrorText: null,
        // What the printer says about the job it is doing right now: the stage
        // it is in (`stg_cur`) and the minutes it thinks are left
        // (`mc_remaining_time`). Display only, refreshed on every report rather
        // than on the slot interval, and meaningless once the print has ended.
        currentStage: null,
        currentRemainingMinutes: null,
        // The closing report of the last finished print: what was booked, what
        // was skipped and why. Held in memory only, dropped when the next print
        // starts, and never written anywhere.
        lastPrintSummary: null,
        // Whether the result of the last print has been cleared from the
        // dashboard, by the timer below or by hand. It cannot be derived from
        // the state: the printer keeps repeating its terminal `gcode_state` in
        // every report for as long as it sits there, so without this flag the
        // next report would put the finished print straight back on the card.
        printResultDismissed: false,
        // When the result clears itself, in epoch milliseconds. Null when no
        // timer is running, which is the case before the first print and when
        // PRINT_RESET_MINUTES is 0.
        printResetAt: null,
        // Humidity, temperature and drying state per AMS unit, for the header
        // of each unit's table. Display only: it never reaches Spoolman, and it
        // is refreshed on every report rather than on the slot update interval.
        amsEnv: [],
        lastAmsEnvBroadcast: null,
        lastAmsEnvBroadcastTime: 0,
        // Which AMS each unit is, by unit label, from the printer's get_version
        // answer. Requested once per connection, see requestVersion() in
        // mqtt.js; kept across reconnects because the hardware does not change
        // between two of them.
        amsModels: {},
        // How many AMS updates a slot has been waiting for its remain reading,
        // keyed by slot label. See waitedLongEnoughForRemain() in mqtt.js.
        remainWaits: {},
    };
}

/**
 * Checks one printer entry.
 *
 * @param {object} entry - the entry to check
 * @param {object[]} existing - the printers already known, for the duplicate check
 * @param {string|null} ignoreId - id of the entry being edited, excluded from that check
 * @returns {string|null} an error message, or null when the entry is usable
 */
export function validatePrinterEntry(entry, existing = [], ignoreId = null) {
    if (!entry || typeof entry !== "object") return "Printer must be an object";

    for (const field of PERSISTED_FIELDS) {
        const value = entry[field];
        if (typeof value !== "string" || value.trim() === "") {
            return `Printer field "${field}" is required`;
        }
    }

    const id = entry.id.trim().toUpperCase();
    if (existing.some(p => p.id === id && p.id !== ignoreId)) {
        return `A printer with the serial number ${id} already exists`;
    }

    return null;
}

/** A printer entry without its access code, for log output. */
function redactPrinter({ code, ...rest }) {
    return rest;
}

/**
 * Normalises an entry to the shape stored in printers.json.
 *
 * `logDetail` is left out when nothing is overridden, so a printer that follows
 * the global settings keeps the file as short as it was before this existed.
 */
export function normalizePrinterEntry(entry) {
    const normalized = {
        id: entry.id.trim().toUpperCase(),
        code: entry.code.trim(),
        ip: entry.ip.trim(),
        name: entry.name.trim(),
    };

    const logDetail = normalizeLogDetail(entry.logDetail);
    if (Object.keys(logDetail).length) normalized.logDetail = logDetail;

    return normalized;
}

/**
 * Reads `printers/printers.json`.
 *
 * A single invalid entry rejects the whole file, because a partially loaded
 * printer list is harder to diagnose than none at all. On any failure the
 * PRINTER_ID, PRINTER_CODE and PRINTER_IP environment variables are tried as a
 * single printer seed, which is how the Home Assistant add-on and the simplest
 * Docker setups are configured. That seed is written to printers.json, so the
 * file owns the printer list from then on and the Web UI can edit it.
 *
 * An empty list is a valid result. The service starts anyway so that printers
 * can be added in the Web UI.
 *
 * @returns {object[]} the runtime printer list, possibly empty
 */
function loadPrintersConfig() {
    let entries = null;

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        fileExisted = true;
        if (!Array.isArray(parsed)) throw new Error("printers.json must contain an array");

        parsed.forEach(printer => {
            const error = validatePrinterEntry(printer, []);
            if (error) throw new Error(`Invalid printer configuration: ${JSON.stringify(printer)} (${error})`);
        });

        entries = parsed.map(normalizePrinterEntry);
        // Never log the access code. The log files are downloadable from the Web
        // UI and end up attached to bug reports.
        debug("service", "Server", serverLogFilePath, "Printers loaded successfully:", entries.map(redactPrinter));
    } catch (error) {
        if (error.code !== "ENOENT") {
            fileExisted = true;
            console.error("Server", serverLogFilePath, "Error loading printers configuration:", error.message);
        }

        if (envPrinterSeed.id && envPrinterSeed.code && envPrinterSeed.ip) {
            console.log("Server", serverLogFilePath, "Seeding the printer list from the PRINTER_ID, PRINTER_CODE and PRINTER_IP variables...");
            seededFromEnvironment = true;
            entries = [normalizePrinterEntry({
                id: envPrinterSeed.id,
                code: envPrinterSeed.code,
                ip: envPrinterSeed.ip,
                name: "Bambu Lab Printer",
            })];
        } else {
            debug("service", "Server", serverLogFilePath, "No printers.json and no printer environment variables, starting with an empty list.");
            entries = [];
        }
    }

    const runtime = entries.map(createRuntimePrinter);
    runtime.forEach(applyLogDetail);

    // Persist the seeded list so that printers.json is the source of truth from
    // the first start on, which is what makes the Web UI able to edit it.
    if (entries.length && !fs.existsSync(configPath)) {
        savePrinters(runtime);
    }

    return runtime;
}

/** Whether the printer list of this run came from the PRINTER_* variables. */
export function printerListSeededFromEnv() {
    return seededFromEnvironment;
}

/** Whether printers.json existed when this process started. */
export function printerFileExistedAtStart() {
    return fileExisted;
}

/**
 * Writes the printer list back to `printers/printers.json` atomically, so a
 * crash mid write cannot truncate it. Only the persisted fields are written;
 * runtime state never reaches the file.
 *
 * @param {object[]} list - the runtime printer list to persist
 */
function savePrinters(list = printers) {
    const entries = list.map(printer => {
        const entry = {
            id: printer.id,
            code: printer.code,
            ip: printer.ip,
            name: printer.name,
        };

        // Left out entirely while the printer follows the global settings, so
        // the file of an installation that never opens the dialog is unchanged
        const logDetail = normalizeLogDetail(printer.logDetail);
        if (Object.keys(logDetail).length) entry.logDetail = logDetail;

        return entry;
    });

    const tmp = `${configPath}.tmp`;
    fs.ensureDirSync(path.dirname(configPath));
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 4));
    fs.renameSync(tmp, configPath);
}

/**
 * Creates the log file of a printer, or rotates it when it has grown too large.
 *
 * Nothing ever truncated these files: they were created once and appended to
 * from then on. Called on every start, and the append path checks the size
 * while the service runs.
 *
 * @param {object} printer - the runtime printer object
 */
export function ensurePrinterLogFile(printer) {
    if (fs.existsSync(printer.logFilePath)) {
        rotateLogFile(printer.logFilePath);
        return;
    }

    fs.writeFile(printer.logFilePath, `Log started at: ${formatDateLog(new Date())}\n`, err => {
        if (err) {
            console.error(printer.name, printer.logFilePath, `Failed to create log file: ${err.message}`);
        } else {
            console.log(printer.name, printer.logFilePath, "Log file created");
        }
    });
}

/**
 * Adds a printer and persists the list.
 *
 * @param {object} entry - id, code, ip and name
 * @returns {{ok: true, printer: object}|{ok: false, error: string}}
 */
export function addPrinter(entry) {
    const error = validatePrinterEntry(entry, printers);
    if (error) return { ok: false, error };

    const printer = createRuntimePrinter(normalizePrinterEntry(entry));
    printers.push(printer);
    applyLogDetail(printer);
    savePrinters();
    ensurePrinterLogFile(printer);

    return { ok: true, printer };
}

/**
 * Replaces the log override of one printer and persists it.
 *
 * Its own entry point rather than a field of `updatePrinter()`, because that one
 * validates address and access code and decides whether to reconnect, and none
 * of that has anything to do with how much a printer writes to its log.
 *
 * @param {string} printerId - serial number of the printer
 * @param {object|null} detail - the override, or null to follow the global settings
 * @returns {{ok: true, printer: object}|{ok: false, error: string}}
 */
export function updatePrinterLogDetail(printerId, detail) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return { ok: false, error: "Printer not found" };

    printer.logDetail = normalizeLogDetail(detail);
    applyLogDetail(printer);
    savePrinters();

    return { ok: true, printer };
}

/**
 * Updates name, address or access code of a printer and persists the list.
 *
 * The serial number is immutable: it keys the MQTT topic, the log file and the
 * spool assignments, so changing it would describe a different printer. Pass an
 * empty access code to keep the stored one, which is what the Web UI sends
 * because it never displays the code it already has.
 *
 * @param {string} printerId - serial number of the printer to change
 * @param {object} patch - name, ip and code
 * @returns {{ok: true, printer: object, reconnect: boolean}|{ok: false, error: string}}
 */
export function updatePrinter(printerId, patch) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return { ok: false, error: "Printer not found" };

    const merged = {
        id: printer.id,
        name: patch?.name ?? printer.name,
        ip: patch?.ip ?? printer.ip,
        code: patch?.code?.trim() ? patch.code : printer.code,
    };

    const error = validatePrinterEntry(merged, printers, printer.id);
    if (error) return { ok: false, error };

    const normalized = normalizePrinterEntry(merged);
    // Only an address or credential change needs the MQTT connection rebuilt.
    const reconnect = normalized.ip !== printer.ip || normalized.code !== printer.code;

    printer.name = normalized.name;
    printer.ip = normalized.ip;
    printer.code = normalized.code;
    savePrinters();

    return { ok: true, printer, reconnect };
}

/**
 * Removes a printer from the list and persists it. The log file is kept.
 *
 * @param {string} printerId - serial number of the printer to remove
 * @returns {{ok: true, printer: object}|{ok: false, error: string}}
 */
export function removePrinter(printerId) {
    const index = printers.findIndex(p => p.id === printerId);
    if (index === -1) return { ok: false, error: "Printer not found" };

    const [printer] = printers.splice(index, 1);
    savePrinters();

    return { ok: true, printer };
}

/**
 * Applies a changed slot update interval to every printer.
 *
 * The interval is copied onto the printer object when it is created, so a
 * settings change has to be pushed into the existing objects as well.
 */
export function syncPrinterIntervals() {
    for (const printer of printers) {
        printer.update_interval = settings.UPDATE_INTERVAL;
    }
}

/**
 * Makes every printer read its slots again on the next report, whether or not
 * anything in them changed.
 *
 * The AMS update only runs when a slot or a Spoolman spool changed, so a
 * setting that changes what a slot means, such as switching the automatic
 * assignment on, would otherwise wait for the next spool to move.
 */
export function reprocessSlotsOnNextReport() {
    for (const printer of printers) {
        printer.lastAmsData = null;
    }
}

export const printers = loadPrintersConfig();
