import express from "express";

import { CATALOGUE, EXTERNAL_MATERIALS } from "./catalogue.js";
import { SEED_FILAMENTS, SEED_SPOOLS } from "./scenario.js";

/**
 * A Spoolman instance that only exists in memory.
 *
 * It implements the endpoints `src/spoolman.js` actually calls and nothing
 * else, so the service can complete its startup sequence, read the catalogue,
 * and create, merge and book spools without a database or a real Spoolman
 * anywhere near it. Everything is lost when the process ends, which is the
 * point: every run starts from the same scenario.
 *
 * It is not a Spoolman reimplementation. Validation is minimal and the numbers
 * it derives are the few the Web UI shows.
 */

/** Spoolman derives these on read, so the mock has to as well. */
function expandSpool(spool, filaments) {
    const filament = filaments.find(f => f.id === spool.filament_id) || null;
    const initial = Number(spool.initial_weight) || 0;
    const used = Number(spool.used_weight) || 0;
    const remaining = spool.remaining_weight != null
        ? Number(spool.remaining_weight)
        : Math.max(0, initial - used);

    return {
        id: spool.id,
        registered: spool.registered,
        first_used: spool.first_used ?? null,
        last_used: spool.last_used ?? null,
        filament,
        initial_weight: initial,
        spool_weight: filament?.spool_weight ?? 250,
        used_weight: used,
        remaining_weight: remaining,
        remaining_percentage: initial ? Math.round((remaining / initial) * 100) : 0,
        location: spool.location ?? null,
        lot_nr: spool.lot_nr ?? null,
        comment: spool.comment ?? null,
        archived: spool.archived ?? false,
        extra: spool.extra ?? {},
        tags: spool.tags ?? [],
    };
}

/**
 * Builds the mock and returns it with the state it holds, so the entry point
 * can report what changed while it was running.
 *
 * @param {(line: string) => void} log - where request lines go
 * @returns {{app: import("express").Express, store: object}}
 */
