import test from "node:test";
import assert from "node:assert/strict";

import { externalSpoolUnits, rememberedExternalSpoolUnits, releaseVanishedSlots } from "../src/mqtt.js";
import { processData, slotIsOccupied } from "../src/ams.js";
import { convertAMSandSlot, EXTERNAL_SLOT, SECOND_EXTERNAL_SLOT } from "../src/utils.js";

// The external spool holder as a P2S reports it, copied from a live report. It
// is field for field a chipless AMS tray, which is why it is handed to the same
// pipeline as a unit of its own rather than given a branch of its own.
const virSlot = {
    bed_temp: "0",
    bed_temp_type: "0",
    cali_idx: -1,
    cols: ["9D432CFF"],
    ctype: 2,
    drying_temp: "0",
    drying_time: "0",
    id: "255",
    nozzle_temp_max: "240",
    nozzle_temp_min: "190",
    remain: 0,
    tag_uid: "0000000000000000",
    total_len: 330000,
    tray_color: "9D432CFF",
    tray_diameter: "1.75",
    tray_id_name: "",
    tray_info_idx: "GFA00",
    tray_sub_brands: "",
    tray_type: "PLA",
    tray_uuid: "00000000000000000000000000000000",
    tray_weight: "0",
    xcam_info: "000000000000000000000000",
};

test("the holder is read as a unit of its own", () => {
    const [unit] = externalSpoolUnits({ vir_slot: [virSlot] });

    assert.equal(unit.id, "255");
    assert.equal(unit.tray.length, 1);
    assert.equal(convertAMSandSlot(unit.id, unit.tray[0].id), EXTERNAL_SLOT);
});

test("the holder classifies as the chipless spool it is", () => {
    const [unit] = processData(externalSpoolUnits({ vir_slot: [virSlot] }));
    const [tray] = unit.tray;

    assert.equal(slotIsOccupied(tray), true);
    // An all zero uuid is what sends processSlot into the 3rd party branch, so
    // the holder becomes assignable rather than read-only
    assert.equal(tray.tray_uuid, "N/A");
    assert.equal(tray.tray_sub_brands, "N/A");
    assert.deepEqual(tray.cols, ["9D432CFF"]);
});

test("older firmware reports the same thing as a single object", () => {
    // vt_tray is what this was before vir_slot. The P2S measured here no longer
    // sends the key at all, so both shapes have to be read.
    const [unit] = externalSpoolUnits({ vt_tray: virSlot });
    assert.equal(unit.tray.length, 1);
    assert.equal(unit.tray[0].tray_color, "9D432CFF");
});

// The same holder with the spool taken off, copied from a live report. Every
// field is still there and only the three that name a material are empty.
const emptyVirSlot = {
    ...virSlot,
    cols: ["FFFFFF00"],
    nozzle_temp_max: "0",
    nozzle_temp_min: "0",
    tray_color: "FFFFFF00",
    tray_info_idx: "",
    tray_type: "",
};

test("a holder with nothing on it yields no unit", () => {
    // The whole record is reported either way, so the material is what tells
    // the two apart. Without this the empty holder reaches slotIsOccupied()
    // carrying its temperature fields and reads as a loaded spool nobody can
    // identify.
    assert.deepEqual(externalSpoolUnits({ vir_slot: [emptyVirSlot] }), []);
    assert.deepEqual(externalSpoolUnits({ vir_slot: [] }), []);
    assert.deepEqual(externalSpoolUnits({}), []);
});

test("the colour of an empty holder is not evidence of a spool", () => {
    // It reports fully transparent white, which is the printer saying there is
    // nothing rather than that the filament is clear. Reading it as a colour
    // put an invisible swatch on a row for a spool that was not there.
    assert.deepEqual(emptyVirSlot.cols, ["FFFFFF00"]);
    assert.deepEqual(externalSpoolUnits({ vir_slot: [{ ...emptyVirSlot, cols: ["FFFFFF00"] }] }), []);
});

test("a dual nozzle printer's two holders are two units with two labels", () => {
    // As the H2D, H2C and X2D reports in test/fixtures/reports carry them:
    // vir_slot holds two entries, 254 for the second extruder and 255 for the
    // first. Both under one unit would have made two slots with one label and
    // one mappings.json key.
    const second = { ...virSlot, id: "254", tray_type: "TPU", tray_info_idx: "GFU00" };
    const units = externalSpoolUnits({ vir_slot: [second, virSlot] });

    assert.deepEqual(units.map(unit => unit.id), ["255", "254"]);
    assert.deepEqual(units.map(unit => convertAMSandSlot(unit.id, unit.tray[0].id)), [EXTERNAL_SLOT, SECOND_EXTERNAL_SLOT]);
    assert.equal(units[1].tray[0].tray_type, "TPU");
});

test("a single holder is External whatever id the printer gives it", () => {
    // A P2S and an X1C report their one holder as 255, an A1, a P1P and a P1S
    // as 254. The P1S of issue 131 lost its holder to the second label between
    // dev.13 and this test.
    const asP1S = externalSpoolUnits({ vt_tray: { ...virSlot, id: "254" } });
    assert.deepEqual(asP1S.map(unit => convertAMSandSlot(unit.id, unit.tray[0].id)), [EXTERNAL_SLOT]);
    const asVirSlot = externalSpoolUnits({ vir_slot: [{ ...virSlot, id: "254" }] });
    assert.deepEqual(asVirSlot.map(unit => convertAMSandSlot(unit.id, unit.tray[0].id)), [EXTERNAL_SLOT]);
});

