# Backend modules

## Purpose

Owns everything between the printer's MQTT stream and Spoolman: reading AMS
slot data, deciding what each slot means, creating/merging/updating spools in
Spoolman, booking filament consumption per print, and exposing the HTTP + SSE
API the frontend consumes.

Does **not** own rendering (`../public/`), process lifecycle (`../entrypoint.js`
and `../starting.js`) or the Express app wiring itself (`../backend.js`).

## Entry points

| File | Owns |
|---|---|
| `config.js` | The on-disk paths (overridable with `DATA_DIR` and `LOG_DIR`), the port, the version, and the raw environment values that seed the two config files. The only module allowed to read `process.env`. |
| `settings.js` | The runtime configuration: schema, coercion, the resolved `settings` object, `spoolmanUrl()`, the frozen `legacyMode()` and the persistence of `printers/settings.json`, including its schema version and write counter. Owns `LOG_LEVELS` and `LOG_CATEGORIES`. Must not import `logger.js`, which reads the level from here. |
| `service.js` | The startup sequence, the Spoolman reconnect that the settings API triggers when the endpoint changes, and `restartService()`, which ends the process with the restart exit code. The `tag` extra field is the only bootstrap that gates it; the vendor is resolved at the point of use. |
| `supervisor.js` | The decision `entrypoint.js` makes when the service ends, and the exit code it looks for. Deliberately free of imports so it can be tested without spawning a process. |
| `logger.js` | The `console.*` overrides, `debug()`/`trace()` with their level and category filter, the per-file override registry `printers.js` fills, `appendTrace()` for the raw MQTT capture, the serialised per-file write queue, `tailLogLines()` for the log viewer, which reads across the rotated files, and the size based rotation itself. |
| `printers.js` | Loads and writes `printers/printers.json` (or seeds it from the `PRINTER_*` env vars), seeds the mutable per-printer runtime object, and owns add, update and remove. |
| `mqtt.js` | The engine. Connection lifecycle, message handling, slot processing, print-state tracking, consumption booking, SSE broadcast, monitor loops. |
| `ams.js` | Pure functions over AMS payloads: normalisation, change detection, spool matching, and `matchConsumption()`, the one decision about which sliced filament comes out of which slot. No I/O. |
| `gcode.js` | FTPS fetch of the sliced 3MF, `slice_info.config` parsing, the per layer weight of every filament counted from the plate's G-code, consumption maths. |
| `spoolman.js` | Every Spoolman HTTP call. No other module talks to Spoolman directly. |
| `mappings.js` | Manual AMS-slot → Spoolman-spool assignments, persisted to `printers/mappings.json`. |
| `presets.js` | The slicer preset names learned from the sliced file, keyed by the `P` hash a chipless slot reports as `tray_info_idx`, persisted to `printers/presets.json` and read once on first use. What turns "PLA · custom preset" into the preset's name and manufacturer. |
| `printstate.js` | When the running print of each printer started, and the slots it runs from (the mapping, the AMS refills and the spool last seen in each slot), persisted to `printers/printstate.json` so a restart mid print keeps the clock and books a refill as if nothing had happened. Written only when one of them changes. Forgotten when the print ends, and a stored start older than a week is not trusted. |
| `jsonfile.js` | `readJsonFile()` and `writeJsonFile()`: a missing file reads as empty, any other failure is logged, and the write goes through a temporary file plus rename. Shared by `mappings.js`, `presets.js`, `printstate.js` and `apikeys.js`. |
| `routes.js` | All Express handlers, registered by `registerRoutes(app, printers)`. |
| `openapi.js` | The API as an OpenAPI 3.0 document, served at `/api/openapi.json` and rendered by the API page of the Web UI. Written by hand next to the routes; `test/openapi.test.js` holds it to the routes the app registers, in both directions. |
| `auth.js` | Who may talk to this service: the signed session cookie of the Web UI password, the lockout after repeated wrong guesses, and the middleware in front of every page and every route. Without a password the pages are open and `/api/` still needs an API key or a request the browser marks as coming from the Web UI. |
| `passwords.js` | scrypt hashing and verification, and nothing else. Its own module because `settings.js` needs it and may import nothing that logs. |
| `apikeys.js` | The named API keys for callers that are not a browser: generation, the SHA-256 stored in `printers/apikeys.json`, the header a key travels in, and the throttled "last used". A key counts as a session in `auth.js`. |
| `security.js` | The request guard: which `Host` a request may be addressed to, which `Origin` may change something, and whether a request came from the Web UI itself (`isFromOwnUi()`, which `auth.js` uses). Pure decisions plus the middleware `backend.js` puts in front of everything. The allow list is `settings.ALLOWED_HOSTS`, read per request. |
| `uispool.js` | `toClientSpool()`, the one projection from a runtime UI spool to what a client sees. Used by `/api/spools`, `/api/print`, the SSE slot update and `hasSpoolUiChanged()`. |
| `state.js` | Shared mutable process state (Spoolman status, vendor id, SSE clients, last spool snapshot). |
| `languages.js` | `readLanguageBundle()`, every language table under `public/i18n/` as one script, English first, which `backend.js` serves as `/i18n/all.js` before the static files and before the login. Read per request, so a table dropped into the folder needs no restart. |
| `printerrors.js` | Bambu Lab's error catalogue as `data/print-errors.json`, and one more `data/print-errors.<lang>.json` per language the Web UI speaks, all read once at import, and `describePrintError()`, the number a printer reports turned into the catalogue's sentence; the log and the API speak English, `describePrintErrorInAll()` hands the Web UI every language. The file is regenerated by `scripts/fetch-print-errors.js` from Bambu's own lookup endpoint and shipped, never fetched at runtime. |
| `utils.js` | Date/interval formatting, `sleep`, AMS id to slot label (`A1`, `HT-A`), and `slotColors()`, the colour set of a slot. It lives here because both `ams.js` and `uispool.js` need it and `ams.js` already imports `uispool.js`. |

