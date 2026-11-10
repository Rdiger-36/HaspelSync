import test from "node:test";
import assert from "node:assert/strict";

import { catalogueColors, colorSetDistance, rankCatalogueEntries, spoolFitsSlot, spoolIsChipless, uniqueSpoolForSlot } from "../public/match.js";

const slot = (over = {}) => ({ tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "0EE2A0FF", cols: ["0EE2A0FF"], ...over });
const spool = (id, over = {}) => ({
    id,
    archived: false,
    extra: {},
    filament: { material: "PLA", color_hex: "0EE2A0", name: `spool ${id}` },
    ...over,
});
const withFilament = (id, filament, over = {}) => spool(id, { filament: { material: "PLA", color_hex: "0EE2A0", ...filament }, ...over });

/* ---- colorSetDistance ---- */

test("the same colours are no distance apart, a missing side is infinitely far", () => {
    assert.equal(colorSetDistance(["0ee2a0"], ["0ee2a0"]), 0);
    assert.equal(colorSetDistance(["0ee2a0"], []), Infinity);
    assert.equal(colorSetDistance([], []), Infinity);
});

test("a two colour spool is not identical to one of its colours alone", () => {
    assert.ok(colorSetDistance(["0ee2a0", "000000"], ["0ee2a0"]) > 0);
    assert.equal(colorSetDistance(["0ee2a0", "000000"], ["000000", "0ee2a0"]), 0);
});

/* ---- spoolFitsSlot ---- */

test("a spool fits on material family and identical colour", () => {
    assert.equal(spoolFitsSlot(slot(), spool(1)), true);
    // "PLA Silk" is PLA, the way the picker ranks it
    assert.equal(spoolFitsSlot(slot(), withFilament(2, { material: "PLA Silk" })), true);
});

test("a close shade or another material does not fit", () => {
    assert.equal(spoolFitsSlot(slot(), withFilament(3, { color_hex: "0EE2A1" })), false);
    assert.equal(spoolFitsSlot(slot(), withFilament(4, { material: "PETG" })), false);
    assert.equal(spoolFitsSlot(slot({ tray_type: "", tray_info_idx: "" }), spool(5)), false);
});

test("a chipless slot set to a Bambu preset fits on the material the preset prints", () => {
    // GFA00 is Bambu PLA Basic; a P2S reports it for a chipless spool whose
    // slot was set to that preset, with the tag all zeros
    assert.equal(spoolFitsSlot(slot({ tray_info_idx: "GFA00" }), spool(6)), true);
});

/* ---- spoolIsChipless ---- */

test("a tagged or archived spool is never the chipless one", () => {
    assert.equal(spoolIsChipless(spool(1)), true);
    assert.equal(spoolIsChipless(spool(2, { extra: { tag: '"83362CE8"' } })), false);
    assert.equal(spoolIsChipless(spool(3, { archived: true })), false);
    // A native Bambu Lab tag is a chip too, a sticker for another reader is not
    assert.equal(spoolIsChipless(spool(4, { tags: [{ uid: "0417584A3ABE4274838571DB6AA6CABA", format: "bambu" }] })), false);
    assert.equal(spoolIsChipless(spool(5, { tags: [{ uid: "04AABBCC", format: "ntag" }] })), true);
    assert.equal(spoolIsChipless(spool(6, { tags: [{ uid: "BAA8227400000100", format: "bambu" }] })), true);
});

/* ---- uniqueSpoolForSlot ---- */

test("exactly one fitting spool is the answer", () => {
    const spools = [spool(1), withFilament(2, { material: "PETG" }), withFilament(3, { color_hex: "000000" })];
    assert.equal(uniqueSpoolForSlot(slot(), spools)?.id, 1);
});

test("two fitting spools are nobody's answer, the printer cannot tell them apart", () => {
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1), spool(2)]), null);
});

