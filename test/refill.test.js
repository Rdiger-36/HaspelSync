import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

import {
    parseSliceInfo,
    calcFullConsumption,
    calcPartialConsumption,
    completedLayerIndex,
    countPlateExtrusion,
    checkLayerExtrusion,
    resolveSliceSlots,
    refillsBetween,
    splitAtRefills,
} from "../src/gcode.js";
import { matchConsumption, consumptionCandidate } from "../src/ams.js";
import { refillNote, rememberedSlotCandidates } from "../src/mqtt.js";

// An AMS refill traced on a P2S on 2026-10-07. "Würfel", 235 layers, 20.09 g
// of PLA Basic white sliced as filament 3. A3 held a spool cut down to about
// 8 g, A4 the same filament as its backup. The raw MQTT trace said:
//
//   layer 5   A3 runs out at the AMS, the slot reports empty, filam_bak loses
//             the A3+A4 group, tray_now shows 0 while A1 is never loaded
//   layer 88  the tube is empty, print.mapping goes from [65535, 65535, 2] to
//             [65535, 65535, 3], A4 is loaded, the state stays RUNNING
//   FINISH    the service booked all 20.09 g on A4
//
// The sliced file is the one the printer ran, read off its stick afterwards.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "p2s_refill_cube.gcode.3mf");

/** The slice info of the fixture with the G-code counted, as fetchSliceInfo() builds it. */
async function load() {
    const zip = new AdmZip(fixture);
    const sliceInfo = parseSliceInfo(zip.getEntry("Metadata/slice_info.config").getData().toString("utf8"));
    const perLayer = await countPlateExtrusion(zip.getEntry("Metadata/plate_1.gcode"));
    sliceInfo.extrusion = checkLayerExtrusion(perLayer, sliceInfo.filaments);
    return sliceInfo;
}

const REFILL = { index: 2, from: "A3", to: "A4", layer: 88 };

/** The slot of every entry and its grams, in a form an assertion can compare. */
function bySlot(consumption) {
    return Object.values(consumption).map(e => [e.amsId, e.grams]).sort();
}

test("a mapping change once the print is printing is a refill", () => {
    assert.deepEqual(
        refillsBetween([null, null, "A3"], [null, null, "A4"], 88),
        [{ index: 2, from: "A3", to: "A4" }],
    );
    // The X2D of issue 225, a one filament project, A3 to A1
    assert.deepEqual(refillsBetween(["A3"], ["A1"], 140), [{ index: 0, from: "A3", to: "A1" }]);
});

test("a mapping that settles before the first layer is not a refill", () => {
    assert.deepEqual(refillsBetween([null, null, "A3"], [null, null, "A4"], 0), []);
    assert.deepEqual(refillsBetween(null, [null, null, "A4"], 88), []);
});

test("a filament the plate does not use, or one that appears, is not a refill", () => {
    assert.deepEqual(refillsBetween([null, "B1", "A3"], [null, null, "A3"], 40), []);
    assert.deepEqual(refillsBetween([null, null, "A3"], ["A1", null, "A3"], 40), []);
});

test("a finished print is split at the layer the printer switched", async () => {
    const sliceInfo = await load();
    const consumption = resolveSliceSlots(calcFullConsumption(sliceInfo), [null, null, "A4"], { reportedByPrinter: true });
    const split = splitAtRefills(consumption, sliceInfo, [REFILL]);
    // A3 printed through layer 87, weighed from the G-code
    assert.deepEqual(bySlot(split), [["A3", 7.39], ["A4", 12.7]]);
    assert.ok(Object.values(split).every(e => e.amsIdFromPrinter));
});

test("a print cancelled after the refill splits what it printed", async () => {
    const sliceInfo = await load();
    const partial = calcPartialConsumption(sliceInfo, completedLayerIndex(150));
    const consumption = resolveSliceSlots(partial, [null, null, "A4"], { reportedByPrinter: true });
    const split = splitAtRefills(consumption, sliceInfo, [REFILL]);
    const total = Object.values(partial)[0].grams;
    assert.deepEqual(bySlot(split), [["A3", 7.39], ["A4", Math.round((total - 7.39) * 100) / 100]]);
});

