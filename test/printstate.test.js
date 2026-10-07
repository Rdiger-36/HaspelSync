import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

// The module reads its path from config.js at import time, so DATA_DIR has to
// point at a throwaway directory before the first import.
let dir, printStatePath, rememberPrintStart, recallPrintStart, forgetPrintStart, resetPrintStateForTests, rememberSlicedFile, recallSlicedFile, rememberPrintSlots, recallPrintSlots, handlePrintStateChange, deltaAsReport, runningPrint;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-printstate-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    fs.ensureDirSync(process.env.DATA_DIR);
    fs.ensureDirSync(process.env.LOG_DIR);

    ({ printStatePath } = await import("../src/config.js"));
    ({ rememberPrintStart, recallPrintStart, forgetPrintStart, resetPrintStateForTests, rememberSlicedFile, recallSlicedFile, rememberPrintSlots, recallPrintSlots } = await import("../src/printstate.js"));
    ({ handlePrintStateChange, deltaAsReport, runningPrint } = await import("../src/mqtt.js"));
});

after(() => { fs.removeSync(dir); });

test("a start is remembered for the job, survives a reload, and is forgotten at the end", () => {
    rememberPrintStart("SERIAL", "Cube", Date.now() - 1000);
    const stored = JSON.parse(fs.readFileSync(printStatePath, "utf-8"));
    assert.equal(stored.printers.SERIAL.jobName, "Cube");

    resetPrintStateForTests();
    assert.equal(typeof recallPrintStart("SERIAL", "Cube"), "number");
    // Another job, or another printer, gets nothing
    assert.equal(recallPrintStart("SERIAL", "Other"), null);
    assert.equal(recallPrintStart("OTHER", "Cube"), null);

    forgetPrintStart("SERIAL");
    assert.equal(recallPrintStart("SERIAL", "Cube"), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(printStatePath, "utf-8")).printers, {});
});

test("the sliced file's path is kept with the start and read back for the same job", () => {
    resetPrintStateForTests();
    fs.removeSync(printStatePath);
    // No start recorded, so no path either: it would be taken for the next print
    rememberSlicedFile("P2S", "/cache/old.gcode.3mf");
    assert.equal(recallSlicedFile("P2S", "Darts Holder and Storage"), null);

    rememberPrintStart("P2S", "Darts Holder and Storage", Date.now() - 60_000);
    assert.equal(recallSlicedFile("P2S", "Darts Holder and Storage"), null);
    rememberSlicedFile("P2S", "/cache/0.2mm layer, 2 walls, 15% infill.gcode.3mf");
    resetPrintStateForTests();
    assert.equal(recallSlicedFile("P2S", "Darts Holder and Storage"), "/cache/0.2mm layer, 2 walls, 15% infill.gcode.3mf");
    assert.equal(recallSlicedFile("P2S", "another job"), null);

    // A new start of the printer forgets the path with the old start
    rememberPrintStart("P2S", "Darts Holder and Storage", Date.now());
    assert.equal(recallSlicedFile("P2S", "Darts Holder and Storage"), null);
    forgetPrintStart("P2S");
    assert.equal(recallSlicedFile("P2S", "Darts Holder and Storage"), null);
});

test("a start older than a week is not trusted", () => {
    rememberPrintStart("SERIAL", "Cube", Date.now() - 8 * 24 * 60 * 60 * 1000);
    assert.equal(recallPrintStart("SERIAL", "Cube"), null);
    forgetPrintStart("SERIAL");
});

const printer = (over = {}) => ({
    id: "SERIAL",
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
    printStartedAt: null,
    stateSeenSinceStart: false,
    ...over,
});

test("a restart mid print keeps the print's start time, a new print starts its own", async () => {
    // The process that saw the print begin
    const before = printer();
    await handlePrintStateChange(before, { gcode_state: "IDLE" });
    await handlePrintStateChange(before, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 1 });
    const started = before.printStartedAt;
    assert.equal(typeof started, "number");

    // The process after a restart: its first report already says RUNNING
    const after = printer();
    await new Promise(resolve => setTimeout(resolve, 5));
    await handlePrintStateChange(after, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 7 });
    assert.equal(after.printStartedAt, started);

    // The print ends, the start is forgotten, and the same job printed again
    // later starts a clock of its own
    await handlePrintStateChange(after, { gcode_state: "FINISH", subtask_name: "Cube", layer_num: 11 });
    assert.equal(recallPrintStart("SERIAL", "Cube"), null);

    const again = printer();
    await handlePrintStateChange(again, { gcode_state: "IDLE" });
    await handlePrintStateChange(again, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 1 });
    assert.notEqual(again.printStartedAt, started);
    assert.ok(again.printStartedAt > started);
});