test("a tagged twin does not count, a twin assigned to another slot does not count", () => {
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1), spool(2, { extra: { tag: '"B3B31439"' } })])?.id, 1);
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1), spool(2)], new Set([2]))?.id, 1);
    assert.equal(uniqueSpoolForSlot(slot(), [spool(1)], new Set([1])), null);
});

test("no spools, or none fitting, is no answer", () => {
    assert.equal(uniqueSpoolForSlot(slot(), []), null);
    assert.equal(uniqueSpoolForSlot(slot(), [withFilament(1, { material: "ABS" })]), null);
});

/* ---- rankCatalogueEntries ---- */

// Sunlu PETG as SpoolmanDB lists it, cut down to what decides: the slot on an
// X1E reported 161616, the catalogue's nearest is "High Speed Matte PETG -
// Black" at 151616, and "Black" is 000000. Read off the real catalogue on
// 2026-09-08.
const sunlu = (name, hex, weight = 1000) => ({ manufacturer: "Sunlu", material: "PETG", name, color_hex: hex, weight });
const SUNLU_PETG = [
    sunlu("Black", "000000"),
    sunlu("High Speed Matte PETG - Black", "151616"),
    sunlu("High Speed Matte PETG - Blue", "3a39bb"),
    sunlu("White", "FFFFFF"),
];
const blackSlot = { tray_info_idx: "GFSNL08", tray_type: "PETG", tray_color: "161616FF", cols: ["161616FF"] };

test("the entry nearest the slot's colour comes first, with its distance", () => {
    const [best, second] = rankCatalogueEntries(SUNLU_PETG, blackSlot);
    assert.equal(best.entry.name, "High Speed Matte PETG - Black");
    assert.ok(best.distance > 0 && best.distance < 2, `nearest at ${best.distance}`);
    assert.equal(second.entry.name, "Black");
    assert.equal(best.tooHeavy, false);
    assert.equal(best.offLine, false);
});

test("an exact colour ranks at distance 0", () => {
    const [best] = rankCatalogueEntries(SUNLU_PETG, { ...blackSlot, tray_color: "151616FF", cols: ["151616FF"] });
    assert.equal(best.entry.name, "High Speed Matte PETG - Black");
    assert.equal(best.distance, 0);
});

test("a spool heavier than an AMS takes ranks behind every fitting one, but not on the holder", () => {
    const entries = [sunlu("Black 3 kg", "161616", 3000), sunlu("White", "FFFFFF")];

    const inAms = rankCatalogueEntries(entries, blackSlot);
    assert.equal(inAms[0].entry.name, "White");
    assert.equal(inAms[1].tooHeavy, true);

    const onHolder = rankCatalogueEntries(entries, blackSlot, { external: true });
    assert.equal(onHolder[0].entry.name, "Black 3 kg");
    assert.equal(onHolder[0].tooHeavy, false);
});

test("a preset that names a product line ranks that line first", () => {
    const poly = (name, hex) => ({ manufacturer: "Polymaker", material: "PETG", name, color_hex: hex, weight: 1000 });
    const entries = [poly("PolyMax™ PETG Blue", "2850E0"), poly("PolyLite™ PETG Electric Blue", "0076CF")];
    const slot = { tray_info_idx: "GFG60", tray_type: "PETG", tray_color: "2850E0FF", cols: ["2850E0FF"] };

    assert.equal(rankCatalogueEntries(entries, slot)[0].entry.name, "PolyMax™ PETG Blue");
    const [best] = rankCatalogueEntries(entries, slot, { line: "PolyLite" });
    assert.equal(best.entry.name, "PolyLite™ PETG Electric Blue");
    assert.equal(best.offLine, false);
});

test("a catalogue entry's colours are read whole", () => {
    assert.deepEqual(catalogueColors({ color_hex: "#FF9016" }), ["ff9016"]);
    assert.deepEqual(catalogueColors({ color_hexes: ["000000", "C12E1F"], color_hex: "000000" }), ["000000", "c12e1f"]);
    assert.deepEqual(catalogueColors({}), []);
    assert.deepEqual(rankCatalogueEntries([], blackSlot), []);
});
