<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/banner-dark.png">
    <img src="docs/images/banner-light.png" alt="HaspelSync" width="800">
  </picture>
</p>

<p align="center">
  Synchronize your Bambu Lab AMS filament spools with Spoolman, automatically.<br/>
  Tracks what a print actually consumes and keeps Spoolman in sync in real time.
</p>

<p align="center">
  <a href="https://github.com/Rdiger-36/HaspelSync/releases/latest"><img src="https://img.shields.io/github/v/release/Rdiger-36/HaspelSync?style=flat-square&label=latest&color=blue" alt="latest release" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <a href="docs/installation.md#supported-architectures"><img src="https://img.shields.io/badge/platforms-amd64%20%C2%B7%20arm64%20%C2%B7%20arm%2Fv7-lightgrey?style=flat-square&color=orange" alt="platforms" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Rdiger-36/HaspelSync?style=flat-square&color=green" alt="license" /></a>
  <img src="https://img.shields.io/badge/maintained-yes-brightgreen?style=flat-square" alt="maintained" />
</p>

<p align="center">
  <a href="https://github.com/Rdiger-36/HaspelSync/stargazers"><img src="https://img.shields.io/github/stars/Rdiger-36/HaspelSync?style=flat-square&color=yellow" alt="stars" /></a>
  <a href="https://github.com/Rdiger-36/HaspelSync/forks"><img src="https://img.shields.io/github/forks/Rdiger-36/HaspelSync?style=flat-square&color=orange" alt="forks" /></a>
  <a href="https://github.com/Rdiger-36/HaspelSync/issues"><img src="https://img.shields.io/github/issues/Rdiger-36/HaspelSync?style=flat-square" alt="open issues" /></a>
  <a href="https://github.com/Rdiger-36/HaspelSync/pkgs/container/haspelsync"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FRdiger-36%2FRdiger-36%2Fmain%2Fbadges%2Fpulls.json&style=flat-square&logo=docker" alt="pulls" /></a>
  <a href="https://github.com/Rdiger-36/HaspelSync/commits/main"><img src="https://img.shields.io/github/last-commit/Rdiger-36/HaspelSync?style=flat-square&label=last%20commit" alt="last commit" /></a>
</p>

---

