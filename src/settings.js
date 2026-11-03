import fs from "fs-extra";
import path from "path";
import { settingsPath, envSeed, supervised } from "./config.js";
import { hashPassword, isPasswordHash } from "./passwords.js";
import { DEFAULT_LOCATION_FORMAT } from "../public/shared.js";

/**
 * Runtime configuration, persisted to `printers/settings.json`.
 *
 * Values resolve in three layers: the schema default, then the matching
 * environment variable when one is set, then the stored file. The file wins,
 * so a value changed in the Web UI survives a restart even when the container
 * still passes the old environment variable. An environment variable therefore
 * only seeds a setting that has never been written, which also keeps a setting
 * added in a later version honouring its variable on an existing install.
 *
 * This module must not import logger.js. logger.js reads the log level from
 * here, and an import cycle between the two would run this file before the
 * console overrides exist. Problems found while loading are collected in
 * `settingsLoadIssues` and logged by backend.js once logging is up.
 */

/**
 * How much detail a log file carries, quietest first.
 *
 * The order is the ladder: a line is written when its own level sits at or
 * below the configured one, which is what lets the settings page draw it as a
 * slider rather than as four unrelated choices. `normal` is what an
 * installation ran with before this existed and `debug` is the old
 * `DEBUG=true`, minus the full payload dumps that moved up to `trace`: they are
 * written on every update interval and they were the reason a debug log became
 * unreadable within minutes.
 */
export const LOG_LEVELS = ["errors", "normal", "debug", "trace"];

/**
 * The areas a debug or trace line can belong to.
 *
 * Only those two are filtered. Errors and the ordinary progress lines are
 * always written, because an area switched off must not be able to hide a
 * failure. A line whose category is not in this list is never filtered either,
 * which is what keeps an uncategorised `console.debug` visible.
 */
export const LOG_CATEGORIES = ["mqtt", "ams", "spoolman", "gcode", "print", "service"];

/**
 * Field definitions.
 *
 * `restartRequired` marks a setting the running process cannot adopt safely;
 * the UI shows it and the value is stored but only takes effect on the next
 * start. `advanced` moves a field into the collapsed part of its group, for
 * everything an ordinary install never touches. `dialog` takes a field out of
 * the card's field grid entirely and hands it to the named dialog, for a group
 * of fields that belong together and that a printer can override.
 */
