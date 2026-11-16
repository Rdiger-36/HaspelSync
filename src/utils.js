import { materialFamily } from "../public/materials.js";
// Imported rather than only re-exported: `convertAMSandSlot()` below reads them,
// and a bare re-export does not bring a name into this module's scope.
import { EXTERNAL_SPOOL_ID, EXTERNAL_SLOT, SECOND_EXTERNAL_SPOOL_ID, SECOND_EXTERNAL_SLOT, externalSlotLabel, isExternalSlot, AMS_3H_UNIT_ID, AMS_3H_LETTER, AMS_3H_SLOTS } from "../public/shared.js";

/** Resolves after the given number of milliseconds. */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Formats a date for display as `DD.MM.YYYY HH:MM:SS`.
 *
 * In `public/shared.js` because the dashboard prints the same timestamps and
 * used to carry its own copy. Re-exported so the callers here keep their import.
 */
export { formatDate } from "../public/shared.js";

/**
 * Formats a date for a log line as `YYYY-MM-DD_HH:MM:SS`.
 *
 * Sorts lexicographically, unlike formatDate, which is why log timestamps use
 * this variant and the UI uses the other.
 */
export function formatDateLog(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}_${hours}:${minutes}:${seconds}`;
}

/** Formats a millisecond duration as a readable interval, e.g. "2 minute(s) 5 second(s)". */
export function formatInterval(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0 && seconds > 0) return `${minutes} minute(s) ${seconds} second(s)`;
    if (minutes > 0) return `${minutes} minute(s)`;
    return `${seconds} second(s)`;
}

/**
 * Turns the numeric AMS unit and slot ids from MQTT into the slot label used
 * throughout the UI, the logs and the mapping file.
 *
 * Regular AMS units are 0 to 3 and carry four slots each, giving `A1` to `D4`.
 * The single slot AMS HT units are 128 to 135 and have no slot number of their
 * own, giving `HT-A` to `HT-H`. 255 is the external spool holder, which the
 * printer reports outside the AMS block altogether and which has no slot number
 * either, giving `External`; 254 is the second holder of a dual nozzle printer,
 * giving `External-2`, see `public/shared.js` for where that number comes from.
 * The AMS 3H of an H3C is unit 32 with nine slots, giving `E1` to `E9`
 * (issue #262). The letter is fixed to the unit id rather than to the order of
 * the units, because extra AMS units hang off the first tool of an H3C as units
 * 0 to 3 and keep `A` to `D`. A slot beyond the ninth is not a slot of that
 * unit and yields `Z`. 247 to 253 are the further holders of the H3C, one per
 * tool, see `externalSlotLabel()` in `public/shared.js`.
 * Anything outside those ranges yields `Z`, which marks a unit this service
 * does not know how to address.
 *
 * The slot number is the printer's, not the payload's: MQTT counts a unit's
 * slots from 0, while the printer's own display, its touchscreen and Bambu
 * Studio all count them from 1. The label is read next to that hardware, so it
 * says what the hardware says.
 *
 * The label is not only shown: it is the key an assignment is stored under in
 * `mappings.json`, so changing one orphans the assignments already on disk.
 * `migrateStored()` in `mappings.js` renumbers the keys written before this.
 *
 * @param {number|string} amsID  - AMS unit id from `print.ams.ams[].id`
 * @param {number|string|null} slotID - slot id within the unit, null for none
 * @returns {string} the slot label
 */
export function convertAMSandSlot(amsID, slotID) {
    amsID = Number(amsID);
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];

    // Anything that is not a slot number leaves the label without one, which is
    // how a whole unit is named: `convertAMSandSlot(0, null)` is "A".
    const number = Number(slotID);
    const slot = slotID === null || slotID === "" || !Number.isFinite(number) ? "" : number + 1;

    if (amsID >= 0 && amsID <= 3) return letters[amsID] + slot;
    if (amsID === AMS_3H_UNIT_ID) {
        if (slot !== "" && slot > AMS_3H_SLOTS) return "Z";
        return AMS_3H_LETTER + slot;
    }
    if (amsID >= 128 && amsID <= 135) return `HT-${letters[amsID - 128]}`;
    return externalSlotLabel(amsID) ?? "Z";
}

/**
 * The slot whose filament sits in the nozzle that prints, read off one report.
 *
 * Two encodings are in the wild. A printer with `device.extruder.info` names
 * the loaded slot per nozzle in `snow`: the unit id in the high byte and the
 * slot in the low one, 0xFF in the low byte for an empty nozzle. Which nozzle
 * prints is bits 4 to 7 of `device.extruder.state`, which is how an H2D with
 * a spool in either nozzle tells the two apart. `ams.tray_now` is the older
 * field and the only one an A1, a P1 or an X1 sends: four slots per unit
 * packed into one number, 128 and up for an AMS HT, 254 for the external
 * holder and 255 for nothing. On a dual nozzle printer it loses the unit, so
 * `snow` wins wherever it is present. Both decodings follow ha-bambulab, which
 * has seen the most hardware.
 *
 * The H3C sends both, and its `tray_now` is the slot within its one unit 32:
 * "2" while `snow` said 8194, unit 32 slot 2, which `tray_now` would have read
 * as A3 (issue #262). So once a printer has named its slot through `snow`,
 * `tray_now` is not read for it any more, which the caller tracks as
 * `fromSnow` on the answer and hands back as `snowSeen`.
 *
 * A report that carries neither, which is what a delta report mostly is, says
 * nothing: `undefined` rather than null, so the caller keeps what it had.
 *
 * @param {object} print - the `print` block of a report
 * @param {number} lastNozzle - the printing nozzle the last report named
 * @param {boolean} [snowSeen] - whether an earlier report of this printer carried `snow`
 * @returns {{slot: string|null, nozzle: number, fromSnow: boolean}|undefined}
 */
export function activeSlotFromReport(print, lastNozzle = 0, snowSeen = false) {
    const extruder = print?.device?.extruder;
    const state = Number(extruder?.state);
    const nozzle = Number.isFinite(state) && extruder?.state != null ? (state >> 4) & 0xF : lastNozzle;

    if (Array.isArray(extruder?.info) && extruder.info.length) {
        const entry = extruder.info.find(info => Number(info?.id) === nozzle);
        const snow = Number(entry?.snow);
        if (!entry || !Number.isFinite(snow)) return { slot: null, nozzle, fromSnow: true };
        const unit = snow >> 8;
        const slot = snow & 0xFF;
        if (slot === 0xFF) return { slot: null, nozzle, fromSnow: true };
        return { slot: snowSlotLabel(unit, slot), nozzle, fromSnow: true };
    }

    if (snowSeen || print?.ams?.tray_now == null) return undefined;
    const trayNow = Number(print.ams.tray_now);
    if (!Number.isFinite(trayNow) || trayNow === 255) return { slot: null, nozzle, fromSnow: false };
    if (trayNow === 254) return { slot: convertAMSandSlot(EXTERNAL_SPOOL_ID, null), nozzle, fromSnow: false };
    if (trayNow >= 128) return { slot: convertAMSandSlot(trayNow, null), nozzle, fromSnow: false };
    return { slot: convertAMSandSlot(trayNow >> 2, trayNow & 0x3), nozzle, fromSnow: false };
}

/**
 * The label of the slot a `snow` value names, null where it names none.
 *
 * Only a unit with numbered slots passes its slot on: an AMS HT and a holder
 * have one slot each and their label carries no number. The four slot units
 * keep the mask they always had, the AMS 3H gets its slot as it is, because a
 * mask to four would turn its ninth slot into its first.
 */
function snowSlotLabel(unit, slot) {
    if (unit <= 3) return convertAMSandSlot(unit, slot & 0x3);
    if (unit === AMS_3H_UNIT_ID) {
        const label = convertAMSandSlot(unit, slot);
        return label === "Z" ? null : label;
    }
    return convertAMSandSlot(unit, null);
}

/**
 * The unit id the external spool holder is addressed under, and the label it
 * produces.
 *
 * In `public/shared.js` as well: the dashboard has to know which slots stand
 * alone rather than filling a four slot unit, and it had the label as a second
 * constant of its own. The label is the key an assignment is stored under, so
 * the two drifting apart orphans what is on disk.
 */
export { EXTERNAL_SPOOL_ID, EXTERNAL_SLOT, SECOND_EXTERNAL_SPOOL_ID, SECOND_EXTERNAL_SLOT, externalSlotLabel, isExternalSlot, AMS_3H_UNIT_ID, AMS_3H_LETTER, AMS_3H_SLOTS };

/**
 * The colour set of an AMS slot as bare six digit lowercase hex, and the colour
 * set of a Spoolman filament in the same shape.
 *
 * Both live in `public/shared.js`, because the dashboard draws the same swatches
 * from the same payloads and used to answer this with a second implementation.
 * Re-exported from here so that the callers in `ams.js`, `mappings.js` and
 * `uispool.js` keep their import: `ams.js` imports `uispool.js`, so an export in
 * `ams.js` itself would close an import cycle between the two.
 */
export { slotColors, filamentColors } from "../public/shared.js";

/**
 * Turns the "N/A" placeholder into a real absence.
 *
 * `processData()` writes that literal into every field the printer left out,
 * because the backend branches on it. It is a marker, not a value: a client
 * that receives it renders it, which is how an emptied slot came to be labelled
 * "N/A" and how its colour swatch ended up styled `#N/A`. An empty string is
 * squashed for the same reason.
 *
 * It lives here because both readers need it and have to agree. `toClientSpool()`
 * has already turned the marker into null by the time the dashboard route builds
 * its candidates, while `consumptionCandidate()` is also called on the runtime
 * shape, which still carries it: two implementations would key one slot two ways
 * depending on which side asked.
 *
 * @param {*} value - a field of an AMS slot
 * @returns {*} the value, or null where there was none
 */
