# Open work

Working notes for the G-code tracking rebuild, kept in the repo so the next
session starts where the last one stopped. Not user documentation: the
user-facing summary lives in the CHANGELOG and in the description of
[PR #79](https://github.com/Rdiger-36/bambulab-ams-spoolman-filamentstatus/pull/79).

Everything below is either a task nobody has done yet or a decision worth not
rediscovering. Anything finished comes out of this file.

## Verify against hardware

Most of this has been run against the P2S by now, and the ticks say which.
Ordered by how likely a user is to hit it.

- [ ] **AMS refill split, booked end to end.** The switch itself was traced on
  the P2S on 2026-10-07 (spool cut to about 8 g in A3, backup in A4, mapping
  moved at layer 88 of 235) and `test/refill.test.js` replays it. The split
  itself was booked end to end the same day against the mock Spoolman: a
  second refill at layer 89 of 140, cancelled at layer 100, booked 7.47 g on
  the A3 spool remembered from before it ran out and 0.85 g on A4, both
  exactly what the G-code weighs, and the report carried both rows with their
  refill note. Still to do: one in a multi colour print, and a look at an X1
  or X2D trace. Two gaps by design for now: the refills of a print are
  held in memory, so a restart of the service between the switch and the end
  books everything on the backup slot again, and the dashboard's live figures
  during the print still show the filament on the slot it runs from now.

- [x] **Booking a print as it actually finishes.** Done on 2026-09-01 against
  the P2S, seven cancelled prints against a throwaway Spoolman. `useSpoolWeight()`
  reached it six times and the partial maths was exact: at layer 3 of a
  sequential print, 8.13 g scaled over the first object's 85 layers gave the
  0.38 g that was booked. Both of the gaps this used to name are closed as of
  2026-09-04, see "Two prints on 2026-09-04" below: a print that actually
  finishes, and a booking onto the external spool holder with a real amount on
  it.
- [x] **An AMS HT.** Settled on 2026-09-04 from a sliced file off a P1S with two
  AMS units, an AMS HT and a spool on the external holder, read against the
  slots the printer reported over MQTT: the HT is the last position of the list,
  after the external holder, although the printer numbers the holder 254 and the
  HT 128. One printer, so one measurement. See `test/gcode.htexternal.test.js`.
- [ ] **AMS Lite.** Everything was tested on a P2S with two AMS units. The AMS
  Lite was never in scope for G-code tracking; the README only documents its
  legacy mode limitation.
- [x] **A second printer.** Run by a tester since 2026-09-06: a P2S and a P1S on
  one installation through the dev builds of issue #146, each with its own log
  and trace, both booking. On 2026-09-08 a second, unreachable printer was added
  and removed next to the real P2S over the Web UI: immediate connect attempt,
  backoff, its own log file, "Disconnected / No update yet" on the dashboard,
  and the dashboard back on the P2S without a reload once it was deleted.
- [ ] **The update check with a newer release.** Only the prerelease path was
  observed, where the running version is ahead of the latest release. The
  "version X is available" path has never been rendered against a real answer.
  `1.3.1` is the first release that shows it, on every `1.3.0` installation.
- [x] **What P2S stages 51 and 54 are.** Named in 1.3.0-dev.13: 51 is the
  calibration lines and 54 the heatbed coming up to temperature, both counted
  as preparing. Stages 36 to 77 followed in dev.14 from ha-bambulab's table.
- [ ] **Low priority, waiting on other people's hardware: slice files from more
  printer families.** The ordering in `orderedAmsSlots()` rests on four
  printers. The empty slot rule is measured on two of them, P2S and X1E, and
  merged as #148; the holder before HT rule rests on one P1S. It matters less
  than it did: a P2S and an X1 report `print.mapping`, and a P1 or an A1 echoes
  the `project_file` command Bambu Studio sends, which #156 reads, so the list
  order is only the fallback for a print started from the SD card or repeated
  on the printer's screen. Two things are needed per device, and the second is
  what makes the first readable:

    1. a sliced `.gcode.3mf` of a plate using several filaments, sliced after
       synchronising the project with the printer in Bambu Studio
    2. the slots the printer reports, from
       `node scripts/capture-trays.js <ip> <code> <serial>`, taken without
       moving a spool in between

  `Metadata/project_settings.config` carries `filament_ids` and
  `filament_colour` for the whole project, and reading those against the
  reported slots gives the position of every slot, which is the measurement.
  What each of them would settle:

  - [x] **X1E with one AMS** (the X1, X1C and P1S family). Settled on
    2026-09-07: an X1E with one original AMS, loaded at A1, A2 and A4, produced
    a three entry list, and its own `print.mapping` read [0, 1, 3] for the
    whole print. The empty slot rule holds on the X1 family and the printer
    confirmed it itself. See `test/gcode.x1eemptyslot.test.js`.
  - **A1 mini with an AMS Lite.** The Lite was never in scope for G-code
    tracking, and it is the one unit whose four slots might not be listed the
    way the others are. It also carries an external spool, so the position of
    the holder is measurable on it a second time.
  - **X2D with an AMS 2 Pro and an AMS HT** (the H2D and H2C family, and with
    the P2S one variant of the H2S). The second dual nozzle sample. It would say
    whether the extruder grouping the H2C showed is how that whole family lists
    its filaments, and whether the holder still comes before the HT when the
    list is grouped rather than ordered by unit.

  Two questions ride along with these:

  - [x] **Does anything but a P2S report `print.mapping`?** An X1E does
    (issue #146, 2026-09-07). A P1S does not, in 964 messages of a print
    (issue #131), and neither does an A1 by the fixtures. Both echo the
    `project_file` command with `ams_mapping` and `ams_mapping2` on their report
    topic, seen on three P1S prints and the X1E, and the P2S sends that echo as
    well; #156 reads it, so those printers no longer depend on the list order.
    Not seen yet: how the external holder is encoded in that echo.
  - **What `group_id` in `slice_info.config` means.** In the H2C file the four
    filaments carried 0, 3, 2, 1, and ordering the right extruder's filaments by
    it reproduced their AMS order exactly. One file, so it is a lead and not a
    finding; a second dual nozzle file either kills it or makes it worth using.

## Log detail and the raw MQTT capture

Added on the `feat/log-detail-and-mqtt-trace` branch: the `LOG_LEVEL` ladder
that replaced `DEBUG`, the per-area switches, the per-printer override and the
raw MQTT capture. Most of it was exercised against the P2S on 2026-09-05,
including two whole prints, the rotation of a capture file and its download.
What was not:

- [x] **Two or more printers.** Seen on 2026-09-08 with a second printer next
  to the P2S: the Printers card read "Log *" on the P2S, which carried an
  override, and "Log" on the other. Two overrides in force at the same time is
  the one part not exercised; the registry in `logger.js` is covered by
  `test/logdetail.test.js` for it.
- [x] **Legacy mode.** Switched on with a restart on 2026-09-08: the badge read
  "Legacy · MQTT remain", the classic table drew, the remain percentages were
  written to Spoolman, and the per-printer log override survived the restart
  in both directions. One thing worth knowing: legacy mode writes the remain
  percentages whatever `MODE` says, manual only stops creating and merging.
- [x] **The log detail dialog on a phone.** At 375 px on 2026-09-08 the dialog
  was 355 px wide, nothing reached past the edge and nothing scrolled sideways.
- [x] **The `errors` level with a real failure.** Done on 2026-09-08 with the
  mock printer and the Spoolman endpoint on a dead port (launch config
  `mock-dead-spoolman`): with the level at `errors` and every area switched
  off, "Spoolman is unreachable (ECONNREFUSED)" kept reaching the server log
  every 30 seconds. Pointing the endpoint back at a live Spoolman brought the
  service up, 25 slots processed, and neither log carried a single progress
  line for it, only the `[ERROR]` lines of the scenario's unmatched spools.
- [x] **`calcPartialConsumption()` and `layer_num`.** Settled on 2026-09-08
  through the capture and two deliberate cancels: `layer_num` is the layer
  being printed, counted from 1, it went to 1 in the second `stg_cur` went to
  0, and a ten layer plate ended at 11. `completedLayerIndex()` in
  `src/gcode.js` converts it (#159); a cancel at layer 9 booked 8/11 of the
  plate. The report that starts a job still carries the previous job's last
  layer, and within a job the P2S reports a stale value next to the current
  one, so the counter starts a job at 0 and only goes up.

## Verified against the printer

On 2026-08-31 the image was run against the real P2S on the LAN, pointed at a
seeded fake Spoolman so nothing in the real instance was touched. In manual mode
no write reached Spoolman at all, which was checked rather than assumed.

- **The merge path fired for the first time.** With one untagged Spoolman spool
  matching A0 in material, colour and remaining weight, the log showed
  `Found mergeable Spool => Spoolman Spool ID: 42` and the slot offered
  `Merge Spool`.
- **Two 3rd party spools were loaded**, both classified `Loaded (3rd party)`
  and offering `Assign Spool`. Assigning one persisted a mapping with the
  fingerprint `PLA|F98C36`, and the slot flipped to `Unassign Spool` carrying
  the assigned spool's weight.
- **`fetchSliceInfo()` works against the printer**, over FTPS on port 990,
  including a job name with an umlaut. It returned 2 filaments across 169
  layers, with non contiguous filament ids, and `calcPartialConsumption()` at
  layer 0 produced 0.09 g, matching the layer ranges in the file.
- **Legacy mode behaves as intended.** With `LEGACY_MODE=true` there was not a
  single `[Print]` line, and the only write was
  `PATCH /api/v1/spool/<id> {"remaining_weight":270}`, derived from the AMS
  reporting 27 % of a 1 kg spool.
- **Reconnect works.** Cutting the container off the network produced
  `Printer ... is unreachable. Next try in 20 second(s)`, and the monitor loop
  brought the connection back on its own one interval later.

On 2026-09-01 the anonymised diagnostics bundle was pulled from the same
instance, with `DEBUG=true` and the printer connected. The serial, the address,
the access code and the Spoolman host name were all gone, in the log text, in
`printers.json`, in the keys of `mappings.json` and in the log file name. The
printer name, the spool names and the `tray_uuid` values were kept, which is
what the design says they should be.

Reconnect and the global monitoring pause were exercised against the same live
connection. The reconnect tears the session down and is back within a second.
Pausing disconnects immediately, and a second pause reports that it changed
nothing rather than claiming success.

That run also surfaced the cooldown defect described below and the misleading
close line, both since fixed and re-checked against the same printer: reconnect,
pause and resume in sequence now bring the connection back within a second, and
the log says "Connection closed, reconnecting on request" and "Connection
closed, monitoring was switched off" instead of announcing a retry by the
monitor loop.

It also found a real defect, now fixed: the fallback pattern for a serial that
is no longer in the printer list required a leading zero, matching the P1S
examples in the README. A P2S reports `22E8BJ581201877`, so every P2S serial
slipped through it. Only the known list was covering them.

Two observations that correct what is written below:

- **`state` 27 exists** and is not in the list of values recorded so far.
- **`state` 11 is not proof of a read Bambu tag.** A chipless spool with an all
  zero `tray_uuid` reported 11 as well, so the value says the slot is loaded,
  not that it was identified.

On 2026-09-01 the shared consumption match was run against the same P2S, with
the mock Spoolman, so nothing was written anywhere. `/api/print?job=<name>`
pulled one of the printer's own sliced files over FTPS, five filaments across
two AMS units, and the match placed them on the nine slots the printer reported
at that moment:

- The black PLA Basic went to A3, not to A0 where the slicer's list order
  estimated it and a pink spool actually sits. That is the confirmation doing
  its work: the estimate was rejected and the filament identity found the slot.
- The ABS and the PETG HF went to their own slots by identity, and the white
  PLA to the matte white slot by material and colour, its profile being a
  different one.
- The fifth filament, a grey nobody has loaded, was placed on nothing and is
  what the dashboard lists as required but not loaded.
- No slot was claimed twice.

A print was then started and cancelled on the same printer, with the spools of
that job in the test Spoolman, which closes the booking question:

- The printer reported its slots as `["B1","A0",null,"External"]` and all three
  filaments were booked against that, the external holder included. Its filament
  sits at index 3 while index 2 is the unused one, so the sparse position
  counted through correctly.
- Cancelled on layer 0, so only one filament had an amount: `Booked 0.1g for
  spool 16 (A0, GFA01 PLA #FFFFFF)`. Spoolman went from 999.8 g to 999.7 g on
  that spool and left the other two untouched, which is the zero gram entries
  being skipped rather than written as zero.
- Two of the three ran from a slot holding a different colour than the sliced
  one, and the booking followed the printer rather than the colour. That is the
  substitution the field exists to report.
- Every filament of that print had a slot from `print.mapping`, so no fallback
  stage ran and the claim above was not part of this.

Also seen: both 3rd party spools report `tray_info_idx` `GFL99`, the generic
profile, which is exactly the collision described under the automatic creation
gap below. They differ only in colour. And they report `remain` as `-1`, which
`processData()` clamps to 0.


On 2026-09-04 two prints were run on the P2S from the local build, against the
throwaway Spoolman, and they settled more than they were started for.

**A print that finishes.** "Cube", 2 filaments, 25 layers. `FINISH` reached the
booking for the first time: 2.11 g onto spool 16 (A1, by tag) and 2.21 g onto
spool 8 (External, manually assigned). Spoolman moved by exactly those amounts
and both carried the same `last_used` second, so nothing else wrote them. That
is the finished print and the external holder booking the entry above used to
be waiting for, in one run.

**A print stopped by hand**, same plate, stopped at `layer_num` 18 of 26. It
answered three things:

- **`layer_num` is 0-based while a print runs.** The first layer reports 0, the
  next 1, and the counter is set to the layer count when the print ends, which
  is one past the highest index the sliced file carries. That last part is what
  made the dashboard show "Layer 27 / 26" and 104%, fixed in #128.
- **`calcPartialConsumption()` is correct**, and reading `layer_num` as 0-based
  is what makes it so. The plate prints pink over layers 0-11 and black over
  12-25. At layer 18 it booked 2.25 g of pink, its full amount, and 0.93 g of
  black, exactly half: 12 of 12 layers and 7 of 14. A global progress fraction
  would have given both 19/26 and been wrong in both directions. Read 1-based,
  the black share would have been 6/14 and 0.79 g rather than the 0.93 g that
  was booked, so the arithmetic settles the convention on its own.
- **A print stopped by hand reports `FAILED`, not `CANCEL`.** Both are terminal
  and the booking fires either way. `print_error` is 50348044 for it, and it
  arrives one report *after* the state does and is back at 0 the report after
  that, which is why the summary collects it across reports rather than reading
  the terminal one (#128).

Also seen: `print.mapping` was reported for both prints, `["A1",null,"External"]`
and `["A1",null,"A4"]`, so the sparse positions counted through correctly again.
A pause leaves `stg_cur` at 0 and shows up only in `gcode_state`, so the thirteen
"Paused, ..." entries of the stage table may never be reached on a P2S.

## Verified in a container

Recorded so the next session does not redo it. On 2026-08-31 the image was
built and run on an Apple Silicon host against a fake Spoolman and a local
mosquitto with a self signed certificate, standing in for the printer:

- The FTPS download path works on basic-ftp 6.2.1: implicit TLS against a
  self signed certificate, `downloadTo` on the `/cache/<job>.gcode.3mf`
  candidate, extraction of `Metadata/slice_info.config` and parsing, and a
  missing file falling through both candidate paths to null. Only the hardcoded
  port 990 was not exercised, because binding it needs root.
- The reworked G-code table renders correctly at 1280 px and at 375 px, with
  no horizontal overflow and the mobile card labels intact. Rendering it also
  surfaced a pre-existing defect, now fixed: a 3rd party spool showed
  `NaNg / 0g` in the weight column.
- The image runs Node 22.23.2, with `mqtt` 5.15.2, `got` 16.0.0 and
  `adm-zip` 0.6.0 installed and no `async-mqtt`.
- Startup completes: Spoolman health, vendor and extra field checks all pass
  over `got` 16, and the Web UI and API answer on port 4000.
- `mqtt` v5 connects over TLS and subscribes, logging `MQTT client connected`.
- A published AMS report is processed end to end. A tagged Bambu slot is
  classified as `Loaded (Bambu Lab)` and logged as
  `[A0] PLA Basic 000000FF (63%)`, while an empty slot with `state` 0 stays
  `Empty`, and `/api/spools/<id>` reflects both.

None of this involved real hardware, so it says nothing about the items above.

## The 1.3.0 release

The dev phase ended with `1.3.0-dev.30`; dev.29 was the build that renamed the
project to HaspelSync. The version is `1.3.0` in `package.json`,
`package-lock.json` and `src/config.js`, and the consolidated release block,
written for a reader of 1.2.1, replaced the thirty `Version 1.3.0-dev.*` blocks
in `CHANGELOG.md`. Fixes of behaviour only a dev build had were left out of it
on purpose; the dev blocks stay in the history of `CHANGELOG.md`. Every tag
publishes two images, `haspelsync` and, built on top of it from
`docker/Dockerfile.legacy`, the old name; a container from the old name says so
in its log and on the dashboard after every start.

- [x] Delete the `v1.3.0-dev.*` releases once `v1.3.0` is out, and keep their
  tags. A pre-release carries the generated pull request list of one dev step
  and that step's changelog section, and neither is lost with it: the pull
  requests keep their labels, and the dev blocks stay in the history of
  `CHANGELOG.md`. The tag is the part that carries something of its own, which
  is the commit that went into `:1.3.0-dev.<n>` on ghcr, where the image
  outlives the release either way. A ref costs nothing and the compare links of
  the remaining notes are built from it.
- [ ] The next version takes a fresh `Unreleased` block at the top of
  `CHANGELOG.md`, renamed at its bump the way the dev builds were, and a
  version bump moves `package.json`, `package-lock.json` and `src/config.js`
  together: the publish workflow compares the tag against `package.json` and
  aborts on a mismatch.

Tag behaviour, after the hardening in `c053561`:

| Tag | Images | `:latest` | GitHub release |
|---|---|---|---|
| `v1.3.0` | `:1.3.0` and `:latest` | moved | release, marked Latest |
| `v1.3.0-dev` and `v1.3.0-dev.2` to `v1.3.0-dev.18` | `:<version>` and `:dev` | untouched | pre-release |
| `v1.3.0-rc1` and other suffixes | `:<version>` only | untouched | pre-release |

One `case` decides all four columns, so the image tags and the release cannot
disagree: whatever does not move `:latest` is a pre-release.

The release is written after the image push, not before, because a release
pointing at an image that never built sends people to a pull that fails. Its
body is the section of `CHANGELOG.md` for exactly that version, so a release
without a changelog entry says so instead of inventing notes. A re-run for a
tag that already has a release edits it rather than failing.

Publishing from a branch is rejected outright, so the "Run workflow" button can
no longer overwrite `:latest` with whatever is on `main`.

## Decided: armv7 stays, on Node 22

Node 22 entered maintenance on 2025-10-21 and reaches end of life on
**2027-04-30**. It is also the last Node that exists on 32 bit ARM at all, so
those two facts are the same deadline for this project.

Checked on 2026-08-31, against the Node release schedule, the download index,
the Docker library manifests, the unofficial builds index and Alpine's own
package:

| | armv7 |
|---|---|
| Node 22 (EOL 2027-04-30) | yes, official binaries and `node:22-alpine` |
| Node 23 (EOL) | yes, but not an LTS |
| Node 24, 25, 26 | **none**, upstream stopped building armv7l |
| unofficial-builds.nodejs.org | armv6 only for 22, nothing for 24 and later |
| Alpine's own `nodejs` package, armhf | 22.23.2, so no way forward either |

So there is no supported path to Node 24 or later on 32 bit ARM. The choice was
to drop `linux/arm/v7` from the publish matrix on 2027-04-30, or to keep
shipping on a Node that no longer gets security fixes.

**Decided on 2026-09-02: keep shipping on Node 22 and keep `linux/arm/v7`.** A
32 bit user is left with a working image rather than with none, and the service
talks to a printer and a Spoolman instance on the user's own LAN rather than to
the internet. Revisit only if a Node 22 vulnerability actually reaches this
service; there is nothing to do before then.

A 64 bit OS sidesteps it entirely. A Raspberry Pi 3B and newer are all 64 bit
capable, and `linux/arm64` stays supported.

## Settings GUI and printer management

Everything below landed on `feat/settings-ui-and-printer-management` up to
2026-08-31 and was merged as #81. Kept here because the change is large enough
that the next session should not have to read the diff to know what is in it.

### What #81 brought

- **A settings page** at `public/settings.html`, rendered from what
  `/api/settings` describes, so a new field only has to be added to
  `SETTINGS_SCHEMA` in `src/settings.js`. Cards: Spoolman connection, Tracking,
  Synchronisation, Printer connection, Logging, plus Printers and Service.
- **Configuration lives in `printers/settings.json`** and is applied to the
  running service. Environment variables only seed a setting that has never been
  saved. The file carries a schema version, a migration hook and a write counter;
  a save against a state somebody else replaced is answered with a 409.
- **Printer management** in the Web UI: add, edit and remove, with the list in
  `printers/printers.json` written by the service (atomically) rather than by
  hand. A new printer connects right away, a removed one is disconnected and its
  assignments are dropped. The serial number is immutable and the access code is
  never sent to a client.
- **Connection tests** for Spoolman and for a printer, MQTT and FTPS in
  parallel, using the values in the form rather than the stored ones. The MQTT
  test waits for a report on the topic of the serial number, because the printer
  accepts a subscription to any topic.
- **The tracking mode is frozen at startup** and read through `legacyMode()`.
  Saving it changes what is stored, only a restart changes what runs.
- **A supervisor**: `entrypoint.js` runs the service (`starting.js`) as a child
  process and starts it again on the restart exit code, so the restart button
  works without a container restart policy. `SUPERVISOR=false` gives the single
  process back, which is worth the memory of one more Node process, measured at
  47 MB on macOS and around 30 MB on Alpine.
- **Log rotation** with the size and the number of kept files configurable, for
  the server log and per printer. The log page reads backwards across the
  rotated files, and the download hands out the whole history as one zip as
  soon as there is more than the current file.
- **One menu bar** across all pages, `public/menu.js`, keyboard operable, and a
  shared visual language: `.data-table`, the button classes and the form fields
  are the same everywhere.
- **Tests**: 105, including an HTTP harness (`test/helpers/app.js`) that registers
  the routes on a bare Express app and points `DATA_DIR` and `LOG_DIR` at a
  temporary directory.

### Verified on hardware

Both open points here were run against the P2S on 2026-09-08:

- [x] **Adding and removing a printer with real hardware.** See "A second
  printer" above.
- [x] **A restart through the Web UI during a running print.** The guard
  answers 409 without `force`. Forced, the supervisor had the service back in
  two seconds, the first report found the print running, the slice info was
  fetched again and the job was booked at FINISH. So the booking is not lost,
  which the guard and the dialog now say; the start time survives too, kept in
  `printers/printstate.json` (#159). What a P1 or an A1 loses is the slots
  Bambu Studio sent the job to, because that echo comes once.

### Decisions taken along the way

Not tasks. Recorded so they are not relitigated.

**`settings.json` owns every field after the first save**, not only the ones
that were edited. Chosen so that a value changed in the Web UI is not silently
reverted by a container definition that still passes the old variable. The cost
is that an environment change no longer has an effect, which the README states
and a "default" link per field softens.

**The restart is an exit code, not an in place reload.** The values that need a
restart are read at startup, and re-reading them in place is what the frozen
tracking mode exists to prevent. Only the dedicated code restarts; every other
exit is passed on, so a crash stays a crash and the container restart policy
stays in charge of it. Letting both layers restart on a crash would nest two
loops.

**No automatic recovery after an uncaught exception**, for the same reason. The
supervisor could do it, and that is deliberately not built.

**Access protection came later**, as the request guard, the password and the
API keys (#110 to #112), see the entry under known gaps.

**A shutdown button was considered and rejected.** The supervisor passes every
exit code except the restart one straight through, so a shutdown lands on the
container restart policy: with `unless-stopped` or `always`, the recommended
setting, the container comes straight back and the button visibly does nothing;
with `restart: no` it stays down and takes the Web UI with it, so the only way
back is Docker or the Home Assistant UI. It works exactly in the configuration
where it is hardest to undo. "Reconnect all printers" covers what people
actually reach for the restart button for, and does it without losing the
consumption tracking of a running print.

**Anonymising an export masks the network, not the user's own labels.** Printer
names and spool data are kept: they are what makes a log readable, and a name is
chosen by the user rather than assigned by the network. The RFID tag ids are kept
for the same reason, they identify a piece of filament. If this is revisited,
the right shape is an extra "also replace the printer names" switch, not a
different default.

**The access code is masked in the full export as well.** The service never
writes it to a log on purpose, but "on purpose" is not a guarantee worth handing
out, and the code is the one value that is never useful in a bug report. "Full"
therefore means the addresses, serials and paths, which is what the dialog says.

**Serials are masked before access codes**, in `maskText()`. An eight character
access code can appear inside a fifteen character Bambu serial; masking the code
first cuts the serial into pieces that the serial pass no longer recognises, and
the address in the same line then leaks in a different shape. `test/anonymize.test.js`
holds the ordering.

**Every deliberate disconnect goes through `closeMqtt()`.** The "close" handler
cannot otherwise tell a connection the network dropped from one the service
closed itself, and it announced that the monitor loop would retry within the
offline check interval in both cases. That is wrong whenever a reconnect has
already been started or the process is shutting down, and the line then sat in
the log directly above the successful reconnect. The handler also ignores a close
that arrives after the printer already has a newer client, which a deliberate
reconnect can produce and which would otherwise tear the live connection back
down.

**An explicit reconnect clears the retry cooldown, the monitor loop does not.**
`setupMqtt()` ignores a call within 30 seconds of the last attempt, which is what
stops the monitor loop from hammering a printer that is off. A button the user
pressed is not the monitor loop: resuming monitoring shortly after a reconnect
did nothing at all and the printer only came back on the next monitor pass, up
to half a minute later. The printer edit route already cleared the cooldown for
exactly this reason; the monitoring and reconnect routes now do the same.
`test/diagnostics.test.js` holds it, and both tests fail without the fix.

**The deprecation of environment configuration is state driven, not version
driven.** Nothing records which version an installation came from, and it would
not help: a fresh install set up from an older README needs the same hint as one
upgraded from 1.2.x. `deprecatedConfig()` asks instead which settings still
resolve from the environment right now, so the hint and the log lines stop by
themselves once the values have been saved. Deprecated means deprecated here, not
scheduled for removal, and neither the hint nor the README names a version that
would drop the variables.

**The dismissal of that hint is stored beside the values in `settings.json`**,
under `notices`, not among them. Acknowledging it writes the file on an
installation that has never saved anything, and writing a value there is exactly
what takes ownership away from the environment. Keeping the flag outside `values`
is what lets the file exist with nothing in it, so every variable still seeds its
setting. `test/notices.test.js` holds that guarantee.

**Encrypting the access code at rest was rejected.** Without a key store the key
ships in the same image, so it is obfuscation rather than protection. The README
note that the code sits in plain text in `printers.json` is the honest version.

## Documentation

- [x] The "How does it work" section of the README still describes only the RFID
  based merge and create flows. The newer "Tracking modes" section above it
  explains G-code tracking, but the older section was never rewritten to match.
  Done with the 1.3.0 rewrite: "How it works" now carries G-code tracking as its
  own subsection, and legacy mode has a section of its own pointing at the v1.2.1
  README.

The Home Assistant side is out of scope for this repository. The integration in
`ha-bambulab-ams-spoolman-filamentstatus` only drives the AMS monitoring toggle
per printer, through `/api/printers`,
`/api/printer/{id}/monitoring/start|stop` and `/api/status/{id}`. None of those
changed and it sets no environment variables, so nothing here is a task for it.

## Decided: one file for what both halves compute

`public/shared.js` holds the pure functions the dashboard and the server both
apply to the same payloads: `normColor`, `slotColors`, `filamentColors` and
`correctRemainInt`. `src/utils.js`, `src/gcode.js` and `src/ams.js` re-export
them so every existing caller keeps its import, and `public/frontend.js` imports
them directly.

It lives under `public/` rather than in `src/` because that is the half with the
constraint: the directory is served straight from disk, has no build step and no
dependencies, so the browser has to be able to load the file as it is. The
server has no such limit, which is why it imports across rather than the other
way round. Whatever is added there has to keep working in both places: no Node
built-ins, no DOM.

`test/shared.test.js` is the first coverage anything under `public/` has, and it
asserts the arrangement as well as the behaviour: that the server re-exports
those functions rather than holding a copy, and that `public/frontend.js` still
imports them. A future second implementation fails a test rather than waiting
for a user to notice, which is how the last two were found.

The rest of `public/frontend.js` still has no tests, and that has not changed.
What can be moved into the shared file is what can be covered; the DOM around it
cannot be, without adding the build step the directory exists to avoid.

`public/index.html` loads `frontend.js` as a module, which is what makes the
import possible. `menu.js` stays a classic script and `frontend.js` still calls
`initMenubar` as a global, because modules run after classic scripts and before
`DOMContentLoaded`.

## Known gaps, by design

Not tasks. Decisions and limits worth not relitigating.

**The claim on a slot the printer named cannot be produced from Bambu Studio**,
so `test/ams.slotmatch.test.js` owns it rather than a print. It stops a filament
with no reported slot from reaching, through the colour stages, a slot
`print.mapping` named for another one. That needs a mapping that is present and
still leaves one filament with an amount unplaced, and the two ways
`decodePrintMapping()` yields nothing both rule that out: `0xFFFF` is a filament
the plate does not print, which `slice_info.config` does not list either
(measured on a P2S, a four filament project printed a three filament plate and
the file listed exactly the three), and an index beyond the mapping array does
not occur, because the mapping covers the whole project list including gaps in
the filament ids. A printer that sends no mapping at all leaves every filament
unreported, so the claim set is empty and the confirmation against the slot
decides, which is the path that was observed live.

Worth keeping anyway: it is one line, and the shape of the payload is the
printer's to change. The defect it was written for is structurally gone, since
the server now decides per filament, and one filament resolves to one slot. It
was the browser asking per slot which filament it might be that could answer
twice.

**Two spools identical in material and colour** are told apart by the slot the
print really runs from, where the printer names it: `print.mapping` on a P2S or
an X1, the echoed `project_file` command on a P1 or an A1 (#156). Only a print
started from the SD card or repeated on the printer's screen, on a P1 or an A1,
falls back to the list order below, and there the booking goes to the first
match and logs a warning.

**The slicer's list order is the fallback, not the source.** The position of a
filament in the project list equals the Nth loaded slot, empty slots skipped
(#148, measured on a P2S and confirmed by an X1E's own mapping). It is used
only where the printer names nothing, and only through `slotConfirmsSlice()`,
which refuses a position whose slot does not hold the sliced profile and
colours: the project list is a snapshot from slice time while the loaded slots
are live, and a reused project is remapped by colour when the job is sent, so
the list order can be wrong for two of three filaments, which the P1S case in
`test/gcode.studiomapping.test.js` shows.

**No automatic creation for third party spools**, which is what issue #47
asked for and what was closed on 2026-09-08 without it. `tray_info_idx` is the
preset chosen for the slot, not a property of the spool: a P2S reports the
generic `GFL99` for every chipless spool set from its screen, and a Bambu id
for a chipless spool set to a Bambu profile. What shipped instead: automatic
assignment, opt in, to the one Spoolman spool of the same material and colours
(#150); the preset named on the slot (#145) and learned from the sliced file
for a cloud preset's hash (#154); and a create dialog that proposes the
manufacturer, the material and the nearest catalogue filament from a vendor
preset (#152). Anyone still wanting creation opens a new issue.

**Third party spools report no weight**, so full and remaining weight are typed
in once per spool. Nothing to be done about it, but it surprises people.

**Access protection is a password and API keys, not a hidden page.** Decided
on 2026-08-31 to ship none, revised in September: the request guard (#110)
refuses hosts that are not named, the Web UI takes an optional password (#111),
and callers without a browser use named API keys (#112); the API answers only
the Web UI and a key holder since then. The `CONFIG_UI=false` switch and the
`ADMIN_TOKEN` that were weighed at first are not coming back. The service still
belongs in a trusted network; the README says so.