export const SETTINGS_SCHEMA = {
    SPOOLMAN_ENDPOINT: {
        type: "string",
        default: null,
        group: "spoolman",
        label: "Spoolman endpoint",
        description: "Full base URL of the Spoolman instance, for example http://192.168.1.9:7912. Takes precedence over host and port.",
    },
    SPOOLMAN_IP: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman host",
        description: "Host name or IP of the Spoolman instance. Only used when no endpoint is set.",
    },
    SPOOLMAN_PORT: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman port",
        description: "Port of the Spoolman instance. Only used when no endpoint is set.",
    },
    SPOOLMAN_SUBFOLDER: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman subfolder",
        description: "Path prefix when Spoolman runs behind a reverse proxy, for example /spoolman.",
    },
    SPOOLMAN_FQDN: {
        type: "string",
        default: null,
        group: "spoolman",
        advanced: true,
        label: "Spoolman public URL",
        description: "Address the Web UI links to. Set this when the browser reaches Spoolman under a different name than this service does.",
    },
    MODE: {
        type: "enum",
        options: ["manual", "automatic"],
        default: "manual",
        group: "tracking",
        label: "Operation mode",
        description: "Automatic creates and merges spools in Spoolman without asking. Manual waits for a decision in the Web UI.",
    },
    LEGACY_MODE: {
        type: "boolean",
        default: false,
        restartRequired: true,
        group: "tracking",
        label: "Legacy mode",
        description: "Derives the spool weight from the AMS RFID remain percentage instead of tracking consumption from the sliced G-code. Disables 3rd party spool support and manual assignments.",
    },
    AUTO_ASSIGN_THIRD_PARTY: {
        type: "boolean",
        default: false,
        group: "tracking",
        label: "Assign 3rd party spools automatically",
        description: "Links a spool without an RFID tag to the one Spoolman spool of the same material and colour, when there is exactly one that carries no tag and sits in no other slot. With two or more the slot waits for a choice in the Web UI. Nothing is created in Spoolman.",
    },
    PRINT_RESET_MINUTES: {
        type: "integer",
        default: 10,
        min: 0,
        max: 240,
        group: "tracking",
        label: "Clear print result after",
        description: "Minutes a finished print stays on the dashboard before the card returns to idle. Its summary stays reachable until the next print. 0 keeps the result until it is cleared by hand.",
    },
    UPDATE_INTERVAL: {
        type: "integer",
        default: 120000,
        min: 5000,
        max: 300000,
        group: "sync",
        label: "Slot update interval",
        description: "Milliseconds between two processed slot reports per printer. Covers the AMS slots and the external spool holder.",
    },
    SET_LOCATION: {
        type: "boolean",
        default: false,
        group: "sync",
        label: "Write slot as location",
        description: "Stores printer name and slot of the loaded spool as its location in Spoolman.",
    },
    LOCATION_FORMAT: {
        type: "string",
        default: DEFAULT_LOCATION_FORMAT,
        group: "sync",
        advanced: true,
        label: "Location format",
        description: "Template of the location written while the slot is stored as location. {printer} is replaced by the printer name and is required, {unit} by the AMS unit, for example A or HT-A, {number} by the position in it, for example 3, and {slot} by the slot, for example A3. \"{printer} AMS {unit}\" gives the four spools of a unit one location, \"{printer}\" alone stores the printer name.",
    },
    ARCHIVE_EMPTY_SPOOLS: {
        type: "boolean",
        default: false,
        group: "sync",
        label: "Archive empty spools",
        description: "Archives a spool in Spoolman as soon as its remaining weight reaches the empty threshold. Archiving is reversible, nothing is deleted.",
    },
    EMPTY_SPOOL_THRESHOLD: {
        type: "integer",
        default: 0,
        min: 0,
        max: 100,
        group: "sync",
        advanced: true,
        label: "Empty threshold",
        description: "Grams left at which a spool counts as empty. Only used when empty spools are archived.",
    },
    NEVER_MERGE_IF_TAG: {
        type: "boolean",
        default: false,
        group: "sync",
        label: "Never merge a tagged spool",
        description: "Skips any Spoolman spool that already carries a tag when looking for a merge candidate.",
    },
    OFFLINE_CHECK_INTERVAL: {
        type: "integer",
        default: 20000,
        min: 20000,
        max: 3600000,
        group: "printer",
        label: "Offline check interval",
        description: "Milliseconds between two reachability checks of a disconnected printer.",
    },
    OFFLINE_MAX_INTERVAL: {
        type: "integer",
        default: 300000,
        min: 20000,
        max: 3600000,
        group: "printer",
        advanced: true,
        label: "Offline backoff limit",
        description: "Longest wait between two reachability checks of a printer that stays unreachable. The wait doubles from the offline check interval up to this value. Set it to the check interval to keep the pace constant.",
    },
    MAX_RETRIES: {
        type: "integer",
        default: 0,
        min: 0,
        max: 1000,
        group: "printer",
        label: "Max connection retries",
        description: "Failed connection attempts before monitoring is disabled for a printer. 0 retries forever.",
    },
    LOG_LEVEL: {
        type: "enum",
        options: LOG_LEVELS,
        default: "normal",
        group: "logging",
        // Edited in the log detail dialog rather than in the field grid, next to
        // the categories it works with. Listed here so the dialog can render it
        // from the schema instead of holding a second copy of the ladder.
        dialog: "logDetail",
        label: "Log level",
        description: "How much every log file carries. Errors writes failures only, normal adds the ordinary progress lines, debug adds the internal steps, and trace adds the full Spoolman and AMS payloads behind them.",
    },
    LOG_CATEGORIES: {
        type: "set",
        options: LOG_CATEGORIES,
        default: [...LOG_CATEGORIES],
        group: "logging",
        dialog: "logDetail",
        label: "Logged areas",
        description: "Which parts of the service write their debug and trace lines. Errors and the ordinary progress lines are never filtered, so switching an area off cannot hide a failure.",
    },
    MQTT_TRACE: {
        type: "boolean",
        default: false,
        group: "logging",
        dialog: "logDetail",
        label: "Capture raw MQTT messages",
        description: "Writes every report a printer sends into its own trace file, unparsed and one line per message. For analysing a problem afterwards against the data the printer really sent. It stays on until it is switched off.",
    },
    MQTT_TRACE_MAX_SIZE_MB: {
        type: "integer",
        default: 50,
        min: 1,
        max: 500,
        group: "logging",
        dialog: "logDetail",
        label: "Trace file size (MB)",
        // 50 rather than 10: measured on a P2S the capture runs at about 21 MB
        // an hour, so the original default held 85 minutes across all its files
        // and a fault that only shows up now and then was never in it.
        description: "Size a trace file may reach before it is rotated. This is what decides how far back a trace reaches: measured on a P2S it runs at around 22 MB an hour, idle and through a print alike, so this size plus the kept files is roughly that many hours of history.",
    },
    MQTT_TRACE_KEEP: {
        type: "integer",
        default: 2,
        min: 0,
        max: 20,
        group: "logging",
        dialog: "logDetail",
        label: "Kept trace files",
        description: "How many rotated trace files to keep per printer, next to the current one.",
    },
    LOG_MAX_SIZE_MB: {
        type: "integer",
        default: 1,
        min: 1,
        max: 100,
        group: "logging",
        label: "Log file size (MB)",
        description: "Size a log file may reach before it is rotated. The current file is renamed and an empty one takes its place.",
    },
    LOG_KEEP_SERVER: {
        type: "integer",
        default: 2,
        min: 0,
        max: 20,
        group: "logging",
        label: "Kept server logs",
        description: "How many rotated server logs to keep next to the current one. 0 starts the current one over instead of keeping history.",
    },
    LOG_KEEP_PRINTER: {
        type: "integer",
        default: 2,
        min: 0,
        max: 20,
        group: "logging",
        label: "Kept printer logs",
        description: "How many rotated logs to keep per printer. Every printer has its own file, so this multiplies with the number of printers.",
    },
    AUTH_PASSWORD: {
        type: "password",
        default: null,
        group: "network",
        label: "Web UI password",
        description: "Ask for this password before anything in the Web UI is shown. Leave it empty to keep the Web UI open to everyone on the network, which is how it behaved before. It is stored as a scrypt hash and never sent back to the browser.",
    },
    ALLOWED_HOSTS: {
        type: "string",
        default: null,
        group: "network",
        label: "Allowed host names",
        description: "Host names this service may be addressed under, comma separated, for example ams.example.com. IP addresses, localhost and .local names are always accepted, so most installations leave this empty. Set it when the Web UI is reached under a real domain name or through a reverse proxy, otherwise those requests are answered with 403.",
    },
};

