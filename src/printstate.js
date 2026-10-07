import { printStatePath } from "./config.js";
import { readJsonFile, writeJsonFile } from "./jsonfile.js";

/**
 * When the print each printer is running started, kept on disk.
 *
 * No Bambu printer reports when its job began: the P2S, the P1S and the X1E
 * all send the state, the layer and the remaining minutes and nothing else
 * about time, so the service measures the start itself when it sees the state
 * go active. That measurement lived in memory only, and a restart of the
 * service during a print started the clock again: "Running for" on the
 * dashboard and the duration in the report were counted from the restart, not
 * from the print. Seen on a P2S on 2026-09-08 with a restart at layer 3.
 *
 * So the start is written here when a print begins and read back when the
 * service starts up and finds the printer already printing the same job. It is
 * forgotten when the print ends, so a later print of the same name starts its
 * own clock; a stored start older than a week is not trusted either, in case
 * the end was never seen.
 *
 * The path of the sliced file is kept next to the start once it is found.
 * A restart during a print whose file is not named after the job, a reprint
 * started on the printer's screen of a file that had been on the stick for
 * half an hour (P2S, 2026-10-02), had nothing to find it by: the printer's
 * `project_file` echo named it once, before the restart, and the listing by
 * time does not reach that far back. The path does.
 *
 * The slots of the running print are kept as well: the mapping the printer
 * last reported, the AMS refills it went through and the spool last seen in
 * each slot. All three lived in memory only, and a restart between a spool
 * running out and the end of the print booked everything on the backup spool,
 * because the slot that ran out reports empty and the refill was forgotten.
 * See `refillsBetween()` in gcode.js. Written when one of them changes, which
 * is a handful of times per print, not on every report.
 */

const SCHEMA_VERSION = 1;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let state = null;

function load() {
    if (state) return state;
    const parsed = readJsonFile(printStatePath);
    state = parsed && typeof parsed.printers === "object" && parsed.printers !== null ? parsed.printers : {};
    return state;
}

function persist() {
    writeJsonFile(printStatePath, { schemaVersion: SCHEMA_VERSION, printers: state });
}

/**
 * Records that a printer's job began.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` of the job
 * @param {number} startedAt - epoch milliseconds
 */
export function rememberPrintStart(printerId, jobName, startedAt) {
    load()[printerId] = { jobName: jobName ?? null, startedAt };
    persist();
}

/**
 * The entry recorded for a printer's job, if it is the same job and recent.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` the printer reports now
 * @returns {object|null} the stored entry, or null when nothing fits
 */
function currentEntry(printerId, jobName) {
    const entry = load()[printerId];
    if (!entry || typeof entry.startedAt !== "number") return null;
    if ((entry.jobName ?? null) !== (jobName ?? null)) return null;
    if (Date.now() - entry.startedAt > STALE_AFTER_MS || entry.startedAt > Date.now()) return null;
    return entry;
}

/**
 * The start recorded for a printer's job, if it is the same job and recent.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` the printer reports now
 * @returns {number|null} epoch milliseconds, or null when nothing fits
 */
export function recallPrintStart(printerId, jobName) {
    return currentEntry(printerId, jobName)?.startedAt ?? null;
}

/**
 * Records where the sliced file of the running job was found.
 *
 * Only for a job whose start is recorded: a path without a start would be
 * taken for a later print of the same name.
 *
 * @param {string} printerId - the printer's serial
 * @param {string} filePath - the FTPS path the file was read from
 */
export function rememberSlicedFile(printerId, filePath) {
    const entry = load()[printerId];
    if (!entry || typeof entry.startedAt !== "number" || !filePath) return;
    entry.filePath = filePath;
    persist();
}

/**
 * The path recorded for a printer's job, if it is the same job and recent.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` the printer reports now
 * @returns {string|null}
 */
export function recallSlicedFile(printerId, jobName) {
    const path = currentEntry(printerId, jobName)?.filePath;
    return typeof path === "string" && path ? path : null;
}

/**
 * Records the slots of the running job: the mapping, the refills and the spool
 * last seen in each slot.
 *
 * Only for a job whose start is recorded, for the reason `rememberSlicedFile()`
 * gives.
 *
 * @param {string} printerId - the printer's serial
 * @param {{mapping: (string|null)[]|null, refills: object[], slotSpools: object}} slots
 */
export function rememberPrintSlots(printerId, { mapping, refills, slotSpools }) {
    const entry = load()[printerId];
    if (!entry || typeof entry.startedAt !== "number") return;
    entry.slots = { mapping: mapping ?? null, refills: refills ?? [], slotSpools: slotSpools ?? {} };
    persist();
}

/**
 * The slots recorded for a printer's job, if it is the same job and recent.
 *
 * The file is edited by nobody but this module, but it is read after a crash
 * as well, so every part is checked and a part that does not have the shape
 * it was written in is dropped rather than trusted. An entry written before
 * this existed has no slots and gives null.
 *
 * @param {string} printerId - the printer's serial
 * @param {string|null} jobName - `subtask_name` the printer reports now
 * @returns {{mapping: (string|null)[]|null, refills: object[], slotSpools: object}|null}
 */
export function recallPrintSlots(printerId, jobName) {
    const slots = currentEntry(printerId, jobName)?.slots;
    if (!slots || typeof slots !== "object") return null;

    const mapping = Array.isArray(slots.mapping) && slots.mapping.every(s => s === null || typeof s === "string")
        ? slots.mapping
        : null;
    const refills = Array.isArray(slots.refills)
        ? slots.refills.filter(r => r && Number.isInteger(r.index) && typeof r.from === "string" && typeof r.to === "string" && Number.isFinite(r.layer))
        : [];
    const slotSpools = {};
    for (const [amsId, candidate] of Object.entries(slots.slotSpools && typeof slots.slotSpools === "object" ? slots.slotSpools : {})) {
        if (candidate && candidate.amsId === amsId && Number.isFinite(candidate.id)) slotSpools[amsId] = candidate;
    }
    return { mapping, refills, slotSpools };
}

/**
 * Drops the recorded start once the job has ended.
 *
 * @param {string} printerId - the printer's serial
 */
export function forgetPrintStart(printerId) {
    const table = load();
    if (!(printerId in table)) return;
    delete table[printerId];
    persist();
}

/** Test hook: forgets the loaded table so the next call reads the file again. */
export function resetPrintStateForTests() {
    state = null;
}
