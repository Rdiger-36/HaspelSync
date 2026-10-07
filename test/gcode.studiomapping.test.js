// First, so the modules below read a throwaway DATA_DIR, see the helper
import "./helpers/tempdata.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { decodeStudioMapping, parseSliceInfo, calcFullConsumption, resolveSliceSlots, orderedAmsSlots } from "../src/gcode.js";
import { decodePrintMapping } from "../src/utils.js";
import { matchConsumption, consumptionCandidate } from "../src/ams.js";
import { loadedSlotIds } from "../src/uispool.js";

// The project_file command a printer echoes when Bambu Studio sends a job,
// cut down to the two fields that carry the slots. All three are real echoes
// from issue #146, September 2026.

// Schnuecks's P1S, 2026-09-07: a reused project whose list reads blue, orange,
// red, sent to slots where blue sits in A1, red in A3 and orange in A4, with
// A2 empty. Studio remapped by colour and the printer ran 0, 3, 2.
const P1S_REUSED = {
    command: "project_file",
    subtask_name: "Würfel",
    ams_mapping: [0, 3, 2],
    ams_mapping2: [{ ams_id: 0, slot_id: 0 }, { ams_id: 0, slot_id: 3 }, { ams_id: 0, slot_id: 2 }],
};

// beegee-tokyo's P1S, 2026-09-07: a four filament project using three, the
// fourth unused.
const P1S_UNUSED = {
    command: "project_file",
    ams_mapping: [0, 1, 2, -1],
    ams_mapping2: [{ ams_id: 0, slot_id: 0 }, { ams_id: 0, slot_id: 1 }, { ams_id: 0, slot_id: 2 }, { ams_id: 255, slot_id: 255 }],
};

// Niklas's X1E, 2026-09-07: A3 empty, and the printer's own print.mapping read
// [0, 1, 3] for the whole print.
const X1E = {
    command: "project_file",
    ams_mapping: [0, 1, 3],
    ams_mapping2: [{ ams_id: 0, slot_id: 0 }, { ams_id: 0, slot_id: 1 }, { ams_id: 0, slot_id: 3 }],
};

test("the echo names the slots by unit and slot, unused filaments as null", () => {
    assert.deepEqual(decodeStudioMapping(P1S_REUSED), ["A1", "A4", "A3"]);
    assert.deepEqual(decodeStudioMapping(P1S_UNUSED), ["A1", "A2", "A3", null]);
});

test("the echo says what the printer's own mapping says where both exist", () => {
    assert.deepEqual(decodeStudioMapping(X1E), decodePrintMapping([0x0000, 0x0001, 0x0003]));
});

test("the flat index is read when the explicit pairs are missing", () => {
    assert.deepEqual(decodeStudioMapping({ ams_mapping: [0, 3, 2] }), ["A1", "A4", "A3"]);
    assert.deepEqual(decodeStudioMapping({ ams_mapping: [0, 1, 2, -1] }), ["A1", "A2", "A3", null]);
    // unit 1 slot 2, and an AMS HT at flat index 16 and 17
    assert.deepEqual(decodeStudioMapping({ ams_mapping: [6, 16, 17] }), ["B3", "HT-A", "HT-B"]);
    // out of every known range
    assert.deepEqual(decodeStudioMapping({ ams_mapping: [24, 99] }), [null, null]);
});

test("an AMS HT in the explicit pairs, and a unit nobody can name", () => {
    assert.deepEqual(decodeStudioMapping({ ams_mapping2: [{ ams_id: 128, slot_id: 0 }, { ams_id: 1, slot_id: 1 }] }), ["HT-A", "B2"]);
    assert.deepEqual(decodeStudioMapping({ ams_mapping2: [{ ams_id: 16, slot_id: 0 }, { ams_id: "x", slot_id: 0 }, null] }), [null, null, null]);
});

test("a command without a mapping yields null", () => {
    assert.equal(decodeStudioMapping({ command: "project_file" }), null);
    assert.equal(decodeStudioMapping({ ams_mapping: [], ams_mapping2: [] }), null);
    assert.equal(decodeStudioMapping(null), null);
});

// The reused project itself, and the slots as the P1S reported them at the
// time. This is the case no list order can get right: the estimate names A3
// for the orange filament and A4 for the red one, the echo names them the
// other way round, and the printer ran the echo.
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "p1s_reused_project.config");
const reused = parseSliceInfo(fs.readFileSync(fixturePath, "utf-8"));

