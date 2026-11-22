import test from "node:test";
import assert from "node:assert/strict";

import { slotConfirmsSlice, matchConsumption, consumptionCandidate } from "../src/ams.js";

// The position of a filament in the slicer's list is the AMS slot it was sliced
// for, which is the only thing that can tell two identical spools apart. The
// printer is free to remap slots when a job is sent, and slice_info.config is
// written before that, so the slot is confirmed against what the AMS reports
// for it now rather than taken on trust.

const candidate = (idx, colors) => ({ id: 1, amsId: "B1", mapped: false, idx, colors });
const entry = (idx, color, colors = null) => ({ tray_info_idx: idx, color, colors, amsId: "B1" });

test("a slot holding what the slice expected confirms it", () => {
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["8ec9e9", "e7c1d5"]), entry("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"])),
        true,
    );
});

test("the colour set is compared as a set, not by its first colour", () => {
    // Bambu Studio and the RFID chip need not agree on which colour comes
    // first, and a comparison that depended on it would reject exactly the
    // spools this exists for.
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["e7c1d5", "8ec9e9"]), entry("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"])),
        true,
    );
});

test("a different profile in the slot refuses it", () => {
    assert.equal(
        slotConfirmsSlice(candidate("GFA05", ["8ec9e9", "e7c1d5"]), entry("GFA00", "#8EC9E9", ["8EC9E9", "E7C1D5"])),
        false,
    );
});

test("a different colour set in the slot refuses it", () => {
    // The remap case: the slot exists and holds the right profile, but another
    // filament. Booking on it would be silent and wrong.
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["ffffff", "e94b3c"]), entry("GFA00", "#FFFFFF", ["FFFFFF", "9CDBD9"])),
        false,
    );
});

test("a single colour spool confirms on its one colour", () => {
    assert.equal(slotConfirmsSlice(candidate("GFA00", ["000000"]), entry("GFA00", "#000000")), true);
    assert.equal(slotConfirmsSlice(candidate("GFA00", ["ffffff"]), entry("GFA00", "#000000")), false);
});

test("a multi colour slot does not confirm against a slice that carries no set", () => {
    // An older slicer writes no project_settings.config, so the set is unknown
    // and only the first colour is comparable. Refusing here costs the slot
    // stage and leaves the decision to the stages that existed before it.
    assert.equal(
        slotConfirmsSlice(candidate("GFA00", ["ffffff", "9cdbd9"]), entry("GFA00", "#FFFFFF")),
        false,
    );
});

test("a slot with no profile at all refuses", () => {
    assert.equal(slotConfirmsSlice(candidate(null, ["000000"]), entry("GFA00", "#000000")), false);
    assert.equal(slotConfirmsSlice(candidate("GFA00", []), entry("GFA00", "#000000")), false);
});

/* ---- A reported slot is trusted, an estimated one is confirmed ---- */

// Read off a live print. The slice held Army Green on the external holder, and
// the print was started with the orange spool in A2 selected for that filament
// by mistake. print.mapping said A2, which was right: A2 is what the printer
// would have consumed.
const armyGreenSlice = { index: 3, amsId: "A2", tray_info_idx: "GFL99", color: "#5E6345", colors: null };
const orangeInA1 = { id: 9, amsId: "A2", mapped: true, idx: "GFL99", colors: ["f98c36"] };

test("a slot the printer reported is not checked against the sliced colour", () => {
    // Confirming it rejected the one answer that was right. A filament
    // substituted for the sliced one is not a mistake to catch, it is the
    // substitution the field exists to report, and rejecting it fell through to
    // the colour stages, which found the spool that was sliced rather than the
    // spool that would have been consumed.
    assert.equal(slotConfirmsSlice(orangeInA1, armyGreenSlice), false);

    // Which is why the stage reads the flag rather than the confirmation for a
    // reported slot. Same predicate as bookConsumption's first stage.
    const stage = (candidate, info) =>
        !!info.amsId && candidate.amsId === info.amsId && (info.amsIdFromPrinter || slotConfirmsSlice(candidate, info));

    assert.equal(stage(orangeInA1, { ...armyGreenSlice, amsIdFromPrinter: true }), true);
    assert.equal(stage(orangeInA1, { ...armyGreenSlice, amsIdFromPrinter: false }), false);
});

