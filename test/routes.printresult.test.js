import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { startTestApp, call } from "./helpers/app.js";

// Everything the print card above the slot tables says, over HTTP.
//
// The first half is a print that has ended: it is shown with its booking
// label, it clears itself after PRINT_RESET_MINUTES or when somebody says so,
// and its summary stays readable afterwards. The second half is a print that
// is running: when it started, when it is expected to end, and what the
// printer is busy with.
//
// The one thing worth a test of its own is that clearing survives the printer
// repeating itself. A P2S sends its terminal `gcode_state` in every report for
// as long as it sits there, so a cleared result that were derived from the
// state alone would come straight back on the next report.

let app;
let printer;
let sliceInfo;
let settings;

const SERIAL = "01P00A000000009";

const loadedSlot = (amsId, { id, idx, type, color }) => ({
    amsId,
    slotState: "Loaded (Bambu Lab)",
    connectedViaTag: true,
    connectedViaMapping: false,
    existingSpool: { id, remaining_weight: 500, initial_weight: 1000, filament: { name: `spool ${id}` } },
    slot: {
        tray_uuid: `uuid-${amsId}`,
        tray_type: type,
        tray_info_idx: idx,
        tray_color: color,
        cols: [color],
        tray_weight: "1000",
        remain: 50,
    },
});

before(async () => {
    app = await startTestApp({
        seedPrinters: [{ id: SERIAL, code: "12345678", ip: "127.0.0.1", name: "Test Printer" }],
    });

    const { parseSliceInfo } = await import("../src/gcode.js");
    const { printers } = await import("../src/printers.js");
    ({ settings } = await import("../src/settings.js"));

    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "four_colours.config");
    sliceInfo = parseSliceInfo(fs.readFileSync(fixture, "utf-8"));

    printer = printers.find(p => p.id === SERIAL);
});

after(async () => { await app.close(); });

/** A printer sitting on a finished print, the way the MQTT handler leaves it. */
beforeEach(() => {
    const f0 = sliceInfo.filaments[0];

    printer.currentJobName        = "four colours";
    printer.currentGcodeState     = "FINISH";
    printer.currentLayerNum       = 40;
    printer.currentSliceInfo      = sliceInfo;
    printer.currentMapping        = null;
    printer.consumptionBooked     = true;
    printer.printResultDismissed  = false;
    printer.printResetAt          = Date.now() + 10 * 60_000;
    printer.printStartedAt        = Date.now() - 90_000;
    printer.lastPrintSummary      = {
        state: "FINISH",
        jobName: "four colours",
        endedAt: Date.now(),
        startedAt: printer.printStartedAt,
        durationMs: 90_000,
        layerNum: 40,
        totalLayers: sliceInfo.totalLayers,
        printError: null,
        note: null,
        rows: [{ amsId: "A1", type: "PLA", color: "#FFFFFF", grams: 12.5, status: "booked", spoolId: 101 }],
    };
    printer.spoolData = [
        loadedSlot("A1", { id: 101, idx: f0.tray_info_idx, type: "PLA", color: f0.color.replace("#", "") }),
    ];
});

