import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, call } from "./helpers/app.js";

// Its own app, and therefore its own empty data directory: the point of the
// acknowledgement is that it writes settings.json without putting a single
// value in it, which can only be checked while nothing else has been saved.
let app;

before(async () => { app = await startTestApp(); });
after(async () => { await app.close(); });

test("the deprecation notice is served with the variables it found", async () => {
    const { status, body } = await call(`${app.url}/api/notices`);

    assert.equal(status, 200);
    // Whether it is active depends on the environment the tests run in, the
    // shape does not.
    assert.equal(typeof body["env-config"].active, "boolean");
    assert.ok(Array.isArray(body["env-config"].variables));
    assert.equal(body["env-config"].acknowledged, false);
});

test("a fresh installation, without a printers.json, is not told it was updated", async () => {
    const { body } = await call(`${app.url}/api/notices`);

    assert.equal(body["upgrade-1.3.0"].active, false);
    assert.equal(body["upgrade-1.3.0"].acknowledged, false);
});

test("acknowledging the notice does not hand a single setting to the file", async () => {
    const before = await call(`${app.url}/api/settings`);
    assert.equal(app.readJson("settings.json"), null);

    const { status, body } = await call(`${app.url}/api/notices/env-config/ack`, "POST", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Storing the acknowledgement beside the values rather than among them is
    // what keeps this true: the file now exists, but owns nothing, so every
    // environment variable still seeds its setting exactly as before.
    const stored = app.readJson("settings.json");
    assert.deepEqual(stored.values, {});
    assert.equal(stored.notices["env-config"], true);
    // The upgrade notice was never raised here, so the file knows nothing of it.
    assert.equal("upgrade-1.3.0" in stored.notices, false);

    const after = await call(`${app.url}/api/settings`);
    assert.deepEqual(after.body.sources, before.body.sources);
    assert.equal((await call(`${app.url}/api/notices`)).body["env-config"].acknowledged, true);
});

test("a saved setting survives an acknowledgement written after it", async () => {
    await call(`${app.url}/api/settings`, "PUT", { MAX_RETRIES: 4 });
    await call(`${app.url}/api/notices/env-config/ack`, "POST", {});

    const stored = app.readJson("settings.json");
    assert.equal(stored.values.MAX_RETRIES, 4);
    assert.equal(stored.notices["env-config"], true);
});

test("an unknown notice is refused", async () => {
    const { status } = await call(`${app.url}/api/notices/whatever/ack`, "POST", {});
    assert.equal(status, 404);
});

test("the image notice is served, inactive outside a published image", async () => {
    const { body } = await call(`${app.url}/api/notices`);

    // The tests run from a checkout, which has no image name baked in
    assert.equal(body["legacy-image"].active, false);
    assert.equal(body["legacy-image"].acknowledged, false);
    assert.equal(body["legacy-image"].image, null);
    assert.match(body["legacy-image"].replacement, /^ghcr\.io\/rdiger-36\/haspelsync$/);
});

test("closing the image notice holds until the next start and writes nothing", async () => {
    const { state } = await import("../src/state.js");
    const { legacyImageNotice, LEGACY_IMAGE } = await import("../src/imagenotice.js");

    const { status, body } = await call(`${app.url}/api/notices/legacy-image/ack`, "POST", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal((await call(`${app.url}/api/notices`)).body["legacy-image"].acknowledged, true);
    assert.equal(legacyImageNotice(LEGACY_IMAGE).acknowledged, true);

    // The dismissal is held in memory only: settings.json, written by the
    // earlier acknowledgements, knows nothing of it, so the next start asks
    // again for as long as the container runs from the old name.
    assert.equal("legacy-image" in app.readJson("settings.json").notices, false);

    // What a restart does
    state.legacyImageNoticeDismissed = false;
    assert.equal(legacyImageNotice(LEGACY_IMAGE).acknowledged, false);
    assert.equal((await call(`${app.url}/api/notices`)).body["legacy-image"].acknowledged, false);
});

test("a container from the old image name is told so, in the log on every start", async () => {
    const { legacyImageNotice, legacyImageLogLines, LEGACY_IMAGE } = await import("../src/imagenotice.js");

    const notice = legacyImageNotice(LEGACY_IMAGE);
    assert.equal(notice.active, true);
    assert.equal(notice.image, "ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus");

    const lines = legacyImageLogLines(notice);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /bambulab-ams-spoolman-filamentstatus/);
    assert.match(lines[1], /ghcr\.io\/rdiger-36\/haspelsync/);

    // The HaspelSync image and a checkout say nothing
    assert.deepEqual(legacyImageLogLines(legacyImageNotice("haspelsync")), []);
    assert.deepEqual(legacyImageLogLines(legacyImageNotice(null)), []);
});

test("the tag notice needs a Spoolman with native tags and a spool left to migrate", async () => {
    const { state } = await import("../src/state.js");
    const before = { native: state.spoolmanNativeTags, pending: state.tagMigrationPending, version: state.spoolmanVersion };
    const notice = async () => (await call(`${app.url}/api/notices`)).body["native-tags"];

    try {
        // Nobody looked yet
        state.spoolmanNativeTags = null;
        state.tagMigrationPending = null;
        assert.equal((await notice()).active, false);

        // An old Spoolman has nowhere to migrate to, however many spools wait
        state.spoolmanNativeTags = false;
        state.tagMigrationPending = 3;
        assert.equal((await notice()).active, false);

        state.spoolmanNativeTags = true;
        state.spoolmanVersion = "0.27.1";
        assert.deepEqual(await notice(), { active: true, acknowledged: false, pending: 3, version: "0.27.1" });

        state.tagMigrationPending = 0;
        assert.equal((await notice()).active, false);

        // Said once: the dismissal is stored like the others
        state.tagMigrationPending = 3;
        assert.equal((await call(`${app.url}/api/notices/native-tags/ack`, "POST", {})).status, 200);
        assert.equal((await notice()).acknowledged, true);
        assert.equal(app.readJson("settings.json").notices["native-tags"], true);
    } finally {
        state.spoolmanNativeTags = before.native;
        state.tagMigrationPending = before.pending;
        state.spoolmanVersion = before.version;
    }
});