test("an estimated slot still has to hold what the slice expects", () => {
    // The list order cannot tell whether the project is synchronised with the
    // printer, so its answer is corroborated before anything is booked on it.
    const stage = (candidate, info) =>
        !!info.amsId && candidate.amsId === info.amsId && (info.amsIdFromPrinter || slotConfirmsSlice(candidate, info));

    const matchingSlot = { id: 1, amsId: "A2", mapped: false, idx: "GFL99", colors: ["5e6345"] };
    assert.equal(stage(matchingSlot, { ...armyGreenSlice, amsIdFromPrinter: false }), true);
});

/* ---- The whole decision, as both callers make it ---- */

// matchConsumption() is the one implementation of "which sliced filament comes
// out of which slot". bookConsumption() runs it over the spools it may book on,
// the dashboard route over every loaded slot. It used to exist a second time in
// the browser, where nothing tested it and both defects fixed at the end of
// PR #89 sat.

const spool = (amsId, { id = null, idx = null, type = "PLA", color = null, cols = null, mapped = false, tag = false } = {}) =>
    consumptionCandidate({
        amsId,
        connectedViaMapping: mapped,
        connectedViaTag: tag,
        existingSpool: id ? { id } : null,
        slot: { tray_info_idx: idx, tray_type: type, tray_color: color, cols: cols ?? (color ? [color] : []) },
    });

const filament = (index, { idx = null, color = null, colors = null, type = "PLA", amsId = null, fromPrinter = false, grams = 10 } = {}) =>
    ({ index, tray_info_idx: idx, color, colors, type, amsId, amsIdFromPrinter: fromPrinter, grams });

const matchedSlot = (entries, candidates, entry) => matchConsumption(entries, candidates).get(entry)?.[0]?.amsId ?? null;

test("the slot the printer named wins, whatever colour sits in it", () => {
    const sliced = filament(0, { idx: "GFL99", color: "#5E6345", amsId: "A2", fromPrinter: true });
    const slots = [spool("A1", { id: 1, idx: "GFL99", color: "5E6345", tag: true }), spool("A2", { id: 2, idx: "GFL99", color: "F98C36", tag: true })];

    assert.equal(matchedSlot([sliced], slots, sliced), "A2");
});

test("an estimated slot has to hold what the slice expects, or the stages below decide", () => {
    const sliced = filament(0, { idx: "GFA00", color: "#5E6345", amsId: "A2" });
    const slots = [spool("A1", { id: 1, idx: "GFA00", color: "5E6345", tag: true }), spool("A2", { id: 2, idx: "GFA00", color: "F98C36", tag: true })];

    // A2 is what the list order estimated, A1 is what actually holds the colour.
    assert.equal(matchedSlot([sliced], slots, sliced), "A1");
});

test("a slot the printer named for one filament is not claimed by another", () => {
    // The defect a user found on the dashboard: a print running from remapped
    // slots showed every figure twice, on the slot being consumed and on the
    // slot merely holding the colour the file was sliced with. The second one
    // reaches the colour stage and matches, unless the claim is respected.
    const remapped = filament(0, { idx: "GFA00", color: "#FFFFFF", amsId: "A2", fromPrinter: true });
    const other    = filament(1, { idx: "GFA00", color: "#FFFFFF", amsId: null });
    const slots = [spool("A1", { id: 1, idx: "GFA00", color: "FFFFFF", tag: true }), spool("A2", { id: 2, idx: "GFA00", color: "FFFFFF", tag: true })];

    const matched = matchConsumption([remapped, other], slots);
    assert.equal(matched.get(remapped)[0].amsId, "A2");
    assert.deepEqual(matched.get(other).map(c => c.amsId), ["A1"]);
});

test("a slot the printer named without a bookable spool books nothing elsewhere", () => {
    // Issue #273: white printed from A3, which had no spool assigned, while an
    // identical white spool sat assigned in A1. The colour stage booked the
    // grams onto A1. The booking only offers bookable slots, so A3 is absent.
    const white = filament(0, { idx: "GFSNL04", color: "#FFFFFF", amsId: "A3", fromPrinter: true });
    const teal  = filament(1, { idx: "GFSNL03", color: "#408080", amsId: "A2", fromPrinter: true });
    const slots = [
        spool("A1", { id: 2, idx: "GFSNL04", color: "FFFFFF", mapped: true }),
        spool("A2", { id: 1, idx: "GFSNL03", color: "408080", mapped: true }),
    ];

    const matched = matchConsumption([white, teal], slots);
    assert.deepEqual(matched.get(white), []);
    assert.equal(matched.get(teal)[0].amsId, "A2");
});

