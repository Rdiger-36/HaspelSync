import test from "node:test";
import assert from "node:assert/strict";

import { buildFilamentPayload, buildSpoolPayload, supportsNativeTags, writesLegacyTag } from "../src/spoolman.js";
import { settings } from "../src/settings.js";
import { state } from "../src/state.js";

state.vendorID = 1;

// Real SpoolmanDB entries, as returned by GET /api/v1/external/filament.
const supportForPla = {
    id: "bambulab_pla_supportforplawhite_500_175_n",
    manufacturer: "Bambu Lab",
    name: "Support for PLA White",
    material: "PLA",
    density: 1.33,
    diameter: 1.75,
    weight: 500.0,
    spool_weight: 250.0,
    color_hex: "FFFFFF",
    color_hexes: null,
    extruder_temp: 225,
    bed_temp: 40,
    multi_color_direction: null,
};

const plaBlack = {
    id: "bambulab_pla_black_1000_175_n",
    name: "Black",
    density: 1.24,
    diameter: 1.75,
    weight: 1000.0,
    spool_weight: 250.0,
    color_hex: "000000",
    color_hexes: null,
    extruder_temp: 220,
    bed_temp: 60,
    multi_color_direction: null,
};

const slot = (subBrands, trayWeight) => ({ tray_sub_brands: subBrands, tray_weight: trayWeight });

test("filament weights are the catalogue values, not a hardcoded 1kg", () => {
    const p = buildFilamentPayload({
        slot: slot("PLA Basic", "1000"),
        matchingExternalFilament: plaBlack,
    });
    assert.equal(p.weight, 1000);
    assert.equal(p.spool_weight, 250);
});

test("a deviating physical spool does not change the filament weight", () => {
    // The Support for PLA sample reports 250g on its RFID chip, but the filament
    // describes the 500g product it belongs to. The deviation lives on the spool
    // as initial_weight, not on the filament shared by every spool of that type.
    const p = buildFilamentPayload({
        slot: slot("Support for PLA", "250"),
        matchingExternalFilament: supportForPla,
    });
    assert.equal(p.weight, 500);
    assert.equal(p.spool_weight, 250);
});

test("material is the AMS sub brand, the rest comes from the catalogue entry", () => {
    const p = buildFilamentPayload({
        slot: slot("Support for PLA", "250"),
        matchingExternalFilament: supportForPla,
    });
    assert.equal(p.material, "Support for PLA");
    assert.equal(p.name, "Support for PLA White");
    assert.equal(p.density, 1.33);
    assert.equal(p.diameter, 1.75);
    assert.equal(p.color_hex, "FFFFFF");
    assert.equal(p.external_id, "bambulab_pla_supportforplawhite_500_175_n");
    assert.equal(p.settings_extruder_temp, 225);
    assert.equal(p.settings_bed_temp, 40);
    assert.equal(p.vendor_id, 1);
});

test("multi colour hexes are joined, and empty when the entry has none", () => {
    const single = buildFilamentPayload({ slot: slot("PLA Basic", "1000"), matchingExternalFilament: plaBlack });
    assert.equal(single.multi_color_hexes, "");

    const multi = buildFilamentPayload({
        slot: slot("PLA Galaxy", "1000"),
        matchingExternalFilament: { ...plaBlack, color_hexes: ["FF0000", "00FF00"], multi_color_direction: "coaxial" },
    });
    assert.equal(multi.multi_color_hexes, "FF0000,00FF00");
    assert.equal(multi.multi_color_direction, "coaxial");
});

test("fields Spoolman does not accept are not sent", () => {
    const p = buildFilamentPayload({
        slot: slot("PLA Basic", "1000"),
        matchingExternalFilament: { ...plaBlack, spool_type: "plastic", finish: "matte", pattern: null, translucent: false, glow: false },
    });
    for (const key of ["spool_type", "finish", "pattern", "translucent", "glow"]) {
        assert.equal(key in p, false, `${key} should not be part of the payload`);
    }
});

/* ---- The spool payload, shared by both creation paths ---- */

const bambuSlot = {
    tray_sub_brands: "PLA Basic",
    tray_type: "PLA",
    tray_uuid: "ABCD1234",
    tray_weight: "1000",
    remain: 63,
};

