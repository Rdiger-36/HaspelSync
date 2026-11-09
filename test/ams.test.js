import test from "node:test";
import assert from "node:assert/strict";

import { correctRemainInt, haveSpoolDataChanged, slotIsOccupied, extractComparableTrayData, hasTrayDataChanged, findMergeableSpool, slotIsBusy, processData, findExistingSpool, findMatchingExternalFilament, spoolTag, spoolMatchesTrayUuid } from "../src/ams.js";
import { slotColors } from "../src/utils.js";

test("correctRemainInt passes through a full-size spool unchanged", () => {
    assert.equal(correctRemainInt(63, 1000, "PLA"), 63);
});

test("correctRemainInt rescales a sub-1kg spool from the 1kg basis", () => {
    // The AMS reports 25% of 1000g = 250g left, which is all of a 250g spool
    assert.equal(correctRemainInt(25, 250, "PLA"), 100);
    // 10% of 1000g = 100g left on a 500g spool -> 20%
    assert.equal(correctRemainInt(10, 500, "PLA"), 20);
});

test("correctRemainInt leaves support material alone", () => {
    // Support material is already measured against its real spool size, so
    // rescaling it would report far more than is actually left.
    assert.equal(correctRemainInt(40, 250, "PLA-S"), 40);
});

test("correctRemainInt clamps the rescaled value to 100%", () => {
    assert.equal(correctRemainInt(90, 250, "PLA"), 100);
});

const spool = (id, tag, remaining) => ({
    id,
    extra: { tag: `"${tag}"` },
    remaining_weight: remaining,
    used_weight: 1000 - remaining,
    filament: { id, name: "Black", material: "PLA" },
});

test("spoolMatchesTrayUuid finds one tray UUID among three native tags", () => {
    const registered = {
        tags: [
            { uid: "04AABBCC", format: "ntag" },
            { uid: "AABBCC1122334455", format: "bambu" },
            { uid: "04DDEEFF", format: "ntag" },
        ],
    };
    assert.equal(spoolMatchesTrayUuid(registered, "aabbcc1122334455"), true);
    assert.equal(spoolMatchesTrayUuid(registered, "AABB-CC11-2233-4455"), true);
    assert.equal(spoolMatchesTrayUuid(registered, "NOT_MATCHED"), false);
});

test("spoolMatchesTrayUuid retains legacy tag compatibility", () => {
    assert.equal(spoolMatchesTrayUuid(spool(1, "AABBCC", 800), "AABBCC"), true);
    assert.equal(spoolMatchesTrayUuid({ tags: [] }, "AABBCC"), false);
});

test("haveSpoolDataChanged detects native tag additions", async () => {
    const before = { ...spool(1, "AAA", 800), tags: [] };
    const after = { ...spool(1, "AAA", 800), tags: [{ uid: "AABBCC", format: "bambu" }] };
    assert.equal(await haveSpoolDataChanged([after], [before]), true);
});

test("haveSpoolDataChanged treats reordered native tags as unchanged", async () => {
    const first = { ...spool(1, "AAA", 800), tags: [{ uid: "AABB" }, { uid: "CCDD" }] };
    const second = { ...spool(1, "AAA", 800), tags: [{ uid: "CCDD" }, { uid: "AABB" }] };
    assert.equal(await haveSpoolDataChanged([first], [second]), false);
});

test("haveSpoolDataChanged treats an unseeded baseline as changed", async () => {
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 800)], null), true);
});

test("haveSpoolDataChanged detects the first spool on a previously empty Spoolman", async () => {
    // The fresh-install case: the baseline is genuinely empty and the first
    // created spool has to register as a change.
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 800)], []), true);
});

test("haveSpoolDataChanged ignores the order of the Spoolman response", async () => {
    const a = spool(1, "AAA", 800);
    const b = spool(2, "BBB", 500);
    assert.equal(await haveSpoolDataChanged([a, b], [b, a]), false);
});

test("haveSpoolDataChanged detects a changed remaining weight", async () => {
    assert.equal(await haveSpoolDataChanged([spool(1, "AAA", 700)], [spool(1, "AAA", 800)]), true);
});