test("without the G-code the split falls back to counting layers", async () => {
    const sliceInfo = { ...(await load()), extrusion: null };
    const consumption = resolveSliceSlots(calcFullConsumption(sliceInfo), [null, null, "A4"], { reportedByPrinter: true });
    const split = splitAtRefills(consumption, sliceInfo, [REFILL]);
    // 87 of 235 layers
    assert.deepEqual(bySlot(split), [["A3", 7.44], ["A4", 12.65]]);
});

test("a filament that refilled twice is cut at both layers", async () => {
    const sliceInfo = await load();
    const consumption = resolveSliceSlots(calcFullConsumption(sliceInfo), [null, null, "A1"], { reportedByPrinter: true });
    const split = splitAtRefills(consumption, sliceInfo, [REFILL, { index: 2, from: "A4", to: "A1", layer: 200 }]);
    const slots = bySlot(split);
    assert.deepEqual(slots.map(([slot]) => slot), ["A1", "A3", "A4"]);
    assert.equal(slots.find(([slot]) => slot === "A3")[1], 7.39);
    const sum = slots.reduce((s, [, g]) => s + g, 0);
    assert.equal(Math.round(sum * 100) / 100, 20.09);
});

test("no refill leaves the consumption as it was", async () => {
    const sliceInfo = await load();
    const consumption = calcFullConsumption(sliceInfo);
    assert.equal(splitAtRefills(consumption, sliceInfo, []), consumption);
});

test("the part before the refill matches the spool remembered for the emptied slot", async () => {
    const sliceInfo = await load();
    const consumption = resolveSliceSlots(calcFullConsumption(sliceInfo), [null, null, "A4"], { reportedByPrinter: true });
    const entries = Object.values(splitAtRefills(consumption, sliceInfo, [REFILL]));

    const slot = { tray_info_idx: "GFA01", tray_type: "PLA", tray_color: "FFFFFFFF", cols: ["FFFFFFFF"] };
    // A3 was seen with spool 5 before it ran out, A4 still holds spool 6
    const remembered = consumptionCandidate({ amsId: "A3", slot, existingSpool: { id: 5 }, connectedViaTag: true });
    const loaded = consumptionCandidate({ amsId: "A4", slot, existingSpool: { id: 6 }, connectedViaTag: true });

    const matched = matchConsumption(entries, [loaded, remembered]);
    const spoolFor = amsId => matched.get(entries.find(e => e.amsId === amsId))?.[0]?.id;
    assert.equal(spoolFor("A3"), 5);
    assert.equal(spoolFor("A4"), 6);
});

test("the summary says why one filament sits on two spools", async () => {
    const sliceInfo = await load();
    const consumption = resolveSliceSlots(calcFullConsumption(sliceInfo), [null, null, "A4"], { reportedByPrinter: true });
    const split = splitAtRefills(consumption, sliceInfo, [REFILL]);
    const note = amsId => refillNote(Object.values(split).find(e => e.amsId === amsId));
    assert.equal(note("A3"), "Printed from A3 through layer 87. The AMS ran out during layer 88 and switched to A4.");
    assert.equal(note("A4"), "Printed from A4 from layer 88 on, after the AMS switched over from A3.");
    assert.equal(refillNote({ grams: 1 }), null);
});

