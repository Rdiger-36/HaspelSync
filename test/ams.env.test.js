import test from "node:test";
import assert from "node:assert/strict";

import { extractAmsEnvironment } from "../src/ams.js";

// The four unit shapes this service has seen, copied from real reports rather
// than invented: an AMS 2 Pro on a P2S, the AMS HT from issue #40, the original
// AMS from issue #7 and the AMS Lite from issue #4. They differ in which fields
// exist at all, which is the whole reason extractAmsEnvironment() exists.
const AMS_2_PRO = {
    id: "0",
    humidity: "1",
    humidity_raw: "47",
    temp: "24.5",
    dry_time: 0,
    dry_sf_reason: [],
    dry_setting: { dry_duration: -1, dry_filament: "", dry_temperature: -1 },
};

const AMS_HT = {
    id: "128",
    humidity: "0",
    humidity_raw: "24",
    info: "2004",
    temp: "26.7",
    dry_time: 0,
};

const AMS_ORIGINAL = { id: "0", humidity: "5", temp: "0.0" };

// Byte for byte the same two fields as the original AMS, although the AMS Lite
// has no sensor of any kind. The level it reports was 5 on the one that was
// logged, and the temperature is the same "0.0" placeholder.
const AMS_LITE = { id: "0", humidity: "5", temp: "0.0" };

test("an AMS 2 Pro reports humidity, percentage, temperature and a dryer", () => {
    const [unit] = extractAmsEnvironment([AMS_2_PRO]);

    assert.equal(unit.amsId, "A");
    assert.equal(unit.humidity, 1);
    assert.equal(unit.humidityPercent, 47);
    assert.equal(unit.temperature, 24.5);
    assert.deepEqual(unit.drying, {
        active: false,
        status: null,
        phase: null,
        remainingMinutes: null,
        targetTemp: null,
        durationHours: null,
        filament: null,
    });
});

test("a running drying cycle carries its target and the minutes left", () => {
    const [unit] = extractAmsEnvironment([{
        ...AMS_2_PRO,
        dry_time: 214,
        dry_setting: { dry_duration: 8, dry_filament: "PLA", dry_temperature: 55 },
    }]);

    assert.deepEqual(unit.drying, {
        active: true,
        status: null,
        phase: null,
        remainingMinutes: 214,
        targetTemp: 55,
        durationHours: 8,
        filament: "PLA",
    });
});

test("an AMS HT reporting level 0 keeps its percentage", () => {
    // Observed on real hardware: the level is 0 while the sensor reads 24%, so
    // 0 is "no level yet" rather than a sixth step below the driest one.
    const [unit] = extractAmsEnvironment([AMS_HT]);

    assert.equal(unit.amsId, "HT-A");
    assert.equal(unit.humidity, null);
    assert.equal(unit.humidityPercent, 24);
    assert.equal(unit.temperature, 26.7);
});

test("the original AMS reports a level, no percentage and no usable temperature", () => {
    // "0.0" is the absence of a sensor, not a freezing AMS, and the unit has no
    // dryer at all, so it must not be offered one.
    const [unit] = extractAmsEnvironment([AMS_ORIGINAL]);

    assert.equal(unit.humidity, 5);
    assert.equal(unit.humidityPercent, null);
    assert.equal(unit.temperature, null);
    assert.equal(unit.drying, null);
});

test("an AMS Lite is not told apart from the original AMS", () => {
    // It has no sensor at all and still reports a level, so there is nothing to
    // detect it by. Showing the level it sends is the only honest option; the
    // header says where the number comes from.
    assert.deepEqual(extractAmsEnvironment([AMS_LITE]), extractAmsEnvironment([AMS_ORIGINAL]));
});

test("a unit without any reading is left out", () => {
    // The external spool holder passes through the same list and reports no
    // environment data. It must not produce an empty header.
    assert.deepEqual(extractAmsEnvironment([{ id: "0", tray: [] }]), []);
    assert.deepEqual(extractAmsEnvironment([{ id: "255", humidity: "", temp: "" }]), []);
});

test("an empty reading is not read as zero", () => {
    const [unit] = extractAmsEnvironment([{ id: "0", humidity: "", humidity_raw: "", temp: "", dry_time: 0 }]);

    assert.equal(unit.humidity, null);
    assert.equal(unit.humidityPercent, null);
    assert.equal(unit.temperature, null);
    assert.equal(unit.drying.active, false);
});

test("every unit keeps its own label", () => {
    const units = extractAmsEnvironment([AMS_2_PRO, { ...AMS_2_PRO, id: "1" }, AMS_HT]);
    assert.deepEqual(units.map(u => u.amsId), ["A", "B", "HT-A"]);
});

test("a payload that is not a list yields nothing", () => {
    assert.deepEqual(extractAmsEnvironment(undefined), []);
    assert.deepEqual(extractAmsEnvironment(null), []);
});

test("the state of a drying cycle is read from the unit's info, as Bambu Studio reads it", () => {
    // The AMS 2 Pro of the X1C report in test/fixtures/reports, the one unit
    // there caught drying: info "142023", bits 4 to 7 are 2
    const [drying] = extractAmsEnvironment([{ dry_time: 583, humidity: "4", humidity_raw: "9", id: "2", info: "142023", temp: "65.0" }]);
    assert.equal(drying.drying.status, "drying");
    assert.equal(drying.drying.active, true);

    // Cooling down after the cycle, with the countdown at 0: still a cycle
    const [cooling] = extractAmsEnvironment([{ ...AMS_2_PRO, dry_time: 0, info: "1033" }]);
    assert.equal(cooling.drying.status, "cooling");
    assert.equal(cooling.drying.active, true);

    // At rest
    const [idle] = extractAmsEnvironment([{ ...AMS_2_PRO, dry_time: 0, info: "1003" }]);
    assert.equal(idle.drying.status, "off");
    assert.equal(idle.drying.active, false);
});

test("a countdown the info calls off still counts, the bits then say nothing", () => {
    // Studio reads the bits only on printers that dry from afar; a printer
    // that leaves them at 0 while counting down keeps showing its cycle
    const [unit] = extractAmsEnvironment([{ ...AMS_2_PRO, dry_time: 30, info: "1003" }]);
    assert.equal(unit.drying.active, true);
    assert.equal(unit.drying.status, null);
});