test("only the first report after a start may take an old start over", async () => {
    rememberPrintStart("SERIAL", "Cube", Date.now() - 60_000);
    const p = printer();
    // A report was already read, so this is a print that begins now
    await handlePrintStateChange(p, { gcode_state: "IDLE" });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 1 });
    assert.ok(Date.now() - p.printStartedAt < 5_000);
    forgetPrintStart("SERIAL");
});

test("the report that starts a job still carries the previous job's last layer, and a job starts at 0", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Old", layer_num: 11 });
    // Measured on a P2S: FINISH to RUNNING with layer_num 11, then 0 five seconds later
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 11 });
    assert.equal(p.currentLayerNum, 0);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0 });
    assert.equal(p.currentLayerNum, 0);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 4 });
    // A stale lower value in the next report does not pull it back
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 3 });
    assert.equal(p.currentLayerNum, 4);
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Cube", layer_num: 11 });
    assert.equal(p.currentLayerNum, 11);
    forgetPrintStart("SERIAL");
});

test("the previous job's layer is ignored while the printer keeps repeating it after the start", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Old", layer_num: 37 });
    // Seen on a P2S on 2026-09-20: a 36 layer print leaves 37, the next job
    // starts and the reports of the following seconds still say 37
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Zylinder", layer_num: 37 });
    assert.equal(p.currentLayerNum, 0);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Zylinder", layer_num: 37 });
    assert.equal(p.currentLayerNum, 0);
    // A delta on a P1S carries the same stale number the same way
    await handlePrintStateChange(p, deltaAsReport(p, { layer_num: 37 }));
    assert.equal(p.currentLayerNum, 0);
    // The printer's own reset ends it, and from there the counter runs as before
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Zylinder", layer_num: 0 });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Zylinder", layer_num: 2 });
    assert.equal(p.currentLayerNum, 2);
    // Reaching the old number for real is taken, the marker is gone
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Zylinder", layer_num: 37 });
    assert.equal(p.currentLayerNum, 37);
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Zylinder", layer_num: 70 });
    assert.equal(p.currentLayerNum, 70);
    forgetPrintStart("SERIAL");
});

test("the previous job's layer count is ignored until the printer names the new one", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "PenroseTriangle", total_layer_num: 248 });
    // Seen on a P2S on 2026-09-26: the 248 of the last print went on through
    // PREPARE and the new job's 7 came with RUNNING only
    await handlePrintStateChange(p, { gcode_state: "PREPARE", subtask_name: "Swatch Board", total_layer_num: 248 });
    assert.equal(runningPrint(p).totalLayers, null);
    await handlePrintStateChange(p, { gcode_state: "PREPARE", subtask_name: "Swatch Board", total_layer_num: 248 });
    assert.equal(runningPrint(p).totalLayers, null);
    await handlePrintStateChange(p, { gcode_state: "PREPARE", subtask_name: "Swatch Board", total_layer_num: 7 });
    assert.equal(runningPrint(p).totalLayers, 7);
    forgetPrintStart("SERIAL");
});

test("the ids of a cloud print come from its command, and from the reports after a restart", async () => {
    const p = printer();
    p.pendingIdentity = { jobName: "PenroseTriangle", md5: "0d1b4dabe3b479109f4e64cd875daff7", modelId: null, profileId: null, plate: 1 };
    await handlePrintStateChange(p, { gcode_state: "PREPARE", subtask_name: "PenroseTriangle", model_id: "US911eafb6a009f0", profile_id: "801288487", print_type: "cloud" });
    assert.deepEqual(runningPrint(p).identity, { jobName: "PenroseTriangle", md5: "0d1b4dabe3b479109f4e64cd875daff7", modelId: "US911eafb6a009f0", profileId: "801288487", plate: 1 });
    forgetPrintStart("SERIAL");
});

test("a print started on the screen does not take the ids the last cloud print left in the reports", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FINISH", subtask_name: "Swatch Board", model_id: "US910fc6c0b4f723", profile_id: "728244489", print_type: "cloud" });
    // Seen on a P2S on 2026-09-26: the next job, started on the screen, went on
    // reporting the swatch board's model_id
    await handlePrintStateChange(p, { gcode_state: "PREPARE", subtask_name: "Honeycomb Organizer by Craftop", model_id: "US910fc6c0b4f723", profile_id: "", print_type: "local" });
    assert.equal(runningPrint(p).identity, null);
    forgetPrintStart("SERIAL");
});

test("the first report after the service came up takes the running print's layer", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 7 });
    assert.equal(p.currentLayerNum, 7);
    forgetPrintStart("SERIAL");
});

// A P1S sends a full report every few minutes and only what changed in between.
// The deltas below are taken from the raw trace of 2026-09-09: layer_num on its
// own, print_error three seconds ahead of FAILED, and a job start without
// subtask_name because the name had not changed.

