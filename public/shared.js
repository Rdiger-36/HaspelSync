/**
 * The handful of pure decisions the dashboard and the server both have to make.
 *
 * It lives under `public/` because that is the half that cannot import from
 * anywhere else: the directory is served straight from disk, has no build step
 * and no dependencies, so a browser has to be able to load this file as it is.
 * The server has no such constraint and imports it from here, which is why the
 * arrow points this way rather than the other.
 *
 * Everything in here is a pure function of its arguments. Nothing touches the
 * DOM, the filesystem or the network, so `test/shared.test.js` can cover it
 * with plain `node:test` and both sides inherit the same cases.
 *
 * Whatever is added here has to keep working in both places: no Node built-ins,
 * no DOM, ES module syntax only.
 */

/**
 * A colour reduced to the six hex digits every side can compare.
 *
 * Slice colours arrive as "#000000", AMS colours as "000000FF" with a trailing
 * alpha byte, and Spoolman stores bare hex. Dropping the "#" and everything
 * past the sixth digit is what makes the three comparable at all. Case is left
 * to the caller, because the two sides settled on different ones long before
 * this file existed: see `normColor` and `slotColors` below.
 */
function bareHex(color) {
    return String(color).replace(/^#/, "").slice(0, 6);
}

/**
 * Normalises a colour to a bare 6-digit uppercase hex (no "#", no alpha) so
 * slice colours ("#000000") and AMS slot colours ("000000FF") compare equal.
 *
 * Uppercase because the consumption keys built from it are compared against
 * each other, never against a colour set from `slotColors()`.
 *
 * @param {*} c - anything a colour may arrive as
 * @returns {string} the normalised colour, or "" when there was none
 */
export function normColor(c) {
    if (!c) return "";
    return bareHex(c).toUpperCase();
}

/**
 * Every colour of an AMS slot, in the order the printer reported them.
 *
 * AMS colours carry a trailing alpha byte that no Spoolman or SpoolmanDB record
 * has, so every comparison has to drop it first. Reading `cols` rather than
 * `tray_color` is what makes a multi colour filament comparable at all: the
 * single field only ever holds the first colour, so it is the fallback for a
 * payload that predates `cols` rather than the value to read.
 *
 * "N/A" is the placeholder an unidentified slot reports, not a colour, and is
 * dropped rather than normalised into the string "N/A".
 *
 * Order is the one the printer reported, because it is the order the colours
 * sit on the filament and the order the UI draws them in. Callers comparing
 * colour sets sort a copy; Spoolman and SpoolmanDB do not agree on an order.
 *
 * Lowercase, because the sets it produces are compared against Spoolman and
 * SpoolmanDB records, which are lowercased to meet it. `normColor()` above is
 * the uppercase one and the two are never compared with each other.
 *
 * @param {object} slot - an AMS slot, normalised or raw
 * @returns {string[]} the colours, possibly empty
 */
export function slotColors(slot) {
    const raw = Array.isArray(slot?.cols) && slot.cols.length ? slot.cols : [slot?.tray_color];
    return raw
        .filter(color => color && color !== "N/A")
        .map(color => bareHex(color).toLowerCase());
}

/**
 * Every colour of a Spoolman filament, in the same shape and case as
 * `slotColors()` so the two can be compared directly.
 *
 * Single and multi colour records are mutually exclusive in Spoolman: a multi
 * colour filament carries its set in `multi_color_hexes` and no `color_hex` at
 * all. A trailing separator in that field yields an empty entry, which is
 * dropped rather than compared as a colour.
 *
 * @param {object} filament - a Spoolman filament record
 * @returns {string[]} the colours, possibly empty
 */
export function filamentColors(filament) {
    const raw = filament?.multi_color_hexes
        ? String(filament.multi_color_hexes).split(",")
        : [filament?.color_hex];
    return raw
        .filter(Boolean)
        .map(color => bareHex(color).toLowerCase());
}

/**
 * The remaining percentage of the spool that is actually in the slot.
 *
 * Bambu reports `remain` on a 1kg basis for regular colour filament, so a 500 g
 * spool that is half empty reports 25%. Support and accessory material
 * (`tray_type` suffix "-S", e.g. "PLA-S") is sold and measured at its real
 * spool size and is already relative to `tray_weight`, so rescaling it would be
 * wrong twice over.
 *
 * @param {number|string} remainOn1kgBasis - `remain` as the printer reports it
 * @param {number|string} trayWeight - the spool's real filament weight in grams
 * @param {string|null} trayType - `tray_type`, needed to spot support material
 * @returns {number|null} remaining percentage of the real spool, rounded, or
 *   null when the printer reported no usable value
 */
export function correctRemainInt(remainOn1kgBasis, trayWeight, trayType = null) {
    const remain = parseFloat(remainOn1kgBasis);
    // Unknown in, unknown out. The AMS reports no percentage for the first
    // seconds after a spool goes in, and every caller has to decide for itself
    // what to do without a reading; none of them may treat it as 0.
    if (!Number.isFinite(remain)) return null;

    const weight = parseFloat(trayWeight);
    const isSupportMaterial = typeof trayType === "string" && trayType.endsWith("-S");

    if (weight < 1000 && !isSupportMaterial) {
        const grams = (remain / 100) * 1000;
        let percent = (grams / weight) * 100;
        if (percent > 100) percent = 100;
        if (percent < 0) percent = 0;
        return Math.round(percent);
    }
    return Math.round(remain);
}

/**
 * The most filament a spool can hold, in grams, or null when nothing says.
 *
 * A remaining weight corrected by hand has to stay inside it: a spool cannot
 * hold more than its filament's full weight, and a number above that quietly
 * turns every percentage the dashboard shows into nonsense.
 *
 * The larger of the two candidates wins rather than the filament's alone. A
 * spool that was registered with more than the catalogue's full weight really
 * did hold that much, and refusing to write back a number the spool itself
 * reports would be the wrong way round.
 *
 * @param {object} spool - a whole Spoolman spool, with its filament embedded
 * @returns {number|null} the limit in grams, or null when neither is known
 */
export function spoolWeightLimit(spool) {
    const candidates = [spool?.filament?.weight, spool?.initial_weight]
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0);

    return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Formats a date for display as `DD.MM.YYYY HH:MM:SS`.
 *
 * The dashboard prints the timestamps the server sends and used to carry its
 * own copy of this, character for character the same as the one in `utils.js`.
 * Both read it from here now, so the two cannot drift into two formats for one
 * value.
 *
 * @param {Date} date - the date to format
 * @returns {string} the formatted timestamp
 */
export function formatDate(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * The text of a key in the viewer's language, or `english` when there is none.
 *
 * The browser loads `i18n.js` before this file and the server never does, so
 * `globalThis.I18N` is the one thing that tells the two apart. The server's log
 * lines stay English that way, and so does a page whose tables lack the key: a
 * key that is not known is answered in English here rather than shown as a key.
 *
 * @param {string} key - a `format.` key
 * @param {object} params - the placeholder values, `count` among them
 * @param {string} english - today's English text, exactly as it was
 * @returns {string}
 */
function translated(key, params, english) {
    const i18n = globalThis.I18N;
    if (!i18n?.has?.(key)) return english;
    return i18n.t(key, params);
}

/**
 * One unit of a duration, "5 hours", "1 Day", "14 min", "05 s".
 *
 * `value` may arrive padded, "05", and is written as it arrives; the plural is
 * picked by its number. Only days and hours have a plural in English.
 *
 * @param {"days"|"hours"|"min"|"s"} unit
 * @param {number|string} value
 * @returns {string}
 */
function durationUnit(unit, value) {
    const one = Number(value) === 1;
    const english = {
        days: `${value} ${one ? "Day" : "Days"}`,
        hours: `${value} ${one ? "hour" : "hours"}`,
        min: `${value} min`,
        s: `${value} s`,
    }[unit];
    return translated(`format.${unit}`, { count: value }, english);
}

/**
 * A running duration, in words: how long a print has been running, how long
 * its result still has before it clears itself, and how long a finished print
 * took.
 *
 *   under a minute  SS s                     05 s
 *   under an hour   M min SS s               14 min 50 s
 *   under a day     H hour(s) MM min SS s    1 hour 14 min 50 s
 *   a day and over  D Day(s) H hour(s) M min 2 Days 5 hours 13 min
 *
 * This was a clock, "14:50", until a screenshot of 2026-09-20 put it next to
 * "Started 19:14" and "Expected to end 19:30": three pairs of digits with a
 * colon on one line, and only one of them a duration. The units keep the
 * shapes apart. The remaining time next to it already spoke this way,
 * "~ 1 hour 30 min", so the words are its words.
 *
 * Seconds fall away once days are on the line: at that length they are noise,
 * and the label they sit in is rewritten every second anyway.
 *
 * The seconds are padded and the minutes and hours are not: a counter that
 * ticks every second must not move the text after it on every tick, and the
 * minutes only change width once, at the tenth minute. Padding the minutes
 * too would read "04 min", which is not how anyone writes a duration.
 */
export function formatCounter(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const pad = value => String(value).padStart(2, "0");

    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600) % 24;
    const days = Math.floor(total / 86400);

    const hourWord = durationUnit("hours", hours);
    const minuteWord = value => durationUnit("min", value);
    const secondWord = durationUnit("s", pad(seconds));
    if (days) return `${durationUnit("days", days)} ${hourWord} ${minuteWord(minutes)}`;
    if (total >= 3600) return `${hourWord} ${minuteWord(pad(minutes))} ${secondWord}`;
    if (total >= 60) return `${minuteWord(minutes)} ${secondWord}`;
    return secondWord;
}

/**
 * The time a print has left, at the precision the printer actually has.
 *
 * `mc_remaining_time` is reported in whole minutes and revised as the print
 * goes, so it is an estimate that moves. Rendered as a clock it read "03:00
 * left" and claimed a second hand the number does not have; the tilde and the
 * words say what it is.
 *
 * Zero is its own case. The printer sends it for the last stretch of a print,
 * and "~ 0 min" reads like a stopped clock.
 *
 * @param {number|null|undefined} minutes - `mc_remaining_time` from the report
 * @returns {string|null} the estimate, or null when there is none
 */
export function formatRemaining(minutes) {
    if (minutes == null) return null;
    if (minutes <= 0) return translated("format.lessThanMinute", {}, "< 1 min");

    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes / 60) % 24;
    const rest = minutes % 60;

    const parts = [];
    if (days) parts.push(durationUnit("days", days));
    if (hours) parts.push(durationUnit("hours", hours));
    // The minutes are dropped only when something larger carries the estimate
    // already, so "4 hours" stays "4 hours" rather than becoming "4 hours 0 min".
    if (rest || !parts.length) parts.push(durationUnit("min", rest));

    return `~ ${parts.join(" ")}`;
}

