import AdmZip from "adm-zip";
import { promises as fsp } from "fs";
import mime from "mime-types";
import path from "path";
import { serverLogFilePath, version } from "./config.js";
import { buildOpenApiDocument } from "./openapi.js";
import { settings, spoolmanUrl, buildSpoolmanUrl, getSettingsView, updateSettings, coerceSetting, legacyMode, acknowledgeNotice } from "./settings.js";
import { ENV_CONFIG_NOTICE, deprecatedConfig } from "./deprecation.js";
import { UPGRADE_NOTICE, upgradeNotice } from "./upgradenotice.js";
import { IMAGE_NOTICE, dismissLegacyImageNotice, legacyImageNotice } from "./imagenotice.js";
import { buildDiagnosticsBundle, parseDiagnosticsScope, knownValues, systemInfo } from "./diagnostics.js";
import { checkForUpdate } from "./update.js";
import { maskCodes, maskSerial, maskText } from "./anonymize.js";
import { addPrinter, updatePrinter, updatePrinterLogDetail, removePrinter, syncPrinterIntervals, reprocessSlotsOnNextReport, traceEnabled } from "./printers.js";
import { restartSpoolmanConnection, restartService } from "./service.js";
import { state } from "./state.js";
import { attemptLogin, authEnabled, clearSessionCookie, isAuthenticated, issueSession, setSessionCookie } from "./auth.js";
import { createApiKey, listApiKeys, removeApiKey } from "./apikeys.js";
import { tailLogLines, logFileSet } from "./logger.js";
import { toClientSpool, loadedSlotIds } from "./uispool.js";
import { catalogueFacet, filterCatalogue, spoolWeightLimit, SLOT_OPTIONS } from "./utils.js";
import {
    createSpool,
    createFilamentAndSpool,
    mergeSpool,
    getSpoolmanSpools,
    getSpoolmanVendors,
    getSpoolmanLocations,
    getSpoolmanMaterials,
    getSpoolmanExternalMaterials,
    getSpoolmanInternalFilaments,
    createVendor,
    createFilament,
    createSpoolRecord,
    checkSpoolmanHealth,
    getSpoolmanSpool,
    patchSpoolFields,
    getCachedExternalFilaments,
} from "./spoolman.js";
import { calcFullConsumption, calcPartialConsumption, completedLayerIndex, testFtpsConnection, resolveSliceSlots, orderedAmsSlots, printStageName, isPreparingStage, splitAtRefills, SLICE_FETCH_ATTEMPTS } from "./gcode.js";
import { consumptionCandidate, matchConsumption } from "./ams.js";
import { setupMqtt, closeMqtt, broadcastSlotUpdate, broadcastSSE, testMqttConnection, resetOfflineBackoff, ACTIVE_STATES, printResultCleared, loadSliceInfo, ensureSliceInfo, sliceFetchFailure, runningPrint, rememberedSlotCandidates, emptiedPrintSlots } from "./mqtt.js";
import { getMappings, setMapping, clearMapping, clearPrinterMappings } from "./mappings.js";
import {
    claimSlotLocation,
    releaseSlotLocation,
    releasePrinterLocations,
    renamePrinterLocations,
    slotLocation,
} from "./location.js";

/**
 * Looks up a printer, answering with a 404 and returning null when there is
 * none. Callers must stop on null; the response has already been sent.
 *
 * Nearly every handler starts with this lookup, and the ones that wrote it out
 * had drifted into two answer shapes, one of them without the `ok` field the
 * frontend's fetchJson() expects.
 *
 * @param {string} printerId - the printer id from the route or the body
 * @param {object[]} printers - the printer list
 * @param {object} res - the Express response, used for the 404
 * @returns {object|null} the runtime printer, or null
 */
function resolvePrinter(printerId, printers, res) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) { res.status(404).json({ ok: false, error: "Printer not found", code: "printerNotFound" }); return null; }
    return printer;
}

/**
 * How far along the running print is, for the card above the slot tables.
 *
 * Only ever filled while a print is actually running: the printer keeps
 * reporting the last values of a job that is over, so a finished print would
 * otherwise claim an estimated end in the past and a stage it left long ago.
 *
 * The estimated end is derived here rather than in the browser so that every
 * client agrees on it, and it is derived from `mc_remaining_time`, which the
 * printer reports in minutes and revises as it goes.
 *
 * @param {object} printer - the runtime printer
 * @param {string} state - the effective gcode state, after clearing
 * @returns {object} the fields to merge into the print response
 */
function wholeMinute(ms) {
    return ms - ms % 60_000;
}

function liveProgress(printer, state) {
    if (!ACTIVE_STATES.has(state)) {
        return { startedAt: null, elapsedMs: null, remainingMinutes: null, estimatedEndAt: null, stage: null, stageCode: null, preparing: false };
    }

    const remaining = printer.currentRemainingMinutes;
    // A paused print has no expected end. The printer keeps reporting what the
    // job still needs, and adding that to the clock names a moment that slides
    // forward for as long as the pause lasts, so it would be wrong every time
    // anybody read it. The time it still needs is the honest half of that, and
    // it is what the dashboard shows instead.
    const paused = state === "PAUSE";

    return {
        startedAt: printer.printStartedAt ?? null,
        elapsedMs: printer.printStartedAt ? Date.now() - printer.printStartedAt : null,
        remainingMinutes: remaining ?? null,
        // A remaining time of 0 is a real answer near the end of a print, so it
        // is only the absence of the field that makes the estimate unknown.
        // Cut to the whole minute: the printer's estimate has none finer, and
        // the seconds were those of the clock at the moment of the request,
        // different on every refresh for one and the same estimate.
        estimatedEndAt: !paused && remaining != null ? wholeMinute(Date.now() + remaining * 60_000) : null,
        stage: printStageName(printer.currentStage),
        // The number behind the words, so the Web UI can show the stage in the
        // viewer's language; the words stay English for every other caller.
        stageCode: printStageName(printer.currentStage) != null ? Number(printer.currentStage) : null,
        preparing: isPreparingStage(printer.currentStage),
    };
}

/**
 * Looks up one cached UI spool of a printer, answering with a 404 and returning
 * null when the slot is not among them.
 *
 * @param {object} printer - the runtime printer
 * @param {string} amsId - the slot label
 * @param {object} res - the Express response, used for the 404
 * @param {string} missing - what to call the slot in the error message
 * @returns {object|null} the cached UI spool, or null
 */
function resolveUiSpool(printer, amsId, res, missing = "Slot not found") {
    const uiSpool = (printer.spoolData || []).find(s => s.amsId === amsId);
    if (!uiSpool) { res.status(404).json({ ok: false, error: missing }); return null; }
    return uiSpool;
}

/**
 * Looks up the cached UI spool for a printer and slot, answering with a 404 and
 * returning null when either does not exist. Callers must stop on null; the
 * response has already been sent.
 *
 * @param {{printerId: string, amsId: string}} params - route parameters
 * @param {object[]} printers - the printer list
 * @param {object} res - the Express response, used for the 404
 * @returns {object|null} the cached UI spool, or null
 */
function resolveSpoolData({ printerId, amsId }, printers, res) {
    const printer = resolvePrinter(printerId, printers, res);
    if (!printer) return null;
    return resolveUiSpool(printer, amsId, res, "Spool not found");
}

/**
 * Names the slot each sliced filament will actually be consumed from.
 *
 * The same decision `bookConsumption()` makes, through the same function, run
 * over every loaded slot rather than only the bookable ones: the dashboard also
 * has to show what a print needs from a slot that carries no booking yet.
 *
 * The answer is written onto the entry as `matchedAmsId`, next to `amsId`,
 * which stays what the slice named. The two differ exactly where the printer
 * remapped the job, and both are worth reading. The browser used to repeat this
 * decision on the payload instead, and that second implementation drifted.
 *
 * @param {object} consumption - a map already through resolveSliceSlots()
 * @param {object[]} loadedSpools - the client projection of the printer's slots
 * @param {object|null} [printer] - the runtime printer, when the map is its running print's
 * @returns {object} the same map, for chaining
 */
function nameMatchedSlots(consumption, loadedSpools, printer = null) {
    const candidates = loadedSpools
        .filter(spool => spool.slotState !== "Empty")
        .map(consumptionCandidate);
    // The spools of slots that ran empty during the running print, the way the
    // booking reaches them, so the dashboard does not move their grams onto a
    // backup spool of the same colour in the meantime
    if (printer) candidates.push(...rememberedSlotCandidates(printer, candidates));

    const entries = Object.values(consumption);
    const matched = matchConsumption(entries, candidates);

    for (const entry of entries) {
        entry.matchedAmsId = matched.get(entry)?.[0]?.amsId ?? null;
    }
    return consumption;
}

