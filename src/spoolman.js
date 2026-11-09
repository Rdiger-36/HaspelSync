import got from "got";
import { serverLogFilePath } from "./config.js";
import { spoolmanUrl } from "./settings.js";
import { state } from "./state.js";
import { debug, trace } from "./logger.js";
import { correctRemainInt } from "./ams.js";
import { describeConnectionError, connectionErrorCode } from "./utils.js";

/**
 * Derives the used weight a newly created Spoolman spool should start at.
 *
 * The AMS RFID chip reports the real remaining percentage of an already
 * partially used spool. New spools should be created reflecting that, not as
 * if they were brand new. Otherwise a spool found at e.g. 32% remaining would
 * be created at 100% (used_weight 0) and immediately drift out of sync.
 *
 * No reading means brand new. For up to a minute after a spool is inserted the
 * AMS knows the tag but not the percentage, and a spool created in that window
 * used to be booked as fully used, ending up at 0 g left with nothing in G-code
 * mode to correct it afterwards. Starting such a spool full
 * is the recoverable direction: a print books what it consumes.
 *
 * @param {object} slot - a normalised AMS slot
 * @returns {number} grams already consumed, never negative
 */
function usedWeightFromSlot(slot) {
    const remainPct = correctRemainInt(slot.remain, slot.tray_weight, slot.tray_type);
    if (remainPct === null || !Number.isFinite(remainPct)) return 0;
    const remainingWeight = Math.round((remainPct / 100) * slot.tray_weight);
    return Math.max(0, Math.round(slot.tray_weight - remainingWeight));
}

/**
 * The log target for a write that belongs to no printer: the bootstrap ones.
 */
const SERVER = { printerName: "Server", logFilePath: serverLogFilePath };

/**
 * Logs a failed Spoolman write in the block the log viewer looks for.
 *
 * The write paths all fail the same way and used to spell this block out one by
 * one. Four of those copies read the status off `error.filamentResponse`,
 * `error.spoolResponse` and `error.manufacturerResponse`, none of which a got
 * error carries, so exactly the lines meant to say why a write failed printed
 * "undefined undefined" plus a stack trace instead of the Spoolman response.
 *
 * @param {object} target - a UI spool, or SERVER, for the name and the log file
 * @param {string} what - what failed, e.g. "Spool creation"
 * @param {Error} error - the got error
 */
export function logSpoolmanFailure(target, what, error) {
    const { printerName, logFilePath } = target;

    console.error(printerName, logFilePath, "    #####");
    console.error(printerName, logFilePath, `    ${what} failed:`, error.message);
    console.error(printerName, logFilePath, "    Error details:", error.response?.statusCode, error.response?.body || error.stack);
    console.error(printerName, logFilePath, "    #####");
}

/**
 * Logs a failed write and describes it for whoever asked for it.
 *
 * The three actions never throw, because one slot that cannot be written must
 * not abort the remaining slots of the same AMS update. That left the Web UI
 * with no way to tell a write that happened from one that did not: the route
 * answered `ok` either way. They report instead.
 *
 * Spoolman's own message is preferred over the got one, which says only that
 * the request failed with a status code.
 *
 * @returns {{ok: false, error: string}}
 */
function failed(target, what, error) {
    logSpoolmanFailure(target, what, error);

    // A body arrives as a string unless the call asked for JSON, and stringifying
    // one of those escapes it a second time, which is how a Spoolman message
    // ends up in the browser wrapped in quotes and backslashes.
    const body = error.response?.body;
    const detail = body == null || body === ""
        ? error.message
        : (typeof body === "string" ? body : JSON.stringify(body));

    return { ok: false, error: `${what} failed: ${detail}` };
}

/**
 * Fetches all spools. Updates the connection status as a side effect and
 * returns an empty list on failure, so a Spoolman outage pauses processing
 * instead of crashing the service.
 */
