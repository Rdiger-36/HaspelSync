import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// A throwaway Spoolman: every PATCH is recorded and answered, so the tests can
// assert what was written rather than only what the helpers returned.
const patches = [];
const spools = new Map();

const server = http.createServer((req, res) => {
    const id = Number(req.url.split("/").pop());

    if (req.method === "GET") {
        const spool = spools.get(id);
        res.writeHead(spool ? 200 : 404, { "content-type": "application/json" });
        return res.end(JSON.stringify(spool ?? { detail: "not found" }));
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        patches.push({ id, payload });

        const spool = spools.get(id);
        if (spool) Object.assign(spool, payload);

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(spool ?? { id, ...payload }));
    });
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const { settings } = await import("../src/settings.js");
settings.SPOOLMAN_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
settings.SET_LOCATION = true;

const {
    slotLocation,
    ownsLocation,
    claimSlotLocation,
    releaseSlotLocation,
    createLocationSync,
    releasePrinterLocations,
    renamePrinterLocations,
    reformatPrinterLocations,
} = await import("../src/location.js");

const printer = { id: "01P00A000000011", name: "Test Printer", logFilePath: null };

/** Registers a spool with the fake Spoolman and returns the record. */
function seed(id, location = null) {
    const spool = { id, location, filament: { name: `spool ${id}` } };
    spools.set(id, spool);
    // A copy, so a test can hand the helpers a record that is stale in exactly
    // the way the cached `printer.spoolData` is.
    return { ...spool };
}

beforeEach(() => {
    patches.length = 0;
    spools.clear();
    settings.SET_LOCATION = true;
    settings.LOCATION_FORMAT = "{printer} - {slot}";
    printer.name = "Test Printer";
    printer.spoolData = [];
});

after(() => new Promise(resolve => server.close(resolve)));

// ---------------------------------------------------------------------------
// The location string and who it belongs to
// ---------------------------------------------------------------------------

test("the location is the printer name and the slot label", () => {
    assert.equal(slotLocation("X1C", "A1"), "X1C - A1");
    assert.equal(slotLocation("X1C", "External"), "X1C - External");
    assert.equal(slotLocation("X1C", "HT-A"), "X1C - HT-A");
});

test("a location this printer wrote is ours, whichever slot it names", () => {
    assert.equal(ownsLocation("X1C - A1", "X1C"), true);
    assert.equal(ownsLocation("X1C - HT-B", "X1C"), true);
});

test("a location the user set by hand is not ours", () => {
    // The bug this guards: every spool that ever sat in an AMS used to have its
    // location wiped on the way out, shelf or not.
    assert.equal(ownsLocation("Shelf A", "X1C"), false);
    assert.equal(ownsLocation("", "X1C"), false);
    assert.equal(ownsLocation(null, "X1C"), false);
});

test("a location of a printer with a similar name is not ours", () => {
    assert.equal(ownsLocation("P1S - A1", "P1"), false);
    assert.equal(ownsLocation("P1 - A1", "P1S"), false);
});

// ---------------------------------------------------------------------------
// The location format (issue #248)
// ---------------------------------------------------------------------------

test("the location follows the template", () => {
    settings.LOCATION_FORMAT = "{printer}";
    assert.equal(slotLocation("X1C", "A1"), "X1C");
    settings.LOCATION_FORMAT = "AMS {slot} ({printer})";
    assert.equal(slotLocation("X1C", "HT-A"), "AMS HT-A (X1C)");
});

test("a template without the printer falls back to the default", () => {
    // Only a hand edited settings file gets here, the settings API refuses it.
    settings.LOCATION_FORMAT = "{slot}";
    assert.equal(slotLocation("X1C", "A1"), "X1C - A1");
    settings.LOCATION_FORMAT = null;
    assert.equal(slotLocation("X1C", "A1"), "X1C - A1");
});

test("a location written with the current template is ours", () => {
    settings.LOCATION_FORMAT = "{printer}";
    assert.equal(ownsLocation("X1C", "X1C"), true);
    assert.equal(ownsLocation("X1C 2", "X1C"), false);
    settings.LOCATION_FORMAT = "AMS {slot} ({printer})";
    assert.equal(ownsLocation("AMS External-2 (X1C)", "X1C"), true);
    assert.equal(ownsLocation("AMS A1 (X1C2)", "X1C"), false);
});

test("a location written with the old default stays ours after the template changed", () => {
    settings.LOCATION_FORMAT = "{printer}";
    assert.equal(ownsLocation("X1C - A1", "X1C"), true);
});