## The two tracking modes

This is the single most important distinction in the codebase.

**G-code tracking (default, `legacyMode() === false`)**: on `gcode_state` reaching
`RUNNING`, `fetchSliceInfo()` pulls `Metadata/slice_info.config` out of the
sliced `.gcode.3mf` over FTPS. On a terminal state the consumed grams are
computed (`calcFullConsumption` for `FINISH`, `calcPartialConsumption` for
`FAILED`/`CANCEL`) and booked via Spoolman's `/use` endpoint. Works for spools
without an RFID chip. The slicer's `used_g` is always the amount; the plate's
G-code, counted per layer by `createExtrusionCounter()`, only decides how a
partial booking spreads it, and only for a filament whose G-code total agrees
with the slicer's (`checkLayerExtrusion()`).

**Legacy tracking (`legacyMode() === true`)**: the AMS `remain` percentage is
converted to a weight and PATCHed onto the spool. The print handler is skipped
entirely (`mqtt.js`, in `handleMqttMessage`). The AMS Lite reports only 0 % or
100 %, so it is unusable here.

Legacy mode also has no 3rd party support and no manual assignment. Both exist
only to serve the G-code booking, which does not run here, so a chipless slot is
read-only and the mapping endpoints answer 409.

Consequence: in G-code mode the `remain` value is deliberately dropped before
change detection (`hasTrayDataChanged()`), so a drifting RFID percentage does
not trigger endless reprocessing. Whether there is a reading at all is kept:
the transition from "not reported" to a real percentage has to refresh
`printer.spoolData`, because that is the snapshot the create and merge actions
build their Spoolman payload from.

## Contracts & invariants

- **`console.log/error/debug` take `(device, logFilePath, ...args)`.** Set up in
  `logger.js`; see the root AGENTS.md. Use `originalConsoleLog` to bypass.