// The AMS reports remain -1 for the first 15 to 20 seconds after a spool goes
// in, and permanently for a chipless one. Captured on a P2S: at 11:39:10 the
// slot read `remain=-1 state=27 sub="PLA Matte"`, at 11:39:25 `remain=100`.
test("processData keeps an unreported remain unknown instead of calling it empty", () => {
    const [ams] = processData([{ id: "0", tray: [
        { id: "0", state: 27, remain: -1, tray_type: "PLA", tray_sub_brands: "PLA Matte", tray_color: "FFFFFFFF", tray_weight: "1000", tray_uuid: "A5F4AA83" },
        { id: "1", state: 11, remain: 0,  tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "000000FF", tray_weight: "1000", tray_uuid: "18F1DE9B" },
    ] }]);

    assert.equal(ams.tray[0].remain, null, "-1 means the AMS has not read it yet");
    assert.equal(ams.tray[1].remain, 0, "a real 0 is a reading and has to survive");
});

test("processData does not write the normalised remain back onto the raw slot", () => {
    // The raw value is what the next report is compared against.
    const raw = { id: "0", state: 27, remain: -1, tray_color: "FFFFFFFF", tray_sub_brands: "PLA Matte", tray_weight: "1000", tray_uuid: "A5F4AA83" };
    processData([{ id: "0", tray: [raw] }]);
    assert.equal(raw.remain, -1);
});

test("correctRemainInt reports an unknown remain as null, never as 0", () => {
    assert.equal(correctRemainInt(null, "1000", "PLA"), null);
    assert.equal(correctRemainInt(undefined, "1000", "PLA"), null);
    // A spool created from a null here was booked as fully used and came out
    // at 0 g left, with nothing in G-code mode to correct it afterwards.
    assert.equal(correctRemainInt(0, "1000", "PLA"), 0);
    assert.equal(correctRemainInt(100, "1000", "PLA"), 100);
    assert.equal(correctRemainInt(25, "250", "PLA"), 100);
});

// G-code mode ignores the remain percentage, but not whether there is one.
const comparable = remain => [{ id: "0", tray: [
    { id: "0", tray_uuid: "A6A4F33B", tray_weight: "1000", tray_sub_brands: "PLA Glow", tray_color: "7AC0E9FF", remain },
] }];

test("hasTrayDataChanged notices the first remain reading arriving", () => {
    // Captured on a P2S: the slot sat at -1 (null here) for 74 seconds after
    // the spool went in, then reported 53. Without this the snapshot the create
    // action reads keeps saying "no reading" and stores the spool as untouched.
    assert.equal(hasTrayDataChanged(comparable(53), comparable(null)), true);
});

test("hasTrayDataChanged ignores a drifting remain in G-code mode", () => {
    // The weight comes from the sliced file there, so a ticking percentage must
    // not reprocess and log the slot over and over.
    assert.equal(hasTrayDataChanged(comparable(53), comparable(52)), false);
    assert.equal(hasTrayDataChanged(comparable(53), comparable(53)), false);
});

test("hasTrayDataChanged still sees a real change next to a remain tick", () => {
    const before = comparable(53);
    const after = comparable(52);
    after[0].tray[0].tray_color = "FFFFFFFF";
    assert.equal(hasTrayDataChanged(after, before), true);
});

