import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

import { startTestApp, call, UI_HEADERS } from "./helpers/app.js";

// The API is exercised over HTTP against a throwaway data directory, so the
// write paths are covered rather than only the pure functions behind them.
let app;

before(async () => { app = await startTestApp(); });
after(async () => { await app.close(); });

/* ---- Settings ---- */

test("the settings come with their metadata and a revision", async () => {
    const { status, body } = await call(`${app.url}/api/settings`);

    assert.equal(status, 200);
    assert.equal(typeof body.values.UPDATE_INTERVAL, "number");
    assert.ok(body.fields.some(field => field.key === "MODE"));
    assert.equal(typeof body.revision, "number");
});

test("an unusable value is refused and nothing is written", async () => {
    const { status, body } = await call(`${app.url}/api/settings`, "PUT", { MAX_RETRIES: "soon" });

    assert.equal(status, 400);
    assert.match(body.error, /whole number/);
    assert.equal(app.readJson("settings.json"), null);
});

test("an unknown setting is refused", async () => {
    const { status, body } = await call(`${app.url}/api/settings`, "PUT", { SPOOLMAN_PASSWORD: "x" });

    assert.equal(status, 400);
    assert.match(body.error, /Unknown setting/);
});

test("a body that is not JSON is answered in the shape of every route", async () => {
    const response = await fetch(`${app.url}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...UI_HEADERS },
        body: "{broken",
    });

    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "invalidJson");
    assert.equal(app.readJson("settings.json"), null);
});

test("an error inside a handler is answered as a 500 without its details", async () => {
    // Imported here, after startTestApp() pointed DATA_DIR at the temporary directory.
    const { handleRequestError } = await import("../src/routes.js");
    const answer = {};
    const res = {
        headersSent: false,
        status(code) { answer.status = code; return this; },
        json(body) { answer.body = body; return this; },
    };

    handleRequestError(new Error("secret detail"), { method: "GET", path: "/api/x" }, res, () => assert.fail("next() called"));

    assert.equal(answer.status, 500);
    assert.deepEqual(answer.body, { ok: false, error: "Internal server error", code: "internalError" });
});

test("saving clamps into the documented range and writes the file", async () => {
    const { status, body } = await call(`${app.url}/api/settings`, "PUT", { UPDATE_INTERVAL: "1000" });

    assert.equal(status, 200);
    assert.equal(body.values.UPDATE_INTERVAL, 5000);
    assert.deepEqual(body.changed, ["UPDATE_INTERVAL"]);

    const stored = app.readJson("settings.json");
    assert.equal(stored.values.UPDATE_INTERVAL, 5000);
    assert.equal(stored.schemaVersion, 2);
});

test("a save against a replaced state is refused", async () => {
    const before = await call(`${app.url}/api/settings`);
    const stale = before.body.revision;

    await call(`${app.url}/api/settings`, "PUT", { revision: stale, values: { MAX_RETRIES: 3 } });
    const conflict = await call(`${app.url}/api/settings`, "PUT", { revision: stale, values: { MAX_RETRIES: 9 } });

    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.conflict, true);

    const now = await call(`${app.url}/api/settings`);
    assert.equal(now.body.values.MAX_RETRIES, 3);
});

/* ---- Printers ---- */

const printer = { id: "01p00a000000001", code: "12345678", ip: "127.0.0.1", name: "Test printer" };

test("a printer is created, listed without its access code and persisted", async () => {
    const created = await call(`${app.url}/api/printers`, "POST", printer);
    assert.equal(created.status, 200);

    const { body } = await call(`${app.url}/api/printers/config`);
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "01P00A000000001");
    assert.equal(body[0].hasCode, true);
    assert.equal(body[0].code, undefined);

    assert.deepEqual(app.readJson("printers.json"), [{
        id: "01P00A000000001",
        code: "12345678",
        ip: "127.0.0.1",
        name: "Test printer",
    }]);
});

test("a duplicate serial number and a missing field are refused", async () => {
    const duplicate = await call(`${app.url}/api/printers`, "POST", printer);
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.error, /already exists/);

    const incomplete = await call(`${app.url}/api/printers`, "POST", { id: "X", ip: "127.0.0.1", code: "1" });
    assert.equal(incomplete.status, 400);
    assert.match(incomplete.body.error, /name/);
});

test("an update without an access code keeps the stored one", async () => {
    const { status } = await call(`${app.url}/api/printers/01P00A000000001`, "PUT", {
        name: "Renamed", ip: "127.0.0.1", code: "",
    });

    assert.equal(status, 200);
    assert.deepEqual(app.readJson("printers.json"), [{
        id: "01P00A000000001",
        code: "12345678",
        ip: "127.0.0.1",
        name: "Renamed",
    }]);
});

test("an unknown printer is a 404", async () => {
    const missing = await call(`${app.url}/api/printers/NOPE`, "PUT", { name: "x" });
    assert.equal(missing.status, 404);
});

test("a removed printer is gone from the list and the file", async () => {
    const removed = await call(`${app.url}/api/printers/01P00A000000001`, "DELETE", {});
    assert.equal(removed.status, 200);

    const { body } = await call(`${app.url}/api/printers/config`);
    assert.deepEqual(body, []);
    assert.deepEqual(app.readJson("printers.json"), []);
});

/* ---- Connection tests ---- */

test("the printer test names the field it is missing", async () => {
    const noSerial = await call(`${app.url}/api/test/printer`, "POST", { ip: "127.0.0.1", code: "1" });
    assert.equal(noSerial.status, 400);
    assert.match(noSerial.body.error, /Serial number/);

    const noCode = await call(`${app.url}/api/test/printer`, "POST", { id: "01P00A000000002", ip: "127.0.0.1" });
    assert.equal(noCode.status, 400);
    assert.match(noCode.body.error, /Access code/);
});

test("the Spoolman test reports an unconfigured endpoint rather than failing", async () => {
    const { status, body } = await call(`${app.url}/api/test/spoolman`, "POST", {});

    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.url, "");
    assert.match(body.error, /No endpoint/);
});

test("the Spoolman test builds the URL from host, port and subfolder", async () => {
    const { body } = await call(`${app.url}/api/test/spoolman`, "POST", {
        SPOOLMAN_IP: "127.0.0.1",
        SPOOLMAN_PORT: "1",
        SPOOLMAN_SUBFOLDER: "/spoolman",
    });

    assert.equal(body.url, "http://127.0.0.1:1/spoolman");
    assert.equal(body.ok, false);
});

/* ---- Logs ---- */

test("the log endpoint reads across the rotated files", async () => {
    const logDir = process.env.LOG_DIR;
    fs.writeFileSync(path.join(logDir, "server.log.1"), "older line\n");
    fs.writeFileSync(path.join(logDir, "server.log"), "current line\n");

    const { status, body } = await call(`${app.url}/api/logs/server?limit=10`);

    assert.equal(status, 200);
    assert.deepEqual(body.logs, ["older line", "current line"]);
    assert.equal(body.files, 2);
    // The size covers the rotated file too, because the download does
    assert.equal(body.bytes, "older line\n".length + "current line\n".length);
    assert.equal(body.file, "server.log");
    assert.equal(body.capturing, true);
});

test("the download is a zip once there is a history, and a log file before that", async () => {
    const logDir = process.env.LOG_DIR;
    fs.writeFileSync(path.join(logDir, "server.log.1"), "older line\n");
    fs.writeFileSync(path.join(logDir, "server.log"), "current line\n");

    const archive = await fetch(`${app.url}/api/logs/server/download`, { headers: UI_HEADERS });
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get("content-type"), "application/zip");
    assert.match(archive.headers.get("content-disposition"), /server_logs\.zip/);

    // The rotated file has to be in there, otherwise the button promises more
    // than it delivers, which is what it used to do.
    const zip = new AdmZip(Buffer.from(await archive.arrayBuffer()));
    const names = zip.getEntries().map(entry => entry.entryName).sort();
    assert.deepEqual(names, ["01_server.rotated.1.log", "02_server.current.log"]);
    assert.equal(zip.readAsText("01_server.rotated.1.log"), "older line\n");

    fs.rmSync(path.join(logDir, "server.log.1"));
    const single = await fetch(`${app.url}/api/logs/server/download`, { headers: UI_HEADERS });
    assert.match(single.headers.get("content-type"), /text\/plain/);
    assert.match(single.headers.get("content-disposition"), /server\.log/);
    assert.equal(await single.text(), "current line\n");
});

test("the log endpoints refuse an unknown printer", async () => {
    const read = await call(`${app.url}/api/logs/01P00A0000NOPE`);
    assert.equal(read.status, 404);

    const download = await fetch(`${app.url}/api/logs/01P00A0000NOPE/download`, { headers: UI_HEADERS });
    assert.equal(download.status, 404);
});
