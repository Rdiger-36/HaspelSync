import { settings } from "./settings.js";
import { patchSpoolLocation, getSpoolmanSpool } from "./spoolman.js";
import { DEFAULT_LOCATION_FORMAT, matchesLocationFormat, slotLocation as buildSlotLocation } from "../public/shared.js";

/**
 * The Spoolman location of a spool sitting in an AMS slot.
 *
 * Everything that writes a location goes through this, so the string the
 * service writes and the one the "new spool" dialog suggests cannot drift
 * apart. Both build it with `slotLocation()` from `public/shared.js`, from the
 * `LOCATION_FORMAT` setting.
 *
 * @param {string} printerName - the printer's display name
 * @param {string} amsId - slot label, e.g. "A1", "HT-A" or "External"
 * @returns {string} the location to store in Spoolman
 */
export function slotLocation(printerName, amsId) {
    return buildSlotLocation(settings.LOCATION_FORMAT, printerName, amsId);
}

/**
 * Whether a stored location was written by this service for this printer.
 *
 * The clearing paths used to patch an empty string onto any spool that left a
 * slot, which wiped locations the user had set by hand ("Shelf A") for no
 * reason other than the spool having been in an AMS once. A location is only
 * ours to clear when it fits the template with this printer's name in it, so
 * anything else survives.
 *
 * The slot part is not checked: a spool moved from A1 to A2 carries
 * `Printer - A1` until the new slot is written, and that is still ours.
 *
 * The default template counts as well, whatever the setting says. It was the
 * only format before the setting existed, so every installation carries
 * locations written with it, and a spool taken out after the template was
 * changed would otherwise keep its old location for good.
 *
 * @param {string|null|undefined} location - the spool's current location
 * @param {string} printerName - the printer whose slot released the spool
 * @param {string|null} [format] - the template to test, the current one by default
 * @returns {boolean} whether the location may be cleared
 */
export function ownsLocation(location, printerName, format = settings.LOCATION_FORMAT) {
    return matchesLocationFormat(location, format, printerName)
        || matchesLocationFormat(location, DEFAULT_LOCATION_FORMAT, printerName);
}

/**
 * Writes a slot's location onto a spool, unless it already says that.
 *
 * Skipping the equal case matters: this is called from every AMS update, and
 * Spoolman would otherwise see a PATCH per slot per update for a shelf full of
 * spools that never moved.
 *
 * Failures are logged and swallowed. A location is a convenience, and losing
 * it must not abort the slot processing that carries the weights.
 *
 * @param {object} printer - the printer runtime object
 * @param {string} amsId - slot label
 * @param {object|null} spool - the Spoolman spool now in the slot
 * @returns {Promise<boolean>} whether a write happened
 */
export async function claimSlotLocation(printer, amsId, spool) {
    if (!settings.SET_LOCATION || !spool?.id) return false;

    const target = slotLocation(printer.name, amsId);
    if (spool.location === target) return false;

    try {
        await patchSpoolLocation(spool.id, target);
        // The record the caller holds is reused for the rest of this update and
        // cached as `printer.spoolData`, so it has to carry what was written.
        spool.location = target;
        console.log(printer.name, printer.logFilePath, `    Set location "${target}" for Spool-ID ${spool.id}`);
        return true;
    } catch (err) {
        console.error(printer.name, printer.logFilePath, `    Failed to set location for Spool-ID ${spool.id}:`, err.message);
        return false;
    }
}

/**
 * Clears a spool's location when it left a slot of this printer.
 *
 * A spool whose location points somewhere else is left alone, see
 * `ownsLocation()`.
 *
 * @param {object} printer - the printer runtime object
 * @param {object|null} spool - the Spoolman spool that left the slot
 * @returns {Promise<boolean>} whether a write happened
 */
export async function releaseSlotLocation(printer, spool) {
    if (!settings.SET_LOCATION || !spool?.id) return false;
    if (!ownsLocation(spool.location, printer.name)) return false;

    try {
        await patchSpoolLocation(spool.id, "");
        spool.location = "";
        console.log(printer.name, printer.logFilePath, `    Cleared location for Spool-ID ${spool.id}`);
        return true;
    } catch (err) {
        console.error(printer.name, printer.logFilePath, `    Failed to clear location for Spool-ID ${spool.id}:`, err.message);
        return false;
    }
}

/**
 * Collects the location changes of one AMS update and applies them at the end.
 *
 * Writing them as the slots are walked was wrong for the case a spool changes
 * slot: moving one from A2 to A1 wrote `Printer - A1` while A1 was processed
 * and then, one slot later, cleared it again, because A2 saw the spool it used
 * to hold gone and had no way to know it had just reappeared elsewhere. Slot
 * order decided whether a move kept its location or lost it.
 *
 * Deferring makes the whole AMS the unit of decision instead of the slot: a
 * spool that ends up in any slot is claimed by it, and only a spool in none of
 * them is released. Claims run before releases so a Spoolman write can never
 * leave a spool that is physically in the AMS without a location.
 *
 * @param {object} printer - the printer runtime object
 * @returns {{claim: Function, release: Function, flush: Function}}
 */