test("the second label needs a second reported holder, loaded or not", () => {
    // A dual nozzle printer lists both entries whether or not a spool sits on
    // them, so an empty first holder must not move the second one to External.
    const units = externalSpoolUnits({ vir_slot: [{ ...virSlot, id: "254" }, { ...emptyVirSlot, id: "255" }] });
    assert.deepEqual(units.map(unit => convertAMSandSlot(unit.id, unit.tray[0].id)), [SECOND_EXTERNAL_SLOT]);
});

test("only the loaded holder of the two yields a unit", () => {
    const units = externalSpoolUnits({ vir_slot: [{ ...emptyVirSlot, id: "254" }, virSlot] });
    assert.deepEqual(units.map(unit => unit.id), ["255"]);
});

test("a holder with an id this service has no label for is dropped", () => {
    // Nothing observed reports one below 247, the ninth holder of an H3C.
    // Labelling it "Z" would have let it be assigned under a key shared with
    // every other unknown unit.
    assert.deepEqual(externalSpoolUnits({ vir_slot: [{ ...virSlot, id: "246" }] }), []);
});

// A P2S mentions the holder in every report that carries AMS data. A P1S sends
// delta reports that carry the AMS block and leave the holder out, and reading
// those as an empty holder is what made the External slot show and vanish with
// every report in issue #131.
test("a report that does not mention the holder keeps what the last one said", () => {
    const printer = { lastExternalUnits: null };

    const first = rememberedExternalSpoolUnits(printer, { vir_slot: [virSlot] });
    assert.equal(first.length, 1);

    // The AMS block alone, as a delta report carries it
    const delta = rememberedExternalSpoolUnits(printer, { ams: { ams: [] } });
    assert.deepEqual(delta, first);

    // Older firmware, the single object shape, remembered the same way
    rememberedExternalSpoolUnits(printer, { vt_tray: { ...virSlot, tray_color: "545454FF" } });
    assert.equal(rememberedExternalSpoolUnits(printer, {}).at(0).tray[0].tray_color, "545454FF");
});

test("a report that names an empty holder replaces what was remembered", () => {
    const printer = { lastExternalUnits: null };
    rememberedExternalSpoolUnits(printer, { vir_slot: [virSlot] });

    // "Nothing there" is the key with nothing loaded behind it, not a missing
    // key. All three shapes the printers send for it count.
    assert.deepEqual(rememberedExternalSpoolUnits(printer, { vir_slot: [emptyVirSlot] }), []);
    rememberedExternalSpoolUnits(printer, { vir_slot: [virSlot] });
    assert.deepEqual(rememberedExternalSpoolUnits(printer, { vir_slot: [] }), []);
    rememberedExternalSpoolUnits(printer, { vt_tray: virSlot });
    assert.deepEqual(rememberedExternalSpoolUnits(printer, { vt_tray: null }), []);

    // And the emptiness is what is remembered from then on
    assert.deepEqual(rememberedExternalSpoolUnits(printer, { ams: { ams: [] } }), []);
});

test("nothing is remembered before the first report that names the holder", () => {
    const printer = { lastExternalUnits: null };

    assert.deepEqual(rememberedExternalSpoolUnits(printer, { ams: { ams: [] } }), []);
    assert.deepEqual(rememberedExternalSpoolUnits(printer, undefined), []);
    assert.equal(printer.lastExternalUnits, null);
});

test("a holder is one filament, never part of a four slot unit", () => {
    // orderedAmsSlots() must not place it: the slicer lists it after the AMS
    // units and where exactly is not pinned down by any observed file.
    assert.equal(EXTERNAL_SLOT.startsWith("HT-"), false);
    assert.equal("ABCD".includes(EXTERNAL_SLOT[0]), false);
});

// A slot that disappears from the report has no processSlot() run of its own,
// so releasePreviousSpool() never fires for it. Taking the spool off the holder
// is exactly that case: externalSpoolUnits() emits no unit any more.
function recordingSync() {
    const released = [];
    return { released, release(spool) { released.push(spool.id); } };
}

test("a slot that is gone from the report releases its spool", () => {
    const sync = recordingSync();
    const prevByAmsId = {
        A1: { amsId: "A1", existingSpool: { id: 1 } },
        [EXTERNAL_SLOT]: { amsId: EXTERNAL_SLOT, existingSpool: { id: 7 } },
    };
    // Only A1 was rebuilt this update, the holder yielded no unit at all
    const spoolData = [{ amsId: "A1" }];

    releaseVanishedSlots(sync, prevByAmsId, spoolData, [{ id: 1 }, { id: 7 }]);

    assert.deepEqual(sync.released, [7]);
});

test("a slot still in the report is left to processSlot", () => {
    const sync = recordingSync();
    const prevByAmsId = { [EXTERNAL_SLOT]: { amsId: EXTERNAL_SLOT, existingSpool: { id: 7 } } };

    releaseVanishedSlots(sync, prevByAmsId, [{ amsId: EXTERNAL_SLOT }], [{ id: 7 }]);

    assert.deepEqual(sync.released, []);
});

test("a vanished slot that held no spool releases nothing", () => {
    const sync = recordingSync();

    releaseVanishedSlots(sync, { [EXTERNAL_SLOT]: { amsId: EXTERNAL_SLOT, existingSpool: null } }, [], []);

    assert.deepEqual(sync.released, []);
});