/** Problems seen while loading the settings file, logged by backend.js. */
export const settingsLoadIssues = [];

/**
 * The resolved settings every other module reads.
 *
 * Mutated in place so that importers keep working against the same object.
 * Never reassign this binding.
 */
export const settings = {};

/**
 * Normalises the operation mode.
 *
 * "auto" is accepted as a shorthand for "automatic"; anything unrecognised
 * falls back to manual. `valid` is reported separately so a typo in the
 * environment variable can be warned about instead of silently behaving like
 * manual mode.
 *
 * @param {string|undefined} raw - the raw mode value
 * @returns {{raw: string, mode: "automatic"|"manual", valid: boolean}}
 */
export function resolveMode(raw) {
    const value = (raw || "manual").trim();
    const normalized = value.toLowerCase();
    return {
        raw: value,
        mode: normalized === "automatic" || normalized === "auto" ? "automatic" : "manual",
        valid: ["automatic", "auto", "manual"].includes(normalized),
    };
}

/**
 * Turns one raw value into the type the field expects.
 *
 * Accepts what both sources can deliver: a string from an environment variable
 * or an HTML form, and a real boolean or number from the settings file or a
 * JSON request body. An out of range number is clamped rather than rejected,
 * which is what the environment variables did before.
 *
 * @param {string} key - field name
 * @param {*} raw - the value to coerce
 * @returns {{value: *}|{error: string}} the coerced value, or a message
 */
