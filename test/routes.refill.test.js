import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

import { startTestApp, call } from "./helpers/app.js";

// What GET /api/print tells the dashboard about a slot that ran empty while
// the print went on, replayed from the P2S refill of 2026-10-07: "Würfel",
// filament 3 sliced for A3, A3 reporting empty from layer 5 while the tube
// printed on, print.mapping moving to A4 at layer 88. The printer state is
// seeded the way the MQTT handler leaves it, see test/refill.test.js.

let app;
let printer;

const SERIAL = "01P00A000000011";
const SLOT = { tray_type: "PLA", tray_info_idx: "GFA01", tray_color: "FFFFFFFF", cols: ["FFFFFFFF"], tray_weight: "1000", remain: 50 };

const spoolman = (id, remaining) => ({
    id,
    remaining_weight: remaining,
    initial_weight: 1000,
    filament: { name: "PLA Matte Jade White", material: "PLA", color_hex: "FFFFFF", vendor: { name: "Bambu Lab" } },
});

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { parseSliceInfo, countPlateExtrusion, checkLayerExtrusion } = await import("../src/gcode.js");
    const { consumptionCandidate } = await import("../src/ams.js");
    const { printers } = await import("../src/printers.js");

    const zip = new AdmZip(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "p2s_refill_cube.gcode.3mf"));
    const sliceInfo = parseSliceInfo(zip.getEntry("Metadata/slice_info.config").getData().toString("utf8"));
    sliceInfo.extrusion = checkLayerExtrusion(await countPlateExtrusion(zip.getEntry("Metadata/plate_1.gcode")), sliceInfo.filaments);

    printer = printers.find(p => p.id === SERIAL);
    printer.currentJobName    = "Würfel";
    printer.currentGcodeState = "RUNNING";
    printer.currentSliceInfo  = sliceInfo;

    // What the handler remembered while A3 still held its spool
    const a3 = { amsId: "A3", slotState: "Loaded (Bambu Lab)", connectedViaTag: true, existingSpool: spoolman(5, 10), slot: SLOT };
    printer.printSlotSpools = {
        A3: { ...consumptionCandidate(a3), spool: a3.existingSpool },
    };
    printer.spoolData = [
        { amsId: "A3", slotState: "Empty", slot: {} },
        { amsId: "A4", slotState: "Loaded (Bambu Lab)", connectedViaTag: true, existingSpool: spoolman(6, 910), slot: SLOT },
    ];
});

after(async () => { await app.close(); });

/** Slot, matched slot and grams of every entry, sorted. */
const placed = consumption => Object.values(consumption)
    .map(e => [e.amsId, e.matchedAmsId, e.grams])
    .sort();

test("while the tube empties, the filament stays on the emptied slot", async () => {
    printer.currentMapping = [null, null, "A3"];
    printer.refills = [];
    printer.currentLayerNum = 50;

    const { status, body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(status, 200);
    assert.deepEqual(placed(body.fullConsumption), [["A3", "A3", 20.09]]);
    assert.deepEqual(body.emptiedSlots.map(e => [e.amsId, e.spool.id, e.spool.remainingWeight, e.refill]), [["A3", 5, 10, null]]);
});

test("after the refill, the filament is split between the two slots", async () => {
    printer.currentMapping = [null, null, "A4"];
    printer.refills = [{ index: 2, from: "A3", to: "A4", layer: 88 }];
    printer.currentLayerNum = 150;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.deepEqual(placed(body.fullConsumption), [["A3", "A3", 7.39], ["A4", "A4", 12.7]]);
    const printed = placed(body.consumption);
    assert.deepEqual(printed[0], ["A3", "A3", 7.39]);
    assert.deepEqual(body.emptiedSlots.map(e => [e.amsId, e.refill]), [["A3", { to: "A4", layer: 88 }]]);
});

test("a slot the print was not named for is not reported", async () => {
    printer.currentMapping = [null, null, "A4"];
    printer.refills = [];
    printer.currentLayerNum = 150;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.deepEqual(body.emptiedSlots, []);
    assert.deepEqual(placed(body.fullConsumption), [["A4", "A4", 20.09]]);
});