test("a finished print is reported with its booking label and its deadline", async () => {
    const { status, body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(status, 200);
    assert.equal(body.gcodeState, "FINISH");
    assert.equal(body.jobName, "four colours");
    assert.equal(body.consumptionBooked, true);
    assert.equal(body.printResultCleared, false);
    assert.ok(body.printResetAt > Date.now());
    // The figures are still on the card, which is what the columns show.
    assert.ok(body.fullConsumption);
});

test("clearing it by hand empties the card but keeps the summary", async () => {
    const cleared = await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");
    assert.equal(cleared.status, 200);

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(body.gcodeState, "IDLE");
    assert.equal(body.jobName, null);
    assert.equal(body.consumptionBooked, false);
    assert.equal(body.printResultCleared, true);
    // The "Needed" and "After print" columns read these two, so both have to be
    // gone or the finished print keeps standing in the table.
    assert.equal(body.fullConsumption, null);
    assert.equal(body.consumption, null);
    assert.equal(body.sliceInfo, null);

    // The dialog behind the button is still there.
    assert.equal(body.lastPrintSummary.jobName, "four colours");
    assert.equal(body.lastPrintSummary.rows.length, 1);
});

test("a cleared result stays cleared when the printer repeats FINISH", async () => {
    await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");

    // What every further report does: it sets the state again, unchanged.
    printer.currentGcodeState = "FINISH";

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(body.gcodeState, "IDLE");
    assert.equal(body.printResultCleared, true);
});

test("the deadline clears the result without anybody pressing anything", async () => {
    printer.printResetAt = Date.now() - 1;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(body.gcodeState, "IDLE");
    assert.equal(body.printResultCleared, true);
    assert.equal(body.lastPrintSummary.jobName, "four colours");
});

test("without a deadline the result waits to be cleared by hand", async () => {
    // What PRINT_RESET_MINUTES of 0 leaves behind
    printer.printResetAt = null;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(body.gcodeState, "FINISH");
    assert.equal(body.printResultCleared, false);
    assert.equal(body.printResetAt, null);
});

test("a running print cannot be cleared", async () => {
    printer.currentGcodeState = "RUNNING";
    printer.consumptionBooked = false;

    const { status, body } = await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");

    assert.equal(status, 409);
    assert.match(body.error, /is printing/);
});

test("the manual FTPS test is not affected by a cleared result", async () => {
    await call(`${app.url}/api/print/${SERIAL}/clear`, "POST");

    // ?job= names its own file and does not read the printer's state, so it has
    // to keep reaching the download rather than being answered as idle. There
    // is no FTPS server here, so the error is the proof it tried.
    const { body } = await call(`${app.url}/api/print/${SERIAL}?job=whatever`);
    assert.match(body.error, /FTPS fetch failed/);
});

test("PRINT_RESET_MINUTES keeps 0 and clamps what is out of range", async () => {
    const { coerceSetting } = await import("../src/settings.js");

    // 0 is a value, not an empty field: it is what "never clear it on its own"
    // is stored as, so it has to survive coercion rather than fall back to the
    // default of 10.
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "0"), { value: 0 });
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "10"), { value: 10 });
    // Integers are clamped rather than refused here, like every other one in
    // the schema. Both ends land somewhere usable: a negative value becomes
    // "never", and an absurd one the 4 hour maximum.
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "-1"), { value: 0 });
    assert.deepEqual(coerceSetting("PRINT_RESET_MINUTES", "9999"), { value: 240 });
    assert.equal(settings.PRINT_RESET_MINUTES, 10);
});

test("an unbooked filament is told apart from one no slot carried", async () => {
    const { unbookedReason } = await import("../src/mqtt.js");

    // In the plate, and a slot ran it, but nothing links that slot to Spoolman.
    // This is the one a user can fix, so it says how.
    const inSlot = unbookedReason({ amsId: "A4" });
    assert.match(inSlot, /sliced file/);
    assert.match(inSlot, /A4 printed it/);
    assert.match(inSlot, /Assign it in the Web UI/);

    // In the plate and nothing on the printer carried it: the dashboard's
    // "required but not loaded". Nothing to assign, so it does not ask.
    const noSlot = unbookedReason({ amsId: null });
    assert.match(noSlot, /sliced file/);
    assert.match(noSlot, /no slot of the printer carried it/);
    assert.equal(/Assign it in the Web UI/.test(noSlot), false);
});

test("a printer named slot names the filament, an estimated one does not", async () => {
    const { slotFilament } = await import("../src/mqtt.js");

    const filament = { name: "Black", material: "PLA Basic", vendor: { name: "Bambu Lab" } };
    const withSlot = { spoolData: [{ amsId: "A4", existingSpool: { id: 17, filament } }] };

    // print.mapping named the slot, so the sliced file and the printer agree
    // and the spool in it is the one that printed this filament.
    assert.equal(slotFilament(withSlot, { amsId: "A4", amsIdFromPrinter: true }), filament);

    // The slot is orderedAmsSlots() reading the slicer's list order, which is
    // the guess matchConsumption() refuses to book on without confirming it.
    // Naming a spool off it would claim a slot nobody established.
    assert.equal(slotFilament(withSlot, { amsId: "A4", amsIdFromPrinter: false }), null);

    // No slot at all, and a slot holding nothing this service knows.
    assert.equal(slotFilament(withSlot, { amsId: null, amsIdFromPrinter: true }), null);
    assert.equal(slotFilament(withSlot, { amsId: "A1", amsIdFromPrinter: true }), null);
    assert.equal(slotFilament({}, { amsId: "A4", amsIdFromPrinter: true }), null);
});