export function coerceSetting(key, raw) {
    const field = SETTINGS_SCHEMA[key];
    if (!field) return { error: `Unknown setting "${key}"` };

    if (raw === null || raw === undefined || raw === "") {
        return { value: field.type === "string" ? null : field.default };
    }

    if (field.type === "string") {
        const value = String(raw).trim();
        // Without the printer in it a location cannot be told from one typed
        // by hand or from another printer's, and the service would clear and
        // rewrite locations it never wrote. See `matchesLocationFormat()`.
        if (key === "LOCATION_FORMAT" && value !== "" && !value.includes("{printer}")) {
            return { error: "LOCATION_FORMAT must contain {printer}" };
        }
        return { value: value === "" ? null : value };
    }

    // A password arrives in clear text, from the settings page or from the
    // variable that seeds it, and only ever the hash is stored. A value that is
    // already a hash is the settings file being read back and is kept as it is,
    // which is what stops it from being hashed again on every start.
    if (field.type === "password") {
        const value = String(raw).trim();
        if (value === "") return { value: null };
        return { value: isPasswordHash(value) ? value : hashPassword(value) };
    }

    if (field.type === "boolean") {
        if (typeof raw === "boolean") return { value: raw };
        const value = String(raw).trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(value)) return { value: true };
        if (["false", "0", "no", "off"].includes(value)) return { value: false };
        return { error: `${key} must be true or false` };
    }

    if (field.type === "integer") {
        const parsed = typeof raw === "number" ? Math.trunc(raw) : parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(parsed)) return { error: `${key} must be a whole number` };
        let value = parsed;
        if (field.min !== undefined) value = Math.max(value, field.min);
        if (field.max !== undefined) value = Math.min(value, field.max);
        return { value };
    }

    // A set is stored as an array and accepted as one or as the comma separated
    // string an environment variable can carry. Unknown members are dropped
    // rather than rejected, so a category removed in a later version does not
    // make the whole stored value unreadable; an empty result is a legitimate
    // "nothing selected" and is kept.
    if (field.type === "set") {
        const list = Array.isArray(raw) ? raw : String(raw).split(",");
        const value = list
            .map(entry => String(entry).trim().toLowerCase())
            .filter(entry => field.options.includes(entry));
        return { value: [...new Set(value)] };
    }

    if (field.type === "enum") {
        if (key === "MODE") {
            const resolved = resolveMode(String(raw));
            if (!resolved.valid) return { error: `MODE "${resolved.raw}" is not valid, use "automatic" or "manual"` };
            return { value: resolved.mode };
        }
        const value = String(raw).trim().toLowerCase();
        if (!field.options.includes(value)) return { error: `${key} must be one of ${field.options.join(", ")}` };
        return { value };
    }

    return { error: `${key} has an unsupported type` };
}

/**
 * Builds the effective value of every field from default, environment seed and
 * stored file, in that order.
 *
 * A value that cannot be coerced does not abort the merge. It is reported and
 * the layer below it is kept, because refusing to start over one bad number in
 * a config file is worse than running with the documented default.
 *
 * @param {object} stored - the parsed settings file
 * @param {object} env - the raw environment values
 * @param {string[]} issues - collects messages about ignored values
 * @returns {object} the effective settings
 */
export function resolveSettings(stored = {}, env = {}, issues = []) {
    const resolved = {};

    for (const [key, field] of Object.entries(SETTINGS_SCHEMA)) {
        // Copied, not referenced: a set default is an array and handing the
        // schema's own object out would let a later write mutate the default
        resolved[key] = Array.isArray(field.default) ? [...field.default] : field.default;

        for (const [layer, source] of [["environment", env], ["settings.json", stored]]) {
            if (source == null || !Object.prototype.hasOwnProperty.call(source, key)) continue;
            if (source[key] === undefined) continue;

            const result = coerceSetting(key, source[key]);
            if (result.error) {
                issues.push(`Ignoring ${key} from ${layer}: ${result.error}`);
                continue;
            }
            resolved[key] = result.value;
        }
    }

    return resolved;
}

/**
 * Reports where each field's effective value came from, so the Web UI can tell
 * the user that a value was seeded by an environment variable and is now owned
 * by the settings file.
 *
 * @param {object} stored - the parsed settings file
 * @param {object} env - the raw environment values
 * @returns {Object<string, "file"|"environment"|"default">}
 */
export function describeSources(stored = {}, env = {}) {
    const sources = {};
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
        if (stored && stored[key] !== undefined) sources[key] = "file";
        else if (env && env[key] !== undefined && env[key] !== "") sources[key] = "environment";
        else sources[key] = "default";
    }
    return sources;
}

/**
 * The settings whose effective value still comes from an environment variable,
 * meaning they have never been saved in the Web UI.
 *
 * Configuring the service through the environment is deprecated since 1.3.0. It
 * keeps working, and this is what tells the log line and the Web UI hint which
 * variables are actually still in charge, so neither of them warns about a
 * variable the settings file has long since taken over.
 *
 * @returns {string[]} the variable names, in schema order
 */