test("the slot wildcard does not reach into another printer's name", () => {
    settings.LOCATION_FORMAT = "{printer} {slot}";
    assert.equal(ownsLocation("X 2 A1", "X"), false);
    assert.equal(ownsLocation("X A1", "X"), true);
});

test("characters of the template that mean something to a regex are taken literally", () => {
    settings.LOCATION_FORMAT = "[{printer}].{slot}";
    assert.equal(ownsLocation("[P1S].A1", "P1S"), true);
    assert.equal(ownsLocation("[P1S]xA1", "P1S"), false);
});

test("a new template rewrites the locations this service had written", async () => {
    seed(1, "Test Printer - A1");
    seed(2, "Shelf A");
    printer.spoolData = [
        { amsId: "A1", connectedViaTag: true, existingSpool: { id: 1 } },
        { amsId: "A2", connectedViaTag: true, existingSpool: { id: 2 } },
    ];
    settings.LOCATION_FORMAT = "{printer}";

    await reformatPrinterLocations(printer, "{printer} - {slot}");

    assert.deepEqual(patches, [{ id: 1, payload: { location: "Test Printer" } }]);
});

test("a new template writes nothing while the setting is off", async () => {
    seed(1, "Test Printer - A1");
    printer.spoolData = [{ amsId: "A1", connectedViaTag: true, existingSpool: { id: 1 } }];
    settings.SET_LOCATION = false;
    settings.LOCATION_FORMAT = "{printer}";

    await reformatPrinterLocations(printer, "{printer} - {slot}");

    assert.deepEqual(patches, []);
});

test("a spool without its slot is released under the new template", async () => {
    settings.LOCATION_FORMAT = "{printer}";
    const spool = seed(1, "Test Printer");

    await releaseSlotLocation(printer, spool);

    assert.deepEqual(patches, [{ id: 1, payload: { location: "" } }]);
});

// ---------------------------------------------------------------------------
// Claiming and releasing one slot
// ---------------------------------------------------------------------------

test("claiming a slot writes the location", async () => {
    const spool = seed(1);

    assert.equal(await claimSlotLocation(printer, "A1", spool), true);
    assert.deepEqual(patches, [{ id: 1, payload: { location: "Test Printer - A1" } }]);
    // The caller's record is reused for the rest of the update, so it has to
    // carry what was written.
    assert.equal(spool.location, "Test Printer - A1");
});

test("claiming a slot that already says so writes nothing", async () => {
    const spool = seed(1, "Test Printer - A1");

    assert.equal(await claimSlotLocation(printer, "A1", spool), false);
    assert.deepEqual(patches, []);
});

test("claiming corrects a location that was changed in Spoolman", async () => {
    // Nothing used to reconcile this: the write only happened when the slot's
    // filament identity changed, so a location edited in Spoolman stayed wrong.
    const spool = seed(1, "Somewhere else");

    assert.equal(await claimSlotLocation(printer, "A1", spool), true);
    assert.equal(patches[0].payload.location, "Test Printer - A1");
});

test("releasing clears a location this printer wrote", async () => {
    const spool = seed(1, "Test Printer - A1");

    assert.equal(await releaseSlotLocation(printer, spool), true);
    assert.deepEqual(patches, [{ id: 1, payload: { location: "" } }]);
});

test("releasing leaves a location the user set alone", async () => {
    const spool = seed(1, "Shelf A");

    assert.equal(await releaseSlotLocation(printer, spool), false);
    assert.deepEqual(patches, []);
    assert.equal(spools.get(1).location, "Shelf A");
});

test("releasing leaves another printer's location alone", async () => {
    const spool = seed(1, "Other Printer - A1");

    assert.equal(await releaseSlotLocation(printer, spool), false);
    assert.deepEqual(patches, []);
});

test("nothing is written while the setting is off", async () => {
    settings.SET_LOCATION = false;
    const spool = seed(1, "Test Printer - A1");

    assert.equal(await claimSlotLocation(printer, "A1", seed(2)), false);
    assert.equal(await releaseSlotLocation(printer, spool), false);
    assert.deepEqual(patches, []);
});

test("a slot without a spool writes nothing", async () => {
    assert.equal(await claimSlotLocation(printer, "A1", null), false);
    assert.equal(await releaseSlotLocation(printer, null), false);
    assert.deepEqual(patches, []);
});