/**
 * Rejects the manual assignment endpoints while legacy mode is on.
 *
 * Assignments exist to tell the G-code booking which physical spool to charge.
 * Legacy mode books nothing, it writes the weight straight onto the spool the
 * RFID tag already identifies, so an assignment there would change nothing. The
 * UI hides these actions, and this stops a direct call from creating a mapping
 * that would silently take effect on the next mode switch.
 *
 * @returns {boolean} true when the request was answered and the caller must stop
 */
function rejectInLegacyMode(res) {
    if (!legacyMode()) return false;
    res.status(409).json({ ok: false, error: "Manual spool assignment is not available in legacy mode", code: "legacyNoAssignment" });
    return true;
}

/**
 * Rejects a hand made spool edit while legacy mode is on.
 *
 * Legacy mode derives the remaining weight from the AMS RFID remain percentage
 * and writes it on the next slot change (see processSlot in mqtt.js), so a
 * corrected value would disappear again on its own within seconds. The dialog
 * disables the fields for the same reason; this stops a direct call.
 *
 * @returns {boolean} true when the request was answered and the caller must stop
 */
function rejectSpoolEditInLegacyMode(res) {
    if (!legacyMode()) return false;
    res.status(409).json({
        ok: false,
        error: "Legacy mode writes the remaining weight from the AMS RFID reading, so an edit here would be overwritten",
        code: "legacyNoWeightEdit",
    });
    return true;
}

/**
 * Finds a printer that is mid print with this spool loaded in one of its slots.
 *
 * Asked per spool rather than per dashboard: the spool being consumed is what
 * matters, and it can sit in a second printer than the one whose page the dialog
 * was opened from.
 *
 * @param {object[]} printers - the printer list
 * @param {number} spoolId - Spoolman spool id
 * @returns {object|null} the printing printer, or null
 */
function printerPrintingWithSpool(printers, spoolId) {
    return printers.find(printer =>
        ACTIVE_STATES.has(printer.currentGcodeState) &&
        (printer.spoolData || []).some(spool => spool.existingSpool?.id === spoolId)
    ) || null;
}

/**
 * Registers every HTTP route on the Express app.
 *
 * The API falls into four groups: read-only status and spool data for the
 * dashboard, the SSE stream at /api/events that pushes live updates, the
 * actions the UI triggers (create, merge, assign a spool, start and stop
 * monitoring), and the log endpoints. Handlers read from the cached
 * printer.spoolData rather than talking to the printer, so a request never
 * blocks on MQTT.
 *
 * @param {object} app - the Express app
 * @param {object[]} printers - the printer list from printers.js
 */