Based on the idea of a script from [Diogo Resende](https://github.com/dresende), posted in this [issue](https://github.com/Donkie/Spoolman/issues/217).

## What it does

Every Bambu Lab printer reports what its AMS holds, and every sliced print says how much of each filament it needs. This service listens to both and keeps [Spoolman](https://github.com/Donkie/Spoolman) in step with them: it recognises the spools in your AMS, links them to the spools in your inventory, and books what a print actually used onto the right one when the job is done, without you touching Spoolman.

An original Bambu Lab spool is recognised by its RFID tag and linked on its own; a 3rd party spool is linked to a Spoolman spool once, by hand in the Web UI, and is tracked from then on like any other. The external spool holder is one more slot next to the AMS units and is treated the same way. Everything runs in one Docker container on your own network, over MQTT and FTPS to the printer. Nothing goes through the Bambu cloud.

![Dashboard](docs/images/dashboard-dark.png)

## What changed in 1.3.0

- **The project is called HaspelSync.** The image is `ghcr.io/rdiger-36/haspelsync`. The old name `ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus` receives every release for a transition period and will be retired, so switch the image in `docker run` or Docker Compose; configuration and volumes stay as they are. A container from the old name says so itself.
- **G-code tracking is the new default.** Filament consumption is read from the sliced file of the print instead of the AMS RFID remain percentage, so 3rd party spools without a tag are covered as well. The previous behaviour lives on as [Legacy mode](docs/legacy-mode.md).
- **Everything is configured in the Web UI now.** The [settings page](docs/settings.md) holds every setting and the printer list.
- **Environment variables and hand-written `printers.json` are deprecated.** They keep working, see [Deprecated configuration](docs/deprecated-configuration.md).
- **The Web UI can ask for a password, and the [API](docs/api.md) needs a key.** Both are set under **Network access** on the [settings page](docs/settings.md). A script or an integration that called the API without a key needs one now.
- **Slots are numbered the way the printer numbers them.** The first slot of the first unit is `A1`, so every slot label moved up by one, in the Web UI, in the logs, in the API and in the Spoolman location of a spool.

Coming from 1.2.x? [Updating from 1.2.x](docs/updating.md) lists what can need you and what keeps working. The dashboard says the same once on the first visit after the update.

## Attention

Works with Bambu Lab printers of the A, P, H and X series, with or without an AMS: a printer without one is tracked through its external spool holder.

Automatic creating and merging of spools and filaments in Spoolman relies on the RFID tag of original Bambu Lab spools. A 3rd party spool is linked to a Spoolman spool in the Web UI instead, by hand or, when switched on, automatically where exactly one spool of its material and colour exists; its consumption is then tracked like any other.

### Supported hardware

| Printer | Supported |
| :---- | :---- |
| A series with AMS Lite | ⚠️ no weight updates in [legacy mode](docs/legacy-mode.md) |
| A1 with AMS Standard / 2 Pro | ✅ |
| P1 series | ✅ |
| P2S | ✅ with a USB stick in the printer, see below |
| H series | ✅ with a USB stick in the printer, see below |
| X1 series | ✅ |
| X2D | ✅ with a USB stick in the printer, see below |
| A2L | ❓ untested, its AMS reports as unit 16 and is not addressed yet, see [issue tracker](https://github.com/Rdiger-36/HaspelSync/issues) |

| AMS | Supported |
| :---- | :---- |
| AMS | ✅ |
| AMS 2 Pro | ✅ |
| AMS HT | ✅ |
| AMS Lite | ⚠️ no weight updates in [legacy mode](docs/legacy-mode.md) |

Up to 12 AMS on one printer: max. 4 AMS Standard / 2 Pro plus 8 AMS HT.

**The second generation printers, the P2S, the H2 series and the X2D, need a USB stick in the printer for consumption tracking.** Their FTPS server shows the stick and nothing else. With a stick in, the printer writes every job onto it and the sliced file is read from there, found by the job's name or, when the name does not lead to it, by the time it was written and what it says about itself. Without one, the file only exists in the printer's internal storage, which nothing outside the printer can read, and every print ends with "No sliced file on the printer" in the log (issue #179). The printer reports whether a stick is in, and the print card says "No USB stick or SD card in the printer" for as long as none is.

The external spool holder counts as one more slot, named `External`, on a printer that reports it, and a dual nozzle printer gets `External-2` for its second holder. It carries no RFID chip, so it is assigned to a Spoolman spool by hand like any 3rd party spool, and it is not read in [legacy mode](docs/legacy-mode.md), where the weight comes from the chip.

x86-64, arm64 and arm/v7 are built; the [installation](docs/installation.md#supported-architectures) says which device falls under which.

## Features

- Real-time status of every connected AMS and of the external spool holder, on any number of printers
- The humidity, the temperature and a running drying cycle per AMS unit, as far as the unit reports them
- Consumption tracked from the sliced G-code, so 3rd party spools are covered too
- Automatic merging and creating of spools and filaments in Spoolman, or manually per click
- Manual assignment of a Spoolman spool to a slot for spools the printer cannot identify, checked against the material the printer reports
- A detail dialog per slot: everything Spoolman holds about the spool and its filament, next to what the printer reports, with the remaining weight, lot number and comment editable in place
- New filaments filled in from the SpoolmanDB catalogue, multi colour spools included
- Web UI with print dashboard, printer management, settings and log viewer, no container restart needed except for switching legacy mode, and usable on a phone
- The Web UI in English, German and Polish, picked per browser on the settings page; another language is one file, see [Translations](#translations)
- An optional password in front of the Web UI, and named API keys for callers that have no browser
- An [API page](docs/api.md) in the Web UI that lists every route and sends it from the browser, with the same description as OpenAPI for Swagger UI or Postman
- Lightweight Docker container, ready for x86-64, arm64 and arm/v7

## How it works

The printers publish their state via MQTT, this service listens and talks to Spoolman through its API. From what a printer reports about its slots it merges a detected spool into a matching Spoolman spool, creates the spool when only the filament exists, or imports the filament from the SpoolmanDB and creates both, automatically or per click in `manual` mode.

While a print runs, the sliced `.gcode.3mf` is fetched from the printer via FTPS and the grams per filament are read from it. When the job reaches a final state, that amount is booked onto the linked spool; a cancelled print is booked proportionally to the layers printed. A slot that is linked to nothing is named in the log and skipped, so a missing link is visible rather than silently untracked.

➡️ **[How it works](docs/how-it-works.md)**: G-code tracking, operation modes, slot names, archiving empty spools

## Getting started

You need a running Spoolman instance and, per printer, its serial number, access code and IP address, reachable on port **8883** (MQTT) and **990** (FTPS). The service itself is one container, started with `docker run` or Docker Compose and configured in its Web UI on `http://<host>:4000` afterwards; nothing has to be prepared in Spoolman.

➡️ **[Installation](docs/installation.md)**: prerequisites, the container, and the first start

## Documentation

| Page | Covers |
| :---- | :---- |
| [Installation](docs/installation.md) | Prerequisites, supported architectures, `docker run` and Docker Compose, first start |
| [How it works](docs/how-it-works.md) | Merging and creating in Spoolman, G-code tracking, operation modes, slot names, archiving empty spools |
| [Web UI](docs/web-ui.md) | Dashboard, assigning a spool to a slot, the spool and filament dialog, menu and logs |
| [Settings](docs/settings.md) | Every card of the settings page, the printer dialog, the service actions, a printer that is switched off |
| [API](docs/api.md) | Who may call it, the API page in the Web UI, the OpenAPI document, and every route in a table |
| [Troubleshooting](docs/troubleshooting.md) | Reading the logs, the `debug-printers` CLI, diagnostics and what an export contains |
| [Legacy mode](docs/legacy-mode.md) | The RFID based tracking of 1.2.x and what it cannot do |
| [Updating from 1.2.x](docs/updating.md) | The four things an installation updated from 1.2.x can trip over, and what keeps working |
| [Deprecated configuration](docs/deprecated-configuration.md) | Environment variables, hand-written `printers.json`, and the four container level variables |
| [FAQ](docs/faq.md) | The questions that come up most |

> [!IMPORTANT]
> The Web UI asks for a password only once you set one, under **Network access** on the [settings page](docs/settings.md). Without one it is open to everyone on the network and can change the printer list and the Spoolman endpoint, so do not expose the port to the internet either way. The access code of a printer is stored in plain text in `printers/printers.json` and is never sent back to the browser.
>
> Other websites cannot reach the API of an installation on your network: the service answers only requests addressed to it, and refuses a writing request that comes from another site. A Web UI reached under a real domain name or through a reverse proxy has to name that host under **Network access** as well.
>
> The [API](docs/api.md) answers only the Web UI of this installation and a caller carrying an [API key](docs/settings.md#api-keys), whether or not a password is set. Keys are named and revoked one at a time, shown once and stored as a hash. A script or an integration that called this API without a key needs one now.

## Translations

The Web UI is English by default and speaks German and Polish as well; the language field on the settings page picks it per browser. Log lines, the API reference and every value the API hands out stay English on purpose, so bug reports, scripts and the Home Assistant integration read the same everywhere.

Adding a language takes one file and no change to any page:

1. Copy `public/i18n/en.js` to `public/i18n/<code>.js`, named by the two letter ISO 639-1 code of the language, for example `es.js`.
2. In its first line, replace `I18N.register("en", "English", {` with the code and the language's own name, `I18N.register("es", "Español", {`.
3. Translate the values and leave the keys alone. Keep every `{placeholder}` and every `<b>`, `<code>` or link exactly as it is. A plural is written as `{ "one": ..., "other": ... }`; use the categories your language has in `Intl.PluralRules`, German and English need `one` and `other`, Polish for example `one`, `few`, `many` and `other`.
4. Add `"language.<code>"` to every table, your own included, with the language's name in that table's language: `"language.es": "Spanish"` in `en.js`, `"Spanisch"` in `de.js` and `"Español"` in `es.js`. The test holds every table to the keys of `en.js`, so once the key is there, every table needs it.
5. Fetch Bambu Lab's print error catalogue in that language with `node scripts/fetch-print-errors.js <code>`, so the reason a print failed is shown in it too. It writes `src/data/print-errors.<code>.json`, which belongs in the same pull request. A code the catalogue lacks falls back to English; if Bambu Lab answers with nothing for your language, say so in the pull request.
6. Run `npm test`. It finds the new files by itself and names every key, placeholder or plural form that is missing or different.

The service picks the file up on the next page load; the pages load every table in `public/i18n/` through one script, so nothing else has to change. Pull requests with a new language, or with better wording for an existing one, are welcome.

## Feedback

Found a bug, an issue or an improvement? [Let me know](https://github.com/Rdiger-36/HaspelSync/issues).

## Credits

- [SpoolmanDB](https://github.com/Donkie/SpoolmanDB) is the filament catalogue new filaments are filled in from, and a subset of it is what the mock Spoolman of the test server serves.
- [ha-bambulab](https://github.com/greghesp/ha-bambulab), the Home Assistant integration for Bambu Lab printers, is where all but one of the printer reports under `test/fixtures/reports` come from. They are what real A1, A2L, H2C, H2D, H2D Pro, H2S, P1P, P2S, X1C and X2D printers sent, most of them hardware nobody working on this project owns. The one exception, `p1s.json`, is the raw MQTT trace a user attached to issue #131.

The licences of both are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Support me

<a href="https://www.buymeacoffee.com/Rdiger36"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="36" /></a>