/**
 * Whether every moment of a print falls on today, which is the only case where
 * the times alone say when something happened.
 *
 * Asked once for the pair rather than per timestamp, so the two ends of a print
 * are always written the same way. A job that started yesterday and ends today
 * would otherwise read "02.09.2026 22:10" next to a bare "07:31", and the
 * short one is the half that needs the date most.
 *
 * @param {...(number|null|undefined)} moments - epoch milliseconds
 * @returns {boolean} whether all of them are today, and none is missing
 */
export function allToday(...moments) {
    const today = new Date().toDateString();
    return moments.every(at => at != null && new Date(at).toDateString() === today);
}

/**
 * One end of a print: the time of day while it all happens today, and the date
 * in front of it as soon as it does not.
 *
 * Never with seconds. The expected end is "now plus the printer's whole
 * minutes", so its seconds are the clock's at the moment of the request and
 * were counting up with every refresh of the dashboard; and a start or an end
 * is read as a time of day, where a second hand says nothing the duration
 * next to it does not say better.
 *
 * `withDate` is the answer allToday() gave for the whole pair, not a question
 * about this one timestamp.
 *
 * @param {number} at - epoch milliseconds
 * @param {boolean} withDate - whether to spell out the date
 * @returns {string} the moment
 */
export function formatMoment(at, withDate) {
    const date = new Date(at);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (!withDate) return time;

    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}.${date.getFullYear()} ${time}`;
}

/**
 * The unit ids the external spool holders are addressed under, and the labels
 * they produce. The printer reports a holder as `print.vt_tray` or as an entry
 * of `print.vir_slot` carrying `id` 255 or 254, so the numbers are the
 * printer's rather than an invention.
 *
 * A dual nozzle printer (H2C, H2D, X2D) has two holders and reports both, 255
 * and 254. Read off the H2D and H2C reports in test/fixtures/reports:
 * `device.extruder.info[1]`, the second extruder, names its current slot as
 * 0xFEFF, unit 254, while the first extruder's holder is 255. The one every
 * printer has keeps its label, so nothing on disk moves for a single nozzle
 * printer; the second is "External-2", numbered rather than sided because the
 * report says which extruder it feeds and not where it sits.
 *
 * A single nozzle printer reports its one holder under either id, 255 on a
 * P2S and an X1C, 254 on an A1, a P1P and a P1S, which is why
 * `externalSpoolUnits()` in src/mqtt.js labels by how many holders are
 * reported and not by the id alone.
 *
 * The labels are not only shown: they are the keys an assignment is stored
 * under in `mappings.json`, and they are what tells the dashboard that these
 * slots belong to no four slot unit and need a table of their own. Changing one
 * orphans what is on disk, which is why both sides read the same constants.
 */
export const EXTERNAL_SPOOL_ID = 255;
export const EXTERNAL_SLOT = "External";
export const SECOND_EXTERNAL_SPOOL_ID = 254;
export const SECOND_EXTERNAL_SLOT = "External-2";

/** The label of a holder by its unit id, null for anything that is not one. */
export function externalSlotLabel(unitId) {
    const id = Number(unitId);
    if (id === EXTERNAL_SPOOL_ID) return EXTERNAL_SLOT;
    if (id === SECOND_EXTERNAL_SPOOL_ID) return SECOND_EXTERNAL_SLOT;
    return null;
}

/**
 * The Spoolman location written for a spool in a slot, and the template it is
 * built from.
 *
 * `{printer}` is required: it is what tells the locations of one printer from
 * those of another and from the ones a user typed by hand, so a template
 * without it would let the service clear or rewrite locations it never wrote.
 * The settings validation refuses such a template, and one that slipped past it
 * (a hand edited settings file) falls back to the default here.
 */
export const DEFAULT_LOCATION_FORMAT = "{printer} - {slot}";

/** The template to build locations from, the default when `format` is unusable. */
export function effectiveLocationFormat(format) {
    return typeof format === "string" && format.includes("{printer}") ? format : DEFAULT_LOCATION_FORMAT;
}

/**
 * The location of a spool in `slot` of `printerName`, built from `format`.
 *
 * The server writes this string and the create spool dialog suggests it, so
 * both have to build it here.
 *
 * @param {string|null} format - the LOCATION_FORMAT setting
 * @param {string} printerName - the printer's display name
 * @param {string} slot - slot label, e.g. "A1", "HT-A" or "External"
 * @returns {string} the location
 */
export function slotLocation(format, printerName, slot) {
    return effectiveLocationFormat(format)
        .replaceAll("{printer}", printerName)
        .replaceAll("{slot}", slot);
}

/**
 * Whether `location` could have been built from `format` for this printer.
 *
 * The slot is a wildcard, so a spool moved from A1 to A2 still carries a
 * location that is ours until the new slot is written. It only matches what a
 * slot label consists of (letters, digits and the hyphen of `HT-A` and
 * `External-2`), never a space, so `X 2 A1` is not a location of printer `X`
 * under `{printer} {slot}`, and a name that merely starts like this printer's
 * does not match either: the whole string has to fit.
 *
 * @param {string|null|undefined} location - the spool's current location
 * @param {string|null} format - the template it would have been written with
 * @param {string} printerName - the printer's display name
 * @returns {boolean}
 */
export function matchesLocationFormat(location, format, printerName) {
    if (!location || !printerName) return false;
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = effectiveLocationFormat(format)
        .split(/(\{printer\}|\{slot\})/)
        .map(part => part === "{printer}" ? escape(printerName) : part === "{slot}" ? "[A-Za-z0-9-]+" : escape(part))
        .join("");
    return new RegExp(`^${pattern}$`).test(location);
}

/**
 * The print states in which a job is in flight.
 *
 * Its consumption is booked only when it ends, so both sides have to know them:
 * the server refuses to reconnect, restart or take a corrected weight while one
 * of these is on, and the detail dialog does not offer the correction in the
 * first place. Two lists would let the dialog offer what the route then refuses.
 */
export const ACTIVE_PRINT_STATES = ["PREPARE", "RUNNING", "PAUSE"];

/**
 * The layer counter as a person reads it, from two numbers that do not count
 * the same way.
 *
 * `totalLayers` comes out of the sliced file, where parseSliceInfo() takes it
 * from the highest index in `layer_ranges`: a 25 there means the layers 0 to
 * 25, so 26 of them. One is added to it, and that is the only correction here.
 *
 * `layerNum` comes from MQTT and is already a count, so it is shown as it
 * stands. Measured across a whole print on a P2S through the raw MQTT capture:
 * on a plate of 15 layers it ran 0, 1, 2 … 15 and stayed at 15 through FINISH.
 * A 0-based index of the layer being printed could never reach 15 when the
 * highest index in the sliced file is 14, so the field is not that. It is
 * either the layers completed or a 1-based current layer, and both are read the
 * same way off the wire.
 *
 * This used to add one to it as well, on the strength of that 0-based reading,
 * and the dashboard then sat one ahead of the printer's own display and of
 * Bambu Studio for the whole print: 1 / 15 while both of them said 0 / 15.
 * The cap hid it at the end, which is why it survived the fix that put the cap
 * there.
 *
 * Nothing is allowed past the total either way: a layer after the last one does
 * not exist under any reading of the field.
 *
 * Lives here rather than in the dashboard because it was nowhere written down
 * when it broke. Note that `calcPartialConsumption()` reads the same field as an
 * inclusive 0-based index into the layer ranges, which is the other reading; it
 * only runs on a cancelled or failed print and has not been measured against
 * one.
 *
 * @param {number|null|undefined} layerNum - `layer_num` from MQTT, a count
 * @param {number|null|undefined} totalLayers - `totalLayers` from the slice, a
 *   highest index rather than a count
 * @returns {{layer: number, total: number|null, percent: number|null}}
 */
export function humanLayers(layerNum, totalLayers) {
    const total = totalLayers != null ? totalLayers + 1 : null;
    const counted = layerNum ?? 0;
    const layer = total != null ? Math.min(counted, total) : counted;

    return { layer, total, percent: total ? Math.round((layer / total) * 100) : null };
}

/**
 * The actions a slot can offer, as `option` on the UI spool.
 *
 * The server decides which one a slot gets and the dashboard turns it into a
 * button label, so the string is a contract between the two rather than a piece
 * of UI copy. It was spelled out at nine places across both sides, where a typo
 * on either one silently produces a dead button.
 */
export const SLOT_OPTIONS = {
    NONE: "No actions available",
    WAITING: "Waiting for data",
    CREATE: "Create Spool",
    CREATE_WITH_FILAMENT: "Create Filament & Spool",
    MERGE: "Merge Spool",
    ASSIGN: "Assign Spool",
    UNASSIGN: "Unassign Spool",
    SHOW_INFO: "Show Info!",
};