export async function getSpoolmanSpools() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/spool`);
        state.spoolmanStatus = "Connected";
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching spools from Spoolman:", error.message);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

/**
 * Fetches the archived spools alone.
 *
 * Spoolman leaves archived spools out of `/api/v1/spool`, which is what makes
 * archiving useful in the first place, and exactly what would make this service
 * create a second spool for a spool it archived while it still sits in the AMS.
 * The tag lookup therefore has to see them, and only them: an archived spool is
 * never a merge candidate and never gets a location.
 *
 * Returns an empty list on failure, like `getSpoolmanSpools()`, because it runs
 * beside it in the same update and a Spoolman outage already pauses processing.
 */
export async function getArchivedSpoolmanSpools() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/spool`, {
            searchParams: { allow_archived: "true" },
        });
        return JSON.parse(response.body).filter(spool => spool.archived);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching archived spools from Spoolman:", error.message);
        return [];
    }
}

/** Fetches the filaments created in this Spoolman instance, empty on failure. */
export async function getSpoolmanInternalFilaments() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/filament`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching filaments from Spoolman:", error.message);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

/** How long the catalogue is reused before it is fetched again. */
const EXTERNAL_FILAMENT_TTL_MS = 10 * 60 * 1000;

/**
 * The SpoolmanDB catalogue, from the cache while it is fresh.
 *
 * The create-spool dialog queries the catalogue while the user types, and every
 * miss would otherwise pull several megabytes out of Spoolman again. A failed
 * fetch is not cached, so an outage is retried rather than remembered.
 */
export async function getCachedExternalFilaments() {
    const cache = state.externalFilamentCache;
    const fresh = cache.entries.length && (Date.now() - cache.fetchedAt) < EXTERNAL_FILAMENT_TTL_MS;
    if (fresh) return cache.entries;

    const entries = await getSpoolmanExternalFilaments();
    if (entries.length) {
        cache.entries = entries;
        cache.fetchedAt = Date.now();
    }
    return entries;
}

/** Fetches the SpoolmanDB filament catalogue, empty on failure. */
export async function getSpoolmanExternalFilaments() {
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/external/filament`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching external filaments from Spoolman:", error.message);
        state.spoolmanStatus = "Disconnected";
        return [];
    }
}

// ---------------------------------------------------------------------------
// Lookups and creation used by the "new spool" dialog for 3rd party spools.
// Those spools carry no RFID tag, so nothing about them can be derived: the
// data has to be entered once, and these endpoints feed the dialog's dropdowns.
// ---------------------------------------------------------------------------

/**
 * Fetches and parses a Spoolman endpoint, rethrowing on failure.
 *
 * Unlike the list getters above, these lookups back an interactive dialog, so a
 * failure has to surface to the user rather than quietly yield an empty list.
 *
 * @param {string} path - path below the Spoolman base URL
 * @param {string} what - noun used in the error message
 */
async function getJson(path, what) {
    try {
        const response = await got(`${spoolmanUrl()}${path}`);
        return JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, `Error fetching ${what} from Spoolman:`, error.message);
        throw error;
    }
}

/** Fetches the vendors known to this Spoolman instance. */
export const getSpoolmanVendors = () => getJson("/api/v1/vendor", "vendors");

/** Fetches the locations known to this Spoolman instance. */
export const getSpoolmanLocations = () => getJson("/api/v1/location", "locations");

/** Fetches the materials already in use in this Spoolman instance. */
export const getSpoolmanMaterials = () => getJson("/api/v1/material", "materials");

/**
 * Fetches the known material catalogue, which also carries density and
 * temperatures. Density is required when creating a filament and cannot be read
 * off the spool, so this is what the dialog prefills it from.
 */
export const getSpoolmanExternalMaterials = () => getJson("/api/v1/external/material", "external materials");

/**
 * Creates a vendor and returns the created record.
 *
 * `external_id` is the manufacturer string as the SpoolmanDB catalogue writes
 * it, which is what ties the vendor to the catalogue; Spoolman stores its own
 * imported vendors the same way. `empty_spool_weight` is the vendor default a
 * spool falls back on when its filament names no weight, and the catalogue
 * carries it per entry. Both are left out when nothing knows them, rather than
 * sent as null, so a vendor typed by hand stays a vendor typed by hand.
 *
 * @param {object} vendor
 * @param {string} vendor.name - the manufacturer name
 * @param {string|null} [vendor.externalId] - the catalogue's manufacturer string
 * @param {number|null} [vendor.emptySpoolWeight] - grams of the empty spool
 * @returns {Promise<object>} the created vendor
 */