export function createLocationSync(printer) {
    // Keyed by spool id: the same spool cannot be in two slots, but the AMS can
    // report it that way for an update while a move is in flight, and the last
    // slot to claim it is the one that wins.
    const claims = new Map();
    const releases = new Map();

    return {
        /** Records that `spool` occupies `amsId`. Null spools are ignored. */
        claim(amsId, spool) {
            if (!spool?.id) return;
            claims.set(spool.id, { amsId, spool });
            releases.delete(spool.id);
        },

        /**
         * Records that `spool` used to occupy a slot that no longer holds it.
         * Ignored when the same spool is claimed by another slot, now or later
         * in this update.
         */
        release(spool) {
            if (!spool?.id || claims.has(spool.id)) return;
            releases.set(spool.id, spool);
        },

        /** Applies the collected changes. Claims first, then releases. */
        async flush() {
            if (!settings.SET_LOCATION) return;

            for (const { amsId, spool } of claims.values()) {
                await claimSlotLocation(printer, amsId, spool);
            }
            for (const spool of releases.values()) {
                await releaseSlotLocation(printer, spool);
            }
        },
    };
}

/**
 * The spools this printer's slots currently hold, as Spoolman has them now.
 *
 * Only the slots with a real link count: a merge or creation candidate found by
 * filament match sits in the cached slot data too, but it is not in the AMS and
 * never got a location from us.
 *
 * The records are refetched rather than taken from the cache, because both
 * callers decide what to write from the location Spoolman holds right now.
 *
 * @param {object} printer - the printer runtime object
 * @returns {Promise<Array<{amsId: string, spool: object}>>}
 */
async function occupiedSlots(printer) {
    const slots = [];

    for (const uiSpool of printer.spoolData || []) {
        if (!uiSpool.connectedViaTag && !uiSpool.connectedViaMapping) continue;
        const id = uiSpool.existingSpool?.id;
        if (!id) continue;

        const spool = await getSpoolmanSpool(id).catch(() => uiSpool.existingSpool);
        slots.push({ amsId: uiSpool.amsId, spool });
    }

    return slots;
}

/**
 * Clears the locations of every spool in this printer's slots.
 *
 * Called before a printer is removed. The ownership check matches on the
 * printer's name, so once the printer is gone its locations are
 * indistinguishable from ones the user set by hand and would stay behind
 * forever.
 *
 * @param {object} printer - the printer runtime object
 */
export async function releasePrinterLocations(printer) {
    if (!settings.SET_LOCATION) return;

    for (const { spool } of await occupiedSlots(printer)) {
        await releaseSlotLocation(printer, spool);
    }
}

/**
 * Rewrites the locations of this printer's spools after it was renamed.
 *
 * Without this the spools keep naming the old printer, which is both wrong on
 * the shelf and invisible to `ownsLocation()`, so nothing would ever clear them
 * again either.
 *
 * @param {object} printer - the printer runtime object, already renamed
 * @param {string} previousName - the name the locations were written with
 */
export async function renamePrinterLocations(printer, previousName) {
    if (!settings.SET_LOCATION) return;

    for (const { amsId, spool } of await occupiedSlots(printer)) {
        if (!ownsLocation(spool?.location, previousName)) continue;
        await claimSlotLocation(printer, amsId, spool);
    }
}

/**
 * Rewrites the locations of this printer's spools after the template changed.
 *
 * Without this a spool sitting in a slot keeps the old string until something
 * about its slot changes, which on a shelf of spools nobody touches can be
 * never. Only a location this service wrote with the previous template is
 * rewritten; one the user set by hand stays.
 *
 * @param {object} printer - the printer runtime object
 * @param {string|null} previousFormat - the template the locations were written with
 */
export async function reformatPrinterLocations(printer, previousFormat) {
    if (!settings.SET_LOCATION) return;

    for (const { amsId, spool } of await occupiedSlots(printer)) {
        if (!ownsLocation(spool?.location, printer.name, previousFormat)) continue;
        await claimSlotLocation(printer, amsId, spool);
    }
}

/**
 * Writes the location of every spool this printer's slots hold.
 *
 * Called when the setting is switched on. A slot only claims its location
 * while it is processed, and a slot is only processed when something about it
 * changed, so the spools that were already loaded went without a location
 * until they were moved or ran a print.
 *
 * @param {object} printer - the printer runtime object
 */
export async function claimPrinterLocations(printer) {
    if (!settings.SET_LOCATION) return;

    for (const { amsId, spool } of await occupiedSlots(printer)) {
        await claimSlotLocation(printer, amsId, spool);
    }
}
