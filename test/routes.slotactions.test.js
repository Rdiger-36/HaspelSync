import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// The three slot actions of the dashboard, asked for a slot that lacks what
// they write from. Each used to read a field of an absent object and send the
// TypeError to the browser as a 500: "Cannot read properties of null (reading
// 'id')" was what an H3C user saw on every merge in issue #262, where every
// slot was labelled "Z" and the merge was resolved to an empty one. None of
// these reaches Spoolman, so no Spoolman has to run.

let app;
let printer;

const SERIAL = "01P00A000000010";

/** A slot the way the MQTT handler leaves an empty one: nothing to write from. */
const emptySlot = amsId => ({
    amsId,
    slotState: "Empty",
    slot: { tray_uuid: "N/A" },
    mergeableSpool: null,
    matchingInternalFilament: null,
    matchingExternalFilament: null,
    printerName: "Test Printer",
    logFilePath: null,
});

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });
    const { printers } = await import("../src/printers.js");
    printer = printers.find(p => p.id === SERIAL);
    printer.logFilePath = `${process.env.LOG_DIR}/${SERIAL}.log`;
});

after(async () => { await app.close(); });

for (const [path, code] of [
    ["/api/mergeSpool", "nothingToMerge"],
    ["/api/createSpool", "noMatchingFilament"],
    ["/api/createSpoolWithFilament", "noCatalogueFilament"],
]) {
    test(`${path} on a slot without anything to write from is a 409 with a code`, async () => {
        printer.spoolData = [{ ...emptySlot("A1"), logFilePath: printer.logFilePath }];
        const res = await call(`${app.url}${path}`, "POST", { printerId: SERIAL, amsId: "A1" });
        assert.equal(res.status, 409);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.code, code);
        assert.doesNotMatch(res.body.error, /Cannot read properties/);
    });
}

test("two slots under one label are refused rather than resolved to the first", async () => {
    // The shape issue #262 produced: a loaded slot and an empty one, both "Z"
    printer.spoolData = [
        { ...emptySlot("Z"), logFilePath: printer.logFilePath },
        { ...emptySlot("Z"), slotState: "Loaded (Bambu Lab)", mergeableSpool: { id: 96, extra: {}, filament: { name: "PETG White" } }, logFilePath: printer.logFilePath },
    ];
    const res = await call(`${app.url}/api/mergeSpool`, "POST", { printerId: SERIAL, amsId: "Z" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "slotAmbiguous");
    assert.deepEqual(res.body.params, { slot: "Z", count: 2 });
});

test("a slot the printer does not have is a 404 with a code", async () => {
    printer.spoolData = [{ ...emptySlot("A1"), logFilePath: printer.logFilePath }];
    const res = await call(`${app.url}/api/mergeSpool`, "POST", { printerId: SERIAL, amsId: "B4" });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "slotNotFound");
});
