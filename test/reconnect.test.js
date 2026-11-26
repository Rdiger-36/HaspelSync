import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// The write paths have to stay out of a real installation, and these are read
// once at import time, so they are set before the first import below.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-reconnect-"));
process.env.DATA_DIR = path.join(dir, "printers");
process.env.LOG_DIR = path.join(dir, "logs");
fs.ensureDirSync(process.env.DATA_DIR);
fs.ensureDirSync(process.env.LOG_DIR);

const { servicePrinters, describeRequestError } = await import("../src/mqtt.js");
const { state } = await import("../src/state.js");
const { settings } = await import("../src/settings.js");

/** A printer that is enabled, not connected, and points at nothing. */
function offlinePrinter() {
    return {
        id: "TESTPRINTER0001",
        name: "Test Printer",
        // 203.0.113.0/24 is reserved for documentation and routes nowhere, so
        // the reachability probe fails on its own timeout rather than reaching
        // something on the machine running the tests.
        ip: "203.0.113.1",
        logFilePath: path.join(process.env.LOG_DIR, "TESTPRINTER0001.log"),
        monitoringEnabled: true,
        mqttRunning: false,
        mqttStatus: "Disconnected",
        reconnectAttempts: 0,
        offlineChecks: 0,
        nextCheckAt: 0,
        offlineWaitLogged: null,
    };
}

test("the printer monitor keeps working while Spoolman is down", async () => {
    // It used to idle for as long as Spoolman was unreachable, and it is the
    // only thing that reconnects MQTT. Measured on 2026-09-05: a network drop
    // took both down within nine seconds, and for the five minutes until the
    // process was restarted there was not one reconnect attempt and not one
    // reachability check, while the printer answered the whole time.
    const before = state.spoolmanStatus;
    const interval = settings.OFFLINE_CHECK_INTERVAL;

    try {
        state.spoolmanStatus = "Disconnected";
        // Short enough that a tick happens inside the window below
        settings.OFFLINE_CHECK_INTERVAL = 20000;

        const printer = offlinePrinter();
        await servicePrinters([printer]);

        // The probe was made: an unreachable printer comes back with its
        // backoff armed, which is the loop having looked at it at all.
        assert.ok(printer.nextCheckAt > 0, "the printer was never probed while Spoolman was down");
    } finally {
        state.spoolmanStatus = before;
        settings.OFFLINE_CHECK_INTERVAL = interval;
    }
});

test("a printer nobody is monitoring is still left alone while Spoolman is down", async () => {
    // Removing the Spoolman gate must not turn the loop into something that
    // touches printers the user switched off.
    const before = state.spoolmanStatus;

    try {
        state.spoolmanStatus = "Disconnected";

        const printer = { ...offlinePrinter(), monitoringEnabled: false };
        await servicePrinters([printer]);

        assert.equal(printer.mqttStatus, "Disabled");
        assert.equal(printer.nextCheckAt, 0, "a disabled printer must not be probed");
    } finally {
        state.spoolmanStatus = before;
    }
});

test("a failed request is named by its code rather than swallowed", () => {
    // The health checks used to discard the error, so an outage produced a run
    // of identical lines saying only "unreachable". These are four different
    // problems and the log could not tell them apart.
    assert.equal(describeRequestError({ code: "EHOSTUNREACH" }), "EHOSTUNREACH");
    assert.equal(describeRequestError({ code: "ECONNREFUSED" }), "ECONNREFUSED");
    assert.equal(describeRequestError({ code: "ETIMEDOUT" }), "ETIMEDOUT");

    // got wraps the original in `cause`, which is where the code really sits
    assert.equal(describeRequestError({ message: "x", cause: { code: "ECONNRESET" } }), "ECONNRESET");

    // An endpoint that answers something that is not Spoolman
    assert.equal(describeRequestError(new SyntaxError("Unexpected token <")), "the answer was not JSON");

    // Anything else still says something rather than nothing
    assert.equal(describeRequestError(new Error("boom")), "boom");
    assert.equal(describeRequestError(undefined), "no reason given");
    assert.equal(describeRequestError({}), "no reason given");
});

test("a connected printer is not probed, so a slow broker cannot double its connection", async () => {
    // The probe is itself a connection to the broker. A P1S near its client
    // limit fails it while the live connection keeps working, and the loop then
    // used to mark the printer offline and build a second client beside it.
    let ended = false;
    const fakeClient = { connected: true, end() { ended = true; } };
    const printer = { ...offlinePrinter(), mqttRunning: true, mqttStatus: "Connected", mqttClient: fakeClient };

    await servicePrinters([printer]);

    assert.equal(printer.mqttRunning, true);
    assert.equal(printer.nextCheckAt, 0);
    assert.equal(printer.mqttClient, fakeClient);
    assert.equal(ended, false);
});
