import test from "node:test";
import assert from "node:assert/strict";

import { resolveMode, coerceSetting, resolveSettings, describeSources, settings, legacyMode, legacyModeNeedsRestart, parseStoredFile, SETTINGS_SCHEMA_VERSION } from "../src/settings.js";

test('resolveMode accepts "automatic"', () => {
    assert.deepEqual(resolveMode("automatic"), { raw: "automatic", mode: "automatic", valid: true });
});

test('resolveMode accepts "auto" as a shorthand', () => {
    // Documented as "automatic", but "auto" is the obvious thing to type and
    // used to fall through to manual behaviour without any hint.
    assert.equal(resolveMode("auto").mode, "automatic");
    assert.equal(resolveMode("auto").valid, true);
});

test("resolveMode ignores surrounding whitespace and case", () => {
    assert.equal(resolveMode("  Automatic ").mode, "automatic");
    assert.equal(resolveMode("MANUAL").mode, "manual");
});

test("resolveMode falls back to manual and flags an unrecognised value", () => {
    const r = resolveMode("atomatic");
    assert.equal(r.mode, "manual");
    assert.equal(r.valid, false);
    assert.equal(r.raw, "atomatic");
});

test("resolveMode defaults to manual when unset", () => {
    assert.deepEqual(resolveMode(undefined), { raw: "manual", mode: "manual", valid: true });
    assert.deepEqual(resolveMode(""), { raw: "manual", mode: "manual", valid: true });
});

test("coerceSetting clamps an integer into its documented range", () => {
    assert.equal(coerceSetting("UPDATE_INTERVAL", "1000").value, 5000);
    assert.equal(coerceSetting("UPDATE_INTERVAL", 999999).value, 300000);
    assert.equal(coerceSetting("UPDATE_INTERVAL", "30000").value, 30000);
});

test("coerceSetting rejects a number that is not one", () => {
    assert.ok(coerceSetting("MAX_RETRIES", "soon").error);
});

test("coerceSetting reads a boolean from both a string and a real boolean", () => {
    assert.equal(coerceSetting("MQTT_TRACE", "true").value, true);
    assert.equal(coerceSetting("MQTT_TRACE", false).value, false);
    assert.ok(coerceSetting("MQTT_TRACE", "maybe").error);
});

test("coerceSetting turns an empty string into null for a text field", () => {
    assert.equal(coerceSetting("SPOOLMAN_SUBFOLDER", "  ").value, null);
});

test("coerceSetting rejects an unknown field", () => {
    assert.ok(coerceSetting("SPOOLMAN_PASSWORD", "x").error);
});

test("resolveSettings layers default, environment and file in that order", () => {
    const resolved = resolveSettings(
        { MAX_RETRIES: 5 },
        { MAX_RETRIES: "9", SET_LOCATION: "true" },
    );

    // The file wins over the environment variable that seeded it.
    assert.equal(resolved.MAX_RETRIES, 5);
    // A field the file does not mention still honours its environment variable.
    assert.equal(resolved.SET_LOCATION, true);
    // Everything else falls back to the documented default.
    assert.equal(resolved.UPDATE_INTERVAL, 120000);
    assert.equal(resolved.MODE, "manual");
});

test("resolveSettings keeps the layer below an unusable value and reports it", () => {
    const issues = [];
    const resolved = resolveSettings({ MAX_RETRIES: "later" }, { MAX_RETRIES: "3" }, issues);

    assert.equal(resolved.MAX_RETRIES, 3);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /MAX_RETRIES/);
});

test("describeSources names where each value came from", () => {
    const sources = describeSources({ MODE: "automatic" }, { LOG_LEVEL: "debug" });

    assert.equal(sources.MODE, "file");
    assert.equal(sources.LOG_LEVEL, "environment");
    assert.equal(sources.SET_LOCATION, "default");
});

test("the tracking mode is frozen at startup", () => {
    // The two tracking modes book consumption differently, so switching one
    // into a running process would book a print in flight twice or not at all.
    // Saving changes what is stored; only a restart changes what is running.
    const running = legacyMode();
    const stored = settings.LEGACY_MODE;

    try {
        settings.LEGACY_MODE = !stored;

        assert.equal(legacyMode(), running);
        assert.equal(legacyModeNeedsRestart(), true);

        settings.LEGACY_MODE = running;
        assert.equal(legacyModeNeedsRestart(), false);
    } finally {
        settings.LEGACY_MODE = stored;
    }
});

test("the wrapped settings file is read with its revision", () => {
    const file = parseStoredFile({ schemaVersion: 1, revision: 7, values: { MAX_RETRIES: 3 } });

    assert.deepEqual(file.values, { MAX_RETRIES: 3 });
    assert.equal(file.revision, 7);
    assert.equal(file.schemaVersion, 1);
});

test("the first flat settings file is still read", () => {
    // Installs from the first version have the values at the top level and no
    // version at all. Losing them would reset the whole configuration.
    const file = parseStoredFile({ MAX_RETRIES: 3, MODE: "automatic" });

    assert.deepEqual(file.values, { MAX_RETRIES: 3, MODE: "automatic" });
    assert.equal(file.revision, 0);
    assert.equal(file.schemaVersion, 0);
});

test("a wrapped file without a revision starts counting at zero", () => {
    const file = parseStoredFile({ schemaVersion: SETTINGS_SCHEMA_VERSION, values: {} });

    assert.equal(file.revision, 0);
});

test("the dismissed notices are read beside the values", () => {
    const file = parseStoredFile({ schemaVersion: 1, values: {}, notices: { "env-config": true } });

    assert.deepEqual(file.notices, { "env-config": true });
    // Never merged into the values: a dismissed hint must not become a setting
    // the file owns, which would stop the environment variables from seeding.
    assert.deepEqual(file.values, {});
});

test("a file written before the notices existed reads as none dismissed", () => {
    assert.deepEqual(parseStoredFile({ schemaVersion: 1, values: {} }).notices, {});
    assert.deepEqual(parseStoredFile({ MAX_RETRIES: 3 }).notices, {});
    assert.deepEqual(parseStoredFile({ schemaVersion: 1, values: {}, notices: "yes" }).notices, {});
});

test("every setting of the schema can be seeded from the environment", async () => {
    const { SETTINGS_SCHEMA } = await import("../src/settings.js");
    const { envSeed } = await import("../src/config.js");
    // Five settings added after the environment was deprecated were missing
    // here, so ARCHIVE_EMPTY_SPOOLS=true in a compose file did nothing at all,
    // without a word in the log.
    const missing = Object.keys(SETTINGS_SCHEMA).filter(key => !(key in envSeed));
    assert.deepEqual(missing, []);
    const extra = Object.keys(envSeed).filter(key => !(key in SETTINGS_SCHEMA));
    assert.deepEqual(extra, []);
});

test("a location format without the printer is refused", () => {
    assert.ok(coerceSetting("LOCATION_FORMAT", "{slot}").error);
    assert.equal(coerceSetting("LOCATION_FORMAT", "{printer}").value, "{printer}");
    assert.equal(coerceSetting("LOCATION_FORMAT", " {printer} - {slot} ").value, "{printer} - {slot}");
    assert.equal(coerceSetting("LOCATION_FORMAT", "").value, null);
});