- **A new debug line goes through `debug(category, ...)`, a payload dump through
  `trace(category, ...)`.** Both from `logger.js`, both filtered by the level
  ladder and by the category. `console.debug` is the uncategorised fallback and
  cannot be switched off per area, so it is not what new code reaches for. The
  split matters: `trace` carries whole Spoolman and AMS documents written on
  every update interval, and carrying them at debug level is what used to make a
  debug log unreadable within minutes.
- **The level and the categories are read per log file, never globally.**
  `shouldLog()` looks up the file's override first, which is how one printer can
  run at trace while the rest of the service stays quiet. `printers.js` pushes
  the override in through `setLogDetail()`; `logger.js` must not import it back,
  the cycle would run the console overrides too late.
- **An area switched off never hides an error or an ordinary progress line.**
  Only `debug` and `trace` are filtered by category. A switch that could hide a
  failure is a switch that makes a log lie.
- **The raw MQTT trace is captured in the `message` handler, before
  `handleMqttMessage()`.** That function returns immediately while a previous
  report is still being processed and while Spoolman is down, and those are
  exactly the reports an analysis afterwards is missing. It is written unparsed,
  one line per report, into `<serial>.mqtt.log`, which carries its own size and
  history budget: at the log file's default of 1 MB a trace would evict the
  whole log within minutes.
- **Settings are read at the point of use.** `settings.MODE`, never
  `const { MODE } = settings`. The object is mutated in place by the settings
  API, so a destructured copy silently keeps the startup value.
- **The tracking mode is the exception: read it through `legacyMode()`**, which
  returns the value frozen at startup. `settings.LEGACY_MODE` is only what is
  stored and what the settings page shows. Reading the live value would switch
  the mode under a print in flight, and the two modes book differently, so it
  would book twice or not at all.
- **The Spoolman base URL comes from `spoolmanUrl()`**, not from a constant. It
  changes at runtime.
- **The Web UI password is a hash, everywhere.** `settings.AUTH_PASSWORD` holds
  what `passwords.js` produced, never what was typed, and the session cookie is
  signed with a key derived from that hash. Two consequences to keep: changing
  the password invalidates every session, which is why `PUT /api/settings` hands
  the caller a fresh one, and nothing may put the value into a response, a log
  line or an export.
- **A settings write bumps a revision.** The settings page sends back the
  revision it read and a mismatch is answered with 409, so two open tabs cannot
  overwrite each other silently. `PUT /api/settings` accepts the bare field map
  too, which skips the check.
- **`printers` is mutated in place.** `monitorPrinters()` iterates the same
  array forever, which is what makes a printer added in the Web UI get picked
  up. Never reassign the exported binding.
- **All Spoolman HTTP goes through `spoolman.js`.** Do not `got()` a Spoolman URL
  from anywhere else.
- **Every FTPS connection gets its own `secureOptions` object**, built by
  `bambuTlsOptions()`. basic-ftp writes the host into the object it is handed,
  and for implicit TLS that stored host wins over the one passed to `access()`,
  so a shared constant sends every later connection to the printer that used it
  first.
- **The monitor loop is the only retry driver, and an offline printer is asked
  on a growing interval.** `monitorPrinters()` keeps ticking at
  `OFFLINE_CHECK_INTERVAL`, but a printer that failed its last check carries
  `nextCheckAt` and is skipped until it is due, doubling up to
  `OFFLINE_MAX_INTERVAL` (`offlineBackoff()` in `utils.js`). A printer that is
  switched off more often than it is on used to cost one failed connection and
  one log line every interval, all day. Only a wait that differs from the one
  already announced is logged, so the log carries one line per backoff step and
  then goes quiet. Anything the user pressed clears it through
  `resetOfflineBackoff()`, next to the `setupMqtt()` cooldown it sits beside,
  because a button is not the monitor loop.
- **A connection test never disturbs the live connection.** `testMqttConnection`
  opens its own client and force closes it; it must not touch
  `printer.mqttClient`.