test("a failing Spoolman is logged, not thrown", async () => {
    const unreachable = { ...printer };
    const spool = { id: 999, location: "Test Printer - A1" };
    spools.delete(999);

    settings.SPOOLMAN_ENDPOINT = "http://127.0.0.1:1";
    try {
        assert.equal(await claimSlotLocation(unreachable, "A1", { id: 999 }), false);
        assert.equal(await releaseSlotLocation(unreachable, spool), false);
    } finally {
        settings.SPOOLMAN_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    }
});

// ---------------------------------------------------------------------------
// One AMS update as a whole
// ---------------------------------------------------------------------------

test("a spool that changed slot keeps its location", async () => {
    // The regression this exists for: A1 is processed before A2, so the slot the
    // spool moved into wrote the new location and the slot it left cleared it
    // again one slot later.
    const spool = seed(1, "Test Printer - A2");
    const sync = createLocationSync(printer);

    sync.claim("A1", spool);   // it is here now
    sync.release(spool);       // A2 reports it gone
    await sync.flush();

    assert.deepEqual(patches, [{ id: 1, payload: { location: "Test Printer - A1" } }]);
});

test("the slot order does not decide the outcome of a move", async () => {
    const spool = seed(1, "Test Printer - A1");
    const sync = createLocationSync(printer);

    sync.release(spool);       // A1 reports it gone
    sync.claim("A2", spool);   // it turns up in A2
    await sync.flush();

    assert.deepEqual(patches, [{ id: 1, payload: { location: "Test Printer - A2" } }]);
});

test("a spool taken out of the AMS is released", async () => {
    const spool = seed(1, "Test Printer - A1");
    const sync = createLocationSync(printer);

    sync.release(spool);
    await sync.flush();

    assert.deepEqual(patches, [{ id: 1, payload: { location: "" } }]);
});

test("a slot whose spool was swapped releases the old one and claims the new", async () => {
    const removed = seed(1, "Test Printer - A1");
    const inserted = seed(2);
    const sync = createLocationSync(printer);

    sync.claim("A1", inserted);
    sync.release(removed);
    await sync.flush();

    // Claims first: a spool that is physically in the AMS must never be left
    // without a location, not even between two requests.
    assert.deepEqual(patches, [
        { id: 2, payload: { location: "Test Printer - A1" } },
        { id: 1, payload: { location: "" } },
    ]);
});

test("a flush writes nothing while the setting is off", async () => {
    settings.SET_LOCATION = false;
    const sync = createLocationSync(printer);

    sync.claim("A1", seed(1));
    sync.release(seed(2, "Test Printer - A2"));
    await sync.flush();

    assert.deepEqual(patches, []);
});

// ---------------------------------------------------------------------------
// The printer itself changing
// ---------------------------------------------------------------------------

test("removing a printer gives its slots' locations back", async () => {
    seed(1, "Test Printer - A1");
    seed(2, "Shelf A");
    printer.spoolData = [
        { amsId: "A1", connectedViaTag: true, existingSpool: { id: 1 } },
        { amsId: "A2", connectedViaMapping: true, existingSpool: { id: 2 } },
    ];

    await releasePrinterLocations(printer);

    // Only the one this printer wrote. The hand-set shelf survives.
    assert.deepEqual(patches, [{ id: 1, payload: { location: "" } }]);
});

test("removing a printer ignores slots that only hold a merge candidate", async () => {
    seed(1, "Test Printer - A1");
    printer.spoolData = [{ amsId: "A1", existingSpool: { id: 1 } }];

    await releasePrinterLocations(printer);

    assert.deepEqual(patches, []);
});

test("renaming a printer rewrites the locations it had written", async () => {
    seed(1, "Old Name - A1");
    seed(2, "Shelf A");
    printer.spoolData = [
        { amsId: "A1", connectedViaTag: true, existingSpool: { id: 1 } },
        { amsId: "A2", connectedViaTag: true, existingSpool: { id: 2 } },
    ];
    printer.name = "New Name";

    await renamePrinterLocations(printer, "Old Name");

    assert.deepEqual(patches, [{ id: 1, payload: { location: "New Name - A1" } }]);
});

test("a rename reads the location from Spoolman, not from the cached slot", async () => {
    // The cached record is whatever Spoolman said when it was fetched, and the
    // decision depends on what it says now.
    seed(1, "Old Name - A1");
    printer.spoolData = [{
        amsId: "A1",
        connectedViaTag: true,
        existingSpool: { id: 1, location: "something stale" },
    }];
    printer.name = "New Name";

    await renamePrinterLocations(printer, "Old Name");

    assert.deepEqual(patches, [{ id: 1, payload: { location: "New Name - A1" } }]);
});