export function envSeededKeys() {
    const sources = describeSources(storedSettings, envSeed);
    return Object.keys(SETTINGS_SCHEMA).filter(key => sources[key] === "environment");
}

/**
 * The shape version of `settings.json`. Bump it when a stored key is renamed or
 * its meaning changes, and handle the old value in `migrateStored()`.
 */
export const SETTINGS_SCHEMA_VERSION = 2;

let storedSettings = {};
// Notices the user has dismissed in the Web UI, keyed by notice id. Stored
// beside the values rather than among them, because acknowledging a hint must
// not make the file own a setting; only a real save does that.
let storedNotices = {};
// Counts writes. The settings page sends back the revision it read, so a save
// against a state somebody else has already replaced is refused rather than
// silently overwriting it.
let storedRevision = 0;

/**
 * Reads the two shapes the file can have.
 *
 * The first version stored the values flat at the top level. Everything since
 * wraps them, so the file can carry its schema version and the write counter.
 * Existing installs have the flat file on disk and there is no migration step,
 * so the read side stays tolerant of it.
 *
 * @param {object} parsed - the parsed file contents
 * @returns {{values: object, revision: number, schemaVersion: number}}
 */
export function parseStoredFile(parsed) {
    if (parsed && typeof parsed.values === "object" && parsed.values !== null && !Array.isArray(parsed.values)) {
        return {
            values: parsed.values,
            revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
            schemaVersion: Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : SETTINGS_SCHEMA_VERSION,
            notices: parsed.notices && typeof parsed.notices === "object" && !Array.isArray(parsed.notices)
                ? parsed.notices
                : {},
        };
    }

    return { values: parsed ?? {}, revision: 0, schemaVersion: 0, notices: {} };
}

/**
 * Brings a stored set of values up to the current schema version.
 *
 * Version 0 is the flat file, whose keys are the same as version 1's. Version 2
 * replaced the `DEBUG` switch with the `LOG_LEVEL` ladder: a stored `true`
 * becomes `debug` and a stored `false` becomes `normal`.
 *
 * Both are written, including the `false`. A value in this file is one the user
 * saved, and the file beats the environment variable: an installation whose
 * `.env` carries `DEBUG=true` and whose file says `false` is one where somebody
 * turned debug logging off in the Web UI and expects it to stay off. Dropping
 * the `false` would leave `LOG_LEVEL` unowned, the `DEBUG` variable would seed
 * it on the next start, and the upgrade would quietly turn debug logging back
 * on against an explicit decision.
 *
 * @param {object} values - the stored values
 * @param {number} schemaVersion - the version they were written with
 * @returns {object} the values in the current shape
 */
export function migrateStored(values, schemaVersion) {
    if (schemaVersion >= SETTINGS_SCHEMA_VERSION) return values;

    const migrated = { ...values };

    if (schemaVersion < 2 && Object.prototype.hasOwnProperty.call(migrated, "DEBUG")) {
        const wasOn = migrated.DEBUG === true
            || ["true", "1", "yes", "on"].includes(String(migrated.DEBUG).trim().toLowerCase());
        delete migrated.DEBUG;
        // A LOG_LEVEL already set wins, which is the case of a file written by a
        // newer version and read back by this one
        if (migrated.LOG_LEVEL === undefined) migrated.LOG_LEVEL = wasOn ? "debug" : "normal";
    }

    return migrated;
}

// Whether settings.json was there when this process started. Read by the
// upgrade notice, which tells a 1.2.x installation apart from a fresh one by
// exactly this: 1.2.x never wrote the file, and a fresh 1.3.0 install has no
// printers.json either.
let settingsFileExisted = false;

/** Reads the settings file, treating a missing or unreadable file as empty. */
function readStoredSettings() {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        settingsFileExisted = true;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("settings.json must contain an object");
        }

        const file = parseStoredFile(parsed);
        storedRevision = file.revision;
        storedNotices = file.notices;
        return migrateStored(file.values, file.schemaVersion);
    } catch (err) {
        if (err.code !== "ENOENT") {
            settingsFileExisted = true;
            settingsLoadIssues.push(`Could not read settings.json, falling back to environment and defaults: ${err.message}`);
        }
        return {};
    }
}

