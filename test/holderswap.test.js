import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { startTestApp, call } from "./helpers/app.js";

// Bambu Studio's "Use Multicolor with External" (issue #233): every filament of
// the plate runs from the external holder and the printer stops at each change
// for the spool to be swapped by hand. Traced on a P2S on 2026-10-08:
// print.mapping read 0xFF00 for all four filaments and the holder reported the
// first spool for the whole print, so the user names the spool per filament and
// the booking follows that and nothing else.

const uses = [];
const spools = new Map();

const spoolman = http.createServer((req, res) => {
    const route = req.url.split("?")[0];
    const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && route === "/api/v1/spool") return json(200, [...spools.values()]);

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        const use = route.match(/^\/api\/v1\/spool\/(\d+)\/use$/);
        if (req.method === "PUT" && use) {
            const spool = spools.get(Number(use[1]));
            uses.push({ id: Number(use[1]), grams: payload.use_weight });
            spool.remaining_weight = Math.round((spool.remaining_weight - payload.use_weight) * 100) / 100;
            return json(200, spool);
        }
        json(200, spools.get(Number(route.split("/").pop())) ?? {});
    });
});

await new Promise(resolve => spoolman.listen(0, "127.0.0.1", resolve));

// Read at import time by settings.js, so it has to be set before startTestApp
// pulls the modules in.
process.env.SPOOLMAN_ENDPOINT = `http://127.0.0.1:${spoolman.address().port}`;
process.env.LEGACY_MODE = "false";
process.env.SET_LOCATION = "false";

const SERIAL = "01P00A000000233";
const HOLDER = 0xFF00;

let app, printer, sliceInfo, handlePrintStateChange, holderSwapIndices, rememberPrintStart, rememberFilamentSpools, recallFilamentSpools;

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { parseSliceInfo } = await import("../src/gcode.js");
    const { printers } = await import("../src/printers.js");
    ({ handlePrintStateChange } = await import("../src/mqtt.js"));
    ({ holderSwapIndices } = await import("../src/ams.js"));
    ({ rememberPrintStart, rememberFilamentSpools, recallFilamentSpools } = await import("../src/printstate.js"));

    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "four_colours.config");
    sliceInfo = parseSliceInfo(fs.readFileSync(fixture, "utf-8"));
    printer = printers.find(p => p.id === SERIAL);

    for (const [id, name] of [[5, "PLA Blau"], [6, "PLA Gelb"], [7, "PLA Rot"], [8, "PLA Orange"]]) {
        spools.set(id, { id, remaining_weight: 1000, initial_weight: 1000, filament: { name, material: "PLA", vendor: { name: "Generic" } } });
    }
});

after(async () => {
    await app.close();
    await new Promise(resolve => spoolman.close(resolve));
});

const entry = (index, amsId, amsIdFromPrinter = true) => ({ index, amsId, amsIdFromPrinter });

test("every filament the printer sends to one holder needs a spool of its own", () => {
    const swapped = holderSwapIndices([0, 1, 2, 3].map(i => entry(i, "External")));
    assert.deepEqual([...swapped].sort(), [0, 1, 2, 3]);
});

test("one filament on the holder is booked from the holder's own spool", () => {
    assert.equal(holderSwapIndices([entry(0, "A1"), entry(1, "External")]).size, 0);
});

test("two filaments on one AMS slot are one spool and stay with the slot", () => {
    assert.equal(holderSwapIndices([entry(0, "A1"), entry(1, "A1")]).size, 0);
});

test("a list order estimate never turns the holder into a swapped one", () => {
    assert.equal(holderSwapIndices([entry(0, "External", false), entry(1, "External", false)]).size, 0);
});

test("the two holders of a dual nozzle printer are counted apart", () => {
    const swapped = holderSwapIndices([entry(0, "External"), entry(1, "External-2"), entry(2, "External-2")]);
    assert.deepEqual([...swapped].sort(), [1, 2]);
});

test("the spools named per filament survive a restart, malformed ones do not", () => {
    rememberPrintStart("RESTART", "Cube", Date.now());
    rememberFilamentSpools("RESTART", { 0: { id: 5, spool: null }, 1: { id: "6" }, x: { id: 7 }, 2: { id: 0 } });
    assert.deepEqual(recallFilamentSpools("RESTART", "Cube"), { 0: { id: 5, spool: null } });
    assert.deepEqual(recallFilamentSpools("RESTART", "Another job"), {});
});

