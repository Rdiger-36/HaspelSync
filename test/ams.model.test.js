import test from "node:test";
import assert from "node:assert/strict";

import { amsModelsFromVersion, extractAmsEnvironment } from "../src/ams.js";
import { noteVersionInfo } from "../src/mqtt.js";

// The get_version answers of an X1E and a P1S, both with one original AMS,
// captured on 2026-09-07 through issue #146. Serials and the last version
// digits are the placeholders the anonymised trace carries. The status report
// of that unit is what test/ams.env.test.js calls a 2 Pro shape: a percentage,
// a temperature and dry_time 0, which is why the model has to come from here.
const X1E_MODULES = [
    { name: "ota", sw_ver: "01.03.00.XXX", hw_ver: "N/A", loader_ver: "00.00.00.XXX", sn: "03W09XXXXXXXXXX", product_name: "Bambu Lab X1E", visible: true, flag: 0 },
    { name: "ams/0", sw_ver: "00.00.06.XXX", hw_ver: "AMS08", loader_ver: "00.00.00.XXX", sn: "00600XXXXXXXXXX", product_name: "AMS (1)", visible: true, flag: 0 },
    { name: "mc", sw_ver: "00.00.33.XXX", hw_ver: "MC01", loader_ver: "00.00.00.XXX", sn: "01M00XXXXXXXXXX", product_name: "", visible: false, flag: 0 },
    { name: "th", sw_ver: "00.00.10.XXX", hw_ver: "TH01", loader_ver: "00.00.00.XXX", sn: "01E00XXXXXXXXXX", product_name: "", visible: false, flag: 0 },
];

const P1S_MODULES = [
    { name: "ota", sw_ver: "01.10.00.XXX", hw_ver: "OTA", loader_ver: "00.00.00.XXX", sn: "01P00XXXXXXXXXX", product_name: "Bambu Lab P1S", visible: true, flag: 0 },
    { name: "esp32", sw_ver: "01.16.38.XXX", hw_ver: "AP04", loader_ver: "00.00.00.XXX", sn: "01P00XXXXXXXXXX", product_name: "", visible: false, flag: 0 },
    { name: "ams/0", sw_ver: "01.00.06.XXX", hw_ver: "AMS08", loader_ver: "00.00.00.XXX", sn: "00600XXXXXXXXXX", product_name: "AMS (1)", visible: true, flag: 0 },
];

// The original AMS of the X1E as its status report shows it, which is what
// used to be labelled a 2 Pro.
const X1E_ORIGINAL_AMS = { dry_time: 0, humidity: "2", humidity_raw: "35", id: "0", info: "1001", temp: "29.2" };

test("an original AMS is named from the ams/ module", () => {
    assert.deepEqual(amsModelsFromVersion(X1E_MODULES), {
        A: { model: "AMS", hardware: "AMS08", firmware: "00.00.06.XXX" },
    });
    assert.deepEqual(amsModelsFromVersion(P1S_MODULES), {
        A: { model: "AMS", hardware: "AMS08", firmware: "01.00.06.XXX" },
    });
});

test("the other three families are told apart by their prefix", () => {
    // Prefixes as ha-bambulab keys on them; only ams/ is confirmed on a real
    // answer here, the Lite's hw_ver is from ha-bambulab's sample.
    const models = amsModelsFromVersion([
        { name: "ams_f1/0", sw_ver: "00.00.07.89", hw_ver: "AMS_F102", sn: "1" },
        { name: "n3f/1", sw_ver: "00.00.01.00", hw_ver: "", sn: "2" },
        { name: "n3s/128", sw_ver: "00.00.01.00", sn: "3" },
        { name: "n3s/129", sw_ver: "00.00.01.00", sn: "4" },
    ]);

    assert.deepEqual(models, {
        A: { model: "AMS Lite", hardware: "AMS_F102", firmware: "00.00.07.89" },
        B: { model: "AMS 2 Pro", hardware: null, firmware: "00.00.01.00" },
        "HT-A": { model: "AMS HT", hardware: null, firmware: "00.00.01.00" },
        "HT-B": { model: "AMS HT", hardware: null, firmware: "00.00.01.00" },
    });
});

