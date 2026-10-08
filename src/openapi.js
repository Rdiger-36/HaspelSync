import { version } from "./config.js";
import { LOG_CATEGORIES, LOG_LEVELS, SETTINGS_SCHEMA } from "./settings.js";
import { ENV_CONFIG_NOTICE } from "./deprecation.js";
import { UPGRADE_NOTICE } from "./upgradenotice.js";
import { IMAGE_NOTICE } from "./imagenotice.js";
import { SLOT_OPTIONS } from "./utils.js";

/**
 * The HTTP API described as an OpenAPI 3.0 document.
 *
 * Served at `GET /api/openapi.json` and rendered by the API page of the Web UI,
 * which is a click through explorer of every route with a "Send" button per
 * operation. The same document imports into Swagger UI, Postman, Bruno or an
 * HTTP client generator, which is why it is a standard format rather than a
 * list the page alone could read.
 *
 * Written by hand, next to the routes it describes, because the handlers in
 * `routes.js` carry no schema of their own to derive it from. What keeps the
 * two from drifting is `test/openapi.test.js`: every route the app registers
 * has to be in here, and every path in here has to be a registered route. The
 * shapes of the bodies and the answers are documented as far as the routes
 * decide them; where a route hands a Spoolman record through untouched, the
 * schema says so rather than repeating Spoolman's own.
 *
 * A few extensions carry what the explorer needs beyond the standard:
 *
 * - `x-public`: reachable without a session or a key (the login routes).
 * - `x-stream`: the answer is a Server-Sent Events stream, not a document.
 * - `x-download`: the answer is a file the browser should save.
 * - `x-confirm`: the operation ends the process or removes something, so the
 *   explorer asks before it sends.
 */

/** A schema helper, so the tables below read as shapes rather than as JSON. */
const t = {
    string: (description, extra = {}) => ({ type: "string", ...(description ? { description } : {}), ...extra }),
    number: (description, extra = {}) => ({ type: "number", ...(description ? { description } : {}), ...extra }),
    integer: (description, extra = {}) => ({ type: "integer", ...(description ? { description } : {}), ...extra }),
    boolean: (description, extra = {}) => ({ type: "boolean", ...(description ? { description } : {}), ...extra }),
    nullable: schema => ({ ...schema, nullable: true }),
    array: (items, description) => ({ type: "array", items, ...(description ? { description } : {}) }),
    object: (properties, { required, description, additional } = {}) => ({
        type: "object",
        ...(description ? { description } : {}),
        properties,
        ...(required ? { required } : {}),
        ...(additional !== undefined ? { additionalProperties: additional } : {}),
    }),
    ref: name => ({ $ref: `#/components/schemas/${name}` }),
    // OpenAPI 3.0 ignores everything written next to `$ref`, so a nullable
    // reference has to wrap the reference in `allOf` and put `nullable` beside
    // that. A `nullable` written straight onto the reference is silently lost.
    nullableRef: name => ({ allOf: [t.ref(name)], nullable: true }),
};

/** A JSON response of one schema. */
function json(description, schema, example) {
    return {
        description,
        content: { "application/json": { schema, ...(example !== undefined ? { example } : {}) } },
    };
}

/** A JSON request body. */
function body(schema, { required = true, example } = {}) {
    return {
        required,
        content: { "application/json": { schema, ...(example !== undefined ? { example } : {}) } },
    };
}

/** The failure shape every route answers with, at the given status. */
function failure(description) {
    return json(description, t.ref("Error"));
}

/** The 404 a route answers when the printer is not known. */
const PRINTER_NOT_FOUND = failure("No printer with this serial number");

/** The 409 a route answers instead of interrupting a running print. */
const PRINT_IN_FLIGHT = json(
    "A print is running. Send `force: true` to do it anyway.",
    t.ref("PrintInFlight"),
);

/** The 409 the assignment routes answer in legacy mode. */
const LEGACY_MODE = failure("Not available in legacy mode");

/** A reference to one of the shared responses under `components.responses`. */
const sharedResponse = name => ({ $ref: `#/components/responses/${name}` });

/**
 * The two answers every operation can give before its handler runs, described
 * once and referenced from each operation by `op()` below.
 *
 * The 403 comes from the request guard in security.js, which sits in front of
 * everything, the login routes included. The 401 comes from auth.js and is the
 * answer of every route that is not public.
 */
const responses = {
    Unauthorized: json(
        "No session and no API key. `apiKeyRequired` is set while no Web UI password exists and the request did not come from the Web UI, `authRequired` while a password is set and the request carries no valid session.",
        t.ref("Unauthenticated"),
    ),
    Forbidden: failure("The `Host` header is not on the allowed list, or a request that changes something came from another origin."),
};

/** Path parameter: the serial number of a printer. */
const printerId = {
    name: "printerId",
    in: "path",
    required: true,
    description: "The serial number of the printer, as `GET /api/printers` lists it.",
    schema: t.string(null, { example: "01P00A000000001" }),
};

/** Path parameter: a slot label. */
const amsId = {
    name: "amsId",
    in: "path",
    required: true,
    description: "The slot label: `A1` to `D4` for the AMS units, `HT-A` and following for an AMS HT, `External` for the spool holder and `External-2` for the second holder of a dual nozzle printer.",
    schema: t.string(null, { example: "A1" }),
};

/** Path parameter: a filament's position in the sliced file. */
const filamentIndex = {
    name: "index",
    in: "path",
    required: true,
    description: "The filament's position in the sliced file, counting from 0, as `index` in `holderFilaments` of `GET /api/print/{printerId}`.",
    schema: t.integer(null, { minimum: 0, example: 1 }),
};

/** Path parameter: a Spoolman spool id. */
const spoolId = {
    name: "id",
    in: "path",
    required: true,
    description: "The Spoolman spool id.",
    schema: t.integer(null, { minimum: 1, example: 12 }),
};

/** The `force` field the routes read that would interrupt a print. */
const force = t.boolean("Do it although a print is running. Without it the request is answered with 409 while a printer is mid print.");