test("an error the printer names late still reaches the summary", async () => {
    const { printErrorText } = await import("../src/mqtt.js");

    // Nothing wrong: a P2S sends 0 in both fields and "0", not "", as the reason.
    assert.equal(printErrorText({ print_error: 0, mc_print_error_code: "0", fail_reason: "0" }), null);
    assert.equal(printErrorText({}), null);

    // The code a hand stopped print reported, measured on a P2S.
    // A code the catalogue knows carries its sentence, one it does not stays
    // the bare number
    assert.equal(printErrorText({ print_error: 50348044 }), "Printer error 50348044: The task was canceled.");
    assert.equal(printErrorText({ print_error: 0, fail_reason: "3" }), "Fail reason 3");
    assert.equal(printErrorText({ print_error: 7, fail_reason: "3" }), "Printer error 7, fail reason 3");
    // Both fields carrying the same code, which is how a P2S reports a stop,
    // are said once
    assert.equal(printErrorText({ print_error: 50348044, fail_reason: "50348044" }), "Printer error 50348044: The task was canceled.");
    assert.equal(printErrorText({ print_error: 0, fail_reason: "50348044" }), "Fail reason 50348044: The task was canceled.");

});

test("the summary takes an error that arrives after the print has ended", async () => {
    const { handlePrintStateChange } = await import("../src/mqtt.js");

    // The three reports a P2S sent when a print was stopped by hand, in order.
    // The summary is built on the first, which still carries no code at all.
    const target = {
        name: "Test Printer",
        logFilePath: "/dev/null",
        currentGcodeState: "RUNNING",
        currentJobName: "Cube",
        currentLayerNum: 18,
        currentSliceInfo: null,   // nothing to book, which this test is not about
        sliceFetchDone: true,     // and nothing to fetch over FTPS either
        consumptionBooked: false,
        printStartedAt: Date.now() - 60_000,
        lastPrintSummary: null,
        lastPrintError: null,
    };

    await handlePrintStateChange(target, { gcode_state: "FAILED", print_error: 0, fail_reason: "0" });
    assert.equal(target.lastPrintSummary.state, "FAILED");
    assert.equal(target.lastPrintSummary.printError, null);

    await handlePrintStateChange(target, { gcode_state: "FAILED", print_error: 50348044 });
    assert.equal(target.lastPrintSummary.printError, "Printer error 50348044: The task was canceled.");

    // And the report after that, which has it back at 0, must not erase it.
    await handlePrintStateChange(target, { gcode_state: "FAILED", print_error: 0, fail_reason: "0" });
    assert.equal(target.lastPrintSummary.printError, "Printer error 50348044: The task was canceled.");
});

test("the previous print's complaint does not follow the next one into its summary", async () => {
    const { handlePrintStateChange } = await import("../src/mqtt.js");

    // The reports a P2S really sent, read out of the raw MQTT capture. It does
    // not clear fail_reason when the state changes: the report that first said
    // RUNNING still carried the code of a print that had failed two days
    // earlier, and only the next report, five seconds later, had it back at 0.
    const target = {
        name: "Test Printer",
        logFilePath: "/dev/null",
        currentGcodeState: "FAILED",
        currentJobName: null,
        currentLayerNum: 0,
        currentSliceInfo: null,
        sliceFetchDone: true,
        consumptionBooked: false,
        printStartedAt: null,
        lastPrintSummary: null,
        lastPrintError: null,
        staleErrorText: null,
    };

    // Sitting on the previous print's result, which is where a printer waits
    await handlePrintStateChange(target, { gcode_state: "FAILED", fail_reason: "50348044", print_error: 0 });

    // The new print starts, and the printer is still repeating the old code
    await handlePrintStateChange(target, { gcode_state: "RUNNING", fail_reason: "50348044", print_error: 0 });
    assert.equal(target.lastPrintError, null, "the old code must not be collected into the new print");

    // The printer catches up
    await handlePrintStateChange(target, { gcode_state: "RUNNING", fail_reason: "0", print_error: 0 });
    await handlePrintStateChange(target, { gcode_state: "FINISH", fail_reason: "0", print_error: 0 });

    assert.equal(target.lastPrintSummary.state, "FINISH");
    assert.equal(target.lastPrintSummary.printError, null, "a clean FINISH has no error");
});

