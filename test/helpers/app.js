import express from "express";
import fs from "fs-extra";
import os from "os";
import path from "path";

/**
 * Starts the HTTP API against a throwaway data directory.
 *
 * The routes are registered on a bare Express app rather than through
 * `backend.js`, so nothing waits for Spoolman and no monitor loop is started.
 * DATA_DIR and LOG_DIR are pointed at a temporary directory before the modules
 * are imported, which is what keeps the write paths, printers.json,
 * settings.json and the log files, away from a real installation. They are read
 * once at import time, so this has to run before the first import and each test
 * file gets its own process anyway.
 *
 * @param {object} [options]
 * @param {Array} [options.seedPrinters] - Written to printers.json before the import.
 * @returns {Promise<{url: string, dataDir: string, close: function(): Promise<void>, readJson: function(string): object|null}>}
 */
export async function startTestApp({ seedPrinters } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-test-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    // Written before the import, so printers.js loads them the way a real start
    // does. A test that needs a printer to exist without going through
    // POST /api/printers wants this: adding one over the API also creates the
    // log file, asynchronously and with a truncating write, which races anything
    // the test wants to put in that file.
    if (seedPrinters) {
        fs.writeFileSync(path.join(process.env.DATA_DIR, "printers.json"), JSON.stringify(seedPrinters, null, 4));
    }

    const { registerRoutes } = await import("../../src/routes.js");
    const { printers } = await import("../../src/printers.js");
    const { hostGuard } = await import("../../src/security.js");
    const { requireAuth } = await import("../../src/auth.js");
    const { flushLogs } = await import("../../src/logger.js");

    const app = express();
    // Same order as backend.js, so a route is exercised behind the guard rather
    // than in front of it. The server listens on 127.0.0.1, so every request a
    // test makes carries an IP address as its host and passes.
    app.use(hostGuard());
    // Same order as backend.js. It does nothing until a password is set, so
    // every other suite is unaffected.
    app.use(requireAuth());
    app.use(express.json());
    registerRoutes(app, printers);

    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));

    return {
        url: `http://127.0.0.1:${server.address().port}`,
        dataDir: process.env.DATA_DIR,
        readJson(name) {
            try {
                return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, name), "utf-8"));
            } catch {
                return null;
            }
        },
        async close() {
            await new Promise(resolve => server.close(resolve));
            // Log writes are queued per file; a write still in flight when the
            // directory goes lands on a path that no longer exists and prints
            // an ENOENT into the test output.
            const logDir = process.env.LOG_DIR;
            for (const name of fs.readdirSync(logDir)) {
                await flushLogs(path.join(logDir, name));
            }
            fs.removeSync(dir);
        },
    };
}

/**
 * What a browser puts on a request its own page made.
 *
 * Without a password the API answers a caller that is not the Web UI only when
 * it carries an API key, and `Sec-Fetch-Site` is how the Web UI is recognised.
 * A test that stands in for the Web UI sends this; a test that stands in for a
 * script or a home automation deliberately does not. See `isFromOwnUi()` in
 * src/security.js.
 */
export const UI_HEADERS = { "Sec-Fetch-Site": "same-origin" };

/** Small fetch wrapper returning status and parsed body together. */
export async function call(url, method = "GET", body, headers = UI_HEADERS) {
    const response = await fetch(url, {
        method,
        headers: body === undefined ? { ...headers } : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, body: await response.json().catch(() => null) };
}