test("a unit id the labels cannot name is left out rather than filed under Z", () => {
    // Unit 16 is what an A2L reports its AMS as, and which range it belongs to
    // is still open. See KNOWN_GAPS in test/reports.test.js.
    assert.deepEqual(amsModelsFromVersion([{ name: "ams/16", sw_ver: "1", hw_ver: "AMS08" }]), {});
    assert.deepEqual(amsModelsFromVersion([{ name: "ams/x", sw_ver: "1" }, { name: 7 }, null]), {});
    assert.deepEqual(amsModelsFromVersion("not a list"), {});
});

test("the readings carry the model once it is known, and null before", () => {
    const [before] = extractAmsEnvironment([X1E_ORIGINAL_AMS]);
    assert.equal(before.model, null);
    // The shape that used to make the dashboard call it a 2 Pro
    assert.equal(before.humidityPercent, 35);
    assert.notEqual(before.drying, null);

    const [after] = extractAmsEnvironment([X1E_ORIGINAL_AMS], amsModelsFromVersion(X1E_MODULES));
    assert.equal(after.model, "AMS");
    // An original AMS has no dryer, whatever its firmware puts in the report
    assert.equal(after.drying, null);
});

test("the model settles the dryer: 2 Pro and HT have one, AMS and Lite do not, unknown asks the report", () => {
    const withDryer = { ...X1E_ORIGINAL_AMS, dry_time: 30 };
    const models = model => ({ A: { model, hardware: null, firmware: null } });

    assert.equal(extractAmsEnvironment([withDryer], models("AMS"))[0].drying, null);
    assert.equal(extractAmsEnvironment([withDryer], models("AMS Lite"))[0].drying, null);
    assert.equal(extractAmsEnvironment([withDryer], models("AMS 2 Pro"))[0].drying.active, true);
    assert.equal(extractAmsEnvironment([withDryer], models("AMS HT"))[0].drying.active, true);
    // A 2 Pro without the fields, which no report so far has shown, still gets its section
    assert.deepEqual(extractAmsEnvironment([{ id: "0", humidity: "2", humidity_raw: "35", temp: "29.2" }], models("AMS 2 Pro"))[0].drying,
        { active: false, status: null, phase: null, remainingMinutes: null, targetTemp: null, durationHours: null, filament: null });
    assert.equal(extractAmsEnvironment([withDryer])[0].drying.active, true);
});

test("a get_version answer is read off the wire and folded into the readings", () => {
    const printer = {
        id: "03W09XXXXXXXXXX",
        name: "X1E",
        logFilePath: null,
        amsModels: {},
        amsEnv: extractAmsEnvironment([X1E_ORIGINAL_AMS]),
    };

    const answer = JSON.stringify({ info: { command: "get_version", sequence_id: "20004", module: X1E_MODULES, result: "success", reason: "" } });
    assert.equal(noteVersionInfo(printer, Buffer.from(answer)), true);

    assert.deepEqual(printer.amsModels, { A: { model: "AMS", hardware: "AMS08", firmware: "00.00.06.XXX" } });
    assert.equal(printer.amsEnv[0].model, "AMS");
    assert.equal(printer.amsEnv[0].humidityPercent, 35);
    // The readings were taken before the answer and offered a dryer; the answer takes it back
    assert.equal(printer.amsEnv[0].drying, null);
});

test("anything that is not a get_version answer is left to the report handler", () => {
    const printer = { id: "x", name: "x", logFilePath: null, amsModels: { A: { model: "AMS" } }, amsEnv: [] };

    assert.equal(noteVersionInfo(printer, Buffer.from('{"print":{"command":"push_status","gcode_file":"get_version.3mf"}}')), false);
    assert.equal(noteVersionInfo(printer, Buffer.from('{"info":{"command":"get_version"}}')), false);
    assert.equal(noteVersionInfo(printer, Buffer.from("not json")), false);
    // Untouched by any of them
    assert.deepEqual(printer.amsModels, { A: { model: "AMS" } });
});