export async function createVendor({ name, externalId = null, emptySpoolWeight = null }) {
    const payload = { name };
    if (externalId) payload.external_id = externalId;
    if (Number.isFinite(emptySpoolWeight)) payload.empty_spool_weight = emptySpoolWeight;

    const response = await got.post(`${spoolmanUrl()}/api/v1/vendor`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/** Creates a filament from an already built payload and returns the record. */
export async function createFilament(payload) {
    const response = await got.post(`${spoolmanUrl()}/api/v1/filament`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/** Creates a spool from an already built payload and returns the record. */
export async function createSpoolRecord(payload) {
    const response = await got.post(`${spoolmanUrl()}/api/v1/spool`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/** The manufacturer every filament built from a Bambu Lab profile belongs to. */
const BAMBU_VENDOR = "Bambu Lab";

/**
 * The id of the "Bambu Lab" vendor, creating it when this Spoolman has none.
 *
 * Spoolman ships no vendors and creates none on its own: `POST /api/v1/filament`
 * takes a `vendor_id` and nothing else, and the SpoolmanDB catalogue names the
 * manufacturer as a string with no id behind it. So a filament built from a
 * catalogue entry has no manufacturer unless this vendor exists here. Verified
 * against Spoolman 0.26.1.
 *
 * Asked at the point of use rather than at startup. It is needed by one thing,
 * `createFilamentAndSpool()`, and holding the whole service back for it stopped
 * the monitor loops over a vendor that merging, tag linking, the G-code booking
 * and every manual assignment do not need. The answer is cached in
 * `state.vendorID` and cleared when the endpoint changes, so the lookup happens
 * once per Spoolman instance rather than once per filament.
 *
 * @returns {Promise<number>} the vendor id
 * @throws when Spoolman cannot be read or the vendor cannot be created
 */
async function ensureVendor() {
    if (state.vendorID) return state.vendorID;

    console.log("Server", serverLogFilePath, "Checking Vendors...");
    let vendors;
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/vendor`);
        vendors = JSON.parse(response.body);
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching and setting vendor for Spoolman:", error.message);
        state.spoolmanStatus = "Disconnected";
        throw error;
    }

    const existing = vendors.find(vendor => vendor.name === BAMBU_VENDOR || vendor.external_id === BAMBU_VENDOR);
    if (existing) {
        state.vendorID = existing.id;
        console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" exists: true');
        return state.vendorID;
    }

    console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" exists: false');
    console.log("Server", serverLogFilePath, 'Creating Vendor "Bambu Lab"...');

    try {
        // 250 g is what a Bambu Lab spool weighs empty, and it is what every
        // Bambu entry of the catalogue reports as its spool weight.
        const created = await createVendor({
            name: BAMBU_VENDOR,
            externalId: BAMBU_VENDOR,
            emptySpoolWeight: 250,
        });

        if (!created.id) throw new Error("Spoolman created the vendor but answered without an id");

        state.vendorID = created.id;
        console.log("Server", serverLogFilePath, 'Vendor "Bambu Lab" successfully created!');
        return state.vendorID;
    } catch (error) {
        logSpoolmanFailure(SERVER, "Vendor creation", error);
        throw error;
    }
}

/**
 * Makes sure the spool extra field "tag" exists in Spoolman.
 *
 * That field holds the slot's tray_uuid and is the only link between a physical
 * Bambu Lab spool and its Spoolman record, so the service cannot work without
 * it. Runs once at startup.
 *
 * @returns {Promise<boolean>} whether the field is available
 */
export async function checkAndSetExtraField() {
    console.log("Server", serverLogFilePath, 'Checking Extra Field "tag"...');
    try {
        const response = await got(`${spoolmanUrl()}/api/v1/field/spool`);
        const fields = JSON.parse(response.body);
        const extraFieldExists = fields.some(f => f.name === "tag");

        if (!extraFieldExists) {
            console.log("Server", serverLogFilePath, 'Spoolman Extra Field "tag" for Spool is set: false');
            return await createExtraField();
        } else {
            console.log("Server", serverLogFilePath, 'Spoolman Extra Field "tag" for Spool is set: true');
            return true;
        }
    } catch (error) {
        console.error("Server", serverLogFilePath, "Error fetching extra tag from Spoolman:", error.message);
        throw error;
    }
}

/** Creates the spool extra field "tag" in Spoolman. */
async function createExtraField() {
    console.log("Server", serverLogFilePath, 'Create Extra Field "tag" for Spools in Spoolman');
    try {
        const payload = { name: "tag", field_type: "text" };
        await got.post(`${spoolmanUrl()}/api/v1/field/spool/tag`, {
            json: payload,
            responseType: "json",
        });
        console.log("Server", serverLogFilePath, 'Extra Field "tag" successfully created!');
        return true;
    } catch (error) {
        logSpoolmanFailure(SERVER, 'Extra Field "tag" creation', error);
        throw error;
    }
}

/**
 * Creates a spool for an AMS slot whose filament already exists in Spoolman,
 * tagged with the slot's tray_uuid so it is recognised from then on.
 *
 * Failures are reported, not thrown: one slot that cannot be created must not
 * abort the remaining slots of the same AMS update.
 *
 * @param {object} spoolData - the UI spool, carrying slot and matched filament
 * @returns {Promise<{ok: boolean, error?: string}>} what became of the write
 */
/**
 * Registers a Bambu tray UUID as a native Spoolman tag on an existing spool.
 * The legacy extra.tag remains in place when an older Spoolman does not
 * support native tags or the tag link fails, so the spool stays identifiable.
 */
async function linkNativeSpoolTag(spoolData, spoolId) {
    try {
        await got.post(`${spoolmanUrl()}/api/v1/spool/${spoolId}/tag`, {
            json: { uid: spoolData.slot.tray_uuid, format: "bambu" },
        });
    } catch (error) {
        logSpoolmanFailure(spoolData, `Native tag link for Spool-ID ${spoolId}`, error);
    }
}

export async function createSpool(spoolData) {
    const postData = buildSpoolPayload(spoolData, spoolData.matchingInternalFilament.id);

    debug("spoolman", spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${spoolmanUrl()}/api/v1/spool`);
    trace("spoolman", spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(postData));

    try {
        const response = await got.post(`${spoolmanUrl()}/api/v1/spool`, { json: postData, responseType: "json" });
        await linkNativeSpoolTag(spoolData, response.body.id);
        console.log(spoolData.printerName, spoolData.logFilePath, `    Spool successfully created for Slot => ${spoolData.amsId}!`);
        return { ok: true };
    } catch (error) {
        return failed(spoolData, "Spool creation", error);
    }
}

/**
 * Builds the Spoolman spool payload for an AMS slot.
 *
 * Both creation paths send the same spool, they only differ in where the
 * filament id comes from: an existing Spoolman filament, or one created moments
 * earlier. The tag is the slot's tray_uuid, JSON encoded, because that is what
 * later identifies this spool as the one in the slot.
 *
 * @param {object} spoolData - the UI spool, carrying the slot
 * @param {number|string} filamentId - the Spoolman filament to attach it to
 * @returns {object} the payload for POST /api/v1/spool
 */
export function buildSpoolPayload(spoolData, filamentId) {
    return {
        filament_id: Number(filamentId),
        initial_weight: Number(spoolData.slot.tray_weight),
        used_weight: usedWeightFromSlot(spoolData.slot),
        first_used: Date.now(),
        extra: { tag: `"${spoolData.slot.tray_uuid}"` },
    };
}

/**
 * Builds the Spoolman filament payload for a matched SpoolmanDB entry.
 *
 * Every value is read rather than assumed: weight and spool_weight used to be
 * hardcoded to 1000/250, which mislabelled everything not on a 1 kg spool.
 *
 * The filament describes the product, so both weights are the catalogue values.
 * A physical spool may well deviate from them. Bambu Lab sample spools are not
 * sold separately and the Support for PLA sample reports 250 g against a 500 g
 * catalogue entry, but that belongs on the spool as initial_weight, not on the
 * filament shared by every spool of that product.
 *
 * spool_type, finish, pattern, translucent and glow are not part of Spoolman's
 * FilamentParameters (verified against the 0.26.1 OpenAPI schema) and were
 * discarded on arrival, so they are no longer sent.
 */
export function buildFilamentPayload(spoolData) {
    const external = spoolData.matchingExternalFilament;

    return {
        name: external.name,
        material: spoolData.slot.tray_sub_brands,
        density: external.density,
        diameter: external.diameter,
        spool_weight: external.spool_weight,
        weight: external.weight,
        settings_extruder_temp: external.extruder_temp,
        settings_bed_temp: external.bed_temp,
        color_hex: external.color_hex,
        external_id: external.id,
        multi_color_hexes: external.color_hexes ? external.color_hexes.join(",") : "",
        multi_color_direction: external.multi_color_direction,
        vendor_id: state.vendorID,
    };
}

/**
 * Creates both the filament and the spool for an AMS slot, for the case where
 * the catalogue entry matched but no filament exists in Spoolman yet.
 *
 * The spool is only attempted once the filament came back with an id. As in
 * createSpool, failures are reported rather than thrown.
 *
 * @param {object} spoolData - the UI spool, carrying slot and catalogue entry
 * @returns {Promise<{ok: boolean, error?: string}>} what became of the write
 */
export async function createFilamentAndSpool(spoolData) {
    let filamentId;

    try {
        // The one caller that needs the vendor, so the lookup lives here rather
        // than in the startup sequence. Cached after the first filament.
        await ensureVendor();
    } catch {
        // ensureVendor has already logged what Spoolman answered. This says
        // what it cost: this slot keeps its button and the next AMS update
        // tries again, while everything that does not need a vendor carries on.
        const error = `The "Bambu Lab" vendor could not be resolved, so no filament was created`;
        console.error(spoolData.printerName, spoolData.logFilePath, `    Filament for ${spoolData.amsId} not created: ${error}`);
        return { ok: false, error };
    }

    try {
        const filamentPayload = buildFilamentPayload(spoolData);

        debug("spoolman", spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${spoolmanUrl()}/api/v1/filament`);
        trace("spoolman", spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(filamentPayload));

        const filamentResponse = await got.post(`${spoolmanUrl()}/api/v1/filament`, {
            json: filamentPayload,
            responseType: "json",
        });
        filamentId = filamentResponse.body.id;
    } catch (error) {
        return failed(spoolData, "Filament creation", error);
    }

    try {
        const spoolPayload = buildSpoolPayload(spoolData, filamentId);

        debug("spoolman", spoolData.printerName, spoolData.logFilePath, "    Sending POST request to:", `${spoolmanUrl()}/api/v1/spool`);
        trace("spoolman", spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(spoolPayload));

        const response = await got.post(`${spoolmanUrl()}/api/v1/spool`, { json: spoolPayload, responseType: "json" });
        await linkNativeSpoolTag(spoolData, response.body.id);
        console.log(spoolData.printerName, spoolData.logFilePath, `    Filament and Spool successfully created for Slot => ${spoolData.amsId}!`);
        return { ok: true };
    } catch (error) {
        // The filament is there and the spool is not, which is the one half
        // done outcome of the three. It is named as such, because the next
        // attempt finds that filament and only has to create the spool.
        return failed(spoolData, `Spool creation for the new filament ${filamentId}`, error);
    }
}

/**
 * Connects an existing untagged Spoolman spool to an AMS slot by patching the
 * slot's tray_uuid into its extra.tag. Nothing else about the spool is touched.
 *
 * @param {object} spoolData - the UI spool, carrying slot and mergeableSpool
 * @returns {Promise<{ok: boolean, error?: string}>} what became of the write
 */
export async function mergeSpool(spoolData) {
    const postData = { extra: { tag: `\"${spoolData.slot.tray_uuid}\"` } };

    debug("spoolman", spoolData.printerName, spoolData.logFilePath, "    Sending PATCH request to:", `${spoolmanUrl()}/api/v1/spool/${spoolData.mergeableSpool.id}`);
    trace("spoolman", spoolData.printerName, spoolData.logFilePath, "    Payload:", JSON.stringify(postData));

    try {
        await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolData.mergeableSpool.id}`, { json: postData });
        await linkNativeSpoolTag(spoolData, spoolData.mergeableSpool.id);
        console.log(spoolData.printerName, spoolData.logFilePath, `    Spool successfully merged with Spool-ID ${spoolData.mergeableSpool.id} => ${spoolData.mergeableSpool.filament.name}`);
        return { ok: true };
    } catch (error) {
        return failed(spoolData, "Spool merge", error);
    }
}

/**
 * Sets a spool's remaining weight directly. This is the legacy mode write path,
 * where the weight comes from the AMS RFID remain percentage.
 *
 * The location used to ride along in this payload, which meant legacy mode and
 * G-code mode wrote it from two different places under two different
 * conditions. `src/location.js` owns it in both modes now.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {number} remainingWeight - grams left on the spool
 * @param {string} lastUsed - ISO timestamp
 */
export async function patchSpoolWeight(spoolId, remainingWeight, lastUsed) {
    return got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, {
        json: { remaining_weight: remainingWeight, last_used: lastUsed },
    });
}

/**
 * Fetches a single spool with its filament and vendor embedded.
 *
 * Unlike the narrowed payload the dashboard receives, this is the whole record,
 * which is what the spool detail dialog shows. It rethrows rather than answering
 * with an empty result, because it backs an interactive dialog that has to say
 * why it is empty.
 *
 * @param {number} spoolId - Spoolman spool id
 */
export async function getSpoolmanSpool(spoolId) {
    return getJson(`/api/v1/spool/${spoolId}`, `spool ${spoolId}`);
}

/**
 * Writes an already built patch onto a spool and returns the updated record.
 *
 * Separate from `patchSpoolWeight()`, which is the legacy mode write path with
 * its own fixed payload. This one carries whatever the detail dialog corrected
 * by hand, and rethrows so the route can report the failure.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {object} payload - Spoolman spool fields to write
 */
export async function patchSpoolFields(spoolId, payload) {
    const response = await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, {
        json: payload,
        responseType: "json",
    });
    return response.body;
}

/**
 * Archives or restores a spool. Rethrows, so a caller can say what failed.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {boolean} archived - true archives it, false brings it back
 */
export async function setSpoolArchived(spoolId, archived) {
    const response = await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, {
        json: { archived },
        responseType: "json",
    });
    return response.body;
}

/** Sets a spool's location, or clears it when passed an empty string. */
export async function patchSpoolLocation(spoolId, location) {
    return got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, { json: { location } });
}

/**
 * Books consumed filament against a spool. This is the G-code mode write path:
 * Spoolman subtracts the grams itself, so concurrent bookings cannot overwrite
 * each other the way a computed remaining weight would.
 *
 * @param {number} spoolId - Spoolman spool id
 * @param {number} usedGrams - grams consumed by the finished print
 * @param {string} lastUsed - ISO timestamp, patched separately
 */
export async function useSpoolWeight(spoolId, usedGrams, lastUsed) {
    const result = await got.put(`${spoolmanUrl()}/api/v1/spool/${spoolId}/use`, {
        json: { use_weight: usedGrams },
        responseType: "json",
    });

    // The /use endpoint only accepts use_weight and use_length. A last_used sent
    // along with them is silently dropped, so the timestamp has to be patched
    // separately. Failing to stamp it must not lose the booking, which already
    // succeeded above.
    try {
        await got.patch(`${spoolmanUrl()}/api/v1/spool/${spoolId}`, { json: { last_used: lastUsed } });
    } catch (error) {
        console.error("Server", serverLogFilePath, `Booked consumption for spool ${spoolId}, but could not set last_used:`, error.message);
    }

    // The updated record, which is what the caller needs to see how much the
    // booking left on the spool. Reading it back with a second request would
    // race the next booking of a multi filament print.
    return result.body;
}

/**
 * Single health check against a Spoolman URL, used by the connection test on
 * the settings page. Takes the URL explicitly so an endpoint can be tried
 * before it is saved.
 *
 * @param {string} url - base URL to check
 * @param {number} [timeout] - milliseconds before the request is given up
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 */
export async function checkSpoolmanHealth(url, timeout = 5000) {
    if (!url) return { ok: false, error: "No endpoint configured", code: "spoolmanNoEndpoint" };

    try {
        const response = await got(`${url}/api/v1/health`, { timeout: { request: timeout }, retry: { limit: 0 } });
        const health = JSON.parse(response.body);

        if (health.status === "healthy") return { ok: true, status: health.status };
        return { ok: false, error: `Spoolman reports status "${health.status}"`, code: "spoolmanStatus", params: { status: health.status } };
    } catch (err) {
        const message = err?.message || String(err);
        if (/404/.test(message)) return { ok: false, error: "Reachable, but there is no Spoolman API at this address", code: "spoolmanNoApi" };
        return { ok: false, error: describeConnectionError(err) ?? message, ...(connectionErrorCode(err) ?? {}) };
    }
}
