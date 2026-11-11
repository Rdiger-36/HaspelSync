# Troubleshooting

[← Documentation](README.md)

## Checking logs

```bash
docker logs -f haspelsync
```

Startup and the AMS report:

```bash
[LOG] Server - Setting up configuration...
[LOG] Server - Backend running on http://localhost:4000
[LOG] Server - Spoolman connected successfully!
[LOG] Server - Checking Extra Field "tag"...
[LOG] Server - Spoolman Extra Field "tag" for Spool is set: true
[LOG] Server - Spoolman 0.27.1 knows native tags, spools are linked through them
[LOG] Bambu Lab P1S - Setting up MQTT connection for Printer: 01PXXXXXXXXXX...
[LOG] Bambu Lab P1S - MQTT client connected for Printer: 01PXXXXXXXXXX
[LOG] Bambu Lab P1S - [AMS] Units as the printer names them: A AMS
[LOG] Bambu Lab P1S -  [A1] PLA Basic 000000FF [[ XXXXXX00000A ]] => Spool-ID 1 (G-code mode)
```

A slot that is already linked is logged once, when the loaded filament changes. The remain percentage of the AMS is not logged for it, the weight does not come from there.

A print, from start to booking:

```bash
[LOG] Bambu Lab P1S - [Print] Print running: "bracket.gcode.3mf", fetching slice info via FTPS...
[LOG] Bambu Lab P1S - [Print] Slice info loaded: 2 filament(s), 260 layers
[LOG] Bambu Lab P1S - [Print] FINISH, booking filament consumption: {"GFA00|000000":{"tray_info_idx":"GFA00","color":"#000000","type":"PLA","grams":24.7}, ...}
[LOG] Bambu Lab P1S - [Print] Booked 24.7g for spool 1 (A1, GFA00 PLA #000000)
[LOG] Bambu Lab P1S - [Print] Booked 3.1g for spool 7 (A3, GFA01 PLA #FFFFFF, manually assigned)
```

A slot that is neither tag-linked nor manually assigned is named and skipped, so the log says which spool is missing its link:

```bash
[LOG] Bambu Lab P1S - [Print] No connected or assigned Spoolman spool for GFG00 PETG (#1E88E5), skipping 12.4g (assign the spool in the Web UI to track it)
```

The same logs are readable in the Web UI, per printer and for the server.

## How much gets logged

**Log detail...** in the **Logging** card of the settings page opens the level, the areas and the raw MQTT capture. The **Log** button next to a printer opens the same dialog for that printer alone, which is what lets one machine be turned up while the rest of the service stays quiet.

The level is a ladder, quietest first:

| Level | Writes |
| :---- | :---- |
| `errors` | Failures only |
| `normal` | Plus the ordinary progress lines. The default, and what an installation ran with before this existed |
| `debug` | Plus the internal steps: which check ran, which branch a slot took, which request went to Spoolman |
| `trace` | Plus the whole payloads behind those steps: the Spoolman spool list, the processed AMS data, every request body |

The areas (`mqtt`, `ams`, `spoolman`, `gcode`, `print`, `service`) filter the `debug` and `trace` lines only. Errors and the ordinary progress lines are always written, so switching an area off can never hide a failure.

> [!NOTE]
> `debug` used to mean everything, payload dumps included. Those moved up to `trace`, because they are written on every update interval and they were what made a debug log unreadable within minutes. If you are looking for the full documents, pick `trace`.
>
> The `DEBUG` environment variable still seeds an installation that has never saved a level: `DEBUG=true` becomes `LOG_LEVEL=debug`. A stored `DEBUG` is migrated on the first start of this version.

## Capturing everything the printer sends

**Capture raw MQTT messages** in the same dialog writes every report a printer sends into `logs/<serial>.mqtt.log`, unparsed and one line per message. It is the file to attach to a bug report about behaviour nobody can reproduce on demand: it is what the printer really sent, not what this service made of it, including the reports that were dropped because the previous one was still being processed.

It has its own size and history budget next to the log, because a printer reports far more than it logs. Measured on a P2S, idle and through a whole print alike: **roughly 22 MB an hour**. A full status report every 1.4 seconds, around 8 KB each once the printer's own indentation is folded away, plus the smaller messages between them. **Trace file size** is what decides how far back a trace reaches, and it multiplies with **Kept trace files**: the default of 50 MB with 2 kept files is about six hours of history, and a full day needs around 170 MB per file.

It stays on until it is switched off. Nothing turns it off by itself, on purpose: a fault that shows up twice a day is not caught by a capture that ended an hour ago. Size it for the gap between two occurrences of whatever you are hunting, and turn it off again afterwards.

The trace is readable in the Web UI like any other log: pick the printer under **Source** on the log page and switch **Show** from **Log** to **Raw MQTT trace**. It is in the diagnostics archive as `logs/<serial>.mqtt.current.log`. The download asks the same anonymising question every other log download asks, and it matters more here: a raw report carries every field the printer knows about itself.

## No sliced file on a P2S, H2 or X2D