export function registerRoutes(app, printers) {
    // ---------------------------------------------------------------------
    // Login
    //
    // Public, because the login page is what somebody who is not logged in
    // sees. Everything else in this file sits behind requireAuth() in
    // backend.js, and answers 401 once a password is set. See auth.js.
    // ---------------------------------------------------------------------

    app.get("/api/auth/state", (req, res) => {
        res.json({ required: authEnabled(), authenticated: !authEnabled() || isAuthenticated(req) });
    });

    app.post("/api/auth/login", (req, res) => {
        if (!authEnabled()) return res.json({ ok: true, required: false });

        const result = attemptLogin(String(req.body?.password ?? ""), req.ip);
        if (!result.ok) {
            // 429 rather than 401 while the address is waiting, so the page can
            // say how long instead of repeating that the password was wrong.
            const status = result.retryAfter ? 429 : 401;
            return res.status(status).json({
                ok: false,
                error: result.retryAfter
                    ? `Too many attempts. Try again in ${result.retryAfter} seconds.`
                    : "Wrong password",
                code: result.retryAfter ? "tooManyAttempts" : "wrongPassword",
                params: result.retryAfter ? { count: result.retryAfter } : undefined,
                retryAfter: result.retryAfter,
            });
        }

        setSessionCookie(req, res, result.cookie, result.expiresAt);
        console.log("Server", serverLogFilePath, `[Auth] Logged in from ${req.ip}`);
        res.json({ ok: true });
    });

    app.post("/api/auth/logout", (req, res) => {
        clearSessionCookie(req, res);
        res.json({ ok: true });
    });

    app.get("/api/status/:printerId", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        res.json({
            spoolmanStatus: state.spoolmanStatus,
            mqttStatus: printer.mqttStatus,
            lastMqttUpdate: printer.lastMqttUpdate,
            lastMqttAmsUpdate: printer.lastMqttAmsUpdate,
            PRINTER_ID: printer.id,
            printerName: printer.name,
            MODE: settings.MODE,
            LEGACY_MODE: legacyMode(),
            SPOOLMAN_URL: spoolmanUrl(),
            VERSION: version,
            SPOOLMAN_FQDN: settings.SPOOLMAN_FQDN,
            monitoringEnabled: printer.monitoringEnabled,
            // Humidity, temperature and drying state per AMS unit. Sent with the
            // status so a page load starts with the last readings rather than an
            // empty header until the next broadcast, which is up to 30s away.
            amsEnv: printer.amsEnv || [],
            // Both views load this endpoint, /api/print only the G-code one, and
            // the spool detail dialog has to know in either whether a print is
            // running before it offers to correct a remaining weight.
            gcodeState: printer.currentGcodeState || "IDLE",
            activeSlot: printer.activeSlot ?? null,
        });
    });

    app.get("/api/spools/:printerId", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;
        res.json((printer.spoolData || []).map(toClientSpool));
    });

    app.get("/api/printers", (req, res) => {
        res.json(printers.map(({ id, name }) => ({ id, name })));
    });

    /**
     * Registers one of the three Spoolman write actions the dashboard button
     * triggers. All three take the same body, look up the same cached slot and
     * answer the same way; only the Spoolman call in the middle differs.
     *
     * The three never throw, because the automatic mode calls them per slot and
     * one slot that cannot be written must not abort the rest of the same AMS
     * update. They report instead, and that answer is what reaches the browser:
     * a failed write used to be answered with `ok` and the user was told the
     * action had been sent.
     *
     * @param {string} path - the route
     * @param {string} what - the action, used in the log line and the error
     * @param {function(object): Promise<{ok: boolean, error?: string}>} run - the spoolman.js call
     */
    const spoolAction = (path, what, run) => {
        app.post(path, async (req, res) => {
            const spoolData = resolveSpoolData(req.body, printers, res);
            if (!spoolData) return;
            try {
                const result = await run(spoolData);
                if (result?.ok === false) {
                    return res.status(502).json({ ok: false, error: result.error || `${what} failed` });
                }
                res.status(200).json({ ok: true });
            } catch (err) {
                console.error("Server", serverLogFilePath, `${what} failed:`, err?.message);
                res.status(500).json({ ok: false, error: err?.message || `${what} failed` });
            }
        });
    };

    spoolAction("/api/mergeSpool", "mergeSpool", mergeSpool);
    spoolAction("/api/createSpool", "createSpool", createSpool);
    spoolAction("/api/createSpoolWithFilament", "createSpoolWithFilament", createFilamentAndSpool);

    app.get("/api/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        state.clients.push(res);
        req.on("close", () => {
            state.clients = state.clients.filter(client => client !== res);
        });
    });

    // Reads across the rotated files, so the requested number of lines is
    // delivered even right after a rotation, when the current file is nearly
    // empty. "files" is what the download button needs to know whether it is
    // handing out one file or an archive; "bytes" is the size of all of them
    // together, which is what the page says next to it, because a trace grows
    // by about 22 MB an hour and the number is what tells a reader whether a
    // download is worth waiting for. "capturing" says whether the trace is
    // being written at all: a trace that stays empty because the capture is
    // off reads the same as one that is empty because nothing arrived yet.
    // Several logs at once, the way the log page's dialog asks for them: the
    // diagnostics archive without the configuration files. Registered before
    // the route below, which would otherwise read "download" as a serial.
    app.get("/api/logs/download", async (req, res) => {
        const scope = parseDiagnosticsScope(req.query.scope, printers);
        if (scope.error) return res.status(400).json({ ok: false, error: scope.error, code: "unknownScope" });

        try {
            const anonymize = req.query.anonymize !== "false";
            const { buffer, filename } = await buildDiagnosticsBundle({ anonymize, scope, config: false });
            console.log("Server", serverLogFilePath, `[Service] Log bundle created (${anonymize ? "anonymised" : "full"}, ${Math.round(buffer.length / 1024)} KB)`);

            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Content-Length", buffer.length);
            res.end(buffer);
        } catch (err) {
            console.error("Server", serverLogFilePath, `Log bundle failed: ${err.message}`);
            res.status(500).json({ ok: false, error: "The bundle could not be built", code: "bundleFailed" });
        }
    });

    app.get("/api/logs/:printerId", async (req, res) => {
        try {
            const limitRaw = req.query.limit;
            const limit = Math.max(1, Math.min(2000, parseInt(limitRaw ?? "250", 10) || 250));

            const wantsTrace = req.query.stream === "mqtt";

            let filePath = serverLogFilePath;
            let capturing = true;
            if (req.params.printerId !== "server") {
                const printer = resolvePrinter(req.params.printerId, printers, res);
                if (!printer) return;
                filePath = wantsTrace ? printer.traceFilePath : printer.logFilePath;
                if (wantsTrace) capturing = traceEnabled(printer);
            } else if (wantsTrace) {
                // There is no server trace: the raw messages belong to a printer
                return res.status(404).json({ ok: false, error: "The server has no MQTT trace", code: "noServerTrace" });
            }

            const [lines, files] = await Promise.all([
                tailLogLines(filePath, limit),
                logFileSet(filePath),
            ]);
            const sizes = await Promise.all(files.map(file => fsp.stat(file).then(info => info.size, () => 0)));
            return res.json({
                logs: lines,
                files: files.length,
                bytes: sizes.reduce((sum, size) => sum + size, 0),
                file: path.basename(filePath),
                capturing,
            });
        } catch (err) {
            console.error("Server", serverLogFilePath, `Failed to read log file: ${err.message}`);
            return res.status(500).json({ ok: false, error: "Failed to read log file", code: "logReadFailed" });
        }
    });

    // Hands out the whole history, not only the current file: once a log has
    // rotated, the interesting lines are usually in <name>.log.1. A single file
    // is handed out as it is, several become one zip, because that keeps the
    // file boundaries and the order intact.
    //
    // Read into memory rather than streamed, because both variants of the
    // download rewrite the text: the anonymised one masks everything, the full
    // one still masks the access codes. The size is bounded by the log settings
    // either way.
    app.get("/api/logs/:printerId/download", async (req, res) => {
        try {
            const { printerId } = req.params;

            // The page asks which of the two it should be, so the choice is
            // explicit rather than a default nobody notices, and anonymised is
            // what an unanswered request gets. Anonymised has to read the file
            // instead of streaming it, which is what masking a stream would need
            // a line splitter for; the size is bounded by the log settings
            // either way.
            const anonymize = req.query.anonymize !== "false";
            const known = knownValues();
            // The full download keeps the addresses and the serials but still
            // loses the access codes, for the reason diagnostics.js gives.
            const mask = text => (anonymize ? maskText(text, known) : maskCodes(text, known.codes));

            const wantsTrace = req.query.stream === "mqtt";
            let filePath, baseName;

            if (printerId === "server") {
                if (wantsTrace) return res.status(404).json({ ok: false, error: "The server has no MQTT trace", code: "noServerTrace" });
                filePath = serverLogFilePath;
                baseName = "server";
            } else {
                const printer = resolvePrinter(printerId, printers, res);
                if (!printer) return;
                filePath = wantsTrace ? printer.traceFilePath : printer.logFilePath;
                // The serial is in the file name as well, so it has to be masked
                // there too. The printer name is kept, see anonymize.js.
                const serial = anonymize ? maskSerial(printer.id) : printer.id;
                baseName = `${printer.name.replace(/\s+/g, "_")}_${serial}${wantsTrace ? "_mqtt" : ""}`;
            }

            const suffixed = anonymize ? baseName : `${baseName}_full`;

            const files = await logFileSet(filePath);
            if (files.length === 0) return res.status(404).json({ ok: false, error: "No log file found", code: "noLogFile" });

            if (files.length === 1) {
                res.setHeader("Content-Type", mime.lookup("log") || "text/plain; charset=utf-8");
                res.setHeader("Content-Disposition", `attachment; filename="${suffixed}.log"`);

                return res.end(mask(await fsp.readFile(files[0], "utf-8")));
            }

            // The archive is built in memory. Its size is bounded by the log
            // settings, LOG_MAX_SIZE_MB times the number of kept files, and log
            // text compresses well, so this stays small for any sane setting.
            const zip = new AdmZip();
            for (const [index, file] of files.entries()) {
                // Oldest first inside the archive, and numbered so the order
                // survives a file listing that sorts by name.
                const position = files.length - index;
                const suffix = index === 0 ? "current" : `rotated.${index}`;
                const entry = `${String(position).padStart(2, "0")}_${baseName}.${suffix}.log`;

                if (anonymize) {
                    zip.addFile(entry, Buffer.from(maskText(await fsp.readFile(file, "utf-8"), known)));
                } else {
                    zip.addLocalFile(file, "", entry);
                }
            }

            const buffer = zip.toBuffer();
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="${suffixed}_logs.zip"`);
            res.setHeader("Content-Length", buffer.length);
            return res.end(buffer);
        } catch (err) {
            console.error("Server", serverLogFilePath, `Download error: ${err.message}`);
            res.status(500).json({ ok: false, error: "Download failed", code: "downloadFailed" });
        }
    });

    /**
     * Turns monitoring of one printer on or off.
     *
     * Written as a function because the Service card switches all of them at
     * once and has to do exactly what the per printer toggle on the dashboard
     * does, down to the SSE event the dashboard listens for.
     *
     * @param {object} printer - the runtime printer
     * @param {boolean} enabled - the state to move to
     * @returns {boolean} false when it was already in that state
     */
    function setMonitoring(printer, enabled) {
        if (printer.monitoringEnabled === enabled) return false;

        printer.monitoringEnabled = enabled;

        if (enabled) {
            // Always restart MQTT immediately, regardless of MAX_RETRIES setting.
            // The cooldown in setupMqtt guards against retry storms, not against
            // a deliberate reconnect, so clear it here as the printer edit does.
            // Without this, resuming shortly after another reconnect did nothing
            // and the printer only came back on the next monitor pass.
            printer.reconnectAttempts = 0;
            printer.lastReconnectAttempt = 0;
            resetOfflineBackoff(printer);
            printer.mqttRunning = false;
            printer.mqttStatus = "Reconnecting";
            console.log(printer.name, printer.logFilePath, `Monitoring enabled for ${printer.name} - ${printer.id}, restarting MQTT...`);
        } else {
            // Actively close the existing MQTT connection instead of waiting for it to drop
            closeMqtt(printer, "monitoring was switched off");
            printer.mqttStatus = "Disabled";
            console.log(printer.name, printer.logFilePath, `Monitoring disabled for ${printer.name} - ${printer.id}`);
        }

        broadcastSSE({ type: "monitoring_update", printer: printer.id, enabled });
        if (enabled) setupMqtt(printer);

        return true;
    }

    app.post("/api/printer/:printerId/monitoring/stop", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        if (!setMonitoring(printer, false)) {
            return res.json({ ok: false, message: `Monitoring already disabled for ${printer.name} - ${printer.id}` });
        }

        res.json({ ok: true, printer: printer.id, monitoringEnabled: false });
    });

    app.post("/api/printer/:printerId/monitoring/start", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        if (!setMonitoring(printer, true)) {
            return res.json({ ok: false, message: `Monitoring already enabled for ${printer.name} - ${printer.id}` });
        }

        res.json({ ok: true, printer: printer.id, monitoringEnabled: true });
    });

    // Every printer at once, for the Service card. Answers with what it actually
    // changed rather than a bare ok, so the page can say "3 of 4 were already
    // running" instead of implying it did something.
    app.post("/api/monitoring/:action", (req, res) => {
        const { action } = req.params;
        if (action !== "start" && action !== "stop") {
            return res.status(404).json({ ok: false, error: "Unknown action" });
        }

        const enabled = action === "start";
        const changed = printers.filter(printer => setMonitoring(printer, enabled)).map(printer => printer.id);

        console.log("Server", serverLogFilePath, `[Service] Monitoring ${enabled ? "enabled" : "disabled"} for ${changed.length} of ${printers.length} printers`);

        res.json({ ok: true, enabled, changed, total: printers.length });
    });

    // Rebuilds the MQTT connections without ending the process. This is what
    // most people reach for the restart button for, and unlike a restart it
    // keeps the consumption tracking of a running print, which lives in memory
    // and is booked when the job ends. So it needs no confirmation.
    app.post("/api/printers/reconnect", (req, res) => {
        const reconnected = [];

        for (const printer of printers) {
            if (!printer.monitoringEnabled) continue;

            closeMqtt(printer, "reconnecting on request", true);
            printer.reconnectAttempts = 0;
            // The cooldown in setupMqtt guards against retry storms, not against
            // a deliberate reconnect, so clear it here.
            printer.lastReconnectAttempt = 0;
            resetOfflineBackoff(printer);
            printer.mqttStatus = "Reconnecting";
            reconnected.push(printer.id);
            setupMqtt(printer);
        }

        console.log("Server", serverLogFilePath, `[Service] Reconnecting ${reconnected.length} printer(s) on request`);
        broadcastSSE({ type: "printers_update" });

        res.json({ ok: true, reconnected, skipped: printers.length - reconnected.length });
    });

    app.get("/api/print/:printerId", async (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        // A finished print that has been cleared, by the countdown or by hand,
        // is reported as an idle printer: no job name, no slice info and no
        // figures, which is what empties the "Needed" and "After print" columns
        // without touching what the printer actually reports. Its summary is
        // still sent, because the dialog behind it stays reachable until the
        // next print starts.
        //
        // An explicit ?job= is the manual FTPS test and keeps working either
        // way; it names its own file and does not read the printer's state.
        const cleared = !req.query.job && printResultCleared(printer);

        // Allow ?job=<name> to test the FTPS fetch for a specific file manually
        const jobName   = req.query.job || (cleared ? null : printer.currentJobName) || null;
        const state     = cleared ? "IDLE" : (printer.currentGcodeState || "IDLE");
        const layerNum  = cleared ? 0 : (printer.currentLayerNum || 0);

        // Fetch fresh slice info if a job is known (or explicitly requested),
        // otherwise fall back to the cached version.
        //
        // Not again for a job the print handler already looked for and did not
        // find: the dashboard asks every few seconds, and a job whose file is
        // not there would otherwise cost one FTPS login per request for the
        // whole print. Measured on a P1S: 303 logins in fifteen minutes. The
        // manual ?job= test is the exception, it asks for exactly that.
        //
        // A fetch for the printer's own job is shared with the print handler
        // through ensureSliceInfo(), so a request that lands while the job is
        // preparing fetches the file once for both rather than once each.
        let sliceInfo = req.query.job || cleared ? null : (printer.currentSliceInfo || null);
        const alreadyLookedFor = !req.query.job && printer.lastSliceFetch?.jobName === jobName;
        if (jobName && !sliceInfo && !alreadyLookedFor) {
            try {
                if (req.query.job) {
                    sliceInfo = await loadSliceInfo(printer, jobName, null);
                } else {
                    // Before the print runs, which is where this request lands
                    // first, the look does not count as one of the attempts and
                    // says so in the log, see fetchSliceInfo(). The outcome is
                    // logged by ensureSliceInfo(), so only the start is said here
                    const beforeRunning = state !== "RUNNING" && state !== "PAUSE";
                    if (!printer.sliceFetchInFlight) {
                        console.log(printer.name, printer.logFilePath, `[Print] "${jobName}" is starting, looking for its sliced file via FTPS...`);
                    }
                    sliceInfo = await ensureSliceInfo(printer, jobName, printer.currentGcodeFile, printer.currentFileName, { ...runningPrint(printer), beforeRunning });
                }
            } catch (err) {
                // non-fatal, surface the error in the response
                return res.json({
                    gcodeState: state,
                    jobName,
                    layerNum,
                    error: `FTPS fetch failed: ${err.message}`,
                    sliceInfo: null,
                    loadedSpools: [],
                    consumption: null,
                });
            }
        }

        // The same projection the dashboard gets, rather than a second one with
        // its own field names. That second projection is why this endpoint used
        // to report connectedViaTag but not connectedViaMapping, so it could not
        // answer "will this slot be booked" on its own.
        const loadedSpools = (printer.spoolData || []).map(toClientSpool);

        // fullConsumption = total grams the whole print needs per sliced
        // filament (used for the "needed" column). consumption = estimate at the
        // current print progress (partial for an in-progress/aborted print).
        let fullConsumption = null;
        let consumption     = null;
        let emptiedSlots    = [];
        if (sliceInfo) {
            const TERMINAL = new Set(["FINISH", "FAILED", "CANCEL"]);
            // The same resolution bookConsumption makes, so the dashboard reads
            // the figures off the slots the booking will use rather than
            // repeating the guess client side.
            const reported = printer.currentMapping;
            const slots = reported ?? orderedAmsSlots(loadedSlotIds(loadedSpools));
            const from = { reportedByPrinter: !!reported };
            // The refills and the remembered spools belong to the running
            // print, not to a file asked for by name
            const running = sliceInfo === printer.currentSliceInfo ? printer : null;
            const split = cons => splitAtRefills(resolveSliceSlots(cons, slots, from), sliceInfo, running?.refills);

            fullConsumption = nameMatchedSlots(split(calcFullConsumption(sliceInfo)), loadedSpools, running);
            if (state === "FINISH") {
                consumption = fullConsumption;
            } else if (TERMINAL.has(state) || state === "RUNNING" || state === "PAUSE") {
                consumption = nameMatchedSlots(
                    split(calcPartialConsumption(sliceInfo, completedLayerIndex(layerNum))),
                    loadedSpools,
                    running,
                );
            }
            if (running) {
                emptiedSlots = emptiedPrintSlots(printer, loadedSpools
                    .filter(spool => spool.slotState !== "Empty")
                    .map(consumptionCandidate));
            }
        }

        // Why there is no slice info for the running job, while there is none:
        // the dashboard used to show a bare job name for a print whose file
        // was never found, and the first word about it came with the summary.
        const lookup = printer.lastSliceFetch;
        const sliceFetch = !sliceInfo && jobName && lookup?.jobName === jobName && !lookup.path
            ? {
                attempt: lookup.attempt ?? 1,
                attempts: SLICE_FETCH_ATTEMPTS,
                final: (lookup.attempt || 1) >= SLICE_FETCH_ATTEMPTS,
                // What the hint behind the card's line is about: a login the
                // printer did not answer, or a file none of the paths held
                kind: lookup.error ? "connection" : "missing",
                reason: sliceFetchFailure(lookup),
            }
            : null;

        res.json({
            gcodeState: state,
            jobName,
            modelTitle:     sliceInfo?.modelTitle ?? null,
            layerNum,
            totalLayers:    sliceInfo?.totalLayers   ?? null,
            sliceInfo:      sliceInfo ? {
                filaments: sliceInfo.filaments,
            } : null,
            sliceFetch,
            // Whether the printer's USB stick or SD card is in, which is the
            // storage the sliced file is read from. Null until a report said.
            // Not tied to the job: the card says it while idle as well, so the
            // stick is in before the next print rather than found missing by it.
            storagePresent: printer.storagePresent ?? null,
            loadedSpools,
            fullConsumption,
            consumption,
            emptiedSlots,
            consumptionBooked: cleared ? false : (printer.consumptionBooked ?? false),
            // The closing report of the last print, and when the card clears
            // itself. Both survive the clearing: the summary is what the
            // dialog shows afterwards, and the deadline is what the countdown
            // next to the booking label counts down to.
            lastPrintSummary: printer.lastPrintSummary ?? null,
            printResetAt: printer.printResetAt ?? null,
            printResultCleared: cleared,
            // What the printer says about the job it is doing now. All of it is
            // meaningless once the print has ended, so a cleared or finished
            // card gets nulls rather than the last values of a job that is over.
            //
            // startedAt is this service's own measurement: the printer reports
            // no start time of its own, so it is the moment the state was first
            // seen to be active. A restart mid print loses it, and the Web UI
            // then says the duration is unknown instead of inventing one.
            ...liveProgress(printer, state),
        });
    });

    // Clears the finished print from the dashboard now instead of waiting for
    // the countdown. The summary stays: this ends the result card, not the
    // record of what the print did.
    app.post("/api/print/:printerId/clear", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        if (ACTIVE_STATES.has(printer.currentGcodeState)) {
            return res.status(409).json({
                ok: false,
                error: `${printer.name} is printing (${printer.currentGcodeState}). The result can be cleared once the job has ended.`,
                code: "clearWhilePrinting",
                params: { printer: printer.name, state: printer.currentGcodeState },
            });
        }

        printer.printResultDismissed = true;
        // Its own type rather than a slot update, which carries a spool nothing
        // changed about. Every open dashboard drops the result at once instead
        // of waiting out its update interval.
        broadcastSSE({ type: "print_result_cleared", printer: printer.id });
        res.json({ ok: true });
    });

    // ---------------------------------------------------------------------
    // Manual AMS slot -> Spoolman spool assignments
    //
    // 3rd-party spools have no RFID chip, so nothing links them to a Spoolman
    // spool automatically. These endpoints let the Web UI make that link, which
    // is what enables consumption booking for them (see bookConsumption in
    // mqtt.js). They also resolve the ambiguous case of two tagged spools that
    // are identical in material profile and color.
    // ---------------------------------------------------------------------

    // Full Spoolman spool list for the assignment picker
    app.get("/api/spoolman/spools", async (req, res) => {
        try {
            res.json(await getSpoolmanSpools());
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not load Spoolman spools:", err?.message);
            res.status(502).json({ ok: false, error: err?.message || "Could not load Spoolman spools" });
        }
    });

    // The whole Spoolman record behind one slot, for the spool detail dialog.
    // The dashboard payload is narrowed on purpose (see uispool.js), so the
    // fields the dialog shows are fetched once, on demand, rather than pushed
    // onto every slot of every SSE update.
    app.get("/api/spoolman/spool/:id", async (req, res) => {
        const spoolId = positiveInteger(req.params.id);
        if (!spoolId) return res.status(400).json({ ok: false, error: "The spool id must be a positive integer", code: "spoolIdInvalid" });

        try {
            res.json(await getSpoolmanSpool(spoolId));
        } catch (err) {
            const status = err?.response?.statusCode === 404 ? 404 : 502;
            const message = status === 404
                ? `Spool ${spoolId} not found in Spoolman`
                : err?.message || "Could not load the spool from Spoolman";
            console.error("Server", serverLogFilePath, `Could not load Spoolman spool ${spoolId}:`, err?.message);
            res.status(status).json({ ok: false, error: message });
        }
    });

    // The four fields the detail dialog may correct by hand. Everything else
    // about a spool is either derived, owned by this service, or belongs to the
    // filament, so it is edited in Spoolman itself.
    app.patch("/api/spoolman/spool/:id", async (req, res) => {
        if (rejectSpoolEditInLegacyMode(res)) return;

        const spoolId = positiveInteger(req.params.id);
        if (!spoolId) return res.status(400).json({ ok: false, error: "The spool id must be a positive integer", code: "spoolIdInvalid" });

        const payload = {};

        if (req.body?.remainingWeight !== undefined) {
            const weight = Number(req.body.remainingWeight);
            if (!Number.isFinite(weight) || weight < 0) {
                return res.status(400).json({ ok: false, error: "The remaining weight must be a number of grams, zero or more", code: "weightInvalid" });
            }

            // A running job books its consumption onto the spool when it ends,
            // subtracting from whatever the spool holds at that moment, so a
            // weight corrected now would be overwritten a few minutes later.
            const printing = printerPrintingWithSpool(printers, spoolId);
            if (printing) {
                return res.status(409).json({
                    ok: false,
                    printInFlight: true,
                    error: `${printing.name} is printing (${printing.currentGcodeState}) with this spool. Its consumption is booked when the job ends and would overwrite the corrected weight, so this can be changed once the print is done.`,
                    code: "weightWhilePrinting",
                    params: { printer: printing.name, state: printing.currentGcodeState },
                });
            }

            payload.remaining_weight = weight;
        }

        if (req.body?.comment !== undefined) payload.comment = String(req.body.comment).trim();
        if (req.body?.lotNr !== undefined) payload.lot_nr = String(req.body.lotNr).trim();

        // Archiving by hand is the counterpart of the automatic one, and the way
        // back from it: a spool archived too early is restored from the same
        // row. Only a real boolean is taken, so a string of "false" cannot
        // archive a spool.
        if (req.body?.archived !== undefined) {
            if (typeof req.body.archived !== "boolean") {
                return res.status(400).json({ ok: false, error: "The archived flag must be true or false", code: "archivedInvalid" });
            }
            payload.archived = req.body.archived;
        }

        if (!Object.keys(payload).length) {
            return res.status(400).json({ ok: false, error: "Nothing to change", code: "nothingToChange" });
        }

        try {
            // The upper bound comes from the spool itself, so it is read rather
            // than taken from the caller: a browser tab that has been open for a
            // while may know an older filament.
            if (payload.remaining_weight !== undefined) {
                const limit = spoolWeightLimit(await getSpoolmanSpool(spoolId));
                if (limit != null && payload.remaining_weight > limit) {
                    return res.status(400).json({
                        ok: false,
                        error: `This spool holds at most ${Math.round(limit)} g, so it cannot have ${Math.round(payload.remaining_weight)} g left`,
                        code: "weightAboveLimit",
                        params: { limit: Math.round(limit), weight: Math.round(payload.remaining_weight) },
                    });
                }
            }

            const spool = await patchSpoolFields(spoolId, payload);
            refreshCachedSpool(printers, spool);
            console.log("Server", serverLogFilePath, `[Spool] Updated spool ${spoolId} from the Web UI: ${Object.keys(payload).join(", ")}`);
            res.json(spool);
        } catch (err) {
            const detail = err.response?.body ? JSON.stringify(err.response.body) : err.message;
            console.error("Server", serverLogFilePath, `Could not update Spoolman spool ${spoolId}:`, detail);
            const status = err?.response?.statusCode === 404 ? 404 : 502;
            res.status(status).json({ ok: false, error: detail || "Could not update the spool" });
        }
    });

    app.get("/api/mappings/:printerId", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;
        res.json(getMappings(printer.id));
    });

    app.put("/api/mappings/:printerId/:amsId", async (req, res) => {
        if (rejectInLegacyMode(res)) return;

        const { printerId, amsId } = req.params;
        const printer = resolvePrinter(printerId, printers, res);
        if (!printer) return;

        const spoolId = positiveInteger(req.body?.spoolId);
        if (!spoolId) return res.status(400).json({ ok: false, error: "spoolId must be a positive integer", code: "spoolIdInvalid" });

        const uiSpool = resolveUiSpool(printer, amsId, res);
        if (!uiSpool) return;

        try {
            const spools = await getSpoolmanSpools();
            const spool = spools.find(s => s.id === spoolId);
            if (!spool) return res.status(404).json({ ok: false, error: `Spool ${spoolId} not found in Spoolman`, code: "spoolNotFound", params: { id: spoolId } });

            const mapping = setMapping(printerId, amsId, spoolId, uiSpool.slot);

            // The spool that was assigned here up to now leaves the slot, so it
            // gives its location back before the new one takes it. Waiting for
            // the next AMS update was not an option: by then the cached slot
            // already names the new spool and the old one is nowhere to be found.
            const previous = uiSpool.existingSpool;
            if (previous && previous.id !== spoolId) {
                await releaseSlotLocation(printer, spools.find(s => s.id === previous.id) ?? previous);
            }
            await claimSlotLocation(printer, amsId, spool);

            applyMappingToUiSpool(printer, uiSpool, spool);
            console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId} assigned to Spoolman spool ${spoolId} (${spool.filament?.name ?? "?"})`);

            res.json({ ok: true, mapping });
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not set spool mapping:", err?.message);
            res.status(500).json({ ok: false, error: err?.message || "Could not set spool mapping" });
        }
    });

    // Everything the "new spool" dialog needs to populate its dropdowns, in one
    // round trip. A 3rd party spool tells us only its material and colour, so
    // the rest is picked from what Spoolman already knows.
    app.get("/api/spoolman/lookups", async (req, res) => {
        try {
            const [vendors, materials, externalMaterials, locations, filaments, catalogue] = await Promise.all([
                getSpoolmanVendors(),
                getSpoolmanMaterials(),
                getSpoolmanExternalMaterials(),
                getSpoolmanLocations(),
                getSpoolmanInternalFilaments(),
                // The catalogue itself is far too large to send, but the names
                // in it are what makes the manufacturer field suggest a brand
                // this Spoolman has never seen.
                getCachedExternalFilaments().catch(() => []),
            ]);

            const externalVendors = [...new Set(catalogue
                .map(entry => entry.manufacturer)
                .filter(Boolean))].sort((a, b) => a.localeCompare(b));

            res.json({ vendors, materials, externalMaterials, locations, filaments, externalVendors });
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not load Spoolman lookups:", err?.message);
            res.status(502).json({ ok: false, error: err?.message || "Could not load Spoolman lookups" });
        }
    });

    // The catalogue the create-spool form narrows down in: the manufacturers on
    // offer, the materials that manufacturer sells, and then its entries.
    //
    // Queried while the user types, so it is filtered here: the whole catalogue
    // is around seven thousand entries and a few megabytes, and a browser has no
    // business downloading it to pick ten of them.
    app.get("/api/spoolman/external/filaments", async (req, res) => {
        try {
            const catalogue = await getCachedExternalFilaments();
            const query = {
                manufacturer: req.query.manufacturer,
                material: req.query.material,
                q: req.query.q,
                limit: req.query.limit,
            };

            // The dialog narrows down in steps, so it asks for the values still
            // on offer before it asks for the entries themselves.
            const facet = req.query.facet;
            if (facet === "manufacturer" || facet === "material") {
                return res.json(catalogueFacet(catalogue, facet, query));
            }

            res.json(filterCatalogue(catalogue, query));
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not load the SpoolmanDB catalogue:", err?.message);
            res.status(502).json({ ok: false, error: err?.message || "Could not load the SpoolmanDB catalogue" });
        }
    });

    // Creates a spool for a slot the printer cannot identify by itself and links
    // the slot to it in one step, so the user does not have to assign it
    // separately afterwards. Creates the filament too when none is picked.
    app.post("/api/thirdparty/spool/:printerId/:amsId", async (req, res) => {
        if (rejectInLegacyMode(res)) return;

        const { printerId, amsId } = req.params;
        const printer = resolvePrinter(printerId, printers, res);
        if (!printer) return;

        const uiSpool = resolveUiSpool(printer, amsId, res);
        if (!uiSpool) return;

        const { filamentId, filament, spool = {} } = req.body || {};

        try {
            let resolvedFilamentId = Number(filamentId) || null;

            if (!resolvedFilamentId) {
                const error = validateFilamentInput(filament);
                if (error) return res.status(400).json({ ok: false, error });

                let vendorId = Number(filament.vendorId) || null;
                if (!vendorId && filament.vendorName?.trim()) {
                    // A manufacturer the dialog filled in from the catalogue
                    // brings the two fields Spoolman keeps on a vendor: the
                    // catalogue's own name for it and the weight of its empty
                    // spool. One typed by hand brings neither, and then the
                    // vendor is created with its name alone.
                    const vendor = await createVendor({
                        name: filament.vendorName.trim(),
                        externalId: String(filament.vendorExternalId ?? "").trim() || null,
                        emptySpoolWeight: numberOrNull(filament.vendorSpoolWeight),
                    });
                    vendorId = vendor.id;
                    console.log(printer.name, printer.logFilePath, `[Spool] Created vendor "${vendor.name}" (${vendorId})`);
                }

                // A multi colour filament is stored as the list plus the
                // direction its colours run in, and Spoolman keeps the plain
                // colour field empty then. Sending both is what it refuses.
                const colors = filamentColorSet(filament);
                const multiColour = colors.length > 1;

                const created = await createFilament({
                    name: filament.name?.trim() || null,
                    material: filament.material?.trim() || null,
                    density: Number(filament.density),
                    diameter: Number(filament.diameter),
                    color_hex: multiColour ? null : (colors[0] ?? null),
                    multi_color_hexes: multiColour ? colors.join(",") : "",
                    multi_color_direction: multiColour ? colorDirection(filament.multiColorDirection) : null,
                    weight: numberOrNull(filament.weight),
                    spool_weight: numberOrNull(filament.spoolWeight),
                    settings_extruder_temp: numberOrNull(filament.extruderTemp),
                    settings_bed_temp: numberOrNull(filament.bedTemp),
                    vendor_id: vendorId,
                });
                resolvedFilamentId = created.id;
                console.log(printer.name, printer.logFilePath, `[Spool] Created filament "${created.name ?? "?"}" (${resolvedFilamentId})`);
            }

            const spoolPayload = {
                filament_id: resolvedFilamentId,
                first_used: Date.now(),
                initial_weight: numberOrNull(spool.initialWeight),
                remaining_weight: numberOrNull(spool.remainingWeight),
                // The dialog prefills the slot, but a user who clears the field
                // still ends up with a spool that is demonstrably in this slot,
                // so the slot is what it gets. Only with the setting on: with it
                // off nothing else writes a location either.
                location: spool.location?.trim()
                    || (settings.SET_LOCATION ? slotLocation(printer.name, amsId) : null),
                lot_nr: spool.lotNr?.trim() || null,
                comment: spool.comment?.trim() || null,
            };
            const createdSpool = await createSpoolRecord(spoolPayload);

            // The slot has no tag to link it, so the assignment is the link.
            const mapping = setMapping(printerId, amsId, createdSpool.id, uiSpool.slot);
            const spools = await getSpoolmanSpools();
            applyMappingToUiSpool(printer, uiSpool, spools.find(s => s.id === createdSpool.id) ?? createdSpool);

            console.log(printer.name, printer.logFilePath, `[Spool] Created spool ${createdSpool.id} for ${amsId} and assigned it`);
            res.json({ ok: true, spoolId: createdSpool.id, filamentId: resolvedFilamentId, mapping });
        } catch (err) {
            const detail = err.response?.body ? JSON.stringify(err.response.body) : err.message;
            console.error("Server", serverLogFilePath, "Could not create 3rd party spool:", detail);
            res.status(500).json({ ok: false, error: detail || "Could not create spool" });
        }
    });

    app.delete("/api/mappings/:printerId/:amsId", async (req, res) => {
        if (rejectInLegacyMode(res)) return;

        const { printerId, amsId } = req.params;
        const printer = resolvePrinter(printerId, printers, res);
        if (!printer) return;

        const uiSpool = (printer.spoolData || []).find(s => s.amsId === amsId);
        // Read before the mapping goes, and before the cached slot is cleared:
        // afterwards nothing says which spool used to sit here, which is why an
        // unassigned spool kept naming this slot as its location forever.
        const assigned = uiSpool?.connectedViaMapping ? uiSpool.existingSpool : null;

        const existed = clearMapping(printerId, amsId);

        if (assigned) {
            // Straight from Spoolman rather than from the cache: the ownership
            // check may only clear a location this service wrote, and the
            // cached record carries whatever it said when it was fetched.
            const current = await getSpoolmanSpool(assigned.id).catch(() => assigned);
            await releaseSlotLocation(printer, current);
        }

        if (uiSpool) applyMappingToUiSpool(printer, uiSpool, null);
        if (existed) console.log(printer.name, printer.logFilePath, `[Mapping] ${amsId} assignment removed`);

        res.json({ ok: true, removed: existed });
    });

    // ---------------------------------------------------------------------
    // Runtime configuration
    //
    // Everything that used to be an environment variable only. The values are
    // stored in printers/settings.json and applied to the running process right
    // away, except for the fields the schema marks as restart required.
    // ---------------------------------------------------------------------

    app.get("/api/settings", (req, res) => {
        res.json(getSettingsView());
    });

    app.put("/api/settings", (req, res) => {
        const previousUrl = spoolmanUrl();

        // Two accepted shapes: the bare field map, and the same map wrapped with
        // the revision the caller read, which is what the settings page sends so
        // that a save against a replaced state is refused.
        const wrapped = req.body && typeof req.body.values === "object" && req.body.values !== null;
        const patch = wrapped ? req.body.values : req.body;
        const expectedRevision = wrapped ? req.body.revision : undefined;

        let result;
        try {
            result = updateSettings(patch, expectedRevision);
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not write settings.json:", err?.message);
            return res.status(500).json({ ok: false, error: err?.message || "Could not save the settings" });
        }

        if (!result.ok) {
            const status = result.conflict ? 409 : 400;
            return res.status(status).json({ ok: false, error: result.errors.join(" / "), conflict: !!result.conflict });
        }

        if (result.changed.length) {
            // Never the value itself, and the log is downloadable from the Web
            // UI, so a password change says only that it happened.
            console.log("Server", serverLogFilePath, `[Settings] Changed: ${result.changed.join(", ")}`);
        }

        // A new password invalidates every session, so the caller is handed one
        // signed with it rather than being sent to the login page mid save.
        if (result.changed.includes("AUTH_PASSWORD") && authEnabled()) issueSession(req, res);
        // The interval is copied onto every printer object, so a change has to
        // be pushed into the running ones.
        if (result.changed.includes("UPDATE_INTERVAL")) syncPrinterIntervals();
        // Switching the automatic assignment on has to reach the slots that are
        // already loaded, not only the next spool that moves.
        if (result.changed.includes("AUTO_ASSIGN_THIRD_PARTY")) reprocessSlotsOnNextReport();
        if (spoolmanUrl() !== previousUrl) restartSpoolmanConnection();

        const view = getSettingsView();
        broadcastSSE({ type: "settings_update", values: view.values });

        res.json({ ok: true, ...view, changed: result.changed, restartRequired: result.restartRequired });
    });

    // ---------------------------------------------------------------------
    // API keys
    //
    // The Network access card again, for the callers that have no browser to
    // log in with. Behind the same middleware as everything else: a key can be
    // created by a browser session and by another key, which is what "a key is
    // a full session" means. See apikeys.js.
    // ---------------------------------------------------------------------

    app.get("/api/apikeys", (req, res) => {
        res.json({ keys: listApiKeys() });
    });

    app.post("/api/apikeys", (req, res) => {
        let result;
        try {
            result = createApiKey(req.body?.name);
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not write apikeys.json:", err?.message);
            return res.status(500).json({ ok: false, error: err?.message || "Could not save the key" });
        }

        if (!result.ok) return res.status(400).json({ ok: false, error: result.error, code: result.code, params: result.params });

        // The one time the key exists outside the caller. Everything after this
        // sees the hash, so a client that loses it has to create a new one.
        res.json({ ok: true, key: result.key, entry: result.entry, keys: listApiKeys() });
    });

    app.delete("/api/apikeys/:id", (req, res) => {
        let removed;
        try {
            removed = removeApiKey(req.params.id);
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not write apikeys.json:", err?.message);
            return res.status(500).json({ ok: false, error: err?.message || "Could not remove the key" });
        }

        if (!removed) return res.status(404).json({ ok: false, error: "No key with this id", code: "apiKeyNotFound" });
        res.json({ ok: true, removed, keys: listApiKeys() });
    });

    // ---------------------------------------------------------------------
    // Service
    //
    // What the Service card at the bottom of the settings page needs: the facts
    // about this installation, the update check, and the support bundle.
    // ---------------------------------------------------------------------

    app.get("/api/system", (req, res) => {
        res.json(systemInfo());
    });

    app.get("/api/update", async (req, res) => {
        res.json(await checkForUpdate({ force: req.query.force === "true" }));
    });

    // One archive with the logs, the configuration and the facts about the
    // installation, which is what a bug report otherwise takes four rounds of
    // questions to collect. Anonymised unless the caller says otherwise, and the
    // access code is replaced in both variants; see anonymize.js.
    app.get("/api/diagnostics/download", async (req, res) => {
        const scope = parseDiagnosticsScope(req.query.scope, printers);
        if (scope.error) return res.status(400).json({ ok: false, error: scope.error });

        try {
            const anonymize = req.query.anonymize !== "false";
            const { buffer, filename } = await buildDiagnosticsBundle({ anonymize, scope });

            const carried = [
                scope.server ? "server log" : null,
                ...scope.printers.map(entry => `${entry.id}${entry.log && entry.trace ? "" : entry.log ? " log only" : " trace only"}`),
            ].filter(Boolean).join(", ") || "no logs";
            console.log("Server", serverLogFilePath, `[Service] Diagnostics bundle created (${anonymize ? "anonymised" : "full"}, ${Math.round(buffer.length / 1024)} KB, ${carried})`);

            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Content-Length", buffer.length);
            res.end(buffer);
        } catch (err) {
            console.error("Server", serverLogFilePath, `Diagnostics bundle failed: ${err.message}`);
            res.status(500).json({ ok: false, error: "The bundle could not be built", code: "bundleFailed" });
        }
    });

    // ---------------------------------------------------------------------
    // Notices
    //
    // The dashboard shows each once and the dismissal is stored server side,
    // in settings.json beside the values, so it does not come back on the next
    // browser. The environment notice disappears on its own once the values
    // have been saved in the Web UI, which is why nothing here has to know the
    // previous version. The image notice is the exception: its dismissal is
    // held in memory only, so it is back after every start until the image
    // has been switched, see imagenotice.js.
    // ---------------------------------------------------------------------

    app.get("/api/notices", (req, res) => {
        res.json({
            [UPGRADE_NOTICE]: upgradeNotice(),
            [ENV_CONFIG_NOTICE]: deprecatedConfig(),
            [IMAGE_NOTICE]: legacyImageNotice(),
        });
    });

    // The API described in OpenAPI, for the API page of the Web UI and for
    // anything that imports the format. Behind the same middleware as every
    // other route: the document is not a secret, but it is nothing a caller
    // without a key has a use for either.
    app.get("/api/openapi.json", (req, res) => {
        res.json(buildOpenApiDocument());
    });

    app.post("/api/notices/:id/ack", (req, res) => {
        if (![UPGRADE_NOTICE, ENV_CONFIG_NOTICE, IMAGE_NOTICE].includes(req.params.id)) {
            return res.status(404).json({ ok: false, error: "Unknown notice", code: "unknownNotice" });
        }

        if (req.params.id === IMAGE_NOTICE) {
            dismissLegacyImageNotice();
            return res.json({ ok: true });
        }

        try {
            acknowledgeNotice(req.params.id);
        } catch (err) {
            console.error("Server", serverLogFilePath, "Could not write settings.json:", err?.message);
            return res.status(500).json({ ok: false, error: err?.message || "Could not store the acknowledgement" });
        }

        res.json({ ok: true });
    });

    // ---------------------------------------------------------------------
    // Printer management
    //
    // The access code is never sent to a client. An update without a code keeps
    // the stored one, which is how the Web UI edits a printer it cannot display
    // the code of.
    // ---------------------------------------------------------------------

    app.get("/api/printers/config", (req, res) => {
        res.json(printers.map(publicPrinter));
    });

    app.post("/api/printers", (req, res) => {
        const result = addPrinter(req.body);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

        console.log("Server", serverLogFilePath, `[Printer] Added ${result.printer.name} (${result.printer.id})`);
        broadcastSSE({ type: "printers_update" });

        // Connect right away instead of waiting for the next monitor pass.
        setupMqtt(result.printer);

        res.json({ ok: true, printer: publicPrinter(result.printer) });
    });

    app.put("/api/printers/:printerId", async (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        // Read before the update, because the locations already in Spoolman
        // carry this name and nothing would recognise them afterwards.
        const previousName = printer.name;

        // Only an address or credential change drops the connection, a rename
        // does not, so only that needs the print in flight to be confirmed.
        const changesConnection = (req.body?.ip?.trim() && req.body.ip.trim() !== printer.ip)
            || !!req.body?.code?.trim();
        if (changesConnection && printBlocks(printer, req.body)) {
            return respondPrintInFlight(res, printer, "Changing the address or the access code reconnects the printer", "reconnect");
        }

        const result = updatePrinter(req.params.printerId, req.body);
        if (!result.ok) {
            const status = result.error === "Printer not found" ? 404 : 400;
            return res.status(status).json({ ok: false, error: result.error });
        }

        if (result.printer.name !== previousName) {
            await renamePrinterLocations(result.printer, previousName);
        }

        console.log(result.printer.name, result.printer.logFilePath, `[Printer] Updated ${result.printer.name} (${result.printer.id})`);
        broadcastSSE({ type: "printers_update" });

        if (result.reconnect) {
            disconnectPrinter(result.printer);
            // The cooldown in setupMqtt guards against retry storms, not against
            // a deliberate reconnect, so clear it here.
            result.printer.lastReconnectAttempt = 0;
            result.printer.reconnectAttempts = 0;
            resetOfflineBackoff(result.printer);
            if (result.printer.monitoringEnabled) setupMqtt(result.printer);
        }

        res.json({ ok: true, printer: publicPrinter(result.printer), reconnected: result.reconnect });
    });

    // Its own route rather than a field of the update above: that one validates
    // the address and the access code and decides whether to reconnect, and how
    // much a printer writes to its log has nothing to do with either. An empty
    // body puts the printer back on the global settings.
    app.put("/api/printers/:printerId/logdetail", (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        const result = updatePrinterLogDetail(printer.id, req.body);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

        console.log(result.printer.name, result.printer.logFilePath,
            `[Printer] Log detail changed for ${result.printer.name} (${result.printer.id})`);
        broadcastSSE({ type: "printers_update" });

        res.json({ ok: true, printer: publicPrinter(result.printer) });
    });

    app.delete("/api/printers/:printerId", async (req, res) => {
        const printer = resolvePrinter(req.params.printerId, printers, res);
        if (!printer) return;

        if (printBlocks(printer, req.body)) {
            return respondPrintInFlight(res, printer, "Removing the printer disconnects it", "remove");
        }

        printer.monitoringEnabled = false;
        disconnectPrinter(printer);

        // Before the printer goes: its name is what the ownership check matches
        // on, so once it is removed nothing can tell its locations apart from
        // the ones a user set by hand.
        await releasePrinterLocations(printer);

        const result = removePrinter(printer.id);
        if (!result.ok) return res.status(404).json({ ok: false, error: result.error });

        // The assignments describe slots of a printer that no longer exists.
        clearPrinterMappings(printer.id);

        console.log("Server", serverLogFilePath, `[Printer] Removed ${printer.name} (${printer.id})`);
        broadcastSSE({ type: "printers_update" });

        res.json({ ok: true, removed: printer.id });
    });

    // Ends the process so it is started again. The consumption of a running job
    // is booked when it ends, and that state lives in memory, so a restart mid
    // print has to be confirmed the same way a reconnect does.
    app.post("/api/restart", (req, res) => {
        const printing = printers.find(printer => printBlocks(printer, req.body));
        if (printing) {
            return respondPrintInFlight(res, printing, "Restarting ends the process", "restart");
        }

        res.json({ ok: true });
        restartService();
    });

    // ---------------------------------------------------------------------
    // Connection tests
    //
    // Both take the values from the form rather than the stored ones, so a
    // setting can be tried before it is saved. Nothing is written here.
    // ---------------------------------------------------------------------

    app.post("/api/test/spoolman", async (req, res) => {
        const candidate = {};
        for (const key of ["SPOOLMAN_ENDPOINT", "SPOOLMAN_IP", "SPOOLMAN_PORT", "SPOOLMAN_SUBFOLDER"]) {
            const result = coerceSetting(key, req.body?.[key]);
            if (result.error) return res.status(400).json({ ok: false, error: result.error });
            candidate[key] = result.value;
        }

        const url = buildSpoolmanUrl(candidate);
        const health = await checkSpoolmanHealth(url);

        res.json({ ...health, url });
    });

    app.post("/api/test/printer", async (req, res) => {
        const id = String(req.body?.id || "").trim().toUpperCase();
        const ip = String(req.body?.ip || "").trim();
        // The Web UI never receives the stored access code, so an empty one in
        // an edit means "test the code that is already stored".
        const known = printers.find(p => p.id === id);
        const code = String(req.body?.code || "").trim() || known?.code || "";

        if (!id) return res.status(400).json({ ok: false, error: "Serial number is required", code: "serialRequired" });
        if (!ip) return res.status(400).json({ ok: false, error: "Address is required", code: "addressRequired" });
        if (!code) return res.status(400).json({ ok: false, error: "Access code is required", code: "accessCodeRequired" });

        // Both checks are independent, and a printer that fails one usually
        // fails the other, so waiting for them one after another only doubles
        // the time until the user sees the result.
        const [mqttResult, ftpsResult] = await Promise.all([
            testMqttConnection({ id, ip, code }),
            testFtpsConnection({ ip, code }),
        ]);

        const target = known ? known.name : id;
        console.log("Server", serverLogFilePath, `[Test] ${target}: MQTT ${mqttResult.ok ? "ok" : `failed (${mqttResult.detail})`}, FTPS ${ftpsResult.ok ? "ok" : `failed (${ftpsResult.detail})`}`);

        res.json({ ok: mqttResult.ok && ftpsResult.ok, mqtt: mqttResult, ftps: ftpsResult });
    });
}

