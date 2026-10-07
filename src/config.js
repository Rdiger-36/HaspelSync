import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Not under `node --test`: the suite must see the same environment on every
// machine, and a developer's .env carries MODE, LEGACY_MODE and a Spoolman
// endpoint that would otherwise decide what the tests run against.
if (!process.env.NODE_TEST_CONTEXT) config();

const __filename = fileURLToPath(import.meta.url);
const __rootDir = path.dirname(path.dirname(__filename));

// Where the persistent files and the logs live. The container mounts both, so
// they are overridable separately. Tests point them at a temporary directory,
// which is the only way to exercise the write paths without touching a real
// installation.
export const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__rootDir, "printers");
export const logsDir = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(__rootDir, "logs");

export const serverLogFilePath = path.join(logsDir, "server.log");
export const configPath = path.join(dataDir, "printers.json");
// Manual AMS slot -> Spoolman spool assignments, written by the service itself.
export const mappingsPath = path.join(dataDir, "mappings.json");
// The slicer presets learned from sliced files, see src/presets.js
export const presetsPath = path.join(dataDir, "presets.json");
// The start time of the print each printer is running, so a restart of the
// service does not lose it, see src/printstate.js
export const printStatePath = path.join(dataDir, "printstate.json");
// Runtime configuration edited through the Web UI, see settings.js.
export const settingsPath = path.join(dataDir, "settings.json");
// API keys for callers that are not a browser, see apikeys.js. Its own file
// rather than a field in settings.json, so a settings export can never carry it.
export const apiKeysPath = path.join(dataDir, "apikeys.json");

// Set by the supervisor in entrypoint.js. Tells the Web UI whether a restart
// brings the service back on its own or depends on the container policy.
export const supervised = process.env.SUPERVISED === "1";

// The name the image was published under, baked in by the Dockerfile; null
// outside the published images, which is a checkout or a locally built image.
// src/imagenotice.js is what reads it.
export const imageName = process.env.HASPELSYNC_IMAGE || null;

export const version = "1.3.4-dev.1";
export const PORT = 4000;

/** The spellings a boolean environment variable is accepted in. */
function isTruthy(raw) {
    return ["true", "1", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}

// Raw environment values. They seed settings.json and printers.json on the
// first run only; afterwards those files own the values. This is the only
// module that reads process.env, everything else reads settings.js.
// Every setting of the schema, seeded from the environment while settings.json
// does not own it yet. Kept complete on purpose: a variable that is missing here
// is silently ignored, which is what happened to five settings added after the
// environment was deprecated. test/settings.test.js compares this against the
// schema.
export const envSeed = {
    SPOOLMAN_ENDPOINT: process.env.SPOOLMAN_ENDPOINT,
    SPOOLMAN_IP: process.env.SPOOLMAN_IP,
    SPOOLMAN_PORT: process.env.SPOOLMAN_PORT,
    SPOOLMAN_SUBFOLDER: process.env.SPOOLMAN_SUBFOLDER,
    SPOOLMAN_FQDN: process.env.SPOOLMAN_FQDN,
    MODE: process.env.MODE,
    LEGACY_MODE: process.env.LEGACY_MODE,
    AUTO_ASSIGN_THIRD_PARTY: process.env.AUTO_ASSIGN_THIRD_PARTY,
    PRINT_RESET_MINUTES: process.env.PRINT_RESET_MINUTES,
    UPDATE_INTERVAL: process.env.UPDATE_INTERVAL,
    OFFLINE_CHECK_INTERVAL: process.env.OFFLINE_CHECK_INTERVAL,
    OFFLINE_MAX_INTERVAL: process.env.OFFLINE_MAX_INTERVAL,
    MAX_RETRIES: process.env.MAX_RETRIES,
    NEVER_MERGE_IF_TAG: process.env.NEVER_MERGE_IF_TAG,
    SET_LOCATION: process.env.SET_LOCATION,
    ARCHIVE_EMPTY_SPOOLS: process.env.ARCHIVE_EMPTY_SPOOLS,
    EMPTY_SPOOL_THRESHOLD: process.env.EMPTY_SPOOL_THRESHOLD,
    // DEBUG was the switch before the level ladder existed. It still seeds an
    // installation that has never saved a level, so a container definition
    // carrying DEBUG=true keeps writing debug lines after the upgrade. An
    // explicit LOG_LEVEL wins over it.
    LOG_LEVEL: process.env.LOG_LEVEL ?? (isTruthy(process.env.DEBUG) ? "debug" : undefined),
    LOG_CATEGORIES: process.env.LOG_CATEGORIES,
    MQTT_TRACE: process.env.MQTT_TRACE,
    MQTT_TRACE_MAX_SIZE_MB: process.env.MQTT_TRACE_MAX_SIZE_MB,
    MQTT_TRACE_KEEP: process.env.MQTT_TRACE_KEEP,
    LOG_MAX_SIZE_MB: process.env.LOG_MAX_SIZE_MB,
    LOG_KEEP_SERVER: process.env.LOG_KEEP_SERVER,
    LOG_KEEP_PRINTER: process.env.LOG_KEEP_PRINTER,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
    AUTH_PASSWORD: process.env.AUTH_PASSWORD,
};

// Single printer fallback, used by the Home Assistant add-on and the simplest
// Docker setups. Seeds printers.json when no printer is configured yet.
export const envPrinterSeed = {
    id: process.env.PRINTER_ID,
    code: process.env.PRINTER_CODE,
    ip: process.env.PRINTER_IP,
};