/** The reusable shapes, referenced from the operations by name. */
const schemas = {
    Error: t.object({
        ok: t.boolean(null, { enum: [false] }),
        error: t.string("What went wrong, in a sentence."),
        code: t.string("The same as a stable word, `printerNotFound`, `weightAboveLimit` and so on, for a client that words it in its own language. Missing where the text carries a detail from elsewhere, such as Spoolman's own answer."),
        params: t.object({}, { additional: true, description: "The values the sentence names, `{ limit, weight }` and so on, for a client that words it itself." }),
    }, { required: ["ok", "error"] }),

    Ok: t.object({ ok: t.boolean(null, { enum: [true] }) }, { required: ["ok"] }),

    Unauthenticated: t.object({
        ok: t.boolean(null, { enum: [false] }),
        error: t.string("What to send instead."),
        apiKeyRequired: t.boolean("Set while no Web UI password exists: the API takes a key, or a request from the Web UI itself.", { enum: [true] }),
        authRequired: t.boolean("Set while a password exists and the request carries no valid session.", { enum: [true] }),
    }, { required: ["ok", "error"], description: "The 401 of auth.js. One of the two flags is set, never both." }),

    PrintInFlight: t.object({
        ok: t.boolean(null, { enum: [false] }),
        printInFlight: t.boolean(null, { enum: [true] }),
        error: t.string("Which printer is printing and what the request would interrupt."),
    }, { required: ["ok", "printInFlight", "error"] }),

    PrinterRef: t.object({
        id: t.string("The serial number."),
        name: t.string(),
    }, { required: ["id", "name"] }),

    LogDetail: t.object({
        level: t.string("Overrides the global log level.", { enum: LOG_LEVELS }),
        categories: t.array(t.string(null, { enum: LOG_CATEGORIES }), "Overrides the areas that write debug and trace lines. An empty list silences them all."),
        mqttTrace: t.boolean("Overrides the raw MQTT trace switch."),
    }, { description: "A per printer log override. Every field is optional and an absent one follows the global setting. A level or a category the service does not know is dropped without an error, so a misspelt level puts the printer back on the global one, and a body that is not an object counts as an empty one." }),

    Printer: t.object({
        id: t.string("The serial number."),
        name: t.string(),
        ip: t.string("The address on the local network."),
        hasCode: t.boolean("Whether an access code is stored. The code itself is never sent."),
        mqttStatus: t.string("`Connected`, `Disconnected`, `Reconnecting`, `Disabled` or an error text."),
        monitoringEnabled: t.boolean(),
        logDetail: t.ref("LogDetail"),
    }, { required: ["id", "name", "ip", "hasCode", "mqttStatus", "monitoringEnabled", "logDetail"] }),

    PrinterInput: t.object({
        id: t.string("The serial number. Uppercased on the way in and immutable afterwards."),
        name: t.string("How the printer is shown. Also the prefix of the Spoolman location of its slots."),
        ip: t.string("The address on the local network."),
        code: t.string("The LAN access code from the printer's screen."),
        logDetail: t.ref("LogDetail"),
    }, { required: ["id", "name", "ip", "code"] }),

    PrinterPatch: t.object({
        name: t.string(),
        ip: t.string(),
        code: t.string("An empty or absent code keeps the stored one."),
        force,
    }),

    ConnectionTest: t.object({
        ok: t.boolean(),
        warning: t.string("Set when the connection worked but nothing arrived, which points at a wrong serial number."),
        error: t.string("What to fix, when `ok` is false."),
        detail: t.string("The underlying error message."),
    }, { required: ["ok"] }),

    AmsEnvironment: t.object({
        amsId: t.string("The unit letter, `A` to `D`, or `HT-A` and following."),
        model: t.nullable(t.string("`AMS`, `AMS Lite`, `AMS 2 Pro` or `AMS HT`, once the printer has named it.")),
        humidity: t.nullable(t.integer("Bambu's level, 1 (dry) to 5 (wet).")),
        humidityPercent: t.nullable(t.number()),
        temperature: t.nullable(t.number("Degrees Celsius.")),
        drying: t.nullable(t.object({
            active: t.boolean(),
            remainingMinutes: t.nullable(t.integer()),
            targetTemp: t.nullable(t.number()),
            durationHours: t.nullable(t.number()),
            filament: t.nullable(t.string()),
        }, { description: "Only a unit with a dryer carries this." })),
    }, { additional: true }),

    Status: t.object({
        spoolmanStatus: t.string("`Connected`, `Disconnected` or an error text."),
        mqttStatus: t.string(),
        lastMqttUpdate: t.nullable(t.string("When the printer last reported anything, ISO 8601.")),
        lastMqttAmsUpdate: t.nullable(t.string("When the slots were last processed, ISO 8601.")),
        PRINTER_ID: t.string("The serial number."),
        printerName: t.string(),
        MODE: t.string(null, { enum: ["automatic", "manual"] }),
        LEGACY_MODE: t.boolean("The tracking mode the process is running in, frozen at startup."),
        SPOOLMAN_URL: t.string("The Spoolman base URL the service talks to."),
        VERSION: t.string("The version of this service."),
        SPOOLMAN_FQDN: t.nullable(t.string("The Spoolman address the links in the Web UI use, when it differs from the one the service uses. Null while unset.")),
        monitoringEnabled: t.boolean(),
        amsEnv: t.array(t.ref("AmsEnvironment"), "Humidity, temperature and drying state per AMS unit."),
        gcodeState: t.string("What the printer says it is doing: `IDLE`, `PREPARE`, `RUNNING`, `PAUSE`, `FINISH`, `FAILED` or `CANCEL`."),
        activeSlot: t.nullable(t.string("The slot label whose filament is in the nozzle that prints, `A1`, `HT-A`, `External` and so on. Null while none is loaded or no report has said.")),
    }),

    Slot: t.object({
        preset_name: t.nullable(t.string("The name behind a custom preset, learned from a sliced file.")),
        preset_vendor: t.nullable(t.string()),
        tray_uuid: t.nullable(t.string("The RFID tag. Null for a 3rd party spool.")),
        tray_type: t.nullable(t.string("The material, `PLA`, `PETG` and so on.")),
        tray_sub_brands: t.nullable(t.string("The Bambu Lab product line, `PLA Basic` and so on.")),
        cols: t.array(t.string(), "Every colour of the filament as six hex digits, in the printer's order."),
        tray_color: t.nullable(t.string("The first colour, with the alpha byte the AMS appends.")),
        tray_info_idx: t.nullable(t.string("The filament profile id, `GFA00` and so on.")),
        tray_weight: {
            oneOf: [t.string(), t.number()],
            nullable: true,
            description: "The spool weight the tag reports, in grams. Passed through as the printer sends it, which is a string such as `\"1000\"`; an empty slot carries the number 0, which the normalisation fills in. Null when the field is missing.",
        },
        remain: t.nullable(t.integer("The RFID remain percentage. Null means not reported, never empty.")),
        tag_uid: t.nullable(t.string("The chip id of the RFID tag, which differs from `tray_uuid`. Null for a spool without a tag.")),
        tray_diameter: t.nullable(t.number("The filament diameter in millimetres.")),
        nozzle_temp_min: t.nullable(t.number("The lowest nozzle temperature the filament profile allows, in degrees Celsius.")),
        nozzle_temp_max: t.nullable(t.number("The highest nozzle temperature the filament profile allows, in degrees Celsius.")),
        bed_temp: t.nullable(t.number("The bed temperature the filament profile names, in degrees Celsius.")),
        drying_temp: t.nullable(t.number("The drying temperature the filament profile names, in degrees Celsius.")),
        drying_time: t.nullable(t.number("The drying time the filament profile names, in hours.")),
        k: t.nullable(t.number("The pressure advance factor the printer holds for this slot.")),
    }),

    SpoolRef: t.object({
        id: t.integer("The Spoolman spool id."),
        archived: t.boolean(),
        remaining_weight: t.nullable(t.number("Grams left, as Spoolman holds it.")),
        remaining_percentage: t.nullable(t.number()),
        initial_weight: t.nullable(t.number()),
        filament: t.nullable(t.object({
            id: t.integer(),
            name: t.nullable(t.string()),
            material: t.nullable(t.string()),
            weight: t.nullable(t.number()),
            color_hex: t.nullable(t.string()),
            multi_color_hexes: t.nullable(t.string("Comma separated, set instead of `color_hex` for a multi colour filament.")),
            multi_color_direction: t.nullable(t.string(null, { enum: ["coaxial", "longitudinal"] })),
            vendor: t.nullable(t.object({ name: t.nullable(t.string()) })),
        })),
    }, { description: "The part of a Spoolman spool the Web UI shows. `GET /api/spoolman/spool/{id}` has the whole record." }),

    ClientSpool: t.object({
        amsId: t.string("The slot label."),
        slotState: t.string(null, { enum: ["Empty", "Loaded (Bambu Lab)", "Loaded (3rd party)", "Loaded (archived)"] }),
        slot: t.ref("Slot"),
        existingSpool: t.nullableRef("SpoolRef"),
        mergeableSpool: t.nullableRef("SpoolRef"),
        matchingInternalFilament: t.nullable(t.object({
            id: t.integer(),
            name: t.nullable(t.string()),
            material: t.nullable(t.string()),
        }, { description: "A filament in this Spoolman that fits the slot, for creating a spool of it." })),
        matchingExternalFilament: t.nullable(t.object({
            id: t.string(),
            name: t.nullable(t.string()),
            manufacturer: t.nullable(t.string()),
            material: t.nullable(t.string()),
            density: t.nullable(t.number()),
            diameter: t.nullable(t.number()),
            multi_color_direction: t.nullable(t.string()),
        }, { description: "A SpoolmanDB catalogue entry that fits the slot, for creating filament and spool." })),
        connectedViaTag: t.boolean("Linked to `existingSpool` through the RFID tag."),
        connectedViaMapping: t.boolean("Linked to `existingSpool` by an assignment."),
        assignedAutomatically: t.boolean("The assignment was made by the service, not by hand."),
        archived: t.boolean("The slot holds a spool Spoolman has archived."),
        correctedRemain: t.nullable(t.integer("The RFID remain percentage, corrected for the spool weight.")),
        amsWeight: t.nullable(t.number("What the AMS reads off the RFID tag, in grams. Bambu Lab spools only.")),
        option: t.string("The action the dashboard offers for this slot.", { enum: Object.values(SLOT_OPTIONS) }),
        enableButton: t.string("`\"true\"` while that action can be sent, `\"false\"` otherwise."),
        error: t.boolean(),
        vendor: t.nullable(t.string()),
        material: t.nullable(t.string()),
        filamentName: t.nullable(t.string()),
        spoolmanId: t.nullable(t.integer("The id of the linked spool, when there is one.")),
        key: t.string("The filament identity: profile plus colour set."),
    }, { description: "One slot as the dashboard sees it: what the printer reports, what Spoolman holds for it, and how the two are linked." }),

    Consumption: t.object({
        amsId: t.nullable(t.string("The slot the sliced file names for this filament.")),
        matchedAmsId: t.nullable(t.string("The slot the consumption will be booked from, decided by the service. Differs from `amsId` where the printer remapped the job.")),
        amsIdFromPrinter: t.boolean("Whether the slot came from the printer's own report rather than from the list order."),
        grams: t.number("The grams of this filament the print needs, or has consumed so far."),
        refill: t.object({
            before: t.boolean("Whether this is the part printed before the switch, from `from`, or the part after it, from `to`."),
            from: t.string("The slot that ran out."),
            to: t.string("The slot the AMS switched to."),
            layer: t.integer("The layer the printer reported the switch in."),
        }, { description: "Present when the filament was split at an AMS refill. The filament then has two entries, the one before the switch keyed with `@` and the slot." }),
    }, {
        additional: true,
        description: "One sliced filament of the print, keyed by its position in the slicer's filament list. Carries the profile and the colours next to the fields listed here.",
    }),

    PrintState: t.object({
        gcodeState: t.string("`IDLE`, `PREPARE`, `RUNNING`, `PAUSE`, `FINISH`, `FAILED` or `CANCEL`."),
        jobName: t.nullable(t.string("`subtask_name` as the printer reports it.")),
        modelTitle: t.nullable(t.string("The model's title from the sliced file, when the job is named after a MakerWorld print profile, \"0.2mm layer, 2 walls, 15% infill\", rather than after the model. Null otherwise; `jobName` stays what the printer reports either way.")),
        layerNum: t.integer("The layer being printed, counted from 1. 0 means none: the printer is idle, the result was cleared, or no layer has been reported yet."),
        totalLayers: t.nullable(t.integer("The 0-based index of the last layer of the sliced file, which is what the booking maths counts with, so a plate of 15 layers reads 14. Null without slice info.")),
        sliceInfo: t.nullable(t.object({
            filaments: t.array(t.object({}, { additional: true }), "The filament list of the sliced file."),
        })),
        sliceFetch: t.nullable(t.object({
            attempt: t.integer("Which fetch of the sliced file this was, counted from 1. 0 for the look before the print runs, which does not count."),
            attempts: t.integer("How many fetches a print gets in all."),
            final: t.boolean("Whether this was the last attempt, so nothing will be booked for this print."),
            kind: t.string("`connection` when the FTPS login itself failed, so no path was tried; `missing` when every path was tried and none held the file."),
            reason: t.string("What the printer answered, as the log says it."),
        }, { description: "Set while the running job has no slice info and the last fetch of its file did not deliver a path: while that fetch is still under way, after the printer refused the FTPS login, or once every candidate path was tried and none held the file. Null once the file is read, or when nothing was looked for." })),
        storagePresent: t.nullable(t.boolean("Whether the printer's USB stick or SD card is in, from `print.sdcard`. It is the storage the sliced file is read from, so `false` means nothing will be booked. Null until a report carried the field.")),
        loadedSpools: t.array(t.ref("ClientSpool"), "The same list as `GET /api/spools/{printerId}`."),
        fullConsumption: t.nullable(t.object({}, { additional: t.ref("Consumption"), description: "What the whole print needs, per sliced filament." })),
        consumption: t.nullable(t.object({}, { additional: t.ref("Consumption"), description: "What has been consumed at the current layer, or the whole amount once the print finished." })),
        emptiedSlots: t.array(t.object({
            amsId: t.string("The slot that ran empty."),
            spool: t.object({}, { additional: true, description: "The Spoolman spool it held when it was last seen loaded: `id`, and where known `name`, `vendor`, `material`, `colorHex`, `multiColorHexes`, `remainingWeight` and `initialWeight`." }),
            refill: t.nullable(t.object({
                to: t.string("The slot the AMS switched to."),
                layer: t.integer("The layer the printer reported the switch in."),
            }, { description: "Set when the AMS took over from a backup slot. Null while the filament left in the tube is still printing." })),
        }), "The slots the running print was taking filament from that the AMS reports empty now. Their consumption is still booked on the spool they held, and the consumption maps name them in `matchedAmsId`. Empty outside a print."),
        holderFilaments: t.array(t.object({
            index: t.integer("The filament's position in the sliced file, counting from 0."),
            amsId: t.string("The holder, `External` or `External-2`."),
            type: t.nullable(t.string()),
            trayInfoIdx: t.nullable(t.string()),
            color: t.nullable(t.string("The colour the sliced file gives the filament.")),
            colors: t.nullable(t.array(t.string())),
            grams: t.number("What the whole print needs of it."),
            usedGrams: t.nullable(t.number("What has been printed of it so far, or in all once the print ended.")),
            spool: t.nullable(t.object({}, { additional: true, description: "The spool named for it: `id`, and where known `name`, `vendor`, `material`, `colorHex`, `multiColorHexes`, `remainingWeight` and `initialWeight`." })),
            status: t.nullable(t.string("Once the print has ended, what the booking did with it, as in `lastPrintSummary`: `pending` while it waits for a spool. Null while the print runs.")),
        }), "The filaments of a print that take turns on one external holder swapped by hand (Bambu Studio's \"Use Multicolor with External\"). The printer does not say which spool was loaded for which, so each is booked on the spool named for it with `PUT /api/print/{printerId}/filament/{index}` and on nothing else. Empty for any other print."),
        consumptionBooked: t.boolean("Whether the consumption of the last print has been written to Spoolman."),
        lastPrintSummary: t.nullable(t.object({}, { additional: true, description: "The closing report of the last print: what was booked where, and what could not be. `printError` is the English line of the log, `printErrorDetails` the same as parts, `{ kind, code, texts }` with the catalogue's sentence per language, for a client that words it in its own." })),
        printResetAt: t.nullable(t.number("When the result card clears itself, epoch milliseconds. Null while no countdown runs.")),
        printResultCleared: t.boolean(),
        startedAt: t.nullable(t.number("When the print was first seen running, epoch milliseconds.")),
        elapsedMs: t.nullable(t.number()),
        remainingMinutes: t.nullable(t.integer("What the printer says the job still needs.")),
        estimatedEndAt: t.nullable(t.number("Epoch milliseconds, cut to the whole minute the printer's estimate has. Null while paused.")),
        stage: t.nullable(t.string("The printer's current stage in words.")),
        stageCode: t.nullable(t.integer("The number the printer reports for that stage, `stg_cur`. Null whenever `stage` is.")),
        preparing: t.boolean("Whether the printer is still calibrating or heating."),
        error: t.string("Set instead of `sliceInfo` when the sliced file could not be fetched. That answer is a short one: only `gcodeState`, `jobName`, `layerNum`, `error`, a null `sliceInfo`, an empty `loadedSpools` and a null `consumption`, none of the other fields."),
    }),

    Mapping: t.object({
        spoolId: t.integer("The Spoolman spool the slot is assigned to."),
        fingerprint: t.nullable(t.string("What the slot held when it was assigned, as `tray_info_idx|tray_type|COLOUR`, with the sorted colour set appended as a fourth part for a multi colour spool: `GFA00|PLA|FF0000`. The assignment is dropped when the slot stops matching. A file written by an older version may carry the two part `PLA|FF0000` form, which is still read.")),
        updatedAt: t.string("ISO 8601."),
        automatic: t.boolean("Present and true when the service made the assignment."),
    }, { required: ["spoolId", "updatedAt"] }),

    FilamentInput: t.object({
        name: t.string(),
        material: t.string(),
        density: t.number("Grams per cubic centimetre. Required.", { example: 1.24 }),
        diameter: t.number("Millimetres. Required.", { example: 1.75 }),
        colorHexes: t.array(t.string(), "Six hex digits each, with or without `#`. More than one makes a multi colour filament."),
        colorHex: t.string("A single colour, for a caller that sends one."),
        multiColorDirection: t.string(null, { enum: ["coaxial", "longitudinal"] }),
        weight: t.number("Net weight of a full spool, grams."),
        spoolWeight: t.number("Weight of the empty spool, grams."),
        extruderTemp: t.number(),
        bedTemp: t.number(),
        vendorId: t.integer("An existing Spoolman vendor."),
        vendorName: t.string("Creates the vendor when `vendorId` is absent."),
        vendorExternalId: t.string("The catalogue's own id of the vendor."),
        vendorSpoolWeight: t.number("The weight of the vendor's empty spool, grams."),
    }, { required: ["density", "diameter"] }),

    SpoolInput: t.object({
        initialWeight: t.number("Grams."),
        remainingWeight: t.number("Grams."),
        location: t.string("Defaults to the slot's location while the location setting is on."),
        lotNr: t.string(),
        comment: t.string(),
    }),

    SettingsField: t.object({
        key: t.string(),
        type: t.string(null, { enum: [...new Set(Object.values(SETTINGS_SCHEMA).map(field => field.type))] }),
        group: t.string("The card of the settings page the field belongs to."),
        label: t.string(),
        description: t.string(),
        options: t.nullable(t.array(t.string(), "The values an `enum` field takes, or a `set` field picks from. Null for every other type.")),
        default: t.nullable({}),
        min: t.nullable(t.number()),
        max: t.nullable(t.number()),
        restartRequired: t.boolean(),
        advanced: t.boolean(),
        header: t.boolean(),
        dialog: t.nullable(t.string()),
    }),

    SettingsView: t.object({
        values: t.object(
            Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([key, field]) => [key, settingSchema(field)])),
            { description: "The current values. A password field is always null here." },
        ),
        hasValue: t.object({}, { additional: t.boolean(), description: "Whether a password field holds a value, keyed by field." }),
        sources: t.object({}, { additional: t.string(), description: "Where each value comes from: the settings file, the environment or the default." }),
        fields: t.array(t.ref("SettingsField"), "The schema, which is what the settings page renders."),
        spoolmanUrl: t.string(),
        restartPending: t.boolean("A stored value waits for the next start."),
        revision: t.integer("Send it back with the next save to refuse a save against a replaced state."),
        supervised: t.boolean("Whether a restart brings the service back on its own."),
    }),

    ApiKey: t.object({
        id: t.string("A UUID."),
        name: t.string(),
        createdAt: t.string("ISO 8601."),
        lastUsedAt: t.nullable(t.string("ISO 8601, at most a minute behind.")),
    }, { required: ["id", "name", "createdAt", "lastUsedAt"] }),

    SystemInfo: t.object({
        version: t.string(),
        image: t.nullable(t.string("The name the image was published under, `ghcr.io/rdiger-36/haspelsync`; null for a checkout or a locally built image.")),
        imageDeprecated: t.boolean("The container runs from the old image name, which will stop receiving releases."),
        node: t.string(),
        platform: t.string(),
        os: t.string(),
        uptime: t.integer("Seconds."),
        supervised: t.boolean(),
        tracking: t.string("`G-code` or `legacy (AMS RFID remain %)`."),
        mode: t.string(null, { enum: ["automatic", "manual"] }),
        memoryMB: t.integer(),
        printers: t.integer(),
        apiKeys: t.integer("How many keys exist, never which."),
        amsUnits: t.array(t.object({ printer: t.string(), units: t.array(t.string()) })),
        spoolman: t.string(),
        dataDir: t.string(),
        logsDir: t.string(),
        environmentConfigured: t.boolean(),
        environmentVariables: t.array(t.string()),
    }),

    UpdateCheck: t.object({
        current: t.string(),
        latest: t.nullable(t.string()),
        updateAvailable: t.boolean(),
        ahead: t.boolean("True on a dev or release candidate image newer than any release."),
        url: t.nullable(t.string("The release page.")),
        checked: t.string("ISO 8601."),
        error: t.nullable(t.string("Why the check failed, for an installation without internet access.")),
    }),

    Notice: t.object({
        active: t.boolean(),
        acknowledged: t.boolean("Dismissed in the Web UI. Stored server side, so it holds for every browser."),
        variables: t.array(t.string(), "The settings whose value still comes from the environment."),
        printerVariables: t.array(t.string(), "The PRINTER_* variables that are set."),
        printerVariablesIgnored: t.boolean("They no longer do anything because printers.json owns the list."),
    }, { additional: true }),

    ImageNotice: t.object({
        active: t.boolean("The container runs from the deprecated image name."),
        acknowledged: t.boolean("Dismissed in the Web UI since the service started. Held in memory for every browser, and back after every start until the image has been switched."),
        image: t.nullable(t.string("The image the container runs from.")),
        replacement: t.string("The image to switch to."),
        docs: t.string("The page of the documentation that says how."),
    }),

    UpgradeNotice: t.object({
        active: t.boolean("This process, or one before it, started on the files of a 1.2.x installation and the notice has not been dismissed."),
        acknowledged: t.boolean("Dismissed in the Web UI. Stored server side, so it holds for every browser."),
        docs: t.string("The page of the documentation that lists what changed."),
    }),

    LogLines: t.object({
        logs: t.array(t.string(), "The last lines, oldest first, read across the rotated files."),
        files: t.integer("How many files the history spans."),
        bytes: t.integer("Their size together."),
        file: t.string("The name of the current file."),
        capturing: t.boolean("For the trace: whether it is being written at all."),
    }),

    SseEvent: t.object({
        type: t.string("What happened.", {
            enum: ["slot_update", "status", "refresh", "ams_env", "monitoring_update", "printers_update", "print_result_cleared", "print_filaments", "settings_update"],
        }),
        printer: t.string("The serial number of the printer the event is about, where it is about one."),
    }, {
        additional: true,
        description: "The `data:` field of every event, as JSON. `slot_update` carries a `spool` (a ClientSpool), `ams_env` an `amsEnv` list, `monitoring_update` an `enabled` flag, `status` a `lastMqttUpdate` and a `lastMqttAmsUpdate` (both ISO 8601, the second null until the slots were processed once) and `settings_update` the new `values`. `printers_update` and `settings_update` name no printer.",
    }),
};