test("the print handler notes the refill and the spool the emptied slot held", async () => {
    const { handlePrintStateChange } = await import("../src/mqtt.js");
    const printer = {
        name: "Test Printer",
        logFilePath: "/dev/null",
        currentGcodeState: "IDLE",
        currentJobName: null,
        currentLayerNum: 0,
        currentSliceInfo: null,
        sliceFetchDone: true,
        consumptionBooked: false,
        currentMapping: null,
        pendingMapping: null,
        lastPrintSummary: null,
        lastPrintError: null,
        spoolData: [],
    };
    const slot = { tray_info_idx: "GFA01", tray_type: "PLA", tray_color: "FFFFFFFF", cols: ["FFFFFFFF"] };
    const report = (layer, mapping) => ({ gcode_state: "RUNNING", subtask_name: "Würfel", layer_num: layer, mapping });

    await handlePrintStateChange(printer, { gcode_state: "PREPARE", subtask_name: "Würfel", layer_num: 0, mapping: [0xFFFF, 0xFFFF, 0x0002] });
    // Already loaded, so the handler does not go looking for the file
    printer.currentSliceInfo = { filaments: [], totalLayers: 235, rangesByFilamentIdx: {}, presets: [] };

    printer.spoolData = [
        { amsId: "A3", slot, existingSpool: { id: 5 }, connectedViaTag: true },
        { amsId: "A4", slot, existingSpool: { id: 6 }, connectedViaTag: true },
    ];
    await handlePrintStateChange(printer, report(1, [0xFFFF, 0xFFFF, 0x0002]));

    // Layer 5: A3 runs out at the AMS and reports empty from here on
    printer.spoolData = [{ amsId: "A3", slot: {} }, printer.spoolData[1]];
    await handlePrintStateChange(printer, report(5, [0xFFFF, 0xFFFF, 0x0002]));
    assert.deepEqual(printer.refills, []);

    await handlePrintStateChange(printer, report(88, [0xFFFF, 0xFFFF, 0x0003]));
    assert.deepEqual(printer.currentMapping, [null, null, "A4"]);
    assert.equal(printer.refills.length, 1);
    const [refill] = printer.refills;
    assert.deepEqual({ index: refill.index, from: refill.from, to: refill.to, layer: refill.layer }, REFILL);
    assert.equal(refill.spool.id, 5);
    assert.equal(refill.spool.amsId, "A3");
});

// The other half of what the second P2S run showed: A3 reported empty from
// layer 6, 83 layers before the mapping moved. A print that ends in between
// has no refill at all and still printed every gram from A3.
test("a print that ends while the tube empties books on the spool the emptied slot held", async () => {
    const sliceInfo = await load();
    const consumption = resolveSliceSlots(calcPartialConsumption(sliceInfo, completedLayerIndex(50)), [null, null, "A3"], { reportedByPrinter: true });
    const entries = Object.values(consumption);

    const slot = { tray_info_idx: "GFA01", tray_type: "PLA", tray_color: "FFFFFFFF", cols: ["FFFFFFFF"] };
    const remembered = consumptionCandidate({ amsId: "A3", slot, existingSpool: { id: 5 }, connectedViaTag: true });
    const loaded = consumptionCandidate({ amsId: "A4", slot, existingSpool: { id: 6 }, connectedViaTag: true });
    const printer = { currentMapping: [null, null, "A3"], refills: [], printSlotSpools: { A3: remembered, A4: loaded } };

    // Without the remembered spool the colour stages land on the backup
    assert.equal(matchConsumption(entries, [loaded]).get(entries[0])?.[0]?.id, 6);

    const added = rememberedSlotCandidates(printer, [loaded]);
    assert.deepEqual(added.map(c => c.id), [5]);
    assert.equal(matchConsumption(entries, [loaded, ...added]).get(entries[0])?.[0]?.id, 5);
});

test("only an emptied slot the print was named for is remembered", () => {
    const candidate = (amsId, id) => consumptionCandidate({ amsId, slot: { tray_info_idx: "GFA01", tray_color: "FFFFFFFF" }, existingSpool: { id }, connectedViaTag: true });
    const printer = {
        currentMapping: [null, null, "A4"],
        refills: [{ index: 2, from: "A3", to: "A4", layer: 88 }],
        printSlotSpools: { A1: candidate("A1", 1), A3: candidate("A3", 5), A4: candidate("A4", 6), B2: candidate("B2", 9) },
    };
    // A1 is loaded and answers for itself, B2 was emptied by hand and never printed
    const live = [candidate("A1", 1), candidate("A4", 6)];
    assert.deepEqual(rememberedSlotCandidates(printer, live).map(c => c.amsId), ["A3"]);

    // A3 holds a spool again, which then answers for it
    assert.deepEqual(rememberedSlotCandidates(printer, [...live, candidate("A3", 7)]), []);
    assert.deepEqual(rememberedSlotCandidates({}, live), []);
});