test("a delta with only the layer is read as a report of the running state", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "IDLE" });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0 });

    const delta = deltaAsReport(p, { layer_num: 5 });
    assert.equal(delta.gcode_state, "RUNNING");
    await handlePrintStateChange(p, delta);
    assert.equal(p.currentLayerNum, 5);

    // A full report with a stale layer next to it does not pull it back
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 4 });
    assert.equal(p.currentLayerNum, 5);

    await handlePrintStateChange(p, { gcode_state: "FAILED", subtask_name: "Cube" });
    assert.equal(p.lastPrintSummary.layerNum, 5);
    forgetPrintStart("SERIAL");
});

test("a delta ahead of the first report with a state is dropped, so the restart rule still holds", async () => {
    const p = printer();
    assert.equal(deltaAsReport(p, { layer_num: 7 }), null);
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 7 });
    assert.equal(p.currentLayerNum, 7);
    forgetPrintStart("SERIAL");
});

test("a delta that says nothing about the print is dropped", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "IDLE" });
    assert.equal(deltaAsReport(p, { bed_temper: 40, wifi_signal: "-48dBm" }), null);
    assert.equal(deltaAsReport(p, { gcode_state: "RUNNING" }), null);
    assert.equal(deltaAsReport(p, null), null);
});

test("the error a P1S names in a delta before FAILED lands in the summary", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "IDLE", print_error: 0 });
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0, print_error: 0 });
    await handlePrintStateChange(p, deltaAsReport(p, { print_error: 50348044 }));
    await handlePrintStateChange(p, { gcode_state: "FAILED" });
    assert.match(p.lastPrintSummary.printError, /^Printer error 50348044/);
    forgetPrintStart("SERIAL");
});

test("a delta without the error fields does not clear the error the print started with", async () => {
    const p = printer();
    await handlePrintStateChange(p, { gcode_state: "FAILED", print_error: 50348044 });
    // The report that starts the next print still carries the old complaint
    await handlePrintStateChange(p, { gcode_state: "RUNNING", subtask_name: "Cube", layer_num: 0, print_error: 50348044 });
    await handlePrintStateChange(p, deltaAsReport(p, { layer_num: 1 }));
    assert.equal(p.lastPrintError, null);
    // Only a report that names the field again moves the printer on
    await handlePrintStateChange(p, deltaAsReport(p, { print_error: 0 }));
    await handlePrintStateChange(p, deltaAsReport(p, { print_error: 50348044 }));
    assert.match(p.lastPrintError, /^Printer error 50348044/);
    forgetPrintStart("SERIAL");
});

test("a job with the same name as the last one takes its name from the Studio echo", async () => {
    // After a restart nothing remembers the last name, and the P1S leaves
    // subtask_name out of the report that starts the job
    const p = printer({ currentJobName: null, pendingMapping: { jobName: "Würfel", slots: ["A1", "A3", "A4"] } });
    await handlePrintStateChange(p, { gcode_state: "FAILED", subtask_name: "Würfel" });
    await handlePrintStateChange(p, { gcode_state: "PREPARE", gcode_file: "Würfel.3mf" });
    assert.equal(p.currentJobName, "Würfel");
    assert.equal(p.currentGcodeFile, "Würfel.3mf");
    assert.deepEqual(p.currentMapping, ["A1", "A3", "A4"]);
    forgetPrintStart("SERIAL");
});

// The AMS refill of 2026-10-07 on a P2S, as the print handler sees it: filament
// 3 sliced for A3, A3 reporting empty from layer 5 while the tube printed on,
// print.mapping moving to A4 at layer 88. See test/refill.test.js.
const REFILL_SLOT = { tray_info_idx: "GFA01", tray_type: "PLA", tray_color: "FFFFFFFF", cols: ["FFFFFFFF"] };
const loadedA3 = { amsId: "A3", slot: REFILL_SLOT, existingSpool: { id: 5, remaining_weight: 10, filament: { name: "PLA Matte Jade White", vendor: { name: "Bambu Lab" } } }, connectedViaTag: true };
const loadedA4 = { amsId: "A4", slot: REFILL_SLOT, existingSpool: { id: 6 }, connectedViaTag: true };
const emptyA3 = { amsId: "A3", slot: {} };
const running = (layer, slot) => ({ gcode_state: "RUNNING", subtask_name: "Würfel", layer_num: layer, mapping: [0xFFFF, 0xFFFF, slot] });
const sliceInfo = { filaments: [], totalLayers: 235, rangesByFilamentIdx: {}, presets: [] };