export function orNull(value) {
    return value === "N/A" || value === "" || value == null ? null : value;
}

/**
 * The upper bound for a remaining weight corrected by hand.
 *
 * Also in `public/shared.js`: the detail dialog refuses the same number before
 * it is sent, so the message the user reads and the rule the route enforces
 * cannot drift apart.
 */
export { spoolWeightLimit } from "../public/shared.js";

/**
 * The slot actions and the active print states, both of them agreements between
 * this side and the dashboard rather than values of one side alone.
 *
 * In `public/shared.js` for the reason the colour helpers are: the browser has
 * to be able to load them unbuilt. Re-exported here so a module under `src/`
 * has one place to import from.
 */
export { SLOT_OPTIONS, ACTIVE_PRINT_STATES } from "../public/shared.js";

/**
 * The material family rules the dashboard uses, so the catalogue query answers
 * with what the dialog would consider a fitting material.
 */
export { materialFamily } from "../public/materials.js";

/**
 * The catalogue fields the create-spool dialog reads. The whole record carries
 * pattern, finish, translucency and more that the dialog has no field for, and
 * the catalogue is seven thousand entries long, so what leaves the server is
 * narrowed the way `uispool.js` narrows a slot.
 */
function pickCatalogueEntry(filament) {
    return {
        id: filament.id ?? null,
        manufacturer: filament.manufacturer ?? null,
        name: filament.name ?? null,
        material: filament.material ?? null,
        density: filament.density ?? null,
        diameter: filament.diameter ?? null,
        weight: filament.weight ?? null,
        spool_weight: filament.spool_weight ?? null,
        // Kept because the same filament is listed once per spool it is sold
        // on, and the type is part of what tells those entries apart.
        spool_type: filament.spool_type ?? null,
        extruder_temp: filament.extruder_temp ?? null,
        bed_temp: filament.bed_temp ?? null,
        color_hex: filament.color_hex ?? null,
        color_hexes: filament.color_hexes ?? null,
        multi_color_direction: filament.multi_color_direction ?? null,
    };
}