/**
 * Whether a request has to be confirmed because the printer is mid print.
 *
 * The consumption of a running job is booked when it reaches a terminal state,
 * from data collected while it ran. Dropping the connection before that loses
 * the booking. Legacy mode writes the weight on every AMS update instead, so
 * there is nothing in flight to lose there.
 *
 * @param {object} printer - the printer runtime object
 * @param {object} body - the request body, which may carry `force`
 * @returns {boolean} true when the caller has to confirm first
 */
function printBlocks(printer, body) {
    if (body?.force === true) return false;
    if (legacyMode()) return false;
    return ACTIVE_STATES.has(printer.currentGcodeState);
}

/**
 * Answers a request that would interrupt a running print.
 *
 * @param {object} res - the response
 * @param {object} printer - the printer that is printing
 * @param {string} what - the consequence in English, for the `error` text
 * @param {string} action - the same as a word the Web UI translates: reconnect, remove, restart
 */
function respondPrintInFlight(res, printer, what, action) {
    res.status(409).json({
        ok: false,
        printInFlight: true,
        error: `${printer.name} is printing (${printer.currentGcodeState}). ${what}. The job is booked when it ends if the service is back by then, with its start time; on a P1 or an A1 the slots Bambu Studio sent it to are lost.`,
        code: `printInFlight.${action}`,
        params: { printer: printer.name, state: printer.currentGcodeState },
    });
}

