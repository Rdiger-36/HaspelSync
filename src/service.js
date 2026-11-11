import { serverLogFilePath } from "./config.js";
import { RESTART_EXIT_CODE } from "./supervisor.js";
import { settingsLoadIssues, spoolmanUrl } from "./settings.js";
import { state } from "./state.js";
import { printers, ensurePrinterLogFile } from "./printers.js";
import { checkAndSetExtraField, detectNativeTagSupport, tagMigrationStatus } from "./spoolman.js";
import { closeMqtt, monitorSpoolman, monitorSpoolmanBackground, monitorPrinters } from "./mqtt.js";

/**
 * Startup sequence and the parts of it that have to run again when the Spoolman
 * endpoint changes at runtime.
 *
 * Kept out of backend.js because the settings API needs the same sequence: a
 * new endpoint means a new health check and a fresh extra field bootstrap, and
 * it may be the point at which a service that started without a reachable
 * Spoolman becomes usable.
 */

/**
 * Waits for Spoolman, prepares the "tag" extra field, then starts the monitor
 * loops.
 *
 * Never runs twice in parallel. Repeatedly changing the endpoint while the
 * health check is still waiting would otherwise stack loops that all keep
 * polling forever.
 */
async function bootstrapSpoolman() {
    if (state.spoolmanBootstrapRunning) return;
    state.spoolmanBootstrapRunning = true;

    try {
        await monitorSpoolman({ untilConnected: true });

        // The "tag" extra field is the only link between a physical spool and
        // its Spoolman record, so nothing this service does works without it.
        // The "Bambu Lab" vendor used to be checked here too and held the
        // monitor loops back when it could not be set, although only one thing
        // needs it: see ensureVendor() in spoolman.js, which asks for it when a
        // filament is actually created.
        if (!(await checkAndSetExtraField())) {
            console.error("Server", serverLogFilePath, "Error: Extra Field 'tag' could not be set!");
            return;
        }

        // Before the first AMS update, which already decides how a new spool
        // is linked.
        const nativeTags = await detectNativeTagSupport();
        console.log("Server", serverLogFilePath, nativeTags
            ? `Spoolman ${state.spoolmanVersion} knows native tags, spools are linked through them`
            : `Spoolman ${state.spoolmanVersion ?? "of an unknown version"} has no native tags, spools are linked through extra.tag alone`);

        if (nativeTags) await reportPendingTagMigration();

        startMonitors();
    } finally {
        state.spoolmanBootstrapRunning = false;
    }
}

/**
 * Counts the spools still linked through extra.tag alone and says so in the
 * log. The count is what the dashboard notice reads, see tagnotice.js. A
 * failure here holds nothing back: the notice simply stays quiet.
 */
async function reportPendingTagMigration() {
    try {
        const { pending, conflicts } = await tagMigrationStatus();
        if (pending > 0) {
            console.log("Server", serverLogFilePath,
                `${pending} spools are linked through extra.tag alone. They keep working, and Settings, Spoolman in the Web UI migrates them to native tags.`);
        }
        if (conflicts.length > 0) {
            console.log("Server", serverLogFilePath,
                `${conflicts.length} spools carry a tag that another spool already holds natively and cannot be migrated, see Settings, Spoolman.`);
        }
    } catch (error) {
        console.error("Server", serverLogFilePath, "Could not check the spool tags:", error.message);
    }
}

/** Starts the printer and Spoolman monitor loops, at most once per process. */
function startMonitors() {
    if (state.monitorsRunning) return;
    state.monitorsRunning = true;

    monitorPrinters(printers);
    monitorSpoolmanBackground();
}

/**
 * Runs the startup sequence.
 *
 * An empty printer list is not an error any more. The service keeps running so
 * that printers can be added on the settings page, and the monitor loop picks
 * them up as soon as they exist.
 */
export async function startService() {
    console.log("Server", serverLogFilePath, "Starting service...");

    for (const issue of settingsLoadIssues) {
        console.error("Server", serverLogFilePath, issue);
    }

    if (!spoolmanUrl()) {
        console.error("Server", serverLogFilePath, "No Spoolman endpoint configured. Set one under Settings in the Web UI.");
    }

    if (!printers.length) {
        console.error("Server", serverLogFilePath, "No printers configured. Add one under Settings in the Web UI.");
    }

    for (const printer of printers) {
        ensurePrinterLogFile(printer);
    }

    await bootstrapSpoolman();
}

/**
 * Drops everything derived from the old Spoolman instance and reconnects.
 *
 * Called after the endpoint was changed in the Web UI. The vendor id and the
 * cached spool list belong to the previous instance, so keeping them would
 * write spools against ids that do not exist there. Returns immediately; the
 * reconnect runs in the background because the health check waits for as long
 * as it takes.
 */
export function restartSpoolmanConnection() {
    console.log("Server", serverLogFilePath, `Spoolman endpoint changed, reconnecting to ${spoolmanUrl() || "no endpoint"}...`);

    state.spoolmanStatus = "Disconnected";
    state.vendorID = null;
    state.lastSpoolData = null;
    state.spoolmanVersion = null;
    state.spoolmanNativeTags = null;
    state.tagMigrationPending = null;
    // Force a full rebuild of the slot data, it was matched against spools of
    // the previous instance.
    for (const printer of printers) {
        printer.first_run = true;
    }

    bootstrapSpoolman();
}

/**
 * Ends the process so that whatever runs it starts it again.
 *
 * There is no way to restart from the inside: the settings that need one are
 * read at startup, and re-reading them in place is exactly what the frozen
 * tracking mode exists to prevent. The exit code asks the supervisor in
 * `entrypoint.js` for a restart. It is also non zero, so a container running
 * without that supervisor is restarted by its own policy.
 *
 * The exit is delayed so the HTTP response still reaches the browser, and the
 * MQTT connections are closed first so the printers do not keep a session that
 * nobody is reading.
 *
 * @param {object} [options]
 * @param {number} [options.delay] - milliseconds before the process ends
 * @param {function(number): void} [options.exit] - injected for the test, which
 *   must not take the test runner down with it
 * @returns {Promise<void>} resolves once the exit has been triggered
 */
export function restartService({ delay = 300, exit = code => process.exit(code) } = {}) {
    console.log("Server", serverLogFilePath, "Restart requested through the Web UI, ending the process...");

    for (const printer of printers) {
        closeMqtt(printer, "the service is restarting", true);
    }

    return new Promise(resolve => {
        setTimeout(() => {
            exit(RESTART_EXIT_CODE);
            resolve();
        }, delay);
    });
}