// Real tray payloads captured from a P2S with two AMS 2 Pro units. A loaded
// slot always carries the full record, whether the chip was read or not; an
// empty slot carries `id` and `state` and nothing else. `state` separates
// nothing: 9 and 10 appear on empty slots, 11 and 27 on loaded ones.
const bambuTray = { id: "0", state: 11, cols: ["000000FF"], tag_uid: "55650E0F00000100", tray_diameter: "1.75", tray_info_idx: "GFA00", tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "000000FF", tray_weight: "1000", tray_uuid: "18F1DE9B", remain: 27 };
const thirdParty = { id: "0", state: 11, cols: ["0ACC38FF"], tag_uid: "0000000000000000", tray_diameter: "1.75", tray_info_idx: "GFL99", tray_type: "PLA", tray_sub_brands: "N/A", tray_color: "0ACC38FF", tray_weight: "0", tray_uuid: "N/A", remain: 0 };
const emptyTray = { id: "1", state: 10, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" };

test("slotIsOccupied separates an unidentified spool from an empty slot", () => {
    assert.equal(slotIsOccupied(emptyTray), false);
    assert.equal(slotIsOccupied(thirdParty), true);
    assert.equal(slotIsOccupied(bambuTray), true);
});

test("slotIsOccupied ignores state", () => {
    // The empty slot reports state 10 and the loaded ones report 11, so reading
    // "non zero means occupied" made every empty slot look like a 3rd party
    // spool. Flipping the value must change nothing in either direction.
    assert.equal(slotIsOccupied({ ...emptyTray, state: 0 }), false);
    assert.equal(slotIsOccupied({ ...emptyTray, state: 27 }), false);
    assert.equal(slotIsOccupied({ ...thirdParty, state: 0 }), true);
});

test("slotIsOccupied handles a missing slot", () => {
    assert.equal(slotIsOccupied(undefined), false);
    assert.equal(slotIsOccupied(null), false);
});

test("extractComparableTrayData notices a 3rd party spool arriving", () => {
    const before = [{ id: "0", tray: [{ ...emptyTray, id: "1" }] }];
    const after  = [{ id: "0", tray: [{ ...thirdParty, id: "1" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData notices a 3rd party spool being removed", () => {
    const before = [{ id: "0", tray: [{ ...thirdParty, id: "1" }] }];
    const after  = [{ id: "0", tray: [{ ...emptyTray, id: "1" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData notices material and colour set on the printer", () => {
    // The AMS keeps the slot unidentified, so only the fields the user set on
    // the printer change. Comparing occupancy alone hid this completely.
    const before = [{ id: "0", tray: [{ ...thirdParty, tray_type: "", tray_info_idx: "", tray_color: "N/A" }] }];
    const after  = [{ id: "0", tray: [thirdParty] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData notices one chipless spool swapped for another", () => {
    const before = [{ id: "0", tray: [thirdParty] }];
    const after  = [{ id: "0", tray: [{ ...thirdParty, cols: ["F98C36FF"], tray_color: "F98C36FF" }] }];
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("extractComparableTrayData ignores the state value of an unidentified spool", () => {
    // It varies between reports about the same unchanged slot, so comparing it
    // would trigger a reprocess on nothing.
    const a = [{ id: "0", tray: [{ ...thirdParty, state: 10 }] }];
    const b = [{ id: "0", tray: [{ ...thirdParty, state: 20 }] }];
    assert.deepEqual(extractComparableTrayData(a), extractComparableTrayData(b));
});

test("extractComparableTrayData still tracks identified spools by their data", () => {
    const a = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 50 }] }];
    const b = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 40 }] }];
    assert.notDeepEqual(extractComparableTrayData(a), extractComparableTrayData(b));

    const same = [{ id: "0", tray: [{ ...bambuTray, id: "0", remain: 50 }] }];
    assert.deepEqual(extractComparableTrayData(a), extractComparableTrayData(same));
});

/* ---- Merging an untracked spool, with and without a remain reading ---- */

const glowSlot = remain => ({
    tray_sub_brands: "PLA Glow",
    tray_type: "PLA",
    tray_color: "7AC0E9FF",
    tray_weight: "1000",
    cols: ["7AC0E9FF"],
    remain,
});

const mergeCandidate = (overrides = {}) => ({
    id: 15,
    initial_weight: 1000,
    remaining_weight: 1000,
    used_weight: 0,
    extra: {},
    filament: { material: "PLA Glow", color_hex: "7AC0E9" },
    ...overrides,
});

test("findMergeableSpool matches on weight when the AMS reported one", () => {
    const half = mergeCandidate({ remaining_weight: 500, used_weight: 500 });
    assert.equal(findMergeableSpool(glowSlot(50), [half])?.id, 15);
    // 100 % against a spool that is half gone is outside the 15 % tolerance,
    // and it has been used, so nothing else lets it through either
    assert.equal(findMergeableSpool(glowSlot(100), [half]), undefined);
});

test("findMergeableSpool skips the weight test when there is no reading", () => {
    // Treating the missing value as 0 made the expected remaining weight 0,
    // which matched every empty spool in the instance.
    const empty = mergeCandidate({ remaining_weight: 0, used_weight: 1000 });
    const half = mergeCandidate({ remaining_weight: 500, used_weight: 500 });

    // An untouched spool still merges: never used carries it, not the weight
    assert.equal(findMergeableSpool(glowSlot(null), [mergeCandidate()])?.id, 15);
    // A half used one no longer does, because nothing confirms the guess
    assert.equal(findMergeableSpool(glowSlot(null), [half]), undefined);
    // An empty spool keeps matching on its own rule, unchanged
    assert.equal(findMergeableSpool(glowSlot(null), [empty])?.id, 15);
});

/* ---- Telling a slot being read from one that is simply empty ---- */

// Captured on a P2S while pulling a spool and putting it back. The tray carries
// two fields the whole time, so `state` is the only thing that moves:
//   {"id":"0","state":10}  at rest, empty
//   {"id":"0","state":17}  {"id":"0","state":5}  {"id":"0","state":21}  busy
// then the full 23 field record arrives with state 11.
test("slotIsBusy separates a slot being read from one at rest", () => {
    assert.equal(slotIsBusy({ id: "0", state: 10 }), false);
    assert.equal(slotIsBusy({ id: "0", state: 9 }), false);
    assert.equal(slotIsBusy({ id: "0", state: 17 }), true);
    assert.equal(slotIsBusy({ id: "0", state: 5 }), true);
    assert.equal(slotIsBusy({ id: "0", state: 21 }), true);
});

test("slotIsBusy reads a state sent as a string", () => {
    assert.equal(slotIsBusy({ id: "0", state: "17" }), true);
    assert.equal(slotIsBusy({ id: "0", state: "10" }), false);
});

test("slotIsBusy calls an unseen state at rest, not busy", () => {
    // The wrong way round would leave an empty slot claiming to read a spool
    // for good. This way it says "Empty slot", which is what it says today.
    assert.equal(slotIsBusy({ id: "0", state: 42 }), false);
    assert.equal(slotIsBusy({ id: "0" }), false);
    assert.equal(slotIsBusy(null), false);
});

test("slotIsBusy never fires on a slot that actually holds something", () => {
    // Occupancy is decided by slotIsOccupied, which does not look at state, and
    // a loaded slot must not be labelled as still being read.
    assert.equal(slotIsBusy({ ...thirdParty, state: 17 }), false);
    assert.equal(slotIsBusy({ ...bambuTray, state: 5 }), false);
});

test("extractComparableTrayData notices a slot starting to be read", () => {
    // {"id":"0","state":10} at rest and {"id":"0","state":17} while the AMS
    // pulls the spool in are the same two fields. Without the busy flag nothing
    // reprocesses the slot and the label never reaches a client.
    const atRest = [{ id: "0", tray: [{ id: "0", state: 10, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" }] }];
    const busy = [{ id: "0", tray: [{ id: "0", state: 17, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" }] }];

    assert.notDeepEqual(extractComparableTrayData(atRest), extractComparableTrayData(busy));
});

test("extractComparableTrayData does not reprocess for every busy state", () => {
    // The AMS cycles through 1, 5, 17 and 21 on the way in. They all mean the
    // same thing, so they must cost one update between them, not one each.
    const state = value => [{ id: "0", tray: [{ id: "0", state: value, remain: 0, tray_color: "N/A", tray_sub_brands: "N/A", tray_weight: 0, tray_uuid: "N/A" }] }];

    assert.deepEqual(extractComparableTrayData(state(1)), extractComparableTrayData(state(5)));
    assert.deepEqual(extractComparableTrayData(state(5)), extractComparableTrayData(state(21)));
});

/* ---- Multi colour filaments ---- */

// A real PLA Silk Multi-Color slot as a P2S reports it: two colours in `cols`
// and only the first of them in `tray_color`.
const gildedRose = {
    id: "0",
    state: 11,
    cols: ["FF9425FF", "FCA2BFFF"],
    remain: 80,
    tag_uid: "BAA8227400000100",
    tray_color: "FF9425FF",
    tray_diameter: "1.75",
    tray_info_idx: "GFA05",
    tray_sub_brands: "PLA Silk",
    tray_type: "PLA",
    tray_uuid: "0417584A3ABE4274838571DB6AA6CABA",
    tray_weight: "1000",
};

test("slotColors strips the alpha byte and keeps the reported order", () => {
    assert.deepEqual(slotColors(gildedRose), ["ff9425", "fca2bf"]);
});

test("slotColors falls back to the single colour the printer always sends", () => {
    // Some firmware leaves `cols` out entirely. Three matching functions read
    // it, and they used to reach into `undefined.length` and throw.
    assert.deepEqual(slotColors({ tray_color: "0ACC38FF" }), ["0acc38"]);
    assert.deepEqual(slotColors({ tray_color: "N/A" }), []);
    assert.deepEqual(slotColors({}), []);
});

test("processData fills cols in from the single colour when it is missing", () => {
    const [ams] = processData([{ id: "0", tray: [{ ...gildedRose, cols: undefined }] }]);
    assert.deepEqual(ams.tray[0].cols, ["FF9425FF"]);
});

test("processData leaves an empty slot empty", () => {
    // `cols` is added to every tray, and slotIsOccupied() reads the shape of
    // the record, so a field the normalisation adds unconditionally has to be
    // in EMPTY_TRAY_KEYS or it alone makes every empty slot look occupied.
    const [ams] = processData([{ id: "0", tray: [{ id: "1", state: 10 }] }]);
    assert.deepEqual(ams.tray[0].cols, []);
    assert.equal(slotIsOccupied(ams.tray[0]), false);
});

test("findExistingSpool matches a multi colour spool on its whole colour set", () => {
    const tagged = {
        id: 21,
        extra: { tag: '"0417584A3ABE4274838571DB6AA6CABA"' },
        filament: { material: "PLA Silk", color_hex: null, multi_color_hexes: "FCA2BF,FF9425" },
    };
    // The catalogues do not agree on an order, so the sets are compared sorted.
    assert.equal(findExistingSpool(gildedRose, [tagged])?.id, 21);

    const wrongSecondColour = { ...tagged, filament: { ...tagged.filament, multi_color_hexes: "FF9425,000000" } };
    assert.equal(findExistingSpool(gildedRose, [wrongSecondColour]), null);
});

test("findExistingSpool does not match a multi colour slot to a single colour spool", () => {
    // Both share the first colour, which is all `tray_color` carries, so
    // matching on that field alone connected the slot to the wrong filament.
    const singleColour = {
        id: 22,
        extra: { tag: '"0417584A3ABE4274838571DB6AA6CABA"' },
        filament: { material: "PLA Silk", color_hex: "FF9425" },
    };
    assert.equal(findExistingSpool(gildedRose, [singleColour]), null);
});

test("findMatchingExternalFilament matches a multi colour catalogue entry", () => {
    // Shape and id taken from SpoolmanDB. The material transformations reduce
    // "PLA Silk" to "pla", so only the colour set separates the entries.
    const catalogue = [
        { id: "bambulab_pla_gildedrose(pink-gold)_1000_175_n", material: "PLA", color_hex: null, color_hexes: ["FF9425", "FCA2BF"], multi_color_direction: "coaxial" },
        { id: "bambulab_pla_bluehawaii(blue-green)_1000_175_n", material: "PLA", color_hex: null, color_hexes: ["60A4E8", "4CE4A0"], multi_color_direction: "coaxial" },
    ];
    assert.equal(findMatchingExternalFilament(gildedRose, catalogue).id, "bambulab_pla_gildedrose(pink-gold)_1000_175_n");
});

test("findMatchingExternalFilament takes the Basic line over the ones that sort before it", () => {
    // Ids and names as SpoolmanDB writes them, in its alphabetical order.
    // Basic has no line word in the catalogue, so the first black entry under
    // "bambulab_pla" is Aero Black, and that is what a black Basic spool got.
    const catalogue = [
        { id: "bambulab_pla_aeroblack_1000_175_n", name: "Aero Black", material: "PLA", color_hex: "000000" },
        { id: "bambulab_pla_black_1000_175_n", name: "Black", material: "PLA", color_hex: "000000" },
        { id: "bambulab_pla_liteblack_1000_175_n", name: "Lite Black", material: "PLA", color_hex: "000000" },
        { id: "bambulab_pla_mattecharcoal_1000_175_n", name: "Matte Charcoal", material: "PLA", color_hex: "000000" },
        { id: "bambulab_pla_aerowhite_1000_175_n", name: "Aero White", material: "PLA", color_hex: "FFFFFF" },
        { id: "bambulab_pla_jadewhite_1000_175_n", name: "Jade White", material: "PLA", color_hex: "FFFFFF" },
        { id: "bambulab_pla_litewhite_1000_175_n", name: "Lite White", material: "PLA", color_hex: "FFFFFF" },
        { id: "bambulab_pla_gray_1000_175_n", name: "Gray", material: "PLA", color_hex: "8E9089" },
        { id: "bambulab_pla_slategraysparkle_1000_175_n", name: "Slate Gray Sparkle", material: "PLA", color_hex: "8E9089" },
    ];
    const slot = (subBrand, color) => ({ ...gildedRose, cols: [color], tray_color: color, tray_sub_brands: subBrand, tray_type: "PLA" });

    assert.equal(findMatchingExternalFilament(slot("PLA Basic", "000000FF"), catalogue).name, "Black");
    // The lines the catalogue writes into the id are found by the id.
    assert.equal(findMatchingExternalFilament(slot("PLA Aero", "000000FF"), catalogue).name, "Aero Black");
    assert.equal(findMatchingExternalFilament(slot("PLA Matte", "000000FF"), catalogue).name, "Matte Charcoal");
    // "Jade White" is as long as "Aero White" and sorts after it: it wins
    // because "Aero" starts two colours in the catalogue and "Jade" one.
    assert.equal(findMatchingExternalFilament(slot("PLA Basic", "FFFFFFFF"), catalogue).name, "Jade White");
    // A line the catalogue writes at the end of the name wins by its word,
    // and the plain colour of the same hex stays with Basic.
    assert.equal(findMatchingExternalFilament(slot("PLA Sparkle", "8E9089FF"), catalogue).name, "Slate Gray Sparkle");
    assert.equal(findMatchingExternalFilament(slot("PLA Basic", "8E9089FF"), catalogue).name, "Gray");
});

test("extractComparableTrayData sees a colour set change that tray_color misses", () => {
    // Two multi colour filaments sharing their first colour. Without `cols` the
    // projection is byte identical and the slot is never reprocessed, so the
    // old colours stay on screen.
    const before = processData([{ id: "0", tray: [{ ...gildedRose, tray_uuid: "N/A", tray_sub_brands: "N/A" }] }]);
    const after = processData([{ id: "0", tray: [{ ...gildedRose, tray_uuid: "N/A", tray_sub_brands: "N/A", cols: ["FF9425FF", "000000FF"] }] }]);

    assert.equal(before[0].tray[0].tray_color, after[0].tray[0].tray_color);
    assert.notDeepEqual(extractComparableTrayData(before), extractComparableTrayData(after));
});

test("processData substitutes the PETG Translucent colour in cols too", () => {
    // The spool reports a fully transparent colour, which renders as nothing,
    // so it is shown as white. Correcting only `tray_color` was enough while
    // that was the only colour anything read. `cols` is read first now, and a
    // transparent value left in it draws the spool black.
    const [ams] = processData([{ id: "0", tray: [{
        id: "0", state: 11, cols: ["00000000"], tray_type: "PETG",
        tray_sub_brands: "PETG Translucent", tray_color: "00000000",
        tray_weight: "1000", tray_uuid: "ABCD", remain: 80,
    }] }]);

    assert.equal(ams.tray[0].tray_color, "FFFFFF00");
    assert.deepEqual(ams.tray[0].cols, ["FFFFFF00"]);
    assert.deepEqual(slotColors(ams.tray[0]), ["ffffff"]);
});

/* ---- spoolTag ---- */

test("the tag is read in its stored form, as a bare uuid, and never throws", () => {
    const uuid = "83362CE88F504A599E53E6A02F6680AD";
    // What the service writes: the uuid JSON encoded
    assert.equal(spoolTag({ extra: { tag: `"${uuid}"` } }), uuid);
    // What a hand edit in Spoolman leaves behind
    assert.equal(spoolTag({ extra: { tag: uuid } }), uuid);
    assert.equal(spoolTag({ extra: { tag: ` "${uuid}" ` } }), uuid);
    // Not a tag at all: empty, quotes only, JSON that is not a string, broken JSON
    assert.equal(spoolTag({ extra: { tag: "" } }), null);
    assert.equal(spoolTag({ extra: { tag: '""' } }), null);
    assert.equal(spoolTag({ extra: { tag: "{" } }), "{");
    assert.equal(spoolTag({ extra: { tag: "[1,2]" } }), null);
    assert.equal(spoolTag({ extra: {} }), null);
    assert.equal(spoolTag(null), null);
});

test("a spool with a tag that is not JSON is skipped rather than aborting the search", () => {
    const uuid = "83362CE88F504A599E53E6A02F6680AD";
    const slot = { tray_uuid: uuid, tray_sub_brands: "PLA Basic", tray_color: "F55A74FF", cols: ["F55A74FF"] };
    const broken = { id: 1, extra: { tag: "{not json" }, filament: { material: "PLA Basic", color_hex: "F55A74" } };
    const right = { id: 2, extra: { tag: `"${uuid}"` }, filament: { material: "PLA Basic", color_hex: "F55A74" } };
    assert.equal(findExistingSpool(slot, [broken, right])?.id, 2);
});