/** The printer fields a client may see. The access code is deliberately not one of them. */
function publicPrinter(printer) {
    return {
        id: printer.id,
        name: printer.name,
        ip: printer.ip,
        hasCode: !!printer.code,
        mqttStatus: printer.mqttStatus,
        monitoringEnabled: printer.monitoringEnabled,
        // What the log detail dialog shows for this printer. An absent field
        // means it follows the global setting, which is what the dialog draws
        // as "inherit" rather than as a value of its own.
        logDetail: printer.logDetail || {},
    };
}

/** Closes the MQTT connection of a printer, if it has one. */
function disconnectPrinter(printer) {
    closeMqtt(printer, "the printer was changed or removed in the Web UI");
    printer.mqttStatus = "Disconnected";
}

/** Parses a value into a finite number, or null when it is empty or invalid. */
/** A Spoolman id as a request carries it, or null for anything that is not one. */
function positiveInteger(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Normalises a colour to a bare 6 digit uppercase hex, or null when invalid. */
function normalizeHex(value) {
    const hex = String(value || "").replace(/^#/, "").slice(0, 6).toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? hex : null;
}

/**
 * The colours of a filament as the dialog sends them, normalised and in order.
 *
 * The AMS reports every colour of a multi colour spool and the catalogue lists
 * them too, so the form offers all of them. `colorHex` is still read for a
 * caller that sends a single colour the way this endpoint first took it.
 *
 * @param {object} filament - the filament details from the request
 * @returns {string[]} six digit uppercase hex colours, without duplicates
 */
function filamentColorSet(filament) {
    const raw = Array.isArray(filament?.colorHexes) ? filament.colorHexes : [filament?.colorHex];
    const colors = raw.map(normalizeHex).filter(Boolean);
    return [...new Set(colors)];
}

/** The two directions Spoolman knows, defaulting to the common one. */
function colorDirection(value) {
    return value === "longitudinal" ? "longitudinal" : "coaxial";
}

/**
 * Validates the filament details typed into the new spool dialog.
 *
 * Density and diameter are the only fields Spoolman requires on a filament, and
 * neither can be read off a chipless spool.
 *
 * @param {object|undefined} filament - the filament details from the request
 * @returns {string|null} an error message, or null when the input is usable
 */
function validateFilamentInput(filament) {
    if (!filament) return "Either filamentId or filament details are required";
    if (!Number.isFinite(Number(filament.density)) || Number(filament.density) <= 0) return "Density must be a positive number";
    if (!Number.isFinite(Number(filament.diameter)) || Number(filament.diameter) <= 0) return "Diameter must be a positive number";
    return null;
}

/**
 * Writes an edited Spoolman spool into every slot that already holds it.
 *
 * `printer.spoolData` caches whole Spoolman records and is refreshed from
 * Spoolman on the monitor interval, so without this the dashboard would keep
 * showing the weight the spool had before the edit until that interval comes
 * round. The slot update goes out over SSE the same way a mapping change does.
 *
 * @param {object[]} printers - the printer list
 * @param {object} spool - the spool as Spoolman answered with it
 */
function refreshCachedSpool(printers, spool) {
    for (const printer of printers) {
        for (const uiSpool of printer.spoolData || []) {
            if (uiSpool.existingSpool?.id !== spool.id) continue;

            // The dashboard reads the weight off the spool itself, so following
            // it is all there is to do.
            uiSpool.existingSpool = spool;
            // Archiving or restoring by hand changes what the slot says about
            // itself, and the next AMS update is up to two minutes away.
            uiSpool.archived = !!spool.archived;
            broadcastSlotUpdate(printer.id, uiSpool);
        }
    }
}

/**
 * Reflects a mapping change in the cached slot data right away and pushes it to
 * connected clients. Without this the overview would keep showing the old state
 * until the next AMS update happens to rebuild printer.spoolData.
 */
function applyMappingToUiSpool(printer, uiSpool, spool) {
    uiSpool.existingSpool        = spool;
    uiSpool.connectedViaMapping  = !!spool;
    // Set or cleared by hand either way, so what the colour match once chose
    // is no longer what the dashboard says.
    uiSpool.assignedAutomatically = false;
    uiSpool.option               = spool ? SLOT_OPTIONS.UNASSIGN : SLOT_OPTIONS.ASSIGN;
    uiSpool.enableButton         = "true";

    broadcastSlotUpdate(printer.id, uiSpool);
}