/**
 * Whether a catalogue entry fits the manufacturer, material and search term of
 * a query. A field the query leaves out does not narrow anything.
 *
 * The material is compared by family, so a slot reporting "PLA" also finds the
 * catalogue's "PLA+" and "PLA Matte" entries, which is where most of the useful
 * suggestions sit.
 */
function catalogueMatches(entry, { manufacturer, material, q } = {}) {
    const text = (value) => String(value ?? "").trim().toLowerCase();
    const byVendor = text(manufacturer);
    const byMaterial = materialFamily(material);
    const term = text(q);

    if (byVendor && text(entry.manufacturer) !== byVendor) return false;
    if (byMaterial && materialFamily(entry.material) !== byMaterial) return false;
    if (term && ![entry.manufacturer, entry.name, entry.material].some(field => text(field).includes(term))) return false;

    return true;
}

/**
 * The catalogue entries that fit a manufacturer, a material and a search term.
 *
 * Filtering happens here rather than in the browser: the catalogue is a few
 * megabytes, and the dialog asks for it again whenever the manufacturer or the
 * material changes.
 *
 * @param {object[]} entries - the catalogue as Spoolman serves it
 * @param {object} query - manufacturer, material, q and limit, all optional
 * @returns {object[]} the narrowed matches, at most `limit` of them
 */