const slot = (amsId, idx, type, color, id, tag = true) => ({
    amsId,
    slotState: tag ? "Loaded (Bambu Lab)" : "Loaded (3rd party)",
    connectedViaTag: tag,
    connectedViaMapping: !tag,
    existingSpool: { id },
    slot: { tray_type: type, tray_info_idx: idx, tray_color: color, cols: [color], tray_weight: "1000", remain: 50 },
});
const empty = (amsId) => ({ amsId, slotState: "Empty", connectedViaTag: false, connectedViaMapping: false, existingSpool: null, slot: {} });

const printerSlots = () => [
    slot("A1", "GFSNL03", "PLA", "0D6284FF", 12, false),
    empty("A2"),
    slot("A3", "GFA00", "PLA", "C12E1FFF", 31),
    slot("A4", "GFA00", "PLA", "FF9016FF", 35),
];

test("a reused project is booked onto the slots Studio sent it to", () => {
    assert.deepEqual(reused.filaments.map(f => f.color), ["#0D6284", "#FF9016", "#C12E1F"]);

    const sent = decodeStudioMapping(P1S_REUSED);
    const entries = Object.values(resolveSliceSlots(calcFullConsumption(reused), sent, { reportedByPrinter: true }));
    assert.deepEqual(entries.map(e => e.amsId), ["A1", "A4", "A3"]);
    assert.deepEqual(entries.map(e => e.grams), [2.06, 1.08, 0.5]);

    const candidates = printerSlots().filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);
    assert.deepEqual(entries.map(e => matched.get(e)?.[0]?.amsId ?? null), ["A1", "A4", "A3"]);
});

test("the list order alone would have named the wrong slots for two of the three", () => {
    const estimated = orderedAmsSlots(loadedSlotIds(printerSlots()));
    assert.deepEqual(estimated, ["A1", "A3", "A4"]);

    const entries = Object.values(resolveSliceSlots(calcFullConsumption(reused), estimated, { reportedByPrinter: false }));
    assert.deepEqual(entries.map(e => e.amsId), ["A1", "A3", "A4"]);

    // Saved by the colour stage this time, because the three colours differ.
    // Two spools of one colour would not have been told apart.
    const candidates = printerSlots().filter(s => s.slotState !== "Empty").map(consumptionCandidate);
    const matched = matchConsumption(entries, candidates);
    assert.deepEqual(entries.map(e => matched.get(e)?.[0]?.amsId ?? null), ["A1", "A4", "A3"]);
});

// The hand-over on the printer object: the echo arrives before the state
// changes, is kept, and becomes the mapping of the print of that name.
// A serial of its own per printer, so a print one test leaves running in
// printstate.json is not found again by the next as a print already underway
let printerCount = 0;
const freshPrinter = () => ({
    id: `TEST${++printerCount}`,
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
});

test("a start on the printer's screen names the file, and the print takes it", async () => {
    const { notePrintCommand, handlePrintStateChange } = await import("../src/mqtt.js");
    const printer = freshPrinter();
    // A P2S, 2026-09-23: A1mini.gcode.3mf on the USB stick, started on the
    // screen. The printer announces it with its own url and the model's title
    const command = {
        command: "project_file",
        subtask_name: "Perfectly clean bed for perfect prints!",
        url: "file:///userdata/model/history/A1mini.gcode.3mf",
        ams_mapping: [0],
        ams_mapping2: [{ ams_id: 0, slot_id: 0 }],
    };
    assert.equal(notePrintCommand(printer, Buffer.from(JSON.stringify({ print: command }))), true);
    assert.deepEqual(printer.pendingFileName, { jobName: "Perfectly clean bed for perfect prints!", fileName: "A1mini.gcode.3mf" });

    await handlePrintStateChange(printer, { gcode_state: "RUNNING", subtask_name: "Perfectly clean bed for perfect prints!", layer_num: 0 });
    assert.equal(printer.currentFileName, "A1mini.gcode.3mf");
    assert.equal(printer.pendingFileName, null);
    assert.deepEqual(printer.currentMapping, ["A1"]);

    // Bambu Studio's own command names a remote object, which is no file name
    printer.currentGcodeState = "FINISH";
    notePrintCommand(printer, Buffer.from(JSON.stringify({ print: { ...command, url: "https://example.invalid/x.3mf?sig=1" } })));
    assert.equal(printer.pendingFileName, null);
    await handlePrintStateChange(printer, { gcode_state: "RUNNING", subtask_name: "Perfectly clean bed for perfect prints!", layer_num: 0 });
    assert.equal(printer.currentFileName, null);
});