- **`slot.remain` is never mutated in place.** It is compared raw against the
  next MQTT message in `extractComparableTrayData()`; normalise into a local
  (`correctRemainInt`) instead. Mutating it desyncs change detection forever for
  any spool whose `tray_weight != 1000`.
- **`cols` is the colour set of a slot, `tray_color` only its first colour.**
  A multi colour filament reports every colour it carries in `cols`, and
  Spoolman stores the same thing as `multi_color_hexes` with no `color_hex` at
  all, so anything comparing or drawing a colour has to read the set.
  `slotColors()` in `utils.js` normalises it, dropping the alpha byte the AMS
  appends, and `processData()` guarantees the field exists on every tray, which
  is why `cols` has to be in `EMPTY_TRAY_KEYS`: a field the normalisation adds
  unconditionally makes every empty slot look occupied otherwise. Order is the
  printer's, because it is the order the colours run along the strand; the two
  catalogues do not agree on one, so comparisons sort a copy.
- **A `remain` of `null` means "not reported", never "empty".** The AMS answers
  `-1` between a spool going in and its RFID percentage arriving, measured on
  a P2S at anything from 17 seconds to over a minute, and forever for a
  chipless one. `processData()` turns
  that into `null` and `correctRemainInt()` passes the `null` through, so every
  caller has to decide for itself: create the spool full, skip the legacy PATCH,
  skip the weight test when looking for a mergeable spool, render a dash. A `0`
  is a reading and means the spool really is empty. Collapsing the two created
  new spools at `used_weight = initial_weight`, and in G-code mode nothing
  patches the weight afterwards, so they stayed at 0 g left.
- **`state.lastSpoolData === null` means "not yet seeded".** `[]` is a legitimate
  value (empty Spoolman) and must stay comparable. Never re-seed on empty.
- **An unidentified spool is not an empty slot.** `slotIsOccupied()` is the only
  correct test; a slot with `tray_uuid === "N/A"` is not automatically empty.
  It reads the shape of the tray record, because a loaded slot carries the full
  payload (`tray_info_idx`, `tray_type`, `cols`, `tag_uid`) whether the chip was
  read or not, while an empty one carries `id` and `state` alone. Never go back
  to reading `state`: on a P2S it is 9 or 10 when empty and 11 or 27 when
  loaded, so "non zero means occupied" marks every empty slot as a 3rd party
  spool and freezes change detection for chipless slots. `slotIsBusy()` is the
  one remaining reader of `state`, and it decides a label and nothing else: a
  slot the AMS is moving filament into reports `{ id, state }` and nothing else,
  which is byte for byte an empty slot, so for the roughly 20 seconds until the
  tray record arrives the dashboard would call it empty with the user watching
  the spool sit in it. Its allow list holds the values seen while busy, not the
  ones seen at rest, so an unseen value reads as empty rather than leaving a
  slot claiming to read a spool for good.
- **A spool is not created before the AMS reports how much is left.**
  `usedWeightFromSlot()` turns the percentage into `used_weight`, and without
  one it has to assume brand new, which is wrong for a partly used spool that
  nothing corrects afterwards in G-code mode. `waitedLongEnoughForRemain()`
  holds the create branch back, in both modes: automatic skips the slot for
  this update, manual shows a disabled "Waiting for data" button. It gives up
  after `MAX_REMAIN_WAITS` updates so a chip that never reports still gets its
  spool. Merging is deliberately not held back, it writes only the tag. The
  wait resolves itself because `hasTrayDataChanged()` treats the arrival of the
  first reading as a change.