/** Whether settings.json existed when this process started. */
export function settingsFileExistedAtStart() {
    return settingsFileExisted;
}

/** Writes the settings file atomically, so a crash mid write cannot truncate it. */
function persist() {
    const tmp = `${settingsPath}.tmp`;
    const payload = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        revision: storedRevision,
        values: storedSettings,
        notices: storedNotices,
    };

    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 4));
    fs.renameSync(tmp, settingsPath);
}

/**
 * Loads the settings once at process start.
 *
 * Nothing is written here. The file appears on the first save from the Web UI,
 * so an installation that never opens the settings page keeps behaving exactly
 * like before, driven by its environment variables alone.
 */
function loadSettings() {
    storedSettings = readStoredSettings();
    Object.assign(settings, resolveSettings(storedSettings, envSeed, settingsLoadIssues));
}

loadSettings();

/**
 * The notices the user has dismissed, keyed by notice id.
 *
 * @returns {Object<string, boolean>}
 */
export function getAcknowledgedNotices() {
    return { ...storedNotices };
}

/**
 * Marks a notice as pending, in memory only, unless the file already knows it.
 *
 * A pending notice is stored as `false`, an acknowledged one as `true`, and one
 * the file never heard of is absent. Nothing is written here, for the reason
 * `loadSettings()` gives; the mark rides along with whatever writes the file
 * next, a save on the settings page or the acknowledgement of another notice.
 * That is what keeps a notice from being lost when the condition that raised
 * it, such as a missing settings.json, is gone by the next start.
 *
 * @param {string} id - the notice id
 */
export function markNoticePending(id) {
    if (storedNotices[id] === undefined) {
        storedNotices = { ...storedNotices, [id]: false };
    }
}

/**
 * Records that a notice was dismissed in the Web UI and persists it.
 *
 * Writing this creates settings.json on an installation that has never saved
 * anything. That is deliberate and harmless: the file is written with an empty
 * value set, so every setting still resolves from its environment variable
 * exactly as before.
 *
 * @param {string} id - the notice id
 */
export function acknowledgeNotice(id) {
    storedNotices = { ...storedNotices, [id]: true };
    persist();
}

/**
 * The tracking mode this process runs in, frozen at startup.
 *
 * The two tracking modes are mutually exclusive and book consumption
 * differently, so switching while a print is in flight would book it twice or
 * not at all. `settings.LEGACY_MODE` therefore only holds what is stored and
 * what the settings page shows; everything that decides how a report is
 * processed reads this instead, and the stored value takes effect on the next
 * start. That is what the schema means by `restartRequired`.
 */
const bootLegacyMode = settings.LEGACY_MODE;

/** Whether this process is tracking through the AMS RFID remain percentage. */
export function legacyMode() {
    return bootLegacyMode;
}

/** Whether the stored tracking mode differs from the one this process started with. */
export function legacyModeNeedsRestart() {
    return settings.LEGACY_MODE !== bootLegacyMode;
}

/**
 * Builds the Spoolman base URL from a set of values.
 *
 * Takes the values explicitly so the settings page can test an endpoint before
 * it is saved. The endpoint wins over host and port; a subfolder is appended to
 * whichever of the two produced the base.
 *
 * @param {object} values - SPOOLMAN_ENDPOINT, SPOOLMAN_IP, SPOOLMAN_PORT and
 *   SPOOLMAN_SUBFOLDER, in the shape the schema defines
 * @returns {string} the base URL, or an empty string when nothing is configured
 */
export function buildSpoolmanUrl(values = {}) {
    let base = "";
    if (values.SPOOLMAN_ENDPOINT) {
        base = values.SPOOLMAN_ENDPOINT;
    } else if (values.SPOOLMAN_IP) {
        base = values.SPOOLMAN_PORT
            ? `http://${values.SPOOLMAN_IP}:${values.SPOOLMAN_PORT}`
            : `http://${values.SPOOLMAN_IP}`;
    }

    base = String(base).trim().replace(/\/+$/, "");
    if (!base) return "";

    return values.SPOOLMAN_SUBFOLDER ? `${base}${values.SPOOLMAN_SUBFOLDER}` : base;
}

/**
 * The Spoolman base URL the HTTP client talks to.
 *
 * Read through this function rather than a constant, because the endpoint can
 * change at runtime through the settings API.
 *
 * @returns {string} the base URL, or an empty string when nothing is configured
 */