export function createMockSpoolman(log) {
    const store = {
        vendors: [{ id: 1, name: "Bambu Lab", external_id: "Bambu Lab", empty_spool_weight: 250 }],
        // Seeded with a vendor already attached, the way Spoolman returns them.
        filaments: SEED_FILAMENTS.map(f => ({ ...f, vendor: { id: 1, name: "Bambu Lab" } })),
        spools: SEED_SPOOLS.map(s => ({ ...s, registered: new Date().toISOString() })),
        extraFields: [{ name: "tag", key: "tag", field_type: "text", entity_type: "spool" }],
        // Everything the service wrote, so a run can be judged without reading
        // the service log next to it.
        writes: [],
    };

    let nextFilamentId = Math.max(...store.filaments.map(f => f.id)) + 1;
    let nextSpoolId = Math.max(...store.spools.map(s => s.id)) + 1;

    const app = express();
    app.use(express.json());

    app.use((req, _res, next) => {
        if (req.method !== "GET") {
            store.writes.push(`${req.method} ${req.path} ${JSON.stringify(req.body)}`);
            log(`${req.method} ${req.path} ${JSON.stringify(req.body)}`);
        }
        next();
    });

    app.get("/api/v1/health", (_req, res) => res.json({ status: "healthy" }));
    app.get("/api/v1/info", (_req, res) => res.json({ version: "0.27.1", debug_mode: false }));

    app.get("/api/v1/vendor", (_req, res) => res.json(store.vendors));
    app.post("/api/v1/vendor", (req, res) => {
        const vendor = { id: store.vendors.length + 1, empty_spool_weight: 250, ...req.body };
        store.vendors.push(vendor);
        res.status(201).json(vendor);
    });

    app.get("/api/v1/field/spool", (_req, res) => res.json(store.extraFields));
    app.post("/api/v1/field/spool/:key", (req, res) => {
        const field = { key: req.params.key, entity_type: "spool", ...req.body };
        store.extraFields.push(field);
        res.status(200).json(field);
    });

    // The SpoolmanDB proxy. This is where a multi colour filament gets its
    // colour set and the direction the UI draws it in.
    app.get("/api/v1/external/filament", (_req, res) => res.json(CATALOGUE));
    app.get("/api/v1/external/material", (_req, res) => res.json(EXTERNAL_MATERIALS));

    app.get("/api/v1/material", (_req, res) => res.json([...new Set(store.filaments.map(f => f.material))]));
    app.get("/api/v1/location", (_req, res) => res.json([...new Set(store.spools.map(s => s.location).filter(Boolean))]));

    app.get("/api/v1/filament", (_req, res) => res.json(store.filaments));
    app.post("/api/v1/filament", (req, res) => {
        const vendor = store.vendors.find(v => v.id === req.body.vendor_id) || null;
        const filament = { id: nextFilamentId++, ...req.body, vendor };
        store.filaments.push(filament);
        res.status(201).json(filament);
    });

    // Spoolman leaves archived spools out of this list unless they are asked
    // for. That is what archiving is for, and what the service's tag lookup for
    // an archived spool still sitting in a slot rests on, so the mock has to do
    // the same or the guard cannot be exercised here.
    app.get("/api/v1/spool", (req, res) => {
        const allowArchived = String(req.query.allow_archived) === "true";
        const spools = store.spools.filter(spool => allowArchived || !spool.archived);
        res.json(spools.map(s => expandSpool(s, store.filaments)));
    });
    app.post("/api/v1/spool", (req, res) => {
        const spool = { id: nextSpoolId++, registered: new Date().toISOString(), ...req.body };
        store.spools.push(spool);
        res.status(201).json(expandSpool(spool, store.filaments));
    });

    app.get("/api/v1/spool/:id", (req, res) => {
        const spool = store.spools.find(s => s.id === Number(req.params.id));
        if (!spool) return res.status(404).json({ message: "No spool with that id" });
        res.json(expandSpool(spool, store.filaments));
    });

    app.patch("/api/v1/spool/:id", (req, res) => {
        const spool = store.spools.find(s => s.id === Number(req.params.id));
        if (!spool) return res.status(404).json({ message: "No spool with that id" });

        // extra is merged rather than replaced, so patching the tag does not
        // drop whatever else a spool carries there.
        const { extra, ...rest } = req.body;
        Object.assign(spool, rest);
        if (extra) spool.extra = { ...spool.extra, ...extra };

        // Spoolman keeps the two sides of the same figure consistent: a written
        // remaining weight moves used_weight with it. Without this the mock
        // reports a spool as both refilled and fully used.
        if (rest.remaining_weight !== undefined) {
            const initial = Number(spool.initial_weight) || 0;
            spool.used_weight = Math.max(0, initial - Number(rest.remaining_weight));
        }

        res.json(expandSpool(spool, store.filaments));
    });

    // Native tags, as Spoolman 0.27.0 and newer hold them: uppercase without
    // separators, and one tag on one spool only. The 409 is what a migration
    // runs into when two records carry the same extra.tag.
    const normalizeUid = uid => String(uid ?? "").replace(/[\s:_-]/g, "").replace(/^0x/i, "").toUpperCase();

    app.post("/api/v1/spool/:id/tag", (req, res) => {
        const spool = store.spools.find(s => s.id === Number(req.params.id));
        if (!spool) return res.status(404).json({ message: "No spool with that id" });

        const uid = normalizeUid(req.body.uid);
        if (!uid) return res.status(422).json({ message: "The uid is empty" });

        const holder = store.spools.find(s => (s.tags ?? []).some(tag => tag.uid === uid));
        if (holder && holder !== spool) {
            return res.status(409).json({ message: `Tag ${uid} is already linked to spool ${holder.id}`, spool_id: holder.id, filament_id: null });
        }

        spool.tags = spool.tags ?? [];
        let tag = spool.tags.find(entry => entry.uid === uid);
        if (!tag) {
            tag = { uid, format: req.body.format ?? null, added: new Date().toISOString() };
            spool.tags.push(tag);
        }
        res.json(tag);
    });

    app.delete("/api/v1/spool/:id/tag/:uid", (req, res) => {
        const spool = store.spools.find(s => s.id === Number(req.params.id));
        if (!spool) return res.status(404).json({ message: "No spool with that id" });

        const uid = normalizeUid(req.params.uid);
        spool.tags = (spool.tags ?? []).filter(tag => tag.uid !== uid);
        res.json({ message: "Success" });
    });

    // The G-code booking path. Spoolman subtracts the grams itself, which is
    // why the service sends a delta rather than a computed remaining weight.
    app.put("/api/v1/spool/:id/use", (req, res) => {
        const spool = store.spools.find(s => s.id === Number(req.params.id));
        if (!spool) return res.status(404).json({ message: "No spool with that id" });

        const expanded = expandSpool(spool, store.filaments);
        spool.used_weight = expanded.used_weight + Number(req.body.use_weight || 0);
        spool.remaining_weight = Math.max(0, expanded.initial_weight - spool.used_weight);

        res.json(expandSpool(spool, store.filaments));
    });

    app.use((req, res) => {
        log(`unhandled ${req.method} ${req.path}`);
        res.status(404).json({ message: "Not implemented by the mock" });
    });

    return { app, store };
}