test("a real failure inside the print is still collected once the old one cleared", async () => {
    const { handlePrintStateChange } = await import("../src/mqtt.js");

    // The hold-back must not swallow a genuine error. It lasts only while the
    // printer keeps repeating the exact complaint it started with.
    const target = {
        name: "Test Printer",
        logFilePath: "/dev/null",
        currentGcodeState: "FAILED",
        currentJobName: null,
        currentLayerNum: 0,
        currentSliceInfo: null,
        sliceFetchDone: true,
        consumptionBooked: false,
        printStartedAt: null,
        lastPrintSummary: null,
        lastPrintError: null,
        staleErrorText: null,
    };

    await handlePrintStateChange(target, { gcode_state: "FAILED", fail_reason: "50348044", print_error: 0 });
    await handlePrintStateChange(target, { gcode_state: "RUNNING", fail_reason: "50348044", print_error: 0 });
    await handlePrintStateChange(target, { gcode_state: "RUNNING", fail_reason: "0", print_error: 0 });

    // Something goes wrong in this print, and it happens to be the same code
    await handlePrintStateChange(target, { gcode_state: "RUNNING", fail_reason: "50348044", print_error: 0 });
    assert.equal(target.lastPrintError, "Fail reason 50348044: The task was canceled.");

    await handlePrintStateChange(target, { gcode_state: "FAILED", fail_reason: "0", print_error: 0 });
    assert.equal(target.lastPrintSummary.printError, "Fail reason 50348044: The task was canceled.");
});

test("a prompt the printer clears while the print goes on is not the print's result", async () => {
    const { handlePrintStateChange } = await import("../src/mqtt.js");

    // A spool swapped on the external holder, as a P2S reported it on
    // 2026-10-08 (issue #233): three prompts, each cleared, then a FINISH.
    const target = {
        name: "Test Printer",
        logFilePath: "/dev/null",
        currentGcodeState: "RUNNING",
        currentJobName: "Würfel",
        currentLayerNum: 9,
        currentSliceInfo: null,
        sliceFetchDone: true,
        consumptionBooked: false,
        printStartedAt: Date.now() - 60_000,
        lastPrintSummary: null,
        lastPrintError: null,
        staleErrorText: null,
    };

    for (const code of [134201392, 134201350]) {
        await handlePrintStateChange(target, { gcode_state: "RUNNING", print_error: code, fail_reason: "0" });
        await handlePrintStateChange(target, { gcode_state: "RUNNING", print_error: 0, fail_reason: "0" });
    }
    await handlePrintStateChange(target, { gcode_state: "PAUSE", print_error: 134184967, fail_reason: "0" });
    await handlePrintStateChange(target, { gcode_state: "PAUSE", print_error: 0, fail_reason: "0" });
    await handlePrintStateChange(target, { gcode_state: "RUNNING", print_error: 0, fail_reason: "0" });
    await handlePrintStateChange(target, { gcode_state: "FINISH", print_error: 0, fail_reason: "0" });

    assert.equal(target.lastPrintSummary.state, "FINISH");
    assert.equal(target.lastPrintSummary.printError, null);
    assert.equal(target.lastPrintSummary.printErrorDetails, null);
});

// ---------------------------------------------------------------------------
// What the card shows while a print is running: when it started, when it is
// expected to end, and what the printer is busy with.
// ---------------------------------------------------------------------------

test("a terminal state nothing is known about reads as idle, not as a result", async () => {
    const { printResultCleared } = await import("../src/mqtt.js");

    // What a service started after a print ended is handed: the printer repeats
    // its last gcode_state for as long as it sits on it, and this process has no
    // job name, no summary and no booking to go with it. The card showed a green
    // FINISH badge next to "No active print", two answers to the same question.
    assert.equal(printResultCleared({
        currentGcodeState: "FINISH",
        currentJobName: null,
        lastPrintSummary: null,
        printResetAt: null,
    }), true);

    // A result this process really produced is kept, which is the whole point of
    // PRINT_RESET_MINUTES being 0: it stays until somebody clears it.
    assert.equal(printResultCleared({
        currentGcodeState: "FINISH",
        currentJobName: "Cube",
        lastPrintSummary: { state: "FINISH" },
        printResetAt: null,
    }), false);

    // An active print is not a result and must never be cleared, even when the
    // printer left the job name empty
    assert.equal(printResultCleared({
        currentGcodeState: "RUNNING",
        currentJobName: null,
        lastPrintSummary: null,
        printResetAt: null,
    }), false);
});

test("a running print reports its start, its estimate and its stage", async () => {
    printer.currentGcodeState        = "RUNNING";
    printer.consumptionBooked        = false;
    printer.printResetAt             = null;
    printer.printStartedAt           = Date.now() - 5 * 60_000;
    printer.currentStage             = 2;      // heatbed preheating
    printer.currentRemainingMinutes  = 42;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(body.startedAt, printer.printStartedAt);
    assert.ok(body.elapsedMs >= 5 * 60_000);
    assert.equal(body.remainingMinutes, 42);
    assert.ok(body.estimatedEndAt > Date.now());
    // The printer's estimate is whole minutes, so the moment carries none finer.
    assert.equal(body.estimatedEndAt % 60_000, 0);
    assert.equal(body.stage, "Heatbed preheating");
    assert.equal(body.preparing, true);
});