/** A print up to A3 running out, by the process that saw it begin. */
async function printUntilRunout() {
    const p = printer({ spoolData: [] });
    await handlePrintStateChange(p, { gcode_state: "PREPARE", subtask_name: "Würfel", layer_num: 0, mapping: [0xFFFF, 0xFFFF, 0x0002] });
    p.currentSliceInfo = sliceInfo;
    p.spoolData = [loadedA3, loadedA4];
    await handlePrintStateChange(p, running(1, 0x0002));
    p.spoolData = [emptyA3, loadedA4];
    await handlePrintStateChange(p, running(5, 0x0002));
    return p;
}

/** The process after a restart, its first report at the given layer and slot. */
async function afterRestart(layer, slot) {
    resetPrintStateForTests();
    const p = printer({ spoolData: [emptyA3, loadedA4], currentSliceInfo: sliceInfo });
    await handlePrintStateChange(p, running(layer, slot));
    return p;
}

test("the handler notes a refill and the spool the emptied slot held", async () => {
    const p = await printUntilRunout();
    assert.deepEqual(p.refills, []);

    await handlePrintStateChange(p, running(88, 0x0003));
    assert.deepEqual(p.currentMapping, [null, null, "A4"]);
    assert.deepEqual(p.refills, [{ index: 2, from: "A3", to: "A4", layer: 88 }]);
    assert.equal(p.printSlotSpools.A3.id, 5);
    forgetPrintStart("SERIAL");
});

test("a restart after the runout keeps the spool the emptied slot held", async () => {
    await printUntilRunout();
    const stored = JSON.parse(fs.readFileSync(printStatePath, "utf-8")).printers.SERIAL.slots;
    assert.deepEqual(stored.mapping, [null, null, "A3"]);
    assert.equal(stored.slotSpools.A3.id, 5);
    // Only what the dashboard names the spool by is written
    assert.deepEqual(Object.keys(stored.slotSpools.A3.spool).sort(), ["filament", "id", "initial_weight", "remaining_weight"]);

    const p = await afterRestart(40, 0x0002);
    assert.equal(p.printSlotSpools.A3.id, 5);
    assert.equal(p.printSlotSpools.A3.spool.filament.vendor.name, "Bambu Lab");
    assert.deepEqual(p.refills, []);

    // The switch is then seen as it happens
    await handlePrintStateChange(p, running(88, 0x0003));
    assert.deepEqual(p.refills, [{ index: 2, from: "A3", to: "A4", layer: 88 }]);
    forgetPrintStart("SERIAL");
});

test("a restart after the refill keeps the refill", async () => {
    const before = await printUntilRunout();
    await handlePrintStateChange(before, running(88, 0x0003));

    const p = await afterRestart(150, 0x0003);
    assert.deepEqual(p.refills, [{ index: 2, from: "A3", to: "A4", layer: 88 }]);
    assert.deepEqual(p.currentMapping, [null, null, "A4"]);
    assert.equal(p.printSlotSpools.A3.id, 5);
    forgetPrintStart("SERIAL");
});

test("a refill while the service was down is taken at the first layer seen after it", async () => {
    await printUntilRunout();

    // Down from layer 5 to layer 95, the printer switched at 88 meanwhile
    const p = await afterRestart(95, 0x0003);
    assert.deepEqual(p.refills, [{ index: 2, from: "A3", to: "A4", layer: 95 }]);
    assert.equal(p.mappingRestored, false);
    forgetPrintStart("SERIAL");
});

test("the slots of another job are not taken over", async () => {
    await printUntilRunout();
    resetPrintStateForTests();
    assert.equal(recallPrintSlots("SERIAL", "Something else"), null);
    forgetPrintStart("SERIAL");
    assert.equal(recallPrintSlots("SERIAL", "Würfel"), null);
});

test("stored slots that lost their shape are dropped, not trusted", () => {
    rememberPrintStart("SERIAL", "Würfel", Date.now() - 1000);
    rememberPrintSlots("SERIAL", {
        mapping: [null, 3, "A4"],
        refills: [{ index: 2, from: "A3", to: "A4", layer: 88 }, { index: "2", from: "A3" }],
        slotSpools: { A3: { amsId: "A3", id: 5 }, A4: { amsId: "B1", id: 6 }, A1: { amsId: "A1" } },
    });
    resetPrintStateForTests();
    assert.deepEqual(recallPrintSlots("SERIAL", "Würfel"), {
        mapping: null,
        refills: [{ index: 2, from: "A3", to: "A4", layer: 88 }],
        slotSpools: { A3: { amsId: "A3", id: 5 } },
    });

    // An entry written before the slots existed
    rememberPrintStart("SERIAL", "Würfel", Date.now() - 1000);
    resetPrintStateForTests();
    assert.equal(recallPrintSlots("SERIAL", "Würfel"), null);
    forgetPrintStart("SERIAL");
});