export function filterCatalogue(entries, query = {}) {
    const limit = Math.max(1, Math.min(Number(query.limit) || 100, 500));

    return (entries || [])
        .filter(entry => catalogueMatches(entry, query))
        .slice(0, limit)
        .map(pickCatalogueEntry);
}

/**
 * The distinct manufacturers, or materials, left in the catalogue once the rest
 * of the query has been applied.
 *
 * This is what lets the create-spool dialog narrow down in steps: pick a
 * manufacturer, and the material list holds only what that manufacturer sells.
 * The field being listed does not filter itself, otherwise choosing a value
 * would leave that value as the only remaining choice.
 *
 * @param {object[]} entries - the catalogue as Spoolman serves it
 * @param {"manufacturer"|"material"} field - the field to list
 * @param {object} query - the rest of the query, all parts optional
 * @returns {string[]} the distinct values, sorted
 */
export function catalogueFacet(entries, field, query = {}) {
    const rest = { ...query };
    delete rest[field];
    delete rest.limit;

    const values = (entries || [])
        .filter(entry => catalogueMatches(entry, rest))
        .map(entry => entry[field])
        .filter(Boolean);

    return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}

/**
 * Whether a spool counts as empty, and may therefore be archived.
 *
 * The weight comes from Spoolman, never from the AMS remain percentage: the
 * percentage is an estimate the RFID chip reports and it reaches 0 while there
 * is still filament on the spool, which would archive a spool the user is still
 * printing from. What Spoolman holds is what this service booked, so it is the
 * only number an irreversible looking action may rest on.
 *
 * A missing weight is never empty. Spoolman leaves `remaining_weight` null for
 * a spool whose filament has no weight recorded, and "unknown" must not read as
 * "used up".
 *
 * @param {number|null|undefined} remainingWeight - grams Spoolman holds
 * @param {number} threshold - grams at or below which the spool counts as empty
 * @returns {boolean}
 */
export function spoolIsEmpty(remainingWeight, threshold = 0) {
    const grams = typeof remainingWeight === "number" ? remainingWeight : Number.NaN;
    if (!Number.isFinite(grams)) return false;

    const limit = Number(threshold);
    return grams <= (Number.isFinite(limit) ? limit : 0);
}

/**
 * How long to wait before the next reachability check of an offline printer.
 *
 * A printer that is switched off more often than it is on was checked at the
 * same pace forever, which is one failed connection and one log line every
 * interval, all day. The wait doubles from the check interval up to a limit, so
 * a printer that is off for the evening is asked a handful of times rather than
 * hundreds, and one that comes back is still found within that limit.
 *
 * The first failure waits the base interval, which is what keeps a printer that
 * dropped off for a moment coming back as fast as it did before.
 *
 * @param {number} failures - consecutive failed checks so far, zero on the first
 * @param {number} base - the configured offline check interval, in ms
 * @param {number} limit - the longest wait to grow to, in ms
 * @returns {number} milliseconds to wait before the next check
 */
export function offlineBackoff(failures, base, limit) {
    const start = Number(base) > 0 ? Number(base) : 20000;
    const max = Number(limit) > 0 ? Math.max(Number(limit), start) : start;
    const steps = Number.isFinite(Number(failures)) ? Math.max(0, Math.floor(Number(failures))) : 0;

    // 2 ** steps overflows into Infinity for a printer that has been off for
    // weeks, and Math.min() with it is still the limit, but the intermediate
    // multiplication is capped rather than relied on.
    if (steps > 30) return max;
    return Math.min(start * 2 ** steps, max);
}