test("a print swapped by hand books each filament on the spool named for it", async () => {
    printer.currentGcodeState = "IDLE";
    // The holder is assigned the first spool, which is all the printer reports
    printer.spoolData = [{
        amsId: "External",
        slotState: "Loaded (3rd party)",
        connectedViaMapping: true,
        connectedViaTag: false,
        existingSpool: { ...spools.get(5) },
        slot: { tray_uuid: "N/A", tray_info_idx: "GFA00", tray_type: "PLA", tray_color: "2850E0FF", cols: ["2850E0FF"] },
    }];
    const report = (state, layer) => ({ gcode_state: state, subtask_name: "Cube", layer_num: layer, mapping: [HOLDER, HOLDER, HOLDER, HOLDER] });

    await handlePrintStateChange(printer, report("PREPARE", 0));
    printer.currentSliceInfo = sliceInfo;
    await handlePrintStateChange(printer, report("RUNNING", 1));
    assert.deepEqual(printer.currentMapping, ["External", "External", "External", "External"]);

    // The dashboard asks for a spool for all four, the holder's own included
    let print = await call(`${app.url}/api/print/${SERIAL}`);
    assert.deepEqual(print.body.holderFilaments.map(f => f.index), [0, 1, 2, 3]);
    assert.ok(Object.values(print.body.fullConsumption).every(e => e.holderSwap));

    assert.equal((await call(`${app.url}/api/print/${SERIAL}/filament/0`, "PUT", { spoolId: 5 })).status, 200);
    assert.equal((await call(`${app.url}/api/print/${SERIAL}/filament/1`, "PUT", { spoolId: 7 })).status, 200);
    // Changed while the print runs
    assert.equal((await call(`${app.url}/api/print/${SERIAL}/filament/1`, "PUT", { spoolId: 6 })).status, 200);
    assert.equal((await call(`${app.url}/api/print/${SERIAL}/filament/9`, "PUT", { spoolId: 6 })).body.code, "filamentNotSwapped");
    assert.equal((await call(`${app.url}/api/print/${SERIAL}/filament/0`, "PUT", { spoolId: 99 })).status, 404);

    print = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(print.body.holderFilaments[1].spool.id, 6);
    assert.equal(print.body.holderFilaments[1].spool.name, "PLA Gelb");

    uses.length = 0;
    await handlePrintStateChange(printer, report("FINISH", 12));

    // Two named, booked on their own spools; nothing lands on the holder's
    // spool for the two nobody named
    assert.deepEqual(uses, [{ id: 5, grams: 5.76 }, { id: 6, grams: 3.29 }]);
    const rows = printer.lastPrintSummary.rows;
    assert.deepEqual(rows.map(r => [r.index, r.status, r.spoolId]), [[0, "booked", 5], [1, "booked", 6], [2, "pending", null], [3, "pending", null]]);
    // The holder's spool is not named for a filament it did not print
    assert.equal(rows[2].spoolName, null);

    // Once the print has ended, a waiting filament is booked straight away
    const later = await call(`${app.url}/api/print/${SERIAL}/filament/2`, "PUT", { spoolId: 7 });
    assert.equal(later.status, 200);
    assert.equal(later.body.row.status, "booked");
    assert.deepEqual(uses.at(-1), { id: 7, grams: 2.51 });
    assert.equal(printer.lastPrintSummary.rows[2].spoolId, 7);

    // And only once
    const again = await call(`${app.url}/api/print/${SERIAL}/filament/2`, "PUT", { spoolId: 8 });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "filamentNothingPending");
    assert.equal(uses.length, 3);

    // A booked choice is not taken back here
    assert.equal((await call(`${app.url}/api/print/${SERIAL}/filament/0`, "DELETE")).body.code, "filamentAlreadyBooked");

    print = await call(`${app.url}/api/print/${SERIAL}`);
    assert.deepEqual(print.body.holderFilaments.map(f => f.status), ["booked", "booked", "booked", "pending"]);
});