test("a paused print reports no expected end, only the work left", async () => {
    printer.currentGcodeState       = "PAUSE";
    printer.consumptionBooked       = false;
    printer.printResetAt            = null;
    printer.printStartedAt          = Date.now() - 5 * 60_000;
    printer.currentRemainingMinutes = 12;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);

    // PAUSE is an active state, so the print is still on the card and still
    // counting: only the moment it would end is gone.
    assert.equal(body.gcodeState, "PAUSE");
    assert.ok(body.startedAt);
    assert.ok(body.elapsedMs > 0);
    assert.equal(body.remainingMinutes, 12);
    // Adding what the job still needs to the clock would name an end that moves
    // further away for as long as the pause lasts.
    assert.equal(body.estimatedEndAt, null);
});

test("a finished print reports no live progress at all", async () => {
    // The printer keeps sending the last values of the job it just finished.
    // Reporting them would put an estimated end in the past on the card.
    printer.currentStage            = 2;
    printer.currentRemainingMinutes = 42;

    const { body } = await call(`${app.url}/api/print/${SERIAL}`);

    assert.equal(body.gcodeState, "FINISH");
    assert.equal(body.startedAt, null);
    assert.equal(body.estimatedEndAt, null);
    assert.equal(body.stage, null);
    assert.equal(body.preparing, false);
});

test("a remaining time of zero is an estimate, a missing one is not", async () => {
    printer.currentGcodeState       = "RUNNING";
    printer.consumptionBooked       = false;
    printer.currentRemainingMinutes = 0;

    const zero = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(zero.body.remainingMinutes, 0);
    assert.ok(zero.body.estimatedEndAt);

    printer.currentRemainingMinutes = null;
    const missing = await call(`${app.url}/api/print/${SERIAL}`);
    assert.equal(missing.body.remainingMinutes, null);
    assert.equal(missing.body.estimatedEndAt, null);
});

test("a named stage reads as its name, an unnamed one as its number", async () => {
    const { printStageName, isPreparingStage } = await import("../src/gcode.js");

    assert.equal(printStageName(2), "Heatbed preheating");
    assert.equal(printStageName(14), "Cleaning nozzle tip");
    // The two a P2S announces on an ordinary plate. They were shown as their
    // number until the machine said what they are.
    assert.equal(printStageName(51), "Printing calibration lines");
    assert.equal(printStageName(54), "Heating heatbed to target");
    // The range ha-bambulab has codes for, in this project's wording
    assert.equal(printStageName(36), "Checking absolute accuracy before calibration");
    assert.equal(printStageName(52), "Checking material");
    assert.equal(printStageName(77), "Preparing AMS");
    // Still no guessing for the ones nothing has named.
    assert.equal(printStageName(78), "Stage 78");
    assert.equal(printStageName(99), "Stage 99");
    // Neither end names a stage. -1 is what the printer sends outside a print,
    // and 0 is it laying down filament, which the state badge already says: a
    // P2S sits on 0 for the whole body of a print, so naming it would put
    // "RUNNING" and "Printing" side by side for almost the entire job.
    assert.equal(printStageName(-1), null);
    assert.equal(printStageName(0), null);
    assert.equal(printStageName(null), null);
    // A P1 says "no stage" as 255, seen in test/fixtures/reports/p1p-no-ams.json
    assert.equal(printStageName(255), null);
    assert.equal(isPreparingStage(255), false);
    // Checks, calibrations and heating are preparation; cooling is not
    assert.equal(isPreparingStage(47), true);
    assert.equal(isPreparingStage(77), true);
    assert.equal(isPreparingStage(50), false);
    assert.equal(isPreparingStage(69), false);

    assert.equal(isPreparingStage(2), true);
    assert.equal(isPreparingStage(13), true);
    // Both come before the model: the calibration lines are laid down next to
    // the plate, and a bed still coming up to temperature has not started.
    assert.equal(isPreparingStage(51), true);
    assert.equal(isPreparingStage(54), true);
    // Changing, unloading and loading filament before the first layer
    assert.equal(isPreparingStage(4), true);
    assert.equal(isPreparingStage(22), true);
    assert.equal(isPreparingStage(24), true);
    // A pause is its own state the printer already reports as PAUSE.
    assert.equal(isPreparingStage(16), false);
});
