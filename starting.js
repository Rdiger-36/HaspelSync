/**
 * The service process.
 *
 * Purpose:
 *  - Catches all global Node.js errors (including unhandled Promise rejections)
 *  - Sends all output to stdout/stderr → visible in `docker logs`
 *  - Clearly prefixes its own messages with "[Service]" for easy identification
 *  - Checks that printers/ and logs/ are writable, see src/datadirs.js
 *  - Starts backend.js safely
 *  - Handles SIGTERM / SIGINT, which the supervisor forwards on a Docker stop
 *
 * This is what `entrypoint.js` forks. It runs in its own process so that the
 * supervisor can start it again after a requested restart; the error handlers
 * have to live here for the same reason, they only see the process they are in.
 */

import { formatDateLog } from "./src/utils.js";

// ---------------------------------------------------------
// Logging Utilities
// ---------------------------------------------------------
function logInfo(message) {
    process.stdout.write(`[Service] [${formatDateLog(new Date())}] ${message}\n`);
}

function logError(label, err) {
    const details = err?.stack || err?.message || String(err);
    process.stderr.write(`[Service] [${formatDateLog(new Date())}] [${label}] ${details}\n`);
}

// ---------------------------------------------------------
// Global Error Handling
// ---------------------------------------------------------
process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION", err);
    process.exit(1); // crash visibly so Docker logs show the reason
});

process.on("unhandledRejection", (reason) => {
    logError("UNHANDLED REJECTION", reason);
    process.exit(1);
});

// ---------------------------------------------------------
// Graceful Shutdown for Docker Stop / Ctrl+C
// ---------------------------------------------------------
process.on("SIGTERM", () => {
    logInfo("SIGTERM received – shutting down backend...");
    process.exit(0);
});

process.on("SIGINT", () => {
    logInfo("SIGINT (Ctrl+C) received – shutting down backend...");
    process.exit(0);
});

process.on("exit", (code) => {
    logInfo(`Service process exited with code ${code}`);
});

// ---------------------------------------------------------
// Start Backend
// ---------------------------------------------------------
(async () => {
    try {
    // Before the backend: its first import is the logger, which writes to
    // logs/ at once, and a directory left to root by an earlier image would
    // fail there and on every save afterwards rather than say why.
    const { checkDataDirs } = await import("./src/datadirs.js");
    const problem = checkDataDirs();
    if (problem) {
        for (const line of problem) logError("DATA DIRECTORIES", line);
        process.exit(1);
    }

    logInfo("Starting backend.js ...");

    // Dynamic import so startup errors can be caught. Resolved as a URL rather
    // than a path: the ESM loader takes a file URL on every platform, while an
    // absolute Windows path such as D:\app\backend.js is read as the URL
    // scheme "d:" and refused before the service even starts.
    await import(new URL("./backend.js", import.meta.url));

    logInfo("Backend is now running and waiting for events...");
    } catch (err) {
    logError("STARTUP ERROR", err);
    process.exit(1);
    }
})();