The P2S, the H2 series and the X2D keep the file of a print in internal storage, and their FTPS server shows only a USB stick. Without a stick in the printer, every print starts like this, looks twice more with 30 seconds in between, and nothing is booked. The printer's answer for each path is in parentheses, and the listing of the stick comes after it. A 550 on every path and no 3MF on the printer at all is what a missing stick looks like:

```bash
[LOG] Bambu Lab P2S - [Print] Print running: "bracket", fetching slice info via FTPS...
[LOG] Bambu Lab P2S - [Print] No sliced file on the printer under /cache/bracket.gcode.3mf (550 Failed to open file.), /cache/bracket.3mf (550 Failed to open file.), /bracket.gcode.3mf (550 Failed to open file.), /bracket.3mf (550 Failed to open file.). Listed 0 3MF files on the printer: no 3MF was written at the start, trying again in 30 seconds
[LOG] Bambu Lab P2S - [Print] Looking for the sliced file again, attempt 2 of 3...
[LOG] Bambu Lab P2S - [Print] No sliced file on the printer under /cache/bracket.gcode.3mf (550 Failed to open file.), /cache/bracket.3mf (550 Failed to open file.), /bracket.gcode.3mf (550 Failed to open file.), /bracket.3mf (550 Failed to open file.). Listed 0 3MF files on the printer: no 3MF was written at the start, trying again in 30 seconds
[LOG] Bambu Lab P2S - [Print] Looking for the sliced file again, attempt 3 of 3...
[LOG] Bambu Lab P2S - [Print] No sliced file on the printer under /cache/bracket.gcode.3mf (550 Failed to open file.), /cache/bracket.3mf (550 Failed to open file.), /bracket.gcode.3mf (550 Failed to open file.), /bracket.3mf (550 Failed to open file.). Listed 0 3MF files on the printer: no 3MF was written at the start, consumption tracking unavailable for this print
```