test("the filament identity stage separates a gradient spool from the plain one", () => {
    // The stage was dead: the map is keyed by the position of the filament, and
    // the browser copy looked the key up in it instead of comparing entry by
    // entry, so nothing ever hit and only the loosest stage did any work.
    const gradient = filament(0, { idx: "GFA00", color: "#8EC9E9", colors: ["#8EC9E9", "#E7C1D5"] });
    const slots = [
        spool("A1", { id: 1, idx: "GFA00", color: "8EC9E9", tag: true }),
        spool("A2", { id: 2, idx: "GFA00", color: "8EC9E9", cols: ["8EC9E9", "E7C1D5"], tag: true }),
    ];

    assert.equal(matchedSlot([gradient], slots, gradient), "A2");
});

test("a 3rd party spool is matched on material and colour", () => {
    // It reports the generic profile or none at all, so the identity stage
    // cannot see it and the material stage is what books it.
    const sliced = filament(0, { idx: "GFA00", color: "#F98C36", type: "PLA" });
    const slots = [spool("External", { id: 7, idx: null, type: "PLA", color: "F98C36", mapped: true })];

    assert.equal(matchedSlot([sliced], slots, sliced), "External");
});

test("a profile two filaments of the print share matches nothing on its own", () => {
    // Bambu Studio slices PLA Basic black and PLA Basic white as the same
    // GFA00. With only the black spool loaded, the white filament used to reach
    // it on the profile alone, and its grams were booked onto a spool that never
    // printed it. Unplaced, and a log line asking for an assignment, is the
    // honest answer.
    const black = filament(0, { idx: "GFA00", color: "#000000" });
    const white = filament(1, { idx: "GFA00", color: "#FFFFFF" });
    const slots = [spool("A1", { id: 1, idx: "GFA00", color: "000000", tag: true })];

    const matched = matchConsumption([black, white], slots);
    assert.equal(matched.get(black)[0].amsId, "A1");
    assert.deepEqual(matched.get(white), []);
});

test("a unique profile still matches when the colours do not line up", () => {
    const sliced = filament(0, { idx: "GFB01", color: "#123456", type: "ABS" });
    const slots = [spool("A3", { id: 3, idx: "GFB01", type: "ABS", color: "FFFFFF", tag: true })];

    assert.equal(matchedSlot([sliced], slots, sliced), "A3");
});

test("a manual assignment outranks an automatic match in the same stage", () => {
    const sliced = filament(0, { idx: "GFA00", color: "#000000" });
    const slots = [
        spool("A1", { id: 1, idx: "GFA00", color: "000000", tag: true }),
        spool("A2", { id: 2, idx: "GFA00", color: "000000", mapped: true }),
    ];

    assert.equal(matchedSlot([sliced], slots, sliced), "A2");
});

test("two indistinguishable spools are both reported, for the caller to decide", () => {
    const sliced = filament(0, { idx: "GFA00", color: "#000000" });
    const slots = [
        spool("A1", { id: 1, idx: "GFA00", color: "000000", tag: true }),
        spool("A2", { id: 2, idx: "GFA00", color: "000000", tag: true }),
    ];

    assert.deepEqual(matchConsumption([sliced], slots).get(sliced).map(c => c.id), [1, 2]);
});

test("a filament no loaded slot can serve matches nothing", () => {
    const sliced = filament(0, { idx: "GFA00", color: "#000000" });
    assert.deepEqual(matchConsumption([sliced], []).get(sliced), []);
});

/* ---- One candidate shape out of two payloads ---- */

test("the runtime slot and its client projection produce the same candidate", () => {
    // bookConsumption() builds candidates from the runtime spools, where a field
    // the printer left out is the literal "N/A", and the dashboard route builds
    // them from toClientSpool(), which has already turned that into null. Two
    // keys for one slot would be exactly the drift this function exists to end.
    const runtime = consumptionCandidate({
        amsId: "A1",
        connectedViaMapping: true,
        existingSpool: { id: 5 },
        slot: { tray_info_idx: "N/A", tray_type: "PLA", tray_color: "F98C36", cols: ["F98C36"] },
    });
    const projected = consumptionCandidate({
        amsId: "A1",
        connectedViaMapping: true,
        existingSpool: { id: 5 },
        slot: { tray_info_idx: null, tray_type: "PLA", tray_color: "f98c36", cols: ["f98c36"] },
    });

    assert.deepEqual(runtime, projected);
    // No profile means no identity key, so the identity stage skips the slot
    // instead of matching every other spool the printer could not identify.
    assert.equal(runtime.key, null);
    assert.equal(runtime.matKey, "PLA|F98C36");
});