- **The external spool holder is a slot like any other, in G-code mode only.**
  The printer reports it outside the AMS block as `print.vir_slot`, an array
  whose entry is field for field a chipless AMS tray, so `externalSpoolUnits()`
  hands it to the same pipeline as a unit of id 255 and `processSlot` classifies
  it as the 3rd party spool it is. `convertAMSandSlot()` labels it `External`,
  which is also the key an assignment is stored under, so changing the label
  orphans what is on disk. Legacy mode leaves it out for the reason it leaves
  every chipless spool read-only: it writes the RFID remain percentage and the
  holder has no chip. Older firmware called it `vt_tray` and sent a single
  object; a P2S on 2026 firmware does not send that key at all. Only a holder
  that carries something is emitted: an empty one is reported in full with the
  three material fields empty, and that record would still reach
  `slotIsOccupied()` carrying its temperature fields.
- **A report that does not mention the holder means "unchanged", not "empty".**
  A P2S carries `vir_slot` in every report with AMS data, a P1S sends delta
  reports with the AMS block and no `vt_tray` (issue #131). The handler reads
  the holder through `rememberedExternalSpoolUnits()`, which keeps the last
  report that named it in `printer.lastExternalUnits` and forgets it on every
  connection. Only a report carrying the key, an empty holder included,
  replaces it. `node scripts/test-server/index.js --delta-reports` is the
  reproduction.
- **An archived spool is looked up separately, and only by its tag.** Spoolman
  leaves archived spools out of `/api/v1/spool`, so a spool this service
  archived when it ran empty is gone from the list while it is still sitting in
  its slot, and the automatic mode would create a second record for the same tag
  on the next update. `getArchivedSpoolmanSpools()` fetches them with
  `allow_archived=true` and `processSlot()` checks that list before it merges or
  creates anything. They are never merge candidates, never get a location and
  never carry a booking: an archived spool is one the user has taken out of the
  inventory. The fetch only happens while `ARCHIVE_EMPTY_SPOOLS` is on, so the
  guard costs nothing where nothing archives.
- **Emptiness comes from Spoolman, not from the AMS.** `spoolIsEmpty()` reads
  the weight written by the consumption booking, or by the legacy weight patch,
  which is the only source in that mode. The RFID remain percentage reaches 0
  while there is still filament on the spool, and archiving on it would take a
  spool out of the inventory the user is still printing from.
- **Manual assignment is a G-code mode feature.** `legacyMode()` gates it in
  three places: the 3rd party branch and the Bambu fallback in `processSlot`,
  and `rejectInLegacyMode()` on the mutating routes. A new entry point has to
  gate it too, or a direct API call creates a mapping that silently takes effect
  on the next mode switch.
- **A consumption booking requires a known physical spool**, either
  `connectedViaTag` (Spoolman `extra.tag` == the slot's `tray_uuid`) or
  `connectedViaMapping` (explicit user assignment). Type/colour similarity alone
  never books.
- **The sliced file names the slot, and that beats every colour comparison.**
  The position of a filament in Bambu Studio's list is the AMS slot it was
  sliced for, verified against a real print on a P2S with two AMS units where
  the ids 5, 7 and 8 were B1, B3 and B4. It is the only thing that separates two
  spools identical in profile and colour, so `calcFullConsumption()` keys by
  that position: two filaments never merge, where a colour key added them
  together before anything looked at the AMS and the sum could not be split
  afterwards.
- **The printer says which slot a print runs each filament from, and that beats
  working it out.** `print.mapping` carries one entry per filament of the
  slicer's project, the unit in the high byte and the slot in the low one:
  `0x0100` is B1, `0xFF00` the external holder, `0xFFFF` a filament the plate
  does not use. `decodePrintMapping()` in `utils.js` turns it into the same shape
  `orderedAmsSlots()` produces, so `resolveSliceSlots()` takes either without
  knowing which. It is captured at the transition to RUNNING and kept on the
  printer as `currentMapping`, like the slice info and for the same reason: the
  booking happens on a terminal state and this describes the job that reached
  it. It is also the assignment after any remapping the printer did when the job
  was sent, which the sliced file cannot know. Read off a P2S across three
  prints, where every entry matched the slots the print was really running from.
  It is followed for as long as the print is active rather than read once: the
  value settles a moment after the start, and one observed report still carried
  the slot the job had been configured with before the user changed it.
- **A mapping change once the first layer prints is an AMS refill.** When a
  spool runs out and the AMS takes over from its backup slot, the printer
  rewrites `print.mapping` of the running job to the new slot (P2S traced, X2D
  in issue 225). `refillsBetween()` turns the change into a refill with its
  layer, `printSlotSpools` supplies the spool the emptied slot held, because
  that slot reports empty long before the switch, and `splitAtRefills()` books
  the layers before on that spool and the rest on the new one. The remembered
  spools answer for every emptied slot the print was named for
  (`rememberedSlotCandidates()`), refill or not: a print ending while the tube
  empties otherwise lands on the backup spool by colour. `tray_now` and
  `filam_bak` are not the signal: during the tail in the tube the P2S reported
  `tray_now` 0 for a slot it never loaded, and the backup group vanished from
  `filam_bak` the moment the spool ran out.
- **A position is resolved against the printer, never computed.**
  `resolveSliceSlots()` takes the slots from `orderedAmsSlots()`, which lists the
  four slot units by unit id and then by slot, then the external holder, then an
  AMS HT. Arithmetic on "four per unit" is wrong, it turned the ninth entry of an
  observed file into "C0", a unit the printer does not have, and the list length
  says nothing either: it is the project's filament count, and one P2S produced
  files with six, seven, eight and nine entries.
- **Only a loaded slot takes a position**, which is why both callers pass
  `loadedSlotIds()` from `uispool.js` rather than every slot. Bambu Studio builds
  its filament list by synchronising with the AMS and an empty slot has nothing
  to contribute, so a gap shifts everything after it one to the left. Measured on
  a P2S emptied at A3 and B2: seven loaded slots, seven filaments, both gaps
  absent. Confirmed by an X1E emptied at A4's neighbour A3, whose own
  `print.mapping` for that print read [0, 1, 3]: the printer put the third
  filament on A4, exactly where the estimate puts it. The order past the units
  is measured too, on a P1S carrying an AMS HT and a spool on the holder: the
  holder comes first and the HT last, which is not the order of the ids the
  printer gives them (254 against 128 to 135). `test/gcode.emptyslots.test.js`,
  `test/gcode.x1eemptyslot.test.js` and `test/gcode.htexternal.test.js` hold
  all three.
- **The order is a suggestion and a dual nozzle printer ignores it.** An H2C
  groups its filament list by extruder, so the position names the wrong slot for
  most of the print. It costs nothing, because the confirmation below rejects a
  position whose slot does not hold what was sliced, and the stages under it then
  decide as they did before positions existed.
- **The slot a sliced filament belongs to is decided once**, by
  `matchConsumption()` in `ams.js`. `bookConsumption()` runs it over the spools
  it may book on, so an unassigned slot can never take an amount, and the
  `/api/print` route runs it over every loaded slot and writes the answer onto
  each entry as `matchedAmsId`, next to the `amsId` the slice named. The Web UI
  reads that field and decides nothing. It used to decide it again in
  `public/frontend.js`, where `public/` has no tests, and the two drifted: both
  defects fixed at the end of PR #89 sat in that copy. A new consumer asks this
  function rather than reimplementing the stages.
- **The profile alone speaks only where it names one filament.** The last stage
  of `matchConsumption()` matches on `tray_info_idx`, and Bambu Studio slices
  PLA Basic black and PLA Basic white as the same `GFA00`. With only the black
  spool loaded, the white filament reached that slot through this stage and its
  grams were booked onto a spool that never printed it. It now counts how many
  filaments of the print carry the profile and stays out of it above one, which
  leaves the filament unplaced and the log asking for an assignment.
- **A slot the printer named for one filament is off limits to every other.**
  The fallback stages compare colours, and a print running from remapped slots
  has two slots agreeing on a colour: the one being consumed and the one merely
  holding what the file was sliced with. Without the claim, the second one takes
  the same amount, which showed every figure twice on the dashboard.
- **An estimated slot is confirmed, a reported one is not.**
  `slotConfirmsSlice()` requires the slot to really hold the profile and the
  colours the slice expects, comparing colours as sorted sets because the slicer
  and the RFID chip need not agree on which comes first. It guards the list
  order estimate, which cannot tell whether the project is synchronised with the
  printer. It must not guard `print.mapping`: a print configured to take a
  filament from a slot holding a different colour than the sliced one is the
  substitution that field exists to report, and checking it against the sliced
  colour rejected the one right answer. Measured: a print started with the wrong
  spool selected reported that spool's slot correctly, the check rejected it,
  and the colour stages then found the spool that was sliced rather than the one
  that would have been consumed. `resolveSliceSlots()` records the source as
  `amsIdFromPrinter` so the stage can tell them apart. Everything unconfirmed,
  and every filament with no slot at all, falls through to the stages below.
- **`consumptionKey()` carries the colour set, and `slotFingerprint()` too.**
  A gradient spool is not a profile of its own: Bambu Studio slices PLA Basic
  Gradient as `GFA00`, the same as plain PLA Basic, and `tray_color` is only its
  first colour. Arctic Whisper, Solar Breeze and an ordinary white PLA Basic
  were one key and one fingerprint. The set is sorted in both, because the
  sources disagree on order (Studio writes Cotton Candy Cloud as
  `#8EC9E9 #E7C1D5`, SpoolmanDB stores it the other way round) and an unsorted
  comparison matches nothing rather than the wrong thing. A single colour
  produces the string it always did, so nothing on disk needs migrating.
- **A mapping carries a fingerprint** (`tray_type|colour`). When it stops
  matching, the assignment is dropped rather than booked onto the wrong spool.
- **`mappings.json` is written temp-file-then-rename**, so a crash mid-write
  cannot truncate it.
- **Log rotation runs inside the write queue of its file.** A rename between two
  queued appends would send the lines in between to the rotated file, or to one
  nobody reads any more. `rotateLogFile()` queues; the append path calls the
  unqueued `rotateNow()` because it is already inside the queue.
- **Reconnects are driven only by `monitorPrinters()`.** The MQTT `close` and
  `error` handlers must not reschedule themselves. Two independent retry paths
  used to race. Because it is the only driver, nothing else may be allowed to
  stop it: it used to idle while Spoolman was down, and a network drop that took
  both out then left the printer disconnected for as long as Spoolman stayed
  unreachable, with the close handler still promising a retry. `servicePrinters()`
  is one pass of it, split out so a pass can be asserted on; the loop itself
  never returns.
- **Spoolman being down stops processing, never connecting.** The guard belongs
  in `handleMqttMessage()`, which refuses to process a report without Spoolman,
  and it is already there. Anywhere else it turns an unrelated outage into a
  second one.
- **`printer.blockMqttUpdates` serialises message handling.** Messages arriving
  during processing are dropped, not queued.

## Patterns

**Adding a setting:** add the field to `SETTINGS_SCHEMA` in `settings.js` with
its type, default and range (clamps live there, not at the use site), read it as
`settings.<KEY>` at the point of use, add the variable to `envSeed` in
`config.js` when it should be seedable, and document it in the settings card
table in `docs/settings.md`. The settings page picks it up on its own; `group`
decides which card it lands in, and the card has to be listed in `GROUPS` in
`public/settings.js`. `advanced` puts a field into that card's collapsed
section, `header` puts a switch into the card header with its description behind
an info icon, for a field that belongs to the whole card rather than to a row of
its own, and `dialog` takes it out of the card entirely and hands it to the
named dialog, which renders it from the schema the same way the card would. Mark it `restartRequired`
when the running process cannot adopt it, and handle the live application in the
`PUT /api/settings` handler when it needs more than the new value being read.

A field of type `password` is hashed by `coerceSetting()` on the way in and
never leaves the process: `getSettingsView()` replaces it with null and reports
only whether one is stored, and `updateSettings()` reads an empty string as
"unchanged" so the settings page, which sends every field on every save, cannot
wipe a value it was never shown. Removing one is an explicit null.

**Adding an HTTP route:** add it inside `registerRoutes()` in `routes.js`.
Respond `{ ok: false, error }` with a 4xx/5xx for failures; the frontend's
`fetchJson()` expects that shape. Never build a Spoolman payload inline. Add a
function to `spoolman.js`. Then describe it in `openapi.js`, with its
parameters, its body and its answers: `test/openapi.test.js` fails on a route
the document does not carry, and the API page shows only what the document
says.

**The three write actions report, they do not throw.** `createSpool()`,
`createFilamentAndSpool()` and `mergeSpool()` answer `{ ok, error }`, because
the automatic mode calls them per slot and one slot that cannot be written must
not abort the rest of the same AMS update. Both callers read that answer: the
route turns it into the response, and `processSlot()` counts only a write that
happened as a reason to refetch the Spoolman lists. A new one keeps the shape,
or the Web UI goes back to reporting success for a write that never landed.

**Adding matching logic:** put the decision in `ams.js` as a pure function and
call it from `mqtt.js`. That is what makes it testable: `test/ams.test.js`
covers exactly this seam.

**Testing against a whole system:** `node scripts/test-server/index.js` starts a
mock printer, a mock Spoolman and this service against both, with its state in a
temporary directory. The mocks implement only what `spoolman.js` and `mqtt.js`
actually call. Reach for it when the thing to check is a payload travelling all
the way to the browser, which is the one seam `test/` cannot cover.

**Pushing something to the UI:** `broadcastSlotUpdate()` for a single slot,
`broadcastSSE()` for status/refresh events. A slot goes out through
`toClientSpool()` in `uispool.js`, the one projection from the runtime object to
the client payload, shared with `/api/spools` and `/api/print`. Add a field
there when the UI needs it; anything not listed stays on the server. That
includes the `"N/A"` placeholder `processData()` writes: it is a backend marker
and the projection turns it back into `null`, so a client never renders it. The
broadcast decision is `hasSpoolUiChanged()` alone, which compares that same
projection. Do not add a second condition in front of it; the one that used to
be there held every slot the printer could not identify back, so an emptied slot
never reached the UI.

**Per-unit AMS readings:** humidity, temperature and the drying cycle come out
of `extractAmsEnvironment()` in `ams.js` and travel on their own path, not on
the slot one. They are display only, they are refreshed on every report rather
than on the slot update interval, and their `ams_env` broadcast is throttled to
one every 30 seconds. Do not feed them into `extractComparableTrayData()`: they
change on every report and would make every report look like a slot change.
Which fields a unit sends depends on the hardware, so every one of them is
optional; the shapes that have been observed are in `test/ams.env.test.js`.

**Changing slot classification:** `processSlot()` in `mqtt.js` branches, in
order: invalid slot → empty slot → 3rd party (unidentified) → Bambu Lab. The
order matters; the empty branch must not swallow an occupied-but-unidentified
slot.

## Anti-patterns

- Reading `process.env` outside `config.js`.
- `console.log("some message")` with the normal one-argument signature.
- Awaiting slow I/O inside `handleMqttMessage` outside the existing interval
  guard. Every printer report during that time is lost.
- Refetching Spoolman lists per slot. `processSlot()` returns whether it mutated
  Spoolman; only then does the caller refetch.
- Comparing spool arrays by index. Spoolman may reorder between calls, and
  `haveSpoolDataChanged()` matches by id for that reason.
- Sending `last_used` to Spoolman's `/use` endpoint. It is silently dropped;
  the timestamp needs a separate PATCH.

## Related context

- Root overview and global rules: [`../AGENTS.md`](../AGENTS.md)
- Frontend consuming this API: `../public/frontend.js`. It renders; every
  decision it shows is made here.
- Known gaps and unverified paths: `../OPEN.md`