The printer reports whether a stick is in, and the print card on the dashboard says "No USB stick or SD card in the printer, nothing will be booked" for as long as none is, while idle as well; the log says the same once when the stick goes missing. Put a USB stick into the printer. From then on the printer writes every job it receives onto the stick by itself, whether it was sent from Bambu Studio, through the cloud or from the Handy app, and the next print is tracked. Nothing has to change in Bambu Studio. The file listing of the [Debug-Printers CLI](#debug-printers-cli) below shows what the printer exposes: an empty listing means no stick.

Where on the stick the file lands and what it is called differs. A P2S writes `/cache/<job>.gcode.3mf`. An X2D sending a MakerWorld model that was changed in Bambu Studio writes it to the root under the project's name, `/CartPicker.gcode.3mf`, while the job is named after the print profile, "0.2mm layer, 3 walls, 15% infill". When no file is found under the job's name, the service lists the root and `/cache` and checks the 3MF files written within ten minutes of the print's start. A file is taken when it is proven to be the print's, by the md5 Bambu Studio sent, by the MakerWorld ids or by its profile or model title being the job name, or when it is the only candidate that nothing rules out. The log says which file it took and why:

```bash
[LOG] Bambu Lab X2D - [Print] Sliced file found on the stick: /CartPicker.gcode.3mf, written 2 seconds after the start, its md5 is the one Bambu Studio sent
```

When no file was written at the start, or every one that was is ruled out, the other 3MF files on the stick are checked as well, newest first: a reprint started on the printer's screen takes a file that has been on the stick for days. Each is read from its end only, where the layer count and the plates sit, and only a file that does not contradict the printer is downloaded whole and checked by its title and ids. Two files nothing rules out are still a guess, and none is taken. The log reads the same, with the file's age in place of the seconds:

```bash
[LOG] Bambu Lab P2S - [Print] Sliced file found on the stick: /cache/0.2mm layer, 2 walls, 15% infill.gcode.3mf, written 34 minutes before the start, its title is the job name
```

Once found, the path is kept in `printstate.json` next to the print's start, and a restart of the service during the print reads the same file again, whatever the job is called by then: "Found "Darts Holder and Storage" already running, started ..., its sliced file was read from /cache/...".

A print started on the printer's screen from its internal storage, such as the sample models it ships with, is never on the stick and cannot be tracked.

The i at the end of the line on the print card opens the same advice in the Web UI, with the printer's answer as the log has it.

## The printer does not answer the file transfer

The sliced file is read over FTPS, port 990 on the printer. When the login itself fails, no path is tried and the log says so, with the error the connection raised; the print card reads "The printer did not answer the file transfer, nothing will be booked for this print" and the i next to it opens the steps below. Seen on a P2S on 2026-10-02, with the file sitting right under the first path:

```bash
[LOG] Bambu Lab P2S - [Print] Print running: "0.2mm layer, 2 walls, 15% infill", fetching slice info via FTPS...
[ERROR] Bambu Lab P2S - [Print] Could not fetch slice info: error:0A00010B:SSL routines:tls_validate_record_header:wrong version number (control socket), trying again in 30 seconds
```

The printer accepted the TCP connection and answered the TLS handshake with plain text, or not at all, while its MQTT port kept working. That is the printer's FTPS service hung, and it stays hung until the printer is restarted. A restart ends the running print, so either restart now and print again, or let the print finish, which books nothing, and restart afterwards. Before restarting, close other programs that hold a connection to the printer's storage, the storage view in the Device tab of Bambu Studio, a second instance of this service or a script, and try option 3 of the [Debug-Printers CLI](#debug-printers-cli): a listing that hangs or fails with the service's own client confirms that it is the printer. Once the printer answers again, a restart of the service during the print gives it three new attempts; the next print gets them anyway.

## Debug-Printers CLI

The container ships a script that checks the network and MQTT status of a printer from inside the container:

```bash
docker exec -it CONTAINER_NAME debug-printers
```

Pick a printer by number, then choose between subscribing to its MQTT messages, which prints everything the printer sends including the AMS spool data, a reachability check on port 8883, and a listing of the files on the printer over FTPS, which shows where the printer keeps the sliced file of a print when the log says it was not found:

```bash
--- Options for Bambu Lab P1S ---
1. Subscribe to MQTT messages
2. Check reachability
3. List the files on the printer (FTPS)
4. Back to main menu
```

The listing goes two levels deep and leaves out the camera and timelapse folders. It can also be run on its own, `docker exec CONTAINER_NAME node scripts/list-files.js PRINTER_IP ACCESS_CODE`.

## The Web UI answers with 403

The service accepts a request only under the name it was addressed to, which is
what keeps a page on another website from reaching an installation on your
network. IP addresses, `localhost` and `.local` names are always accepted, so
this only appears when the Web UI is reached under a real domain name or through
a reverse proxy:

```
Host "ams.example.com" is not allowed. Reach this service under its IP address,
or add the name to "Allowed host names" on the settings page.
```

The server log says `[Security] Refused a request for host "ams.example.com".
Add it to ALLOWED_HOSTS to allow it.` once per refused name. Open the Web UI
under the IP address of the host, which is never refused, and add the name under
**Network access** on the settings page, comma separated for more than one. It
takes effect on save, without a restart. `ALLOWED_HOSTS=that.name` in the
container definition seeds the same setting on an installation that has never
saved it, which is how a fresh installation that will only ever be reached under
a name can carry it in its compose file before the first start.

A `PUT` or `POST` answered with 403 while the pages load has the same cause
behind a reverse proxy that rewrites the `Host` header: the same entry fixes
it.

## The password is gone

A forgotten Web UI password is not recoverable, it is stored as a hash. Take it
out of the configuration instead: stop the container, open
`printers/settings.json`, remove the `AUTH_PASSWORD` line from `values`, and
start the container again. The Web UI is open again until a new password is set
on the settings page.

If the container is what sets it, through an `AUTH_PASSWORD` environment
variable on an installation that never saved the field, change it there instead.
A value saved in the Web UI wins over the variable.

Sessions end whenever the password changes, on every device, because the cookie
is signed with it. A browser that suddenly asks again after somebody changed the
password is doing what it should.

## Diagnostics and privacy

Logs and configuration describe a home network: the address of every printer and of Spoolman, the serial numbers, and in `printers.json` the access codes. Every download that can carry them asks first and offers an anonymised variant.

**Download diagnostics...** produces one archive with everything a bug report needs: `info.json` (version, Node, platform, uptime, tracking mode), `settings.json` with the origin of each value, `printers.json`, `mappings.json`, `presets.json` once a preset has been learned, and `logs/` including the rotated history and the raw MQTT trace of every printer it was captured for. The dialog lets you tick which logs go in, the server log and each printer separately; the configuration files are in every bundle, and `info.json` says which logs were asked for, so a missing printer log reads as a choice rather than as a printer that never logged. With several printers and a trace running on one of them, ticking that printer alone keeps the archive small. The API keys are not in it at all, and the Web UI password and the printer access codes are replaced before the archive is written. **Download...** on the log page asks the same question and lets you tick which files go in: the shown log or trace, the printer's other file and the server log, or on the server log every printer's log. One file comes as it is, several as a zip of the logs alone, without the configuration files; the dialog points to the diagnostics bundle for those.

A printer's two logs can be picked apart as well: **Log** next to the printer in the Printers card opens its log detail dialog, and the export at the bottom of it ticks the printer log and the raw MQTT trace separately, then downloads the same archive with only those.

The same choice is available to a script through the `scope` query of `GET /api/diagnostics/download`, which the [API page](api.md) lists with every other route: `server`, serial numbers, `<serial>/log` and `<serial>/trace`, comma separated, for example `?scope=server,01P00A000000042/log`. A bare serial means both of its logs. Without the query the bundle carries every log.

Anonymised replaces the last octet of every IP address, everything after the first five characters of a serial number (in file names as well), everything after the first four characters of an RFID tag, the whole access code, the Spoolman host name (keeping scheme, port and path), and shortens the data and log paths to their last two segments. Four characters of a tag are enough to see that two lines are about the same spool, and too few to recognise the spool by. What a slot reports when it has no tag at all, `N/A` or an all zero uuid, is not a tag and stays as it is. Printer names and the rest of the spool data are kept: they make a log readable and say nothing about the network.

**The access code is never part of any export**, anonymised or not.
