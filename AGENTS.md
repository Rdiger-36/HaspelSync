# HaspelSync

Node service that keeps a Bambu Lab AMS in sync with a [Spoolman](https://github.com/Donkie/Spoolman)
instance. It listens to the printer's MQTT report topic, mirrors the loaded
spools into Spoolman (create, merge, weight update), tracks filament
consumption per print, and serves a small web UI for the parts that need a
human decision.

Runs as a single container. No database: all persistent state is Spoolman plus
six JSON files under `printers/`.

## Intent Layer

**Before modifying code in a subdirectory, read its AGENTS.md first** to
understand local patterns and invariants.

- **Backend modules**: [`src/AGENTS.md`](src/AGENTS.md), covering MQTT ingest,
  AMS matching logic, the Spoolman client, G-code consumption and HTTP/SSE routes

`public/` (frontend) and `test/` have no node of their own; the rules that
matter for them are below.

## Layout

| Path | Role |
|---|---|
| `entrypoint.js` | Container entrypoint and supervisor. Forks `starting.js`, starts it again on the restart exit code, passes every other code on, forwards SIGTERM/SIGINT and waits for the child. `SUPERVISOR=false` runs the service in this process instead. Never put application logic here. |
| `starting.js` | The service process. Global error handlers, signal handling, then dynamic-imports `backend.js`. Forked by `entrypoint.js`, so the handlers live where the application does. |
| `backend.js` | Express app, the request guard from `src/security.js` and the password gate from `src/auth.js` in front of everything, static hosting, startup sequence: Spoolman health, the `tag` extra-field bootstrap, printer log files, monitor loops. |
| `src/` | All backend logic. See its AGENTS.md. |
| `public/` | Vanilla JS/HTML/CSS frontend. No build step, no framework, no bundler; files are served as-is. `favicon.svg`, `favicon.ico` and `apple-touch-icon.png` are the tab and home screen icon every page links in its `<head>`; they are listed in `PUBLIC_PATHS` in `src/auth.js` because the login tab asks for them before anybody is logged in. `login.html` and `login.js` are the exception to everything below: they are served before anybody is logged in and therefore import nothing from the rest of the UI. `menu.js` renders the whole menu bar for every page, the dark mode button included, so each page includes it before its own script and provides an empty `#menu-root` in its `#menubar`. It also fills the printer picker that lives in the page's own headline, `#printer-name` on the dashboard and `#headline` on the log viewer: the bar carries navigation and the session, the page carries what it is showing. `shared.js` holds the pure decisions the frontend and the server both make, including the slot options, the active print states and the external slot label; it lives here because a browser has to be able to load it unbuilt, and `src/` imports it from here. `ui.js` holds what every page does with the API and with a string, `fetchJson()` and `escapeHtml()`, which is browser only and therefore not in `shared.js`. `frontend.js`, `settings.js` and `api.js` are modules and import both; `menu.js` and `export.js` are classic scripts read off the global scope. Every visible string goes through `t("key")` from `i18n.js`, a classic script every page loads first together with one table per language under `i18n/` (`en.js`, `de.js`): English is the default and the fallback for a missing key, the language field on the settings page picks another language per browser, and another language is one more table dropped into `i18n/`: every page loads all of them through `i18n/all.js`, which `src/languages.js` puts together from the folder on each request. Its name in that field comes from a `language.<code>` key in the other tables, else from the name it registers itself with. `test/i18n.test.js` holds every table to the English keys and placeholders. Log lines, the content of the API page and every value the API hands out stay English; a failed answer carries a `code` the UI translates as `error.<code>`. `api.html` and `api.js` are the API page, reached from the API keys on the settings page rather than from the bar: they render whatever `/api/openapi.json` describes and know no route by name, so a route is added to `src/openapi.js` and never to the page. |
| `test/` | `node:test` suites (`npm test`). Fixtures in `test/fixtures/` are real slicer output, not synthetic. `test/fixtures/reports/` holds real printer reports copied from ha-bambulab under its MIT notice, see the README there and `THIRD_PARTY_NOTICES.md`; `test/reports.test.js` runs every one of them through the ingest pipeline and lists what they found that is not handled yet as `todo`. |
| `printers/` | Runtime data, gitignored. `printers.json` (printer list), `settings.json` (runtime configuration), `mappings.json` (slot assignments), `apikeys.json` (the API keys, as hashes), `presets.json` (the slicer preset names learned from sliced files) and `printstate.json` (when the running print of each printer started, and the slots it runs from, its AMS refills included). The first four are written by the service and editable by hand, `apikeys.json` only with a restart: it is read once and then held in memory. The last two are the service's own notes, read at most once, on first use, and written by the service only. |
| `logs/` | Runtime logs, gitignored. One file per printer plus `server.log`, and `<serial>.mqtt.log` for a printer whose raw MQTT trace is switched on. The trace has its own size and history budget, because a printer reports every few seconds and every report is a full document. |
| `scripts/` | `debug.sh` (symlinked to `debug-printers` in the image), the standalone `mqtt.js` probe, `capture-trays.js` (prints a printer's slots once and exits: the AMS trays, the external holder and the slots the running print reports), `list-files.js` (lists the printer's storage over FTPS, two levels deep, for a sliced file the log could not find), and `test-server/`, which runs a mock printer, a mock Spoolman and the service against both. |
| `docker/` | The `Dockerfile`, `Dockerfile.legacy` (the image of the old name, built by the publish workflow on top of the one it just pushed) and one Compose file per way of running the service: `compose.yml` for `:latest`, `compose.dev.yml` for `:dev`, `compose.local.yml` for a build from the checkout, `compose.spoolman.yml` for the service together with a Spoolman. Each is complete on its own; its README says which is which. The build context stays the repository root, so `.dockerignore` stays there too and lists this folder. `docker/data/` is where the Compose files put their volumes and is gitignored. |
| `Home Assistant Addon/` | Docs only for the HA add-on wrapper. |

## Global invariants

- **Console is overridden.** `src/logger.js` replaces `console.log/error/debug`
  with the signature `(device, logFilePath, ...args)`. Every call site must pass
  those two leading arguments; a plain `console.log("text")` writes garbage to a
  file named `"text"`. Import `src/logger.js` before anything that logs;
  `backend.js` does this first, on purpose. For output that must bypass the
  override, use the exported `originalConsoleLog` / `originalConsoleError`.
- **A debug line names the area it belongs to.** `debug(category, device,
  logFilePath, ...args)` and `trace(...)` from `src/logger.js` are what new code
  calls, with a category from `LOG_CATEGORIES` in `settings.js`. `console.debug`
  still works and is never filtered by category, which makes it the wrong
  default: a line nobody can switch off is a line nobody can turn down. `trace`
  is for the whole payloads behind a debug line, never for the line itself.
- **ESM only.** `"type": "module"`; use `import`, not `require`.
- **Every file under `printers/` is written through its owning module only**:
  `printers.json` through `printers.js`, `settings.json` through `settings.js`,
  `mappings.json` through `mappings.js`, `apikeys.json` through `apikeys.js`,
  `presets.json` through `presets.js`, `printstate.json` through
  `printstate.js`. All six write temp file plus rename, the last four through
  `jsonfile.js`, so a crash mid-write cannot truncate them. Runtime state never reaches `printers.json`; only id, code, ip, name and
  the optional `logDetail` are persisted, and `logDetail` is left out entirely
  while the printer follows the global log settings.
- **Never commit `printers/`, `logs/`, or `.env`.** They hold the printer access
  code and LAN addresses and are gitignored. Keep it that way.
- **Two tracking modes, mutually exclusive.** Default tracks consumption from
  the sliced G-code; `LEGACY_MODE=true` derives weight from the AMS RFID remain
  percentage. New behaviour must pick a side, because running both double-books.
- **A requested restart is an exit code, not a signal.** `restartService()`
  ends the process with `RESTART_EXIT_CODE` (75) and the supervisor starts it
  again. Only that code restarts; everything else is passed on so a crash stays
  a crash and the container restart policy stays in charge of it. Letting both
  layers restart on a crash nests two loops.
- **The version lives in two places:** `package.json` and `src/config.js`. The
  publish workflow compares the git tag against `package.json` and aborts on a
  mismatch, so bump both together.
- **Configuration lives in `src/settings.js`**, read as `settings.<KEY>` at the
  point of use, never destructured into a module-level constant. The values
  change at runtime through the settings API. `src/config.js` is the only module
  that reads `process.env`, and it only exposes the raw values that seed
  `settings.json` and `printers.json` on a first run. It also owns the paths,
  the port and the version.

## Coding rules

### Language

- All identifiers (functions, variables, classes, constants) are named in
  English.
- All code comments, doc comments, commit messages and PR descriptions are
  written in English.

### Doc comments

- Every function gets a JSDoc block (`/** ... */`) describing what it does.
- Go into depth where it matters: complex logic, non-obvious behaviour, hardware
  quirks. Keep it to one line for self-explanatory members. Do not over-comment.
  Document parameters and return values only where they add something the
  signature does not already say.
- Inline comments (`//`) only when the WHY is non-obvious: a hidden constraint,
  a workaround, a subtle invariant. Never restate what the code does.

### Punctuation

Never use a dash as punctuation, neither the em dash (`—`) nor a standalone
hyphen (`-`). This covers UI strings, doc comments, inline comments, log
messages, commit messages and PR titles and descriptions. Rephrase, or use a
comma, colon or full stop.

Not punctuation, and therefore allowed:

- Hyphens inside compound words (`3rd-party`, `tag-linked`, `Co-Authored-By`).
- The em dash as a visible "no value" placeholder in a table cell
  (`public/frontend.js`).
- The hyphen as a structural marker: JSDoc `@param name - description`
  separators, bullet lists in block comments, and the ` - ` field separator in
  the log line format in `src/logger.js`.

### Git

- Always create a new branch before making changes when the current branch is
  `main`.
- Name the branch after everything it ends up holding, not just its first
  commit. Rename it when the scope grows.
- Never open a pull request on your own. Commit, push, report the branch, and
  wait. A PR may only be created once the user has given an explicit go-ahead
  for that specific PR. A general permission is not a standing one; ask again
  for the next.
- Every pull request carries a label before it is merged, because the release
  notes are grouped by it: `enhancement`, `bug`, `deprecation`, `documentation`
  or `maintenance` (refactor, build, CI, dependencies, version bump).
  `ignore-for-release` leaves one out entirely. A PR that does two things takes
  both labels and is listed once, under whichever section comes first in
  `.github/release.yml`. An unlabelled PR is not an error, it just lands under
  "Everything else", which is where nobody looks.
- `breaking` goes on top of one of those whenever an existing installation can
  stop working the way it did: a renamed value the API hands out, a caller that
  suddenly needs credentials, a setting that changes meaning. It is first in
  `.github/release.yml`, so a PR labelled `breaking` and `enhancement` is listed
  under "Breaking Changes" rather than among the features. A fix takes it too
  when the fix itself is what locks someone out. The prose block in
  `CHANGELOG.md` says the same thing under its own `Breaking:` heading, and the
  two are written to agree.

### Scope

- GUI and design changes, and larger changes that touch many references, must be
  discussed and approved before they are applied.

### Structure

- **No raw console output in committed code.** Everything goes through the
  overridden `console.log/error/debug`. `originalConsoleLog` and
  `originalConsoleError` belong to `src/logger.js` and to the few places that
  must not recurse into the logger; `process.stdout.write` belongs to
  `entrypoint.js` and `starting.js` only, which both run before the overrides
  exist. No leftover debug logging. `scripts/` is outside the service and never
  imports `logger.js`, so the plain console is correct there and only there.
- **Shared mutable state goes through `src/state.js`**, per-printer state onto
  the printer object created in `src/printers.js`. Never introduce a new
  module-level mutable global, and never keep state in a route handler or in a
  frontend DOM node.
- **External systems are reached only through their owning module**: Spoolman
  through `src/spoolman.js`, the mapping file through `src/mappings.js`, printer
  config through `src/printers.js`. Never call a Spoolman URL or read
  `printers/` from anywhere else.
- **When changing the shape of the UI spool object**, update all of its builders
  in `src/mqtt.js` (`buildEmptySpool`, `buildThirdPartySpool`, `buildArchivedSpool`
  and the Bambu Lab
  branch of `processSlot`), `toClientSpool()` in `src/uispool.js`, and the
  frontend that reads it. A field the projection does not carry never reaches a
  client, and change detection does not see it either: `hasSpoolUiChanged()`
  compares the projection.
- **When changing the shape of `mappings.json`**, keep the read side tolerant of
  the old shape. Existing installs have the file on disk and there is no
  migration step. `settings.json` carries a `schemaVersion` for exactly this
  reason: bump it and handle the old value in `migrateStored()`. Its first
  version had no wrapper at all and is still read.

## Working on this repo

- Tests: `npm test` (`node --test "test/*.test.js"`). No test framework beyond
  the Node built-in, no mocking library; tests call pure functions directly.
  Anything touching MQTT, FTPS or Spoolman HTTP is not unit-tested, so keep new
  logic extractable into a pure function. The HTTP API is covered end to end in
  `test/routes.test.js`, through `test/helpers/app.js`, which registers the
  routes on a bare Express app and points `DATA_DIR` and `LOG_DIR` at a
  temporary directory. Those two variables are read once at import time, so a
  test that needs them must set them before the first import.
- Whole system by hand: `node scripts/test-server/index.js` starts a mock
  printer on 8883, a mock Spoolman on 7912 and the service against both, with
  its state in a temporary directory rather than in `printers/`. Then open
  http://localhost:4000. The scenario fills all 24 addressable AMS slots with
  the multi colour filaments from the Bambu Lab hex code tables, plus the
  external spool holder, which is every position this service can address. It
  covers what no unit test and no ordinary spool collection reaches. `--no-service`
  runs only the two mocks, for pointing a container at them. `--delta-reports`
  leaves the external holder out of every second report, the way a P1S sends
  delta reports (issue #131). Stop it before
  running `npm test`: the suite expects nothing on 8883, and a broker answering
  there leaves the connection tests waiting for a report.
- Against real hardware: `--real-printer <ip> <code> <serial>` replaces the mock
  printer with a physical one and keeps the mock Spoolman, so a spool nobody
  here owns can be seen as the printer really reports it without a write
  reaching a Spoolman instance that matters. Add `--mode automatic` to exercise
  the write paths: pointed at a real printer it seeds the mock with that
  printer's own spools, tags and all, which is what makes a real print bookable
  against a Spoolman nobody has to care about. `node scripts/capture-trays.js
  <ip> <code> <serial>` prints the slots alone when only the payload is in
  question, including `print.mapping` decoded into slot labels, which is what a
  question about a booking landing on the wrong spool starts from.
- There is no linter, formatter or type checker configured. Match the
  surrounding style: 4-space indent, no tabs, in `src/` and in `public/`,
  double quotes, semicolons.
- Comments in this codebase explain why, usually pointing at the bug the line
  prevents. Preserve them when editing nearby; they are the record of hardware
  quirks that are otherwise invisible.
- `OPEN.md` carries the current known gaps and unverified paths.
  Read it before assuming something is finished.

## Anti-patterns

- Adding a frontend build step or framework to `public/`. It is deliberately
  dependency-free and served straight from disk.
- Reading a setting into a constant at import time (`const { MODE } = settings`).
  It freezes the value at startup and the settings page then appears to do
  nothing.
- Duplicating the settings schema in the frontend. `public/settings.js` renders
  whatever `/api/settings` describes, so a new field only has to be added to
  `SETTINGS_SCHEMA`.
- Answering a question in `public/` that the server already answers. Either read
  the answer off the payload, the way the dashboard reads `matchedAmsId` rather
  than matching consumption itself, or put the decision in `public/shared.js`
  and import it on both sides. A second implementation drifts, and `public/` has
  no coverage of its own to catch it: `test/shared.test.js` is what makes the
  shared file testable at all.
- Adding a direct dependency without putting it in `package.json`. The Docker
  image installs from `package.json` and `package-lock.json` only, so relying on
  a transitive package works locally and breaks in the container.
- Blocking the MQTT message handler with long work. It is guarded by
  `printer.blockMqttUpdates`, so anything slow silently drops incoming reports.
- Booking consumption onto a spool that was matched only by material and colour.
  A booking requires an RFID tag link or an explicit user assignment.