/**
 * The OpenAPI schema of one settings field, derived from the schema in
 * settings.js so a new field documents itself.
 *
 * @param {object} field - an entry of SETTINGS_SCHEMA
 * @returns {object} an OpenAPI schema
 */
function settingSchema(field) {
    const base = { description: field.description };
    if (field.restartRequired) base.description += " Takes effect on the next start.";

    switch (field.type) {
        case "integer":
            return { type: "integer", ...base, ...(field.min != null ? { minimum: field.min } : {}), ...(field.max != null ? { maximum: field.max } : {}) };
        case "boolean":
            return { type: "boolean", ...base };
        case "password":
            return { type: "string", nullable: true, ...base, description: `${base.description} Never sent; an empty string keeps the stored value, null removes it.` };
        case "enum":
            return { type: "string", ...base, ...(field.options ? { enum: [...field.options] } : {}) };
        case "set":
            return { type: "array", items: { type: "string", ...(field.options ? { enum: [...field.options] } : {}) }, ...base };
        default:
            // A string field defaults to null and goes back to null when it is
            // saved blank, so there is no string field that is never null.
            return { type: "string", nullable: true, ...base };
    }
}

/**
 * Builds the document.
 *
 * Built on every request rather than once at import, because the version and
 * the settings schema are the only inputs and both are cheap. Nothing in it
 * depends on the runtime state of the service, so it is the same document
 * whether or not a printer is configured.
 *
 * @returns {object} an OpenAPI 3.0.3 document
 */