/**
 * A short sentence for a failed connection, from the error Node hands back.
 *
 * The same four causes are told apart wherever this service opens a socket,
 * MQTT on 8883, FTPS on 990 and Spoolman over HTTP, and each place used to
 * carry its own copy of the table. The port and the hint are the caller's,
 * the mapping is shared.
 *
 * @param {Error|string} err - the error, or its message
 * @param {object} [options]
 * @param {number|string} [options.port] - named in the refused and timeout sentences
 * @param {string} [options.timeoutHint] - appended to the timeout sentence
 * @param {string} [options.refusedHint] - appended to the refused sentence
 * @returns {string|null} the sentence, or null when the cause is not one of the four
 */
export function describeConnectionError(err, { port = null, timeoutHint = "", refusedHint = "" } = {}) {
    const message = err?.message || String(err ?? "");
    const where = port ? `Port ${port}` : "The connection";
    if (/ECONNREFUSED/.test(message)) return `${port ? `${where} refused the connection` : "The connection was refused"}${refusedHint ? `. ${refusedHint}` : ""}`;
    if (/ETIMEDOUT|timeout/i.test(message)) return `No answer${port ? ` on port ${port}` : ""} within the timeout${timeoutHint ? `. ${timeoutHint}` : ""}`;
    if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return "The address cannot be reached";
    if (/ENOTFOUND|EAI_AGAIN/.test(message)) return "The host name cannot be resolved";
    return null;
}

/**
 * The same four causes as `describeConnectionError()`, as a code and the
 * values the sentence names, for the Web UI to word in its own language. The
 * code carries which of the known hints the sentence ends with: `Mqtt` for
 * the LAN mode question on 8883, `Ftps` for the FTP access question on 990.
 *
 * @param {Error|string} err - the error, or its message
 * @param {number|string|null} [port] - the port, as the caller names it to describeConnectionError()
 * @returns {{code: string, params: object}|null}
 */
export function connectionErrorCode(err, port = null) {
    const message = err?.message || String(err ?? "");
    const hint = Number(port) === 8883 ? "Mqtt" : Number(port) === 990 ? "Ftps" : "";
    const params = port ? { port } : {};
    if (/ECONNREFUSED/.test(message)) return { code: `connection.refused${port ? "" : "Anywhere"}${hint === "Ftps" ? "Ftps" : ""}`, params };
    if (/ETIMEDOUT|timeout/i.test(message)) return { code: `connection.timeout${port ? "" : "Anywhere"}${hint === "Mqtt" ? "Mqtt" : ""}`, params };
    if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return { code: "connection.unreachable", params: {} };
    if (/ENOTFOUND|EAI_AGAIN/.test(message)) return { code: "connection.unresolved", params: {} };
    return null;
}

/**
 * The value `print.mapping` uses for a filament the plate does not print.
 * Decoding it would otherwise read as unit 255 slot 255 and name the external
 * spool holder, which is unit 255 slot 0.
 */
const MAPPING_UNUSED = 0xFFFF;

/**
 * The slots a printer says a print is actually taking its filaments from.
 *
 * `print.mapping` is the printer's own answer to the question `orderedAmsSlots`
 * can only estimate, and it is the better one twice over: it needs no
 * assumption about how the slicer numbers its list, and it is the assignment
 * after any remapping the printer did when the job was sent, not the slicer's
 * intention before it.
 *
 * One entry per filament of the slicer's project, in the same order, so the
 * result drops straight into `resolveSliceSlots()`. Each is the unit in the
 * high byte and the slot in the low one: 0x0100 is B1, 0x0002 is A3, 0xFF00 is
 * the external holder, and 0xFFFF means the plate does not use that filament.
 * Both bytes count from 0, while the labels count a unit's slots from 1, which
 * is what `convertAMSandSlot()` is doing to the low byte.
 *
 * Read off a P2S across two prints, where all seven entries matched the slots
 * the print was really running from, including the holder and the unused
 * marker.
 *
 * A unit this service cannot address yields null rather than a label, so the
 * caller treats it as unknown instead of booking onto whatever "Z" would name.
 *
 * @param {number[]|undefined} mapping - `print.mapping` from an MQTT report
 * @returns {string[]|null} slot labels by filament index, null when not reported
 */
export function decodePrintMapping(mapping) {
    if (!Array.isArray(mapping) || !mapping.length) return null;

    return mapping.map(value => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number === MAPPING_UNUSED) return null;

        const label = convertAMSandSlot(number >> 8, number & 0xFF);
        return label === "Z" ? null : label;
    });
}
