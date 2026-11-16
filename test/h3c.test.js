import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convertAMSandSlot, decodePrintMapping, activeSlotFromReport, externalSlotLabel, isExternalSlot } from "../src/utils.js";
import { amsModelsFromVersion, processData, slotIsOccupied, extractAmsEnvironment } from "../src/ams.js";
import { externalSpoolUnits } from "../src/mqtt.js";
import { orderedAmsSlots } from "../src/gcode.js";
import { slotUnit, slotNumber, groupSlotsByUnit, isSingleSlotLabel } from "../public/shared.js";

/**
 * The H3C of issue #262: a nine tool changer whose AMS 3H is one unit 32 with
 * nine slots, and which reports one holder per tool as `vir_slot` 247 to 255.
 * The report is test/fixtures/reports/h3c.json, a print running from slot 2 of
 * the unit, with Bambu Lab spools in slots 0 to 3.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reports", "h3c.json");
const print = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).pushall.print;

test("the nine slots of the AMS 3H are E1 to E9", () => {
    const [unit] = print.ams.ams;
    assert.equal(unit.id, "32");
    assert.deepEqual(unit.tray.map(slot => convertAMSandSlot(unit.id, slot.id)), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]);
    // The unit itself, which is what the environment readings are keyed by
    assert.equal(convertAMSandSlot(32, null), "E");
});

test("the five empty slots read as empty, the four loaded ones as loaded", () => {
    // An empty slot of the AMS 3H carries print_status next to id and state,
    // which read as filament data and made all five a 3rd party spool
    const [unit] = processData(print.ams.ams);
    assert.deepEqual(unit.tray.map(slotIsOccupied), [true, true, true, true, false, false, false, false, false]);
});

test("a slot the AMS 3H does not have is not addressable", () => {
    assert.equal(convertAMSandSlot(32, 9), "Z");
    // The neighbouring ids stay unknown: 16 is the A2L, still open
    assert.equal(convertAMSandSlot(16, 0), "Z");
    assert.equal(convertAMSandSlot(33, 0), "Z");
});

test("the labels of the AMS 3H read as unit and position like every other", () => {
    // What the Spoolman location and the dashboard grouping are built from
    assert.equal(slotUnit("E9"), "E");
    assert.equal(slotNumber("E9"), "9");
});

test("print.mapping and snow name E3, where the report says unit 32 slot 2", () => {
    assert.deepEqual(print.mapping, [65535, 65535, 65535, 65535, 65535, 65535, 8194]);
    assert.deepEqual(decodePrintMapping(print.mapping), [null, null, null, null, null, null, "E3"]);
    assert.deepEqual(activeSlotFromReport(print), { slot: "E3", nozzle: 0, fromSnow: true });
});

test("tray_now is not read once a printer has named its slot through snow", () => {
    // The H3C sends tray_now "2" next to snow 8194. Read the old way, "2" is A3,
    // a unit this printer may not even have.
    const delta = { ams: { tray_now: print.ams.tray_now } };
    assert.equal(activeSlotFromReport(delta, 0, true), undefined);
    // A printer that never sent snow still has tray_now and nothing else
    assert.equal(activeSlotFromReport(delta, 0, false).slot, "A3");
});

test("a snow value beyond the ninth slot names no slot", () => {
    const report = { device: { extruder: { state: 0, info: [{ id: 0, snow: (32 << 8) | 9 }] } } };
    assert.equal(activeSlotFromReport(report).slot, null);
});

test("the nine holders of an H3C are External to External-9", () => {
    assert.deepEqual(print.vir_slot.map(tray => externalSlotLabel(tray.id)),
        ["External-9", "External-8", "External-7", "External-6", "External-5", "External-4", "External-3", "External-2", "External"]);
    assert.equal(externalSlotLabel(246), null);
    assert.ok(print.vir_slot.every(tray => isExternalSlot(externalSlotLabel(tray.id))));
    assert.equal(isExternalSlot("External-10"), false);
    assert.equal(isExternalSlot("E1"), false);
});

test("an empty holder yields no unit, a loaded one its own label", () => {
    // All nine are empty in the report
    assert.deepEqual(externalSpoolUnits(print), []);

    // A spool on the holder of the fifth tool, id 251
    const loaded = print.vir_slot.map(tray => tray.id === "251" ? { ...tray, tray_type: "PLA", tray_info_idx: "GFL99", tray_color: "FF0000FF", cols: ["FF0000FF"] } : tray);
    const units = externalSpoolUnits({ vir_slot: loaded });
    assert.deepEqual(units.map(unit => convertAMSandSlot(unit.id, unit.tray[0].id)), ["External-5"]);
    assert.equal(slotIsOccupied(processData(units)[0].tray[0]), true);
});

test("the slicer order puts the AMS 3H after the four slot units", () => {
    assert.deepEqual(orderedAmsSlots(["E2", "External-3", "A1", "E1", "External", "HT-A"]),
        ["A1", "E1", "E2", "External", "External-3", "HT-A"]);
});

test("the AMS 3H is named from its n10a module, whose id is a field", () => {
    // As ha-bambulab's H3C payload carries it (tests/pybambu/H3C_AMS3H.json):
    // no unit number in the name, the unit id in `id`
    assert.deepEqual(amsModelsFromVersion([{ name: "n10a", id: 32, product_name: "AMS 3H", hw_ver: "N10A05", sw_ver: "02.00.32.82", sn: "X" }]), {
        E: { model: "AMS 3H", hardware: "N10A05", firmware: "02.00.32.82" },
    });
    // Without an id there is no unit to file it under
    assert.deepEqual(amsModelsFromVersion([{ name: "n10a", sw_ver: "1" }]), {});
    // A name that only starts with the same letters is another module
    assert.deepEqual(amsModelsFromVersion([{ name: "n10ab", id: 32, sw_ver: "1" }]), {});
});

test("the AMS 3H reports its readings per drying zone, the heated one last", () => {
    const [env] = extractAmsEnvironment(print.ams.ams, { E: { model: "AMS 3H" } });
    assert.equal(env.amsId, "E");
    assert.equal(env.model, "AMS 3H");
    // No zone stands for the whole unit
    assert.equal(env.humidityPercent, null);
    assert.equal(env.temperature, null);
    // As Bambu Studio showed it for this printer: slots 6 and 8 apart, with
    // their own humidity, the other seven together
    assert.deepEqual(env.zones, [
        { slots: ["E1", "E2", "E3", "E4", "E5", "E7", "E9"], dryer: false, humidity: 2, humidityPercent: 33, temperature: 33.5 },
        { slots: ["E6", "E8"], dryer: true, humidity: 3, humidityPercent: 27, temperature: 31.2 },
    ]);
    // It can dry, and is not drying
    assert.equal(env.drying.active, false);
});

test("the drying state of the AMS 3H comes from the zone with the heater", () => {
    // ha-bambulab's shape: a timer and a setting on the two slot zone, which
    // zone 1 repeats. The state is in the zone's info, as Bambu Studio reads
    // it: bits 4 to 7 are 2 (drying), bits 22 to 23 are 1 (heating).
    const unit = {
        id: "32",
        zone_info: [
            { zone_id: 0, zone_slots: [5, 7], dry_time: 719, info: "240402026", dry_setting: { dry_duration: 12, dry_filament: "PLA", dry_temperature: 55 } },
            { zone_id: 1, zone_slots: [0, 1, 2, 3, 4, 6, 8], dry_time: 719, info: "240002006" },
        ],
    };
    const [env] = extractAmsEnvironment([unit], { E: { model: "AMS 3H" } });
    assert.deepEqual(env.drying, {
        active: true, status: "drying", phase: "heating", slots: ["E6", "E8"],
        remainingMinutes: 719, targetTemp: 55, durationHours: 12, filament: "PLA",
    });
});

test("the trace's dryer is off, whatever the countdown says", () => {
    const [env] = extractAmsEnvironment(print.ams.ams, { E: { model: "AMS 3H" } });
    assert.equal(env.drying.status, "off");
    assert.equal(env.drying.active, false);
    assert.deepEqual(env.drying.slots, ["E6", "E8"]);
});

test("a cooling dryer is still active and says so", () => {
    // State 3 after the cycle, with the countdown already at 0
    const unit = { id: "32", zone_info: [{ zone_id: 0, zone_slots: [5, 7], dry_time: 0, info: "240002036" }] };
    const [env] = extractAmsEnvironment([unit], { E: { model: "AMS 3H" } });
    assert.equal(env.drying.status, "cooling");
    assert.equal(env.drying.active, true);
});

test("the dryer is the zone of two slots, whatever its id", () => {
    // Bambu Studio's rule: the slot count decides, not the order of the zones
    const unit = {
        id: "32",
        zone_info: [
            { zone_id: 0, zone_slots: [0, 1, 2, 3, 4, 6, 8], humidity_raw: "33" },
            { zone_id: 1, zone_slots: [5, 7], humidity_raw: "27" },
        ],
    };
    const [env] = extractAmsEnvironment([unit], { E: { model: "AMS 3H" } });
    assert.deepEqual(env.zones.map(zone => [zone.slots.join(" "), zone.dryer]), [["E1 E2 E3 E4 E5 E7 E9", false], ["E6 E8", true]]);
});

test("the AMS 3H is listed with its zones before get_version has named it", () => {
    const [env] = extractAmsEnvironment(print.ams.ams);
    assert.equal(env.model, null);
    assert.equal(env.zones.length, 2);
});

test("the dashboard draws the AMS 3H as one table of nine", () => {
    const labels = ["A1", "A2", "A3", "A4", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "External", "External-3", "HT-A"];
    const groups = groupSlotsByUnit(labels.map(amsId => ({ amsId })));
    assert.deepEqual(groups.map(group => group.map(slot => slot.amsId).join(" ")),
        ["A1 A2 A3 A4", "E1 E2 E3 E4 E5 E6 E7 E8 E9", "External", "External-3", "HT-A"]);
    assert.equal(isSingleSlotLabel("External-9"), true);
    assert.equal(isSingleSlotLabel("E9"), false);
});