export function buildOpenApiDocument() {
    const paths = {};

    /**
     * Registers one operation, so the list below reads path by path.
     *
     * The answers every route shares are attached here rather than written
     * forty times: the 403 of the request guard on every operation, the 401
     * of the login middleware on every operation that is not public. A public
     * one gets an empty `security` on top, which is how Swagger UI and Postman
     * learn that the document's global requirement does not apply to it.
     */
    const op = (method, path, operation) => {
        const isPublic = !!operation["x-public"];
        const shared = {
            ...(isPublic ? {} : { 401: sharedResponse("Unauthorized") }),
            403: sharedResponse("Forbidden"),
        };
        (paths[path] ||= {})[method] = {
            ...operation,
            ...(isPublic ? { security: [] } : {}),
            responses: { ...operation.responses, ...shared },
        };
    };

    // ---- Login -----------------------------------------------------------

    op("get", "/api/auth/state", {
        tags: ["Login"],
        summary: "Whether a password is set, and whether this request is logged in",
        "x-public": true,
        responses: {
            200: json("The state", t.object({
                required: t.boolean("A password is set and the Web UI asks for it."),
                authenticated: t.boolean("This request carries a valid session, or no password is set."),
            })),
        },
    });

    op("post", "/api/auth/login", {
        tags: ["Login"],
        summary: "Log in with the Web UI password",
        description: "Answers with the session cookie the Web UI uses. A script does not need this: it sends an API key instead, see the note at the top of the page.",
        "x-public": true,
        requestBody: body(t.object({ password: t.string() }, { required: ["password"] })),
        responses: {
            200: json("Logged in, or no password is set (`required: false`)", t.object({ ok: t.boolean(), required: t.boolean() })),
            401: json("Wrong password", t.object({
                ok: t.boolean(null, { enum: [false] }),
                error: t.string(),
                retryAfter: t.integer("Always 0 here; the wait is what the 429 carries.", { enum: [0] }),
            })),
            429: json("Too many wrong attempts from this address", t.object({
                ok: t.boolean(null, { enum: [false] }),
                error: t.string(),
                retryAfter: t.integer("Seconds to wait."),
            })),
        },
    });

    op("post", "/api/auth/logout", {
        tags: ["Login"],
        summary: "End the session of this browser",
        "x-public": true,
        responses: { 200: json("Logged out", t.ref("Ok")) },
    });

    // ---- Printers --------------------------------------------------------

    op("get", "/api/printers", {
        tags: ["Printers"],
        summary: "The printers, by serial number and name",
        responses: { 200: json("The list", t.array(t.ref("PrinterRef"))) },
    });

    op("get", "/api/printers/config", {
        tags: ["Printers"],
        summary: "The printers with address and connection state",
        description: "The access code is never part of it; `hasCode` says whether one is stored.",
        responses: { 200: json("The list", t.array(t.ref("Printer"))) },
    });

    op("post", "/api/printers", {
        tags: ["Printers"],
        summary: "Add a printer",
        description: "Connects to it right away rather than on the next monitor pass.",
        requestBody: body(t.ref("PrinterInput"), { example: { id: "01P00A000000001", name: "Bambu P2S", ip: "192.168.1.60", code: "12345678" } }),
        responses: {
            200: json("Added", t.object({ ok: t.boolean(), printer: t.ref("Printer") })),
            400: failure("A field is missing or the serial number already exists"),
        },
    });

    op("put", "/api/printers/{printerId}", {
        tags: ["Printers"],
        summary: "Rename a printer or change its address or access code",
        description: "A new address or code reconnects the printer, which loses the booking of a running print. The 409 guard is stricter than the reconnect: it fires on a changed `ip` and on any non-empty `code`, the stored code being unknown to the caller, so re-sending the same code mid print is refused unless `force` is set, while the reconnect itself happens only when the address or the code really differs (`reconnected` says whether it did). A rename alone does not reconnect; it renames the Spoolman locations of the printer's slots while `SET_LOCATION` is on.",
        parameters: [printerId],
        requestBody: body(t.ref("PrinterPatch"), { example: { name: "Bambu P2S", ip: "192.168.1.60", code: "" } }),
        responses: {
            200: json("Updated", t.object({ ok: t.boolean(), printer: t.ref("Printer"), reconnected: t.boolean() })),
            400: failure("A value is unusable"),
            404: PRINTER_NOT_FOUND,
            409: PRINT_IN_FLIGHT,
        },
    });

    op("put", "/api/printers/{printerId}/logdetail", {
        tags: ["Printers"],
        summary: "Set how much this printer writes to its log",
        description: "An empty object puts the printer back on the global log settings, and so does a body that is not an object. A field the service does not know, or a level or category it does not know, is dropped without an error rather than refused; the `printer` in the answer says what was kept.",
        parameters: [printerId],
        requestBody: body(t.ref("LogDetail"), { example: { level: "debug", categories: ["mqtt", "ams"], mqttTrace: false } }),
        responses: {
            200: json("Stored, as normalised", t.object({ ok: t.boolean(), printer: t.ref("Printer") })),
            404: PRINTER_NOT_FOUND,
        },
    });

    op("delete", "/api/printers/{printerId}", {
        tags: ["Printers"],
        summary: "Remove a printer",
        description: "Disconnects it, gives back the Spoolman locations this service wrote for its slots while `SET_LOCATION` is on, and drops its assignments. The log file is kept.",
        "x-confirm": "This removes the printer and its assignments, and while SET_LOCATION is on the Spoolman locations this service wrote for its slots.",
        parameters: [printerId],
        requestBody: body(t.object({ force }), { required: false }),
        responses: {
            200: json("Removed", t.object({ ok: t.boolean(), removed: t.string("The serial number.") })),
            404: PRINTER_NOT_FOUND,
            409: PRINT_IN_FLIGHT,
        },
    });

    op("post", "/api/printers/reconnect", {
        tags: ["Printers"],
        summary: "Rebuild the MQTT connection of every monitored printer",
        description: "Keeps the process and with it the consumption tracking of a running print, which is what makes it safe to call at any time.",
        responses: {
            200: json("Done", t.object({
                ok: t.boolean(),
                reconnected: t.array(t.string(), "The serial numbers that were reconnected."),
                skipped: t.integer("How many were not monitored and therefore left alone."),
            })),
        },
    });

    op("post", "/api/test/printer", {
        tags: ["Printers"],
        summary: "Test the MQTT and FTPS connection to a printer",
        description: "Takes the values as typed rather than the stored ones, so a printer can be tried before it is saved. An empty code for a known serial number tests the stored code. Nothing is written.",
        requestBody: body(t.object({
            id: t.string("The serial number."),
            ip: t.string(),
            code: t.string("The access code. May be empty for a printer that is already configured."),
        }, { required: ["id", "ip"] }), { example: { id: "01P00A000000001", ip: "192.168.1.60", code: "12345678" } }),
        responses: {
            200: json("Both results. `ok` is true only when both passed.", t.object({
                ok: t.boolean(),
                mqtt: t.ref("ConnectionTest"),
                ftps: t.ref("ConnectionTest"),
            })),
            400: failure("A field is missing"),
        },
    });

    // ---- Status and print ------------------------------------------------

    op("get", "/api/status/{printerId}", {
        tags: ["Status"],
        summary: "The connection state of a printer and of Spoolman",
        parameters: [printerId],
        responses: {
            200: json("The status", t.ref("Status")),
            404: PRINTER_NOT_FOUND,
        },
    });

    op("get", "/api/spools/{printerId}", {
        tags: ["Status"],
        summary: "Every slot of a printer, with what is in it and what Spoolman holds for it",
        description: "Read from the cache the last AMS report filled, so it never waits for the printer. Empty until the printer has reported once.",
        parameters: [printerId],
        responses: {
            200: json("The slots", t.array(t.ref("ClientSpool"))),
            404: PRINTER_NOT_FOUND,
        },
    });

    op("get", "/api/print/{printerId}", {
        tags: ["Status"],
        summary: "The running or last print: state, progress and consumption per slot",
        description: "The consumption comes from the sliced file, which is fetched from the printer over FTPS once per job. `?job=` fetches the file of a named job instead, which is the manual test of that path. When that fetch throws, the answer is still a 200 but a short one: `gcodeState`, `jobName`, `layerNum`, `error`, a null `sliceInfo`, an empty `loadedSpools` and a null `consumption`, nothing else.",
        parameters: [printerId, {
            name: "job",
            in: "query",
            required: false,
            description: "The name of a job on the printer whose sliced file should be read, instead of the current one.",
            schema: t.string(),
        }],
        responses: {
            200: json("The print", t.ref("PrintState")),
            404: PRINTER_NOT_FOUND,
        },
    });

    op("post", "/api/print/{printerId}/clear", {
        tags: ["Status"],
        summary: "Clear the finished print from the dashboard now",
        description: "The summary of the print stays reachable; only the result card goes.",
        parameters: [printerId],
        responses: {
            200: json("Cleared", t.ref("Ok")),
            404: PRINTER_NOT_FOUND,
            409: failure("The printer is still printing"),
        },
    });

    op("put", "/api/print/{printerId}/filament/{index}", {
        tags: ["Status"],
        summary: "Name the spool a filament swapped onto the external holder came from",
        description: "For a print that sends several filaments to the external holder and stops at each change for the spool to be swapped by hand. While the print runs, the spool is kept and the filament is booked on it when the print ends. Once it has ended, a filament still waiting for a spool (`pending` in `holderFilaments` and in the summary) is booked on it straight away. Not available in legacy mode.",
        parameters: [printerId, filamentIndex],
        requestBody: body(t.object({ spoolId: t.integer(null, { minimum: 1 }) }, { required: ["spoolId"] }), { example: { spoolId: 12 } }),
        responses: {
            200: json("Named, or booked when the print has ended", t.object({ ok: t.boolean(), row: t.nullable(t.object({}, { additional: true, description: "The summary row of the booking made, when one was made." })) })),
            400: failure("The index or `spoolId` is not valid"),
            404: failure("No such printer or Spoolman spool"),
            409: failure("The filament does not run from a holder swapped by hand, is not waiting for a spool, or legacy mode is on"),
            502: failure("Spoolman could not be asked, or refused the booking"),
        },
    });

    op("delete", "/api/print/{printerId}/filament/{index}", {
        tags: ["Status"],
        summary: "Take back the spool named for a filament",
        description: "Only while the print runs. Once it has ended the filament is booked, and Spoolman is where that is corrected. Not available in legacy mode.",
        parameters: [printerId, filamentIndex],
        responses: {
            200: json("Taken back, or there was nothing to take back", t.ref("Ok")),
            400: failure("The index is not valid"),
            404: PRINTER_NOT_FOUND,
            409: failure("The print has ended, or legacy mode is on"),
        },
    });

    op("get", "/api/events", {
        tags: ["Status"],
        summary: "Live updates as Server-Sent Events",
        description: "One stream for every printer. Each event is a JSON document in the `data:` field; `type` says what happened and `printer` which printer it is about. The explorer shows the events as they arrive.",
        "x-stream": true,
        responses: {
            200: {
                description: "The stream",
                content: { "text/event-stream": { schema: t.ref("SseEvent") } },
            },
        },
    });

    // ---- Monitoring ------------------------------------------------------

    for (const action of ["start", "stop"]) {
        op("post", `/api/printer/{printerId}/monitoring/${action}`, {
            tags: ["Monitoring"],
            summary: action === "start" ? "Resume monitoring a printer" : "Pause monitoring a printer",
            description: action === "start"
                ? "Reconnects at once, clearing any backoff a switched off printer had built up."
                : "Closes the MQTT connection and stops probing the printer until it is resumed. What a Home Assistant switch drives.",
            parameters: [printerId],
            responses: {
                200: json("Done, or `ok: false` with a `message` when it already was", t.object({
                    ok: t.boolean(),
                    printer: t.string(),
                    monitoringEnabled: t.boolean(),
                    message: t.string("Only when nothing changed."),
                })),
                404: PRINTER_NOT_FOUND,
            },
        });
    }

    op("post", "/api/monitoring/{action}", {
        tags: ["Monitoring"],
        summary: "Resume or pause monitoring of every printer at once",
        parameters: [{
            name: "action",
            in: "path",
            required: true,
            schema: t.string(null, { enum: ["start", "stop"] }),
        }],
        responses: {
            200: json("What changed", t.object({
                ok: t.boolean(),
                enabled: t.boolean(),
                changed: t.array(t.string(), "The serial numbers whose state changed."),
                total: t.integer(),
            })),
            404: failure("Unknown action"),
        },
    });

    // ---- Spoolman actions (manual mode) ----------------------------------

    const slotBody = body(t.object({
        printerId: t.string("The serial number."),
        amsId: t.string("The slot label."),
    }, { required: ["printerId", "amsId"] }), { example: { printerId: "01P00A000000001", amsId: "A1" } });

    const slotAction = (summary, description) => ({
        tags: ["Slot actions"],
        summary,
        description: `${description} What the button on the dashboard sends in manual mode; in automatic mode the service does it on its own.`,
        requestBody: slotBody,
        responses: {
            200: json("Written", t.ref("Ok")),
            404: failure("No such printer or slot"),
            500: failure("The write threw; the message is the error's"),
            502: failure("Spoolman refused the write"),
        },
    });

    op("post", "/api/mergeSpool", slotAction(
        "Link the spool in a slot to the matching Spoolman spool",
        "Writes the slot's RFID tag onto the Spoolman spool the slot was matched to.",
    ));
    op("post", "/api/createSpool", slotAction(
        "Create a Spoolman spool for a slot from an existing filament",
        "The filament already exists in Spoolman; the spool is created and tagged.",
    ));
    op("post", "/api/createSpoolWithFilament", slotAction(
        "Create filament and spool for a slot from the SpoolmanDB catalogue",
        "Imports the matching catalogue entry as a filament, then creates the tagged spool.",
    ));

    // ---- Assignments -----------------------------------------------------

    op("get", "/api/mappings/{printerId}", {
        tags: ["Assignments"],
        summary: "The slot assignments of a printer",
        parameters: [printerId],
        responses: {
            200: json("Keyed by slot label", t.object({}, { additional: t.ref("Mapping") }), {
                A2: { spoolId: 12, fingerprint: "GFA00|PLA|FF0000", updatedAt: "2026-09-08T20:15:00.000Z" },
            }),
            404: PRINTER_NOT_FOUND,
        },
    });

    op("put", "/api/mappings/{printerId}/{amsId}", {
        tags: ["Assignments"],
        summary: "Assign a Spoolman spool to a slot",
        description: "For a slot the printer cannot identify, a 3rd party spool, or to pick between two tagged spools of the same kind. While `SET_LOCATION` is on, the spool takes the slot's Spoolman location and the one assigned before gives it back. Not available in legacy mode.",
        parameters: [printerId, amsId],
        requestBody: body(t.object({ spoolId: t.integer(null, { minimum: 1 }) }, { required: ["spoolId"] }), { example: { spoolId: 12 } }),
        responses: {
            200: json("Assigned", t.object({ ok: t.boolean(), mapping: t.ref("Mapping") })),
            400: failure("`spoolId` is not a positive integer"),
            404: failure("No such printer, slot or Spoolman spool"),
            409: LEGACY_MODE,
            500: failure("The assignment or a location write threw; the message is the error's"),
        },
    });

    op("delete", "/api/mappings/{printerId}/{amsId}", {
        tags: ["Assignments"],
        summary: "Remove the assignment of a slot",
        description: "While `SET_LOCATION` is on, the spool gives back the slot's Spoolman location when this service wrote it. Not available in legacy mode.",
        "x-confirm": "This removes the assignment. Nothing is booked from the slot until it is assigned again.",
        parameters: [printerId, amsId],
        responses: {
            200: json("Removed, or there was nothing to remove", t.object({ ok: t.boolean(), removed: t.boolean() })),
            404: PRINTER_NOT_FOUND,
            409: LEGACY_MODE,
        },
    });

    op("post", "/api/thirdparty/spool/{printerId}/{amsId}", {
        tags: ["Assignments"],
        summary: "Create a spool for a slot and assign it in one step",
        description: "For a slot without an RFID tag. Either names an existing filament by `filamentId`, or describes one to create, with its vendor when that one is new as well. What the create tab of the assign dialog sends. Not available in legacy mode.",
        parameters: [printerId, amsId],
        requestBody: body(t.object({
            filamentId: t.integer("An existing Spoolman filament. When set, `filament` is ignored."),
            filament: t.ref("FilamentInput"),
            spool: t.ref("SpoolInput"),
        }), {
            example: {
                filament: { name: "PLA Matte Black", material: "PLA", density: 1.24, diameter: 1.75, colorHexes: ["1A1A1A"], weight: 1000, spoolWeight: 250, vendorName: "Sunlu" },
                spool: { initialWeight: 1000, remainingWeight: 1000, lotNr: "", comment: "" },
            },
        }),
        responses: {
            200: json("Created and assigned", t.object({
                ok: t.boolean(),
                spoolId: t.integer(),
                filamentId: t.integer(),
                mapping: t.ref("Mapping"),
            })),
            400: failure("Neither `filamentId` nor a usable `filament`"),
            404: failure("No such printer or slot"),
            409: LEGACY_MODE,
            500: failure("Spoolman refused the write; the body carries what it said"),
        },
    });

    // ---- Spoolman --------------------------------------------------------

    op("get", "/api/spoolman/spools", {
        tags: ["Spoolman"],
        summary: "Every spool in Spoolman, as Spoolman answers it",
        description: "Passed through untouched, archived spools left out. What the assign dialog picks from. A Spoolman outage is answered with 200 and an empty list, never with a failure; `GET /api/status/{printerId}` says whether Spoolman is reachable.",
        responses: {
            200: json("The list, in Spoolman's own shape", t.array(t.object({}, { additional: true }))),
        },
    });

    op("get", "/api/spoolman/spool/{id}", {
        tags: ["Spoolman"],
        summary: "One spool in Spoolman, the whole record",
        parameters: [spoolId],
        responses: {
            200: json("The spool, in Spoolman's own shape", t.object({}, { additional: true })),
            400: failure("The id is not a positive integer"),
            404: failure("No such spool"),
            502: failure("Spoolman could not be reached"),
        },
    });

    op("patch", "/api/spoolman/spool/{id}", {
        tags: ["Spoolman"],
        summary: "Correct the remaining weight, lot number, comment or archived flag of a spool",
        description: "The four fields the spool dialog edits in place. The weight is refused while a printer is printing with the spool, because the booking at the end of the job would overwrite it, and above what the spool can hold. Not available in legacy mode.",
        parameters: [spoolId],
        requestBody: body(t.object({
            remainingWeight: t.number("Grams, zero or more."),
            comment: t.string(),
            lotNr: t.string(),
            archived: t.boolean("Only a real boolean is taken."),
        }), { example: { remainingWeight: 640.5 } }),
        responses: {
            200: json("The spool as Spoolman answers it after the change", t.object({}, { additional: true })),
            400: failure("Nothing to change, or a value is unusable"),
            404: failure("No such spool"),
            409: json("A print is running with this spool (a PrintInFlight, with `printInFlight: true`), or legacy mode is on (a plain Error, without that field)", {
                oneOf: [t.ref("PrintInFlight"), t.ref("Error")],
            }),
            502: failure("Spoolman refused the change"),
        },
    });

    op("get", "/api/spoolman/lookups", {
        tags: ["Spoolman"],
        summary: "What the create spool dialog picks from: vendors, materials, locations, filaments",
        responses: {
            200: json("The lists", t.object({
                vendors: t.array(t.object({}, { additional: true }), "Spoolman's vendors."),
                materials: t.array(t.string(), "The materials of the filaments in Spoolman."),
                externalMaterials: t.array(t.object({
                    material: t.string(),
                    density: t.nullable(t.number("Grams per cubic centimetre.")),
                    extruder_temp: t.nullable(t.number("Degrees Celsius.")),
                    bed_temp: t.nullable(t.number("Degrees Celsius.")),
                }), "The materials the SpoolmanDB catalogue knows, as Spoolman's external material list answers them."),
                locations: t.array(t.string()),
                filaments: t.array(t.object({}, { additional: true }), "Spoolman's filaments."),
                externalVendors: t.array(t.string(), "The manufacturers of the catalogue."),
            })),
            502: failure("Spoolman could not be reached"),
        },
    });

    op("get", "/api/spoolman/external/filaments", {
        tags: ["Spoolman"],
        summary: "Search the SpoolmanDB catalogue",
        parameters: [
            { name: "manufacturer", in: "query", schema: t.string(), description: "Exact manufacturer name." },
            { name: "material", in: "query", schema: t.string(), description: "Matched by material family, so `PLA` also finds `PLA+` and `PLA Matte`." },
            { name: "q", in: "query", schema: t.string(), description: "A search term matched against the manufacturer, the name and the material, case insensitive." },
            { name: "limit", in: "query", schema: t.integer(null, { minimum: 1, maximum: 500, default: 100 }), description: "Ignored when `facet` is set: the facet lists every value." },
            { name: "facet", in: "query", schema: t.string(null, { enum: ["manufacturer", "material"] }), description: "List the distinct values of this field instead of the entries." },
        ],
        description: "Filtered here rather than in the browser: the whole catalogue is thousands of entries. `facet` lists the manufacturers or materials still on offer under the other filters instead of the entries themselves. A catalogue that cannot be loaded is answered with 200 and an empty list, never with a failure.",
        responses: {
            200: json("The matching entries, or the facet values as strings", t.array({
                oneOf: [t.object({}, { additional: true }), t.string()],
            })),
        },
    });

    op("post", "/api/test/spoolman", {
        tags: ["Spoolman"],
        summary: "Test a Spoolman address",
        description: "Builds the URL from the fields as typed and asks Spoolman's health endpoint. Nothing is written.",
        requestBody: body(t.object({
            SPOOLMAN_ENDPOINT: t.string("A full URL. When set, the three fields below are ignored."),
            SPOOLMAN_IP: t.string(),
            SPOOLMAN_PORT: t.string("The port, as the setting stores it: a string. A number is taken as well and turned into one."),
            SPOOLMAN_SUBFOLDER: t.string("The path Spoolman lives under behind a reverse proxy."),
        }), { example: { SPOOLMAN_IP: "192.168.1.50", SPOOLMAN_PORT: "7912", SPOOLMAN_SUBFOLDER: "" } }),
        responses: {
            200: json("The result, with the URL that was tried. All four fields are plain strings, so no value is ever refused; a wrong one shows up as `ok: false` here.", t.object({
                ok: t.boolean(),
                status: t.string("Spoolman's own health status, when reachable."),
                error: t.string("What to fix, when `ok` is false."),
                url: t.string(),
            })),
        },
    });

    // ---- Settings --------------------------------------------------------

    op("get", "/api/settings", {
        tags: ["Settings"],
        summary: "The runtime configuration with its schema",
        responses: { 200: json("The view", t.ref("SettingsView")) },
    });

    op("put", "/api/settings", {
        tags: ["Settings"],
        summary: "Change settings",
        description: "Takes a map of the fields to change, or that map under `values` together with the `revision` that was read, in which case a save against a replaced state is refused with 409. A wrapped body without a revision, or with one that is not an integer, is applied without the check, like the bare map. Applied to the running process at once, except for the fields the schema marks as restart required. A new password hands the caller a fresh session.",
        requestBody: body({
            oneOf: [
                t.object({}, { additional: true, description: "The bare field map." }),
                t.object({
                    revision: t.integer("The revision `GET /api/settings` handed out. Left out or not an integer, the check is skipped."),
                    values: t.object({}, { additional: true }),
                }, { required: ["values"], description: "The field map with the revision it was read at." }),
            ],
        }, { example: { UPDATE_INTERVAL: 120000, MODE: "manual" } }),
        responses: {
            200: json("The new view, plus what changed", {
                allOf: [t.ref("SettingsView"), t.object({
                    ok: t.boolean(),
                    changed: t.array(t.string(), "The keys whose value changed."),
                    restartRequired: t.array(t.string(), "The changed keys that take effect on the next start. Empty when none does."),
                })],
            }),
            400: json("An unknown setting or an unusable value; the message names it", t.object({
                ok: t.boolean(null, { enum: [false] }),
                error: t.string("The messages, joined with ` / `."),
                conflict: t.boolean("Always false here; the 409 is the conflict.", { enum: [false] }),
            })),
            409: json("The revision is stale", t.object({
                ok: t.boolean(null, { enum: [false] }),
                error: t.string(),
                conflict: t.boolean(null, { enum: [true] }),
            })),
            500: failure("settings.json could not be written"),
        },
    });

    // ---- API keys --------------------------------------------------------

    op("get", "/api/apikeys", {
        tags: ["API keys"],
        summary: "The API keys, without the keys themselves",
        responses: { 200: json("The list", t.object({ keys: t.array(t.ref("ApiKey")) })) },
    });

    op("post", "/api/apikeys", {
        tags: ["API keys"],
        summary: "Create an API key",
        description: "The key is in this answer and nowhere else afterwards: only its hash is stored.",
        requestBody: body(t.object({ name: t.string("Unique, at most 64 characters.") }, { required: ["name"] }), { example: { name: "Home Assistant" } }),
        responses: {
            200: json("Created", t.object({
                ok: t.boolean(),
                key: t.string("The key. Shown once."),
                entry: t.ref("ApiKey"),
                keys: t.array(t.ref("ApiKey")),
            })),
            400: failure("No name, a name too long, or one already in use"),
            500: failure("apikeys.json could not be written"),
        },
    });

    op("delete", "/api/apikeys/{id}", {
        tags: ["API keys"],
        summary: "Revoke an API key",
        "x-confirm": "The key stops working at once. Whatever uses it has to be given a new one.",
        parameters: [{ name: "id", in: "path", required: true, schema: t.string(), description: "The key id from the list." }],
        responses: {
            200: json("Revoked", t.object({ ok: t.boolean(), removed: t.ref("ApiKey"), keys: t.array(t.ref("ApiKey")) })),
            404: failure("No key with this id"),
            500: failure("apikeys.json could not be written"),
        },
    });

    // ---- Logs ------------------------------------------------------------

    const logSource = {
        name: "printerId",
        in: "path",
        required: true,
        description: "A printer's serial number, or `server` for the service's own log.",
        schema: t.string(null, { example: "server" }),
    };
    const stream = {
        name: "stream",
        in: "query",
        required: false,
        description: "`mqtt` reads the printer's raw MQTT trace instead of its log. The server has no trace.",
        schema: t.string(null, { enum: ["mqtt"] }),
    };

    op("get", "/api/logs/{printerId}", {
        tags: ["Logs"],
        summary: "The last lines of a log",
        description: "Reads across the rotated files, so the requested number of lines is delivered even right after a rotation.",
        parameters: [logSource, {
            name: "limit",
            in: "query",
            required: false,
            schema: t.integer(null, { minimum: 1, maximum: 2000, default: 250 }),
        }, stream],
        responses: {
            200: json("The lines", t.ref("LogLines")),
            404: failure("No such printer, or the server was asked for a trace"),
            500: failure("The file could not be read"),
        },
    });

    op("get", "/api/logs/download", {
        tags: ["Logs"],
        summary: "Download several logs as one zip",
        description: "The logs `scope` names, each with its rotated history, without the configuration files the diagnostics bundle carries. Anonymised unless `anonymize=false`; the access codes are masked in both variants.",
        "x-download": true,
        parameters: [{
            name: "scope",
            in: "query",
            required: true,
            description: "Comma separated: `server`, a serial number for both files of that printer, `<serial>/log` or `<serial>/trace` for one of them.",
            schema: t.string(null, { example: "server,01P00A000000001/log" }),
        }, {
            name: "anonymize",
            in: "query",
            required: false,
            schema: t.boolean(null, { default: true }),
        }],
        responses: {
            200: { description: "The zip", content: { "application/zip": { schema: t.string(null, { format: "binary" }) } } },
            400: failure("The scope names an unknown printer or log"),
            500: failure("The bundle could not be built"),
        },
    });

    op("get", "/api/logs/{printerId}/download", {
        tags: ["Logs"],
        summary: "Download a log with its rotated history",
        description: "One file as it is, several as a zip. Anonymised unless `anonymize=false`: addresses, serials and paths are masked. The access codes are masked in both variants.",
        "x-download": true,
        parameters: [logSource, {
            name: "anonymize",
            in: "query",
            required: false,
            schema: t.boolean(null, { default: true }),
        }, stream],
        responses: {
            200: {
                description: "The log file, or a zip of the history",
                content: {
                    "text/plain": { schema: t.string() },
                    "application/zip": { schema: t.string(null, { format: "binary" }) },
                },
            },
            404: failure("No such printer, no log file yet, or the server was asked for a trace"),
            500: failure("The files could not be read or archived"),
        },
    });

    // ---- Service ---------------------------------------------------------

    op("get", "/api/system", {
        tags: ["Service"],
        summary: "Facts about this installation",
        responses: { 200: json("The facts", t.ref("SystemInfo")) },
    });

    op("get", "/api/update", {
        tags: ["Service"],
        summary: "Whether a newer release exists on GitHub",
        description: "Cached for a while; `force=true` asks again. An installation without internet access gets an `error` rather than a failure.",
        parameters: [{ name: "force", in: "query", required: false, schema: t.boolean(null, { default: false }) }],
        responses: { 200: json("The result", t.ref("UpdateCheck")) },
    });

    op("get", "/api/diagnostics/download", {
        tags: ["Service"],
        summary: "Download the support bundle",
        description: "A zip with the logs, the configuration and the facts about the installation. The configuration files are always in it; `scope` chooses the logs. Anonymised unless `anonymize=false`, and the access codes are replaced in both variants.",
        "x-download": true,
        parameters: [{
            name: "scope",
            in: "query",
            required: false,
            description: "Comma separated: `server`, a serial number for both files of that printer, `<serial>/log` or `<serial>/trace` for one of them. Absent means everything.",
            schema: t.string(null, { example: "server,01P00A000000001/log" }),
        }, {
            name: "anonymize",
            in: "query",
            required: false,
            schema: t.boolean(null, { default: true }),
        }],
        responses: {
            200: { description: "The bundle", content: { "application/zip": { schema: t.string(null, { format: "binary" }) } } },
            400: failure("The scope names an unknown printer or log"),
            500: failure("The bundle could not be built"),
        },
    });

    op("post", "/api/restart", {
        tags: ["Service"],
        summary: "Restart the service",
        description: "Ends the process so the supervisor, or the container's restart policy, starts it again. Refused with 409 while a printer is printing unless `force` is set: the job is booked when it ends if the service is back by then, but on a P1 or an A1 the slots Bambu Studio sent it to are lost.",
        "x-confirm": "This ends the process. The Web UI is gone for a few seconds.",
        requestBody: body(t.object({ force }), { required: false }),
        responses: {
            200: json("The process ends right after this answer", t.ref("Ok")),
            409: PRINT_IN_FLIGHT,
        },
    });

    op("get", "/api/notices", {
        tags: ["Service"],
        summary: "The notices the dashboard may show",
        description: `Three: \`${UPGRADE_NOTICE}\`, this installation was updated from 1.2.x and has not read what changed, \`${ENV_CONFIG_NOTICE}\`, it is still configured through environment variables, and \`${IMAGE_NOTICE}\`, the container runs from the old image name.`,
        responses: {
            200: json("Keyed by notice id", t.object({ [UPGRADE_NOTICE]: t.ref("UpgradeNotice"), [ENV_CONFIG_NOTICE]: t.ref("Notice"), [IMAGE_NOTICE]: t.ref("ImageNotice") })),
        },
    });

    op("post", "/api/notices/{id}/ack", {
        tags: ["Service"],
        summary: "Dismiss a notice",
        description: "Stored server side, so it stays dismissed in every browser.",
        parameters: [{ name: "id", in: "path", required: true, schema: t.string(null, { enum: [UPGRADE_NOTICE, ENV_CONFIG_NOTICE, IMAGE_NOTICE] }) }],
        responses: {
            200: json("Dismissed", t.ref("Ok")),
            404: failure("Unknown notice"),
            500: failure("settings.json, which holds the acknowledgement, could not be written"),
        },
    });

    op("get", "/api/openapi.json", {
        tags: ["Service"],
        summary: "This document",
        description: "OpenAPI 3.0. Import it into Swagger UI, Postman or any client generator.",
        responses: { 200: json("The document", t.object({}, { additional: true })) },
    });

    return {
        openapi: "3.0.3",
        info: {
            title: "HaspelSync",
            version,
            description: [
                "The HTTP API of the service that keeps a Bambu Lab AMS in sync with Spoolman. Every route answers JSON,",
                "a failure as `{ ok: false, error }` with a 4xx or 5xx status, and the ones that download a file or stream events say so.",
                "",
                "**Who may call it.** The Web UI of this installation, and any caller carrying an API key in",
                "`Authorization: Bearer <key>` or `X-API-Key: <key>`. Keys are created under *Network access* on the settings page.",
                "Anything else is answered with 401: without a Web UI password a request the browser marks as the Web UI's own passes,",
                "with one set a browser needs a session from `POST /api/auth/login`. Only the three login routes are open.",
                "Before any of that, every request has to pass the request guard: a `Host` that is not on the allowed list, or a",
                "request that changes something and comes from another origin, is answered with 403, the login routes included.",
                "",
                "**Slot labels** count the way the printer does: `A1` is the first slot of the first AMS, `External` the spool holder,",
                "`External-2` the second holder of a dual nozzle printer, `HT-A` the first AMS HT.",
            ].join("\n"),
            license: { name: "GPL-3.0", url: "https://github.com/Rdiger-36/HaspelSync/blob/main/LICENSE" },
        },
        externalDocs: {
            description: "The documentation on GitHub",
            url: "https://github.com/Rdiger-36/HaspelSync/blob/main/docs/api.md",
        },
        servers: [{ url: "/", description: "This installation" }],
        tags: [
            { name: "Login", description: "The Web UI password. A script sends an API key instead and never needs these." },
            { name: "Printers", description: "The printer list, as the settings page edits it." },
            { name: "Status", description: "What the dashboard shows: connection state, slots, the running print, and the live stream behind it." },
            { name: "Monitoring", description: "Pausing and resuming the connection to a printer, per printer or for all of them." },
            { name: "Slot actions", description: "The three Spoolman writes the dashboard offers per slot in manual mode." },
            { name: "Assignments", description: "Linking a slot the printer cannot identify to a Spoolman spool, which is what makes its consumption bookable." },
            { name: "Spoolman", description: "What the dialogs read from Spoolman and the SpoolmanDB catalogue, and the spool fields edited in place." },
            { name: "Settings", description: "The runtime configuration, stored in printers/settings.json." },
            { name: "API keys", description: "Keys for callers that have no browser to log in with. A key is a full session." },
            { name: "Logs", description: "The log and the raw MQTT trace of each printer, and the server log." },
            { name: "Service", description: "Facts about the installation, the update check, the support bundle, the restart, the notices the dashboard shows, and this document." },
        ],
        paths,
        components: {
            securitySchemes: {
                bearer: { type: "http", scheme: "bearer", description: "`Authorization: Bearer ams_...`" },
                apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
                session: { type: "apiKey", in: "cookie", name: "ams_session", description: "The cookie `POST /api/auth/login` sets. What the Web UI uses." },
            },
            schemas,
            responses,
        },
        security: [{ bearer: [] }, { apiKey: [] }, { session: [] }],
    };
}