test("the echo is kept and taken by the print of that name", async () => {
    const { notePrintCommand, handlePrintStateChange } = await import("../src/mqtt.js");
    const printer = freshPrinter();

    assert.equal(notePrintCommand(printer, Buffer.from(JSON.stringify({ print: P1S_REUSED }))), true);
    assert.deepEqual(printer.pendingMapping.slots, ["A1", "A4", "A3"]);
    assert.equal(printer.pendingMapping.jobName, "Würfel");

    await handlePrintStateChange(printer, { gcode_state: "PREPARE", subtask_name: "Würfel", layer_num: 0 });
    assert.deepEqual(printer.currentMapping, ["A1", "A4", "A3"]);
    assert.equal(printer.pendingMapping, null);

    // A P2S reports print.mapping itself and that wins on every report
    await handlePrintStateChange(printer, { gcode_state: "RUNNING", subtask_name: "Würfel", layer_num: 1, mapping: [0x0000, 0x0002, 0x0003] });
    assert.deepEqual(printer.currentMapping, ["A1", "A3", "A4"]);
});

test("an echo for another job is not used, and a report is not mistaken for an echo", async () => {
    const { notePrintCommand, handlePrintStateChange } = await import("../src/mqtt.js");
    const printer = freshPrinter();

    notePrintCommand(printer, Buffer.from(JSON.stringify({ print: { ...P1S_REUSED, subtask_name: "Something else" } })));
    await handlePrintStateChange(printer, { gcode_state: "PREPARE", subtask_name: "Würfel", layer_num: 0 });
    assert.equal(printer.currentMapping, null);
    assert.equal(printer.pendingMapping, null);

    // A status report that happens to mention the word is left to the handler
    assert.equal(notePrintCommand(printer, Buffer.from('{"print":{"command":"push_status","gcode_file":"project_file.3mf"}}')), false);
    assert.equal(notePrintCommand(printer, Buffer.from("not json")), false);
    // An echo without a mapping is noted, and leaves nothing behind
    assert.equal(notePrintCommand(printer, Buffer.from('{"print":{"command":"project_file","subtask_name":"x"}}')), true);
    assert.equal(printer.pendingMapping, null);
});

// One download per print: the dashboard's request and the print handler share
// it, and a file the dashboard already fetched is not fetched again at RUNNING.
test("a file the dashboard already fetched is not fetched again when the print runs", async () => {
    const { handlePrintStateChange } = await import("../src/mqtt.js");
    const printer = { ...freshPrinter(), currentGcodeState: "PREPARE", currentJobName: "Würfel", sliceFetchDone: false };
    printer.currentSliceInfo = { filaments: [{ index: 0 }], totalLayers: 3, rangesByFilamentIdx: {}, presets: [] };

    await handlePrintStateChange(printer, { gcode_state: "RUNNING", subtask_name: "Würfel", layer_num: 0 });
    assert.equal(printer.sliceFetchDone, true);
    // fetchSliceInfo() records every attempt on lastSliceFetch before it
    // connects, so an untouched record means no download was started
    assert.equal(printer.lastSliceFetch, undefined);
    assert.equal(printer.currentSliceInfo.totalLayers, 3);
});

test("two callers asking at once share one download", async () => {
    const { ensureSliceInfo } = await import("../src/mqtt.js");
    // No printer answers on this address, so the shared download fails fast;
    // what matters is that the second caller gets the first caller's promise.
    const printer = { ...freshPrinter(), ip: "127.0.0.1", code: "x", currentJobName: "Würfel" };

    const first = ensureSliceInfo(printer, "Würfel", "Würfel.3mf");
    const second = ensureSliceInfo(printer, "Würfel", "Würfel.3mf");
    assert.equal(first, second);
    assert.equal(printer.sliceFetchInFlight.jobName, "Würfel");

    await Promise.allSettled([first, second]);
    assert.equal(printer.sliceFetchInFlight, null);
    // A different job is a different download
    const other = ensureSliceInfo(printer, "Other", null);
    assert.notEqual(other, first);
    await Promise.allSettled([other]);
});