export function spoolmanUrl() {
    return buildSpoolmanUrl(settings);
}

/**
 * The values a client may see.
 *
 * Every password is replaced by null, the way the printer access code is never
 * sent back either. `hasPassword` carries the one thing the settings page needs
 * to know about it: whether a value is stored, so the field can say "unchanged"
 * rather than "empty" and offer to remove it.
 *
 * @returns {object} the settings with every password field emptied
 */
function publicValues() {
    const values = { ...settings };
    for (const [key, field] of Object.entries(SETTINGS_SCHEMA)) {
        if (field.type === "password") values[key] = null;
    }
    return values;
}

/** Whether a password is stored for a field, keyed by field name. */
function passwordsSet() {
    const set = {};
    for (const [key, field] of Object.entries(SETTINGS_SCHEMA)) {
        if (field.type === "password") set[key] = !!settings[key];
    }
    return set;
}

/** The current settings plus the metadata the Web UI needs to render them. */
export function getSettingsView() {
    return {
        values: publicValues(),
        // Which password fields hold a value, since the values themselves are
        // never sent
        hasValue: passwordsSet(),
        sources: describeSources(storedSettings, envSeed),
        fields: Object.entries(SETTINGS_SCHEMA).map(([key, field]) => ({
            key,
            type: field.type,
            group: field.group,
            label: field.label,
            description: field.description,
            options: field.options ?? null,
            // Lets the page offer a way back to the documented value
            default: field.default ?? null,
            min: field.min ?? null,
            max: field.max ?? null,
            restartRequired: !!field.restartRequired,
            // Rendered inside the collapsed part of its group
            advanced: !!field.advanced,
            // Rendered in the card header instead of the field grid
            header: !!field.header,
            // Rendered by the named dialog rather than by the card at all
            dialog: field.dialog ?? null,
        })),
        spoolmanUrl: spoolmanUrl(),
        // Set while a stored value waits for the next start, so the page can
        // keep saying so instead of showing it once after the save.
        restartPending: legacyModeNeedsRestart(),
        // Sent back with the next save, so a state somebody else has already
        // replaced is not overwritten silently.
        revision: storedRevision,
        // Whether a restart brings the service back on its own
        supervised,
    };
}

/**
 * Validates and applies a partial settings update, then persists it.
 *
 * All fields are validated before anything is written, so a rejected request
 * leaves the running configuration untouched instead of applying half of it.
 *
 * @param {object} patch - the fields to change
 * @param {number} [expectedRevision] - the revision the caller last read. When
 *   it no longer matches, the update is refused rather than overwriting what
 *   somebody else saved in the meantime. Omit it to skip the check.
 * @returns {{ok: true, changed: string[], restartRequired: string[]}|{ok: false, errors: string[], conflict?: boolean}}
 */
export function updateSettings(patch, expectedRevision) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return { ok: false, errors: ["Request body must be an object"] };
    }

    if (Number.isInteger(expectedRevision) && expectedRevision !== storedRevision) {
        return {
            ok: false,
            conflict: true,
            errors: ["The settings were changed somewhere else in the meantime"],
        };
    }

    const errors = [];
    const accepted = {};

    for (const [key, raw] of Object.entries(patch)) {
        // A password field the user did not type into keeps what is stored. The
        // settings page sends every field on every save and never receives the
        // stored value, so an empty string here means "unchanged", not "clear
        // it". Removing one is an explicit null, which is what the button next
        // to the field sends.
        if (SETTINGS_SCHEMA[key]?.type === "password" && raw === "") continue;

        const result = coerceSetting(key, raw);
        if (result.error) {
            errors.push(result.error);
            continue;
        }
        accepted[key] = result.value;
    }

    if (errors.length) return { ok: false, errors };

    // A set coerces into a fresh array every time, so identity would report it
    // as changed on every save. Order is not part of its meaning, hence sorted.
    const changed = Object.keys(accepted).filter(key => {
        const [before, after] = [settings[key], accepted[key]];
        if (Array.isArray(before) && Array.isArray(after)) {
            return [...before].sort().join(",") !== [...after].sort().join(",");
        }
        return before !== after;
    });

    Object.assign(settings, accepted);
    storedSettings = { ...settings };
    storedRevision += 1;
    persist();

    return {
        ok: true,
        changed,
        restartRequired: changed.filter(key => SETTINGS_SCHEMA[key].restartRequired),
    };
}