test("the spool payload carries the slot weight, what is used, and the tag", () => {
    const payload = buildSpoolPayload({ slot: bambuSlot }, 7);

    assert.equal(payload.filament_id, 7);
    assert.equal(payload.initial_weight, 1000);
    // 63% left of 1000 g, so 370 g are already gone
    assert.equal(payload.used_weight, 370);
    // JSON encoded, because that is the shape Spoolman stores an extra field in
    assert.equal(payload.extra.tag, '"ABCD1234"');
    assert.equal(typeof payload.first_used, "number");
});

test("both creation paths build the same spool", () => {
    // They differ only in where the filament id comes from: an existing
    // Spoolman filament, or one created moments earlier
    const fromExisting = buildSpoolPayload({ slot: bambuSlot }, "7");
    const fromNew = buildSpoolPayload({ slot: bambuSlot }, 7);

    assert.deepEqual({ ...fromExisting, first_used: 0 }, { ...fromNew, first_used: 0 });
});

test("a slot reporting nothing left creates a spool with everything used", () => {
    const payload = buildSpoolPayload({ slot: { ...bambuSlot, remain: 0 } }, 7);

    assert.equal(payload.initial_weight, 1000);
    assert.equal(payload.used_weight, 1000);
});

test("a slot with no remain reading yet creates a full spool, not an empty one", () => {
    // processData turns the AMS -1 into null, which lasts the 15 to 20 seconds
    // between inserting a spool and the RFID percentage arriving. Creating in
    // that window used to book the whole spool as used, and in G-code mode
    // nothing patches the weight afterwards, so it stayed at 0 g left.
    const payload = buildSpoolPayload({ slot: { ...bambuSlot, remain: null } }, 7);

    assert.equal(payload.initial_weight, 1000);
    assert.equal(payload.used_weight, 0);
});

test("the remain percentage is rescaled to the real spool size", () => {
    // The AMS estimates against a 1 kg reference, so 25% on a 500 g spool means
    // half of it is left, not a quarter
    const payload = buildSpoolPayload({ slot: { ...bambuSlot, tray_weight: "500", remain: 25 } }, 7);

    assert.equal(payload.initial_weight, 500);
    assert.equal(payload.used_weight, 250);
});

/* ---- Native tags ---- */

test("supportsNativeTags starts at Spoolman 0.27.0", () => {
    assert.equal(supportsNativeTags("0.26.1"), false);
    assert.equal(supportsNativeTags("0.27.0"), true);
    assert.equal(supportsNativeTags("v0.27.1"), true);
    assert.equal(supportsNativeTags("1.0.0"), true);
    // Not a version at all reads as too old: extra.tag works everywhere
    assert.equal(supportsNativeTags(null), false);
    assert.equal(supportsNativeTags("unknown"), false);
});

test("extra.tag is written unless a Spoolman with native tags is told to stop", () => {
    const slot = { tray_uuid: "0417584A3ABE4274838571DB6AA6CABA", tray_weight: "1000", remain: 100, tray_type: "PLA" };
    const before = { setting: settings.WRITE_EXTRA_TAG, native: state.spoolmanNativeTags };
    try {
        settings.WRITE_EXTRA_TAG = false;

        // An old Spoolman has nothing else to hold the link, whatever is set
        state.spoolmanNativeTags = false;
        assert.equal(writesLegacyTag(), true);
        assert.deepEqual(buildSpoolPayload({ slot }, 7).extra, { tag: '"0417584A3ABE4274838571DB6AA6CABA"' });

        // Not asked yet counts as old
        state.spoolmanNativeTags = null;
        assert.equal(writesLegacyTag(), true);

        state.spoolmanNativeTags = true;
        assert.equal(writesLegacyTag(), false);
        assert.equal("extra" in buildSpoolPayload({ slot }, 7), false);

        settings.WRITE_EXTRA_TAG = true;
        assert.deepEqual(buildSpoolPayload({ slot }, 7).extra, { tag: '"0417584A3ABE4274838571DB6AA6CABA"' });
    } finally {
        settings.WRITE_EXTRA_TAG = before.setting;
        state.spoolmanNativeTags = before.native;
    }
});
