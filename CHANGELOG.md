-----------------------------------------------------------------------------------------------
Version 1.3.4-dev.1
   - New Features:
      - A print that runs a spool empty and carries on from the AMS backup slot (auto refill) books each spool what came out of it. Until now the whole print went onto the backup spool, because the printer reports the backup slot as the one the print runs from once it has switched. The spool that ran out now gets the layers up to the switch and the backup spool the rest, weighed from the G-code like a cancelled print, and the print report marks the split rows with a ⚠ and says where the filament was split (issue #225). A restart of the service during such a print keeps it: the slots, the switch and the spool that ran out are kept in printers/printstate.json, and a switch that happened while the service was down is split at the first layer seen afterwards
      - A slot that runs empty during a print stays on the dashboard with a ⚠ "Ran out during this print", the spool it held and what the print takes from it. The filament left in the tube still prints after the AMS reports the slot empty, and until now the dashboard, and a booking at the end of such a print, put those grams on a spool of the same colour in another slot
      - A cancelled or failed print books what its layers really used. The service reads the G-code in the sliced file and weighs every layer, where it used to give each layer the same share. A cube cancelled after 8 of its 11 layers booked 1.41 g before and 1.12 g now, because its middle layers are sparse infill. A filament whose G-code does not add up to what the slicer says keeps the even share. A finished print books exactly what it did before

-----------------------------------------------------------------------------------------------
Version 1.3.3
   - New Features:
      - The reason a print failed is shown in Polish too, from Bambu Lab's Polish error catalogue. Until now the Polish Web UI showed it in English

-----------------------------------------------------------------------------------------------
Version 1.3.2
   - New Features:
      - The Web UI speaks Polish. Pick it in the Web UI section of the settings page or on the login page. Thanks to @tomeko12 (PR #219)

-----------------------------------------------------------------------------------------------
Version 1.3.1
   - Fixes:
      - The service asks the printer for a full report as soon as it connects. Until now it waited for the printer to send one by itself, which an A1 mini does only about every five minutes, so after a restart the slots, the external holder and a running print showed up minutes late (issue #212)

-----------------------------------------------------------------------------------------------
Version 1.3.0
   - Breaking:
      - The project is called HaspelSync. The image is ghcr.io/rdiger-36/haspelsync and the repository is github.com/Rdiger-36/HaspelSync. GitHub redirects the old repository address, so links, clones and the update check of an installed version keep working. GHCR does not redirect an image name: every release is published under the old name ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus as well for a transition period, so an installation that pulls it keeps updating, but the old name will be retired. Switch the image in docker run or docker-compose to the new name; the configuration and the volumes stay as they are
         - A container that runs from the old name is told so: two lines in docker logs on every start, a dialog on the dashboard once after every start, so a restart and every new version ask again until the image has been switched, and a line under System on the settings page for as long as it is true, each naming the image to switch to. The image of the old name is the HaspelSync image of the same version with its name baked in, so the service knows which one it was pulled under; the name is on /api/system as image and imageDeprecated, and the notice is legacy-image on /api/notices
         - The diagnostics archive is haspelsync-diagnostics_<stamp>.zip, where it was ams-diagnostics_
      - An installation updated from 1.2.x is told what changed, once: the dashboard opens a dialog on the first visit after the update naming the four things below that can need a hand, with a link to the new "Updating from 1.2.x" page of the documentation, and docker logs repeat them on every start until the dialog is dismissed, because an installation reached under a name that is not allowed yet has only the log. A 1.2.x installation is recognised by its files, a printers.json without a settings.json, so a fresh install never sees it
      - AMS slots are numbered the way the printer numbers them: the first slot of the first unit is A1, the last one of a fourth unit is D4. Every slot label moves up by one, in the Web UI, in the logs, in the API and in the Spoolman location of a spool
         - Nothing has to be done by hand. The assignments in printers/mappings.json are renumbered on the first start, and the Spoolman location follows on the next reading of the AMS, so "P1S - A0" becomes "P1S - A1" on its own. A location set by hand is still left alone
         - A caller of the API sees the new labels in amsId, which is what to look at first for a script or a home automation reading them. The Home Assistant integration is the one to check
         - Before this the labels counted from 0 while the printer's display, its touchscreen and Bambu Studio all counted from 1, so the second slot of the AMS was A1 on one screen and A2 on the other
      - A request is refused unless it was addressed to this service under a name it accepts. IP addresses, localhost and .local names are accepted as they are; every other name has to be listed under "Allowed host names" in the new "Network access" card of the settings page
         - An installation reached under a real domain or through a reverse proxy is the one that notices. It answers nothing until that name is filled in once and saved, which takes effect without a restart. ALLOWED_HOSTS seeds the same setting from the container definition. An installation reached under an IP address, which is most of them, notices nothing
         - The name is checked rather than the address because a name the attacker controls can be pointed at a local address after the browser has loaded their page, which no browser can tell apart from a legitimate request
      - The API answers only two kinds of caller now: the Web UI of this installation, and a request carrying an API key. Anything else is answered with 401 and a sentence saying so. This holds whether or not a Web UI password is set; the pages themselves stay open to the network without one, it is /api/ that asks
         - A script, a home automation or an integration that called this API without a key stops working and needs one. Create it under "API keys" in the Network access card and send it as "Authorization: Bearer <key>" or "X-API-Key: <key>". The Home Assistant integration is the one to look at first
         - Before this, an installation without a password answered every caller on the network, which is also why the key list could never say who was actually using the API
      - Two log lines changed their wording, because the external spool holder is a slot now and not an AMS: "No new AMS Data or changes in Spoolman found ..." and "Spool successfully created for AMS Slot => ..." both say "slot". A script that greps the log for either has to be adjusted
   - Deprecated:
      - Configuring the service through environment variables is deprecated. Nothing has to change and every variable keeps working, but the settings page is the supported place for it now
         - A variable only seeds a setting that has never been saved. After the first save the settings file owns the value, so a change made in the UI is not reverted by the container definition on the next start
         - The printer list is edited on the settings page instead of in printers.json, which the service writes itself now
         - An installation that still relies on them says so once in the dashboard and on every start in "docker logs", naming the variables that are actually still in charge. Both stop on their own once nothing is left that the environment decides
         - The settings page says the same thing where it matters: a standing note at the top names every variable still in charge and says that a save writes the whole configuration into printers/settings.json, so none of those variables changes anything afterwards. It appears under exactly the condition the "from the environment" badges do, so an installation that never used the variables never sees it
         - TZ, DATA_DIR, LOG_DIR and SUPERVISOR are not deprecated: they are container level and have no field in the UI
   - New Features:
      - Filament consumption is tracked from the sliced G-code instead of the AMS RFID remain percentage, and is the default. The sliced .gcode.3mf is fetched from the printer over FTPS while the print runs and booked onto the Spoolman spool when the job ends, scaled to the layers that were finished if it was cancelled. It covers 3rd party spools without an RFID chip, which the remain percentage never could. LEGACY_MODE=true keeps the previous behaviour
         - A P2S, an H2 series printer or an X2D needs a USB stick in the printer. These printers expose only the stick over FTPS: with one in, the printer copies every job to /cache on it and the sliced file is read from there, without one the file exists only in internal storage and nothing is booked. The printer reports whether its stick is in, and the print card says "No USB stick or SD card in the printer, nothing will be booked" for as long as none is, while idle as well, so the stick is in before the next print rather than found missing by it; the log says it once when the stick goes missing and once when it is back. The API carries it as storagePresent on /api/print/{printerId}
         - A print sent over the LAN and a print sent through the Bambu cloud, from Bambu Studio or the Handy app, are both found, under the two names the printer gives them. A print started on the printer's own screen from the USB stick is found under the name the printer announces for it, which is not its job name. The file is looked for up to three times, 30 seconds apart, for a printer that does not answer in the first seconds of a job or is still copying the file to its stick. A print whose job name does not lead to its file at all, a MakerWorld model opened in Bambu Studio, changed and sent through the cloud is named after its print profile in every report while the file on the stick is named after the project, is found by listing the printer's storage: the 3MF files written within ten minutes of the start are checked, closest first, a file is ruled out when the plate or the layer count does not match and proven by the md5 or the MakerWorld ids Bambu Studio's command carries, and two candidates nothing rules out book nothing rather than guess. When no file written at the start is the print's, a reprint started on the printer's screen after a restart of the service, whose file is weeks old, the other 3MF files on the stick are checked too, newest first, each by its last 128 KB over an FTP resume, which hold the layer count and the plates, and only what that does not rule out is downloaded whole and proven by its title and ids. The path of a sliced file, once found, is kept in printers/printstate.json next to the print's start and read first after a restart. The log names the file, how far from the start it was written and why it was taken, or why none was (issue #179)
         - Each filament is booked onto the slot the print really ran it from. A P2S, an X1 and the H2 series report that themselves. A P1 or an A1 never does, so for them the service reads the command Bambu Studio sends with the job, which the printer echoes and which carries the slots after any remapping Studio did for a project that was not synchronised with the printer; an empty slot in the middle of an AMS is handled, and so is the external holder. A print started from the SD card or repeated on the printer's screen on those two families falls back to the order of the sliced file (issue #146)
         - A P1 or an A1 is tracked between its full reports, which come minutes apart with only the changes in between, so a layer, a stage or an error sent on its own is not lost and a cancel books the layer the printer is really on
         - A restart of the service during a print keeps the print: its start time is written to printers/printstate.json when the print begins, and the job is booked when it ends. On a P1 or an A1 the slots Bambu Studio sent it to are lost with the restart, and the log says so
         - A slot that is linked to nothing is named in the log and skipped, so a missing link is visible rather than silently untracked. A booking needs an RFID tag link or an assignment made in the Web UI; a spool matched only by material and colour is never booked onto
      - Print centric dashboard: print state, layer progress, "on spool / needed / after print" per spool, and a list of what the print needs but no slot holds
         - The card says when the print started, how long it has been going and when it is expected to end, at the precision the printer has: "~ 3 min" or "~ 6 Days 4 hours 30 min". Durations are written in words, "14 min 50 s", and every moment says "at". A paused print shows what it still needs instead of an end time that would move for as long as the pause lasts. The start time is measured here, because the printer reports none, and left out rather than invented after a restart mid print
         - The state badge says PREPARE for as long as the printer is heating, homing, levelling, calibrating or changing filament before the first layer, and a second badge names the stage: "Heating heatbed to target", "Printing calibration lines", "Changing filament". Stages 1 to 77 are named, the way the community names them; a code nobody has named shows as its number, and the two codes that mean no stage at all, -1 and 255, show nothing
         - A print error is named, not only numbered: "Printer error 50348044: The task was canceled." The sentences are Bambu Lab's own, fetched by scripts/fetch-print-errors.js from the lookup Bambu Studio uses and shipped as src/data/print-errors.json, 964 codes, so nothing is fetched at runtime. A code the catalogue does not know stays the bare number
         - The card names the model where the printer names the job after its print profile. A MakerWorld model printed through one of its profiles from Bambu Studio is "0.2mm layer, 2 walls, 15% infill" in every report; the sliced file carries the model's title, "Darts Holder and Storage", and the card, the summary and the log line "Slice info loaded" show it, with the profile name in the tooltip. /api/print and the summary carry it as modelTitle, jobName stays what the printer reports
         - While the sliced file is missing the card says so: grey "Sliced file not found yet, looking again once the print runs" while the print prepares and "looking again (attempt 2 of 3)" while attempts are left, red "No sliced file on the printer, nothing will be booked for this print" after the last, or "The printer did not answer the file transfer, nothing will be booked for this print" when the FTPS login itself failed, which the log names as "FTPS login to the printer failed: <error>". An i at the end of the red line opens a dialog with the reason and what to do, for a printer whose file transfer did not answer, for a file none of the paths held and for a missing USB stick, each with the printer's answer as the log has it and a link to the troubleshooting guide. The API carries it as sliceFetch on /api/print/{printerId}, with kind, connection or missing
      - A finished print leaves a summary behind, opened from the label on the card: result, start, end, duration, layers, and one row per filament with the slot it ran from, the grams and the spool it was booked onto
         - The label says what happened: "consumption booked", "1 of 3 booked", "nothing booked" when no filament could be booked, "nothing to book" for a print that ended before it used any, "no sliced file" when nothing could be read
         - The table is every filament of the sliced file and what became of it, so a line without a booking reads as part of the plate rather than as something the service mislaid. A filament that was not booked carries the reason, and the two failures are named apart because only one can be acted on: a slot printed it and no Spoolman spool is connected or assigned to that slot, or no slot of the printer carried it at all
         - Filaments are named the way the slot tables name them, vendor, material and colour with the swatch in front. An error the printer names is carried into it, including the code a print stopped by hand reports
         - The summary is held in memory only. It is dropped when the next print starts and does not survive a restart
      - The card returns to idle on its own once a print has been over for "Clear print result after", ten minutes by default, 0 to keep it until it is cleared by hand. Next to the label is a Clear button carrying the countdown, which does it now; the summary stays reachable as "Last print" until the next print starts
      - An AMS slot can be linked to a Spoolman spool by hand, or to a filament and spool created right in the dialog, prefilled from the AMS and from the SpoolmanDB catalogue
         - The assignment picker suggests the spools that fit the slot first, by material family and colour, and warns when slot and spool disagree on the material
         - "Assign 3rd party spools automatically" in the Tracking settings, off by default, links a spool without an RFID tag to the one Spoolman spool of the same material and colours that carries no tag and sits in no other slot. With two candidates the slot waits for a choice, and nothing is ever created in Spoolman. The assignment picker preselects the same spool, so the usual case with the setting off is one click (issue #47)
         - A 3rd party spool is called by the preset chosen for its slot: "Generic PLA preset", "SUNLU PETG preset" or "PLA · custom preset". A spool without a tag reports nothing of its own, only the filament preset somebody picked for the slot on the printer's screen or in the slicer
         - The create dialog of a chipless slot proposes the filament from the slot's preset. A vendor preset chosen in Bambu Studio, "SUNLU PETG" or "PolyLite PETG", names the manufacturer, so the catalogue is narrowed to that maker and the slot's material when the dialog opens, and the entry nearest the slot's colour is filled in as a proposal with a line saying how near. A filament sold on a spool heavier than 1 kg cannot sit in an AMS and ranks behind every fitting one; the external holder takes any size. Nothing is created by itself (issue #47)
         - The name behind a custom preset is learned from the first print with it. A preset from Bambu Studio's cloud library, or one of the user's own, reaches the slot as a hash such as "Pdd34802", and the printer never sends the name; the sliced file does, and the service reads that file for every print it books. The slot then reads "fibrelogy PLA Basic preset" instead of "PLA · custom preset", and the create dialog knows the manufacturer. Kept in printers/presets.json (issue #47)
      - Clicking the filament name of a slot opens a dialog with everything the printer and Spoolman hold about it; remaining weight, lot number and comment can be corrected there
      - A spool that runs empty is archived in Spoolman on its own, off by default, with a threshold in grams
      - The external spool holder is a slot of its own and can be assigned like any 3rd party spool. A dual nozzle printer (H2C, H2D, X2D) gets a second one, "External-2", for the holder that feeds its second extruder
      - Multi colour filaments are read, drawn and created with all of their colours, and a gradient spool is no longer taken for a plain spool of the same first colour
      - The Spoolman location of a spool follows the AMS slot it sits in, and is cleared when it leaves
         - A slot that stops being reported releases its spool as well, which is what an emptied external spool holder and an unplugged AMS unit look like: the holder is only reported while it carries something. A location that does not name this printer is left alone either way, so anything set by hand in Spoolman survives
      - Each AMS unit says how it is doing above its slot table: relative humidity, the temperature inside it, and the drying cycle while one is running, with its target temperature and the minutes left
         - What is shown depends on which unit it is, because the units report different things. An AMS 2 Pro and an AMS HT carry a real sensor and a dryer and show all of it; the original AMS and the AMS Lite report only the five step humidity level and show that. The external spool holder reports none of it; its header carries the name alone
         - Every unit folds away on a click on its header and back on the next, the chevron at the right end of the header saying which way. A folded unit is one slim line with a swatch per loaded slot, so what is in it is seen without opening it. Which units are folded is kept per browser and printer, and a refresh leaves them as they are
         - The readings are display only. They never reach Spoolman, they are kept out of the change detection that decides when a slot is reprocessed, and they are pushed to the browser at most every 30 seconds
      - The header of an AMS unit names the unit as the printer names it: "AMS A", "AMS 2 Pro A", "AMS HT B". The service asks the printer for its module list on every connection, which is the one place the family is stated; the status report cannot tell an original AMS from a 2 Pro on current firmware. Until the answer arrives a unit reads "AMS", and a single slot unit "AMS HT"
      - Settings page for everything that used to be an environment variable, plus the printer list, applied without a restart, with a connection test for Spoolman and for a printer, MQTT and FTPS, against the values in the form
         - The page is split into sections, Printers, Spoolman, Tracking, Logging, Access, Web UI and System, listed in a navigation card at the left; on a window narrower than about 1000 px the card is a row above the content. One save covers every section: a section with unsaved changes carries a green dot in the navigation and the save bar names it, "Unsaved changes in Spoolman". The section is part of the address, settings.html#access, so a link lands on the right one
         - The Web UI section holds the choices of the browser rather than of the installation, the language and the theme; they apply at once, are kept in the browser and never reach settings.json, so two people on two phones can read the same installation in two languages
      - The Web UI speaks English and German. English is the default, the language is picked in the Web UI section of the settings page and on the login page, and the choice is kept per browser. Every page is translated, the dashboard with its dialogs, the settings with every field the settings schema describes, the log viewer, the download dialog and the login. Log lines, the API page and every value the API hands out stay English, so scripts, the Home Assistant integration and bug reports read the same everywhere. Another language is one more table dropped into public/i18n/; the pages load every table in that folder, and a test holds each to the English keys
      - System section with version, image, platform, uptime, tracking mode and Spoolman connection, plus update check, reconnect all printers, pause monitoring and a diagnostics download
      - The diagnostics download is one archive with everything a bug report needs: version and platform, the settings with the origin of each value, the printer list, the assignments and the logs including their rotated history. It is offered anonymised, which is the default
         - Anonymised replaces the last octet of every IP address, everything after the first five characters of a serial number, everything after the first four characters of the RFID tag of a spool, the Spoolman host name and the path of the upload address a cloud print carries, which names the user's Bambu account, and it shortens the data and log paths. The md5 of the print command stays, although it has the shape of a tag: it names the sliced file and nothing else, and it is what ties a print to its file on the stick. Enough of a serial or a tag survives to see that two lines are about the same printer or the same spool, and too little to identify either
         - What a slot reports when it has no chip, "N/A" or an all zero uuid, is not a tag and stays as it is: it is the answer to half the questions a report about a 3rd party spool is asking
         - The Web UI password, the API keys and the printer access codes are in no variant of the archive, anonymised or not
         - The download asks which logs to include, the server log and each printer separately, and the log detail dialog of a printer exports that printer's log and raw MQTT trace on their own. The configuration files are in every archive, and info.json says which logs were asked for. A script gets the same choice through the scope query of /api/diagnostics/download
      - The Web UI can ask for a password, off unless one is set in the Network access card. One password for the installation, stored as a scrypt hash and never sent back to the browser, a session that lasts 30 days and survives a restart, and a lockout after repeated wrong guesses. Forgotten it? Stop the container, remove the AUTH_PASSWORD line from printers/settings.json, start it again
      - API keys for the callers that have no browser, in the same Network access card. Named keys, created and revoked one at a time, shown once and stored as a hash, sent as "Authorization: Bearer" or "X-API-Key". A key is a full session and works whether or not a password is set
      - An API page in the Web UI: every route with its parameters, an example body and the shapes of its answers, and a "Send" button per route that sends the request from the browser and shows the answer, the event stream included. The description behind it is served as OpenAPI 3.0 at /api/openapi.json and imports into Swagger UI, Postman or a client generator; a test holds it to the routes the app registers
      - A failed API answer carries a code next to its English error, printerNotFound, weightAboveLimit and so on, with params for the values the sentence names, so a client can word it in its own language; the Web UI does. The print on /api/print/{printerId} carries stageCode next to stage, and the closing report of a print carries printErrorDetails next to printError, with Bambu Lab's sentence for the code in every shipped language
      - The API carries what the tag and the printer's filament table say about a spool, and the slot that is feeding. Every slot on /api/spools/{printerId}, /api/print/{printerId} and the live updates has tag_uid, tray_diameter, nozzle_temp_min, nozzle_temp_max, bed_temp, drying_temp, drying_time and k, as numbers, null where the printer reports nothing. /api/status/{printerId} has activeSlot, the slot whose filament is in the nozzle that prints, null while none is loaded. For the Home Assistant integration, which shows a slot the way ha-bambulab does; the dashboard shows neither
      - Log files are rotated instead of growing forever, and the log view and download read across the rotated history
      - How much gets logged is a level rather than a switch, in "Log detail..." in the Logging card: errors, normal, debug and trace, with the areas that write next to it and the raw MQTT capture below. The payload dumps that used to come with debug logging sit at trace, because they are written on every update interval and made a debug log unreadable within minutes. A stored DEBUG is migrated to the debug level on the first start
         - Errors and the ordinary progress lines are never filtered by area, so switching one off cannot hide a failure
         - The print path says what it is doing: the ordinary log names the file it looked for and, when none was found, what the printer answered for every path; the debug level adds every state change, which consumption sum ran and on what layer, where the slots came from, and what the matcher answered per filament
      - Every MQTT message a printer sends can be captured into logs/<serial>.mqtt.log, one line per message, with its own size and history budget. It is what the printer really sent rather than what this service made of it, and it is every kind of message, not only the status reports this service reads. Measured on a P2S it runs at about 22 MB an hour, idle and under a print alike. Readable and downloadable like any other log and part of the diagnostics archive
      - Every printer can have log settings of its own, "Log" next to it in the Printers card, so one machine can run at trace with its capture going while the rest of the service stays quiet
      - The Logs page carries its choices as controls: a Source button over the server and the printers, a Log / Raw MQTT trace switch for a printer, and the download at the right end. Under the toolbar the file is named and described, whether the trace is captured, how many reports are on screen, the refresh and the size of the download. The switch writes into the address, so a link to a trace still opens the trace
         - Download... asks which files go in, the way the diagnostics download does: the shown log or trace, the printer's other file and the server log, or on the server log every printer's log. One file comes as it is, several as haspelsync-logs_<stamp>.zip through GET /api/logs/download?scope=..., the diagnostics archive without the configuration files; the dialog points to the diagnostics download for those
      - Reworked menu bar: the spool and the name HaspelSync at its left end lead back to the dashboard, Dashboard and Logs are tabs next to it with the open one underlined in green and a glyph in front, every log is its own entry of the Logs tab, and the right end holds the dark mode button and a gear. The gear is the settings page, or, once a password is set, a menu with the settings page, the log out and the version at its foot. What a page is showing is picked in the page instead, in the dashboard headline and in the log title. On a phone the two pages fold into one Menu button drawn like the gear. Dark mode covers every page and reaches the controls the browser draws itself
         - The Web UI has an icon, a filament spool whose winding is half Bambu Lab green and half Spoolman orange, as the tab icon of every page and as the home screen icon on a phone, and every browser tab reads "<page> · HaspelSync". The login page carries the bar as well, with the spool and the name, the dark mode button and a language menu, and the footer
      - The dashboard headline moved into the head of the status card and reads "Loaded Spools on <printer>", with the tracking mode at one end of that line and the monitoring switch at the other. The six facts under it, Spoolman, the printer connection, the serial and the two timestamps, are cells of one size in the middle of the card instead of columns stretched over its whole width
      - The monitoring switch stays red while it is off, because off is not a preference here but a stopped service: it closes the MQTT connection to the printer, so nothing is read from it and nothing reaches Spoolman
      - The whole Web UI works on a phone. An AMS unit is one card there, with its header as the head and its slots as sections inside it, instead of four free floating tiles; the printer list, the spool tables and the API keys are cards with their labels above the values instead of a table behind a sideways scroll; the navigation of the settings page is a row above the content, and every dialog fits inside the screen, the confirmation dialogs of "Merge Spool" and "Create Spool" included
      - Every page keeps to the same width as the settings page, 1180 px, instead of stretching to the window, so the menu bar and the content under it line up and a wide screen no longer pulls a spool table or a log line across the whole desk
      - The debug-printers tool in the container lists the files on a printer over FTPS, two levels deep, without the camera and timelapse folders, for a sliced file the log could not find
      - Four container level variables: DATA_DIR and LOG_DIR move the data and the logs, SUPERVISOR=false runs the service without the supervisor process that restarts it on request, TZ sets the time zone. Every other new setting, LEGACY_MODE, the log budgets, ALLOWED_HOSTS and AUTH_PASSWORD among them, can be seeded from a variable of the same name like the settings before it, and is edited on the settings page from then on
   - Fixes:
      - A spool is created with the weight the AMS reports instead of always starting at 100 % (issue #59)
      - New filaments take their weight and spool weight from SpoolmanDB instead of a fixed 1000 g and 250 g
      - A Bambu Lab PLA Basic spool is created from the Basic entry of the SpoolmanDB catalogue. The catalogue writes Basic without a line word, so the lookup fell through to every PLA entry of the colour and took the first, which is Aero Black since the catalogue lists PLA Aero; among the entries of a colour, the line the AMS names wins when its word is in the id, and otherwise the entry whose name carries no line word, with the line words read off the catalogue itself
      - An AMS update is no longer let through by a check that could not fail. The report was tested for empty humidity and temperature fields on the AMS block, where a P2S never puts them: the check compared undefined against an empty string and passed on every report. The fields sit on the units, and that is where they are read now
      - The external spool holder no longer shows and vanishes on a P1S (issue #131). The printer sends delta reports that carry the AMS block and leave the holder out, and each of those was read as an empty holder. A report that does not mention the holder now means nothing changed, and only a report that carries it replaces what the last one said
      - A printer that is switched off is probed at a growing interval and says so once instead of filling the log (issue #54)
      - A printer reconnects after a network drop even while Spoolman is still unreachable. The monitor loop is the only thing that reconnects MQTT, and it idled for as long as Spoolman was down, which made a printer connection hostage to an unrelated service. Nothing is written to Spoolman by keeping the connection up: the message handler refuses to process a report while Spoolman is down, and always did
      - The Spoolman health check says why it failed. No route to the host, a refused connection, a timeout and an answer that is not JSON are four different problems with four different answers, and all four used to read as "unreachable"
      - A location set by hand in Spoolman is no longer wiped, and a spool moved between two slots keeps its location
      - A spool whose tag was edited by hand into something that is not JSON no longer stops every AMS update
      - The log lost most of its lines while the service was running, and it rewrote itself for every "nothing changed" line; only the last line is replaced now
      - A Spoolman write that failed was answered with success; it is a 502 now and names what Spoolman said
      - In automatic mode a spool is created or merged once. A slot that has not changed since the last pass is not written again, so a creation whose follow-up lookup missed the new spool is not repeated and a failed write is not retried on every pass
      - The merge confirmation shows the grams the row shows. It worked the remaining weight out from the raw percentage while the row uses the corrected figure, so the two disagreed for spools lighter than 1 kg
      - The log routes answer a failure as { ok: false, error }, the shape every other route uses
      - A failing "Bambu Lab" vendor lookup no longer stops the whole startup
      - MODE="auto" is accepted, and an unknown value is reported instead of quietly falling back to manual
      - Support material ("-S") no longer has its remaining percentage rescaled to a 1 kg basis
      - The API is no longer reachable from every other website the browser has open. Every response carried "Access-Control-Allow-Origin: *", which tells the browser to hand the answer to any page that asks, so a page on any other site could read the printer list and the settings of an installation on the local network and could write to them as well. The header is gone, and a request that changes something is refused when it comes from another site, while a call from a script or a home automation, which carries no site at all, keeps working
      - Dark mode reaches the controls the browser draws itself. The list of an open select came out white with grey text in it on a dark Windows install, because Chromium paints that list with the colours of the select, and the select had none: it was transparent. Fields carry a colour of their own now, and the page declares which colour scheme it is in, which is what the scrollbars, the radio buttons and the spin buttons follow
      - The spool tables fit a narrow window. Their columns are set to the widest cell of every table so the units line up, and that width was measured with the cell's padding and set without it, 20 px too wide per column; on a window of 800 px the action column ran off the right edge, with its buttons cut. The spool name column also gives up what does not fit, so a narrow window wraps names rather than the table
      - Several dashboard fixes: the theme no longer flashes on page load, the confirmation dialog stays usable, and a spool the printer cannot identify is labelled "3rd party"
      - Web UI: "Go to Spoolman" opens the create page when Spoolman lives under a path; spool, filament and slot names, log lines and the printer name in the export dialog are shown as text rather than markup; the merge dialog and the spool dialog round to two decimals; the footer says the current year; the two theme icons are drawn in the page rather than fetched from icons8.com
   - Development:
      - Node 22, and the README is rebuilt around G-code tracking and the HaspelSync brand, with new screenshots
      - The publish workflow pushes the HaspelSync image first and builds the image of the old name on top of it, from docker/Dockerfile.legacy, with HASPELSYNC_IMAGE set to the name it is published under; the release notes list both
      - The service runs under a supervisor process, entrypoint.js, which starts it again on the restart exit code and passes every other exit on, so a crash stays a crash for the container's restart policy
      - One projection for what a client sees of a slot, one consumption match, and the rules both sides apply live in public/shared.js instead of in two implementations
      - src/location.js is the single place that writes a Spoolman location
      - src/passwords.js, src/auth.js, src/security.js and src/apikeys.js hold the hashing, the session, the request guard and the keys, each covered by its own test file. No variant of the diagnostics bundle carries the password hash or the key file
      - printers/mappings.json carries a schemaVersion beside its assignments, so a flat file written before the slot renumbering is read as version 0, renumbered once and written back
      - extractAmsEnvironment() in src/ams.js is the one reading of the per-unit environment fields, covered against the four unit shapes that have been observed
      - New test server under scripts/test-server: a mock printer and a mock Spoolman, started with one command. It publishes any of the real printer reports under test/fixtures/reports with "--report <name>", or stands in front of a real printer with "--real-printer", and "--state-dir" keeps its state across runs, for what only a restart of the service shows"
      - Real printer reports, copied from the mock data of ha-bambulab under its MIT notice in THIRD_PARTY_NOTICES.md: A1 with AMS Lite, X1C with three AMS and an AMS HT, the dual nozzle H2C, H2D and X2D, P1P without AMS, A2L and P2S. test/reports.test.js runs every one through the ingest pipeline with invariants, and what they found that is not handled yet is listed there as todo: the A2L reports its AMS as unit 16, which no slot label range knows, so the README lists it as untested
      - scripts/capture-trays.js prints a printer's slots once, the AMS trays, the external holder and the slots the running print reports, and scripts/list-files.js lists its storage over FTPS
      - The test suite runs on node:test and covers public/ for the first time
      - The Docker files live in docker/: the Dockerfile, the one of the old image name, and four Compose files, one each for the :latest image, the :dev image, a build from the checkout and a stack together with Spoolman, with a README that says which is which. The docker-compose.yml in the repository root is gone; a checkout that was started with docker compose up from the root takes -f docker/compose.yml now, and every Compose file puts its volumes under docker/data/ next to itself
      - The release notes of every version carry the merged pull requests grouped by the label they were given, configured in .github/release.yml, with the breaking ones first. The release body opens with that list and ends with the changelog section, rather than burying the list under sixty lines of prose
      - The printer runtime object in src/printers.js declares every field the code assigns to it. One reader for a spool's tag, one sentence table for a refused, timed out or unreachable connection, one FTPS login, one retry limit check, one Spoolman monitor and one JSON file store behind the assignments, the learned presets, the print starts and the API keys; each was two to five copies. Thirteen exports nobody imported are plain functions again
      - The weight a slot carries to the dashboard has one meaning: amsWeight is what the AMS reads off the RFID tag, and the dashboard reads Spoolman's weight off the linked spool itself
      - Web UI: the toast after an action is styled by a class, the event handler in frontend.js is indented like the rest of the file, and the logs page and the menu parse their inputs once

-----------------------------------------------------------------------------------------------
Version 1.2.1
   - Bugfixes:
      - Fix: 3rd party spools (no RFID chip) with tray_weight=0 were incorrectly displayed as "Empty" instead of "Loaded (3rd party)"
         - 3rd party spools have no RFID chip and therefore always report tray_weight=0, which caused them to match the empty-slot detection introduced in v1.2.0
         - The empty-slot detection now additionally checks that tray_type is empty, which correctly distinguishes truly empty slots from loaded 3rd party spools
-----------------------------------------------------------------------------------------------
Version 1.2.0
   - New Features:
      - New ENV SET_LOCATION: automatically syncs the spool location in Spoolman with the current AMS slot (e.g. "Bambu Lab P1S - A0") when a spool is detected
         - Disabled by default, enable with SET_LOCATION=true

   - Bugfixes:
      - Fix: Empty AMS slots reported by the printer with N/A values (tray_uuid, tray_sub_brands, tray_color) and tray_weight 0 were incorrectly displayed as "Loaded (3rd party)" instead of "Empty"
         - The slot detection now distinguishes between truly empty slots (tray_weight = 0 + N/A values) and actual 3rd party spools (N/A values but with a valid weight)
-----------------------------------------------------------------------------------------------
Version 1.1.1-dev
   - Changes:
      - Better handling for multiple AMS-HT 
      - New option to stop/start monitoring AMS for each printer
         - possible via switch on WEB UI and via API Call
           (e.g. curl -X POST http://IP_FROM_SERVVICE:PORT/api/printer/PRINTER_ID/monitoring/stop and start)
         - Home Assistant Addon to get state from toggle switch and also use this switch to toggle monitoring
-----------------------------------------------------------------------------------------------
Version 1.1.0
   - Changes:
      - Replaced MQTT subscription in debug-printers from mosquitto_sub to an external Node.js solution. No certificate is needed anymore (this solves issues with Bambulab P2S printers that don't provide a Root CA).
      - Enhanced logging to also capture startup and crash errors that were previously not logged by the app.
      - Improved calculation of remaining filament for spools with capacities other than 1000 grams.
      - Improved handling of the last log line.
-----------------------------------------------------------------------------------------------
Version 1.0.9
   - Changes:
      - Switched printer accessibility check from ping to TCP Port check.
      - Enhanced logging to improve the chronological order.
      - Display only the last 250 lines of the log on the web interface. Include an option to download the complete log via a dedicated Download button.
      - Handling for Spool Updates for Spoolman and the web UI is now separate and not combined for all spools/trays.
      - Removed the Header from the logs (Header for AMS A, B, C with humidity and temp). Now, only the slots and the most recent information will be displayed.
-----------------------------------------------------------------------------------------------
Version 1.0.8
   - Changes:
      - Changed the maximum possible amount of connected AMS-HT to a single printer to 8
-----------------------------------------------------------------------------------------------
Version 1.0.7
   - Bugfixes:
      - Fix false labeling for AMS HT 
         - Normally, all AMS units are assigned a letter from A to D based on their IDs.
           The AMS-HT units originally received the IDs À, Á, Â, and Ã, each followed by an increasing number.
           Since the AMS-HT only has one slot, it does not require an increasing number and is now labeled as HT-A, HT-B, HT-C, and HT-D.
      - Fix wrong remaining weight for spools smaller than 1kg
         - The estimated remaining filament is based on the assumption of 1kg spools.
           However, Bambu also applies these estimates to spools smaller than 1kg, which results in inaccurate measurements

   - New Features:
      - The table layout has been updated. Now each AMS has its own table for a better overview.
-----------------------------------------------------------------------------------------------
Version 1.0.6
   - Spool updates are now only triggered when AMS tray data changes, not when temperature, humidity, or other unrelated values change.
-----------------------------------------------------------------------------------------------
Version 1.0.5
   - Bugfixes:
      - Fix Bug that new Spools throw this error: Cannot read properties of undefined (reading 'toLowerCase')

   - New Features and ENVs:
      - Added a optional feature to prevent merging an existing empty spool if it has a tag, by introducing a new ENV called NEVER_MERGE_IF_TAG wich will be disabled by default.
      - Added a new ENV called SPOOLMAN_ENDPOINT for better backend handling. This will deprecate the ENVs SPOOLMAN_IP, SPOOLMAN_PORT, and SPOOLMAN_SUBFOLDER.
-----------------------------------------------------------------------------------------------
Version 1.0.4
   - Bugfixes:
      - The footer now has a background to prevent it from overlapping the table or other parts of the website.
      - Fixed an error when creating or reading server and printer logs.
      - Scrolling through logs on the web was not possible due to automatic scrolling back to the bottom on refresh.
      - Fixed the bug that prevented merging an empty spool with a new one and its associated tag 

   - New Features:
      - Added a background connection check and reconnection logic for Spoolman.
      - Introduced a new "State" column to indicate whether the data has been processed correctly. If not, an action button allows users to view an info dialog. This helps in cases where AMS data does not match official BambuLab data (e.g., incorrect color codes).
         - ✅ (Checkmark) → Spools recognized correctly and can be processed.
         - ⚠️ (Warning) → Empty slot or non-BambuLab spool loaded.
         - ❗ (Error) → Filament check failed for BambuLab spools.
      - Added support for relative URLs.
      - Added support for Spoolman running in a subfolder.
      - Added support for processing and using multicolor filament and spools.
      - Added a link to Spoolman integration and support for FQDN with HTTPS.
      - Added icons for connection status.
      - If the log displays ‘No new AMS data or changes in Spoolman found…’, only the timestamps will be updated to provide a clearer view
      - The material from a non-BambuLab spool is now shown in the table on the Web-App and in the logs
   
   - New Environment Variables (ENVs):
      - SPOOLMAN_SUBFOLDER → Set this if Spoolman is running in a subfolder.
      - SPOOLMAN_FQDN → Use this to access Spoolman via a web link in the footer or from the button "Go to Spoolman" from "Show Info!" dialog (e.g., http(s)://spoolman.your.domain or http(s)://your.domain/spoolman).
-----------------------------------------------------------------------------------------------
Version 1.0.3
   - Fix Dockerfile that does not contain the script command
-----------------------------------------------------------------------------------------------
Version 1.0.2
   - Added a script for the command line to check the main functionalities of the stored printers
      - connect to your internal docker container like this: docker exec -it NAME_OF_YOU_CONTAINER /bin/sh
        now execute the command "debug-printers"
   - Fixed multiple creations of filaments and spools
   - Fixed false merging of spools if there are multiple spools loaded with the same filament and different serials
   - Fixed error: Cannot read properties of undefined (reading 'extra')
   - Changed color field behavior: all materials will not be displayed in color field
   - Fixed Dockerfile to properly create the log directory, preventing the following error: 'Failed to read log file for printerId'
   - Fixed loosing connection and reconnection problems
-----------------------------------------------------------------------------------------------
Version 1.0.1
   - Added footer to Main Menu
   - Changed color filed behavior: remove "Support for..." and "For AMS" from color field
   - Changed data display behavior in Main Menu
      - From now on, the displayed data will be read from the spool of Spoolman instead of using the external filament database as a source.
        This means that the filament can also be adjusted if there are any problems or errors
   - Fixed incorrect MQTT connection status that showed 'disconnected' after one disconnect and successfull reconnect.
-----------------------------------------------------------------------------------------------
Version 1.0.0
   - Offical Release
   - Features:
      - Real-time AMS filament status updates for all possible AMS on one printer (max. 4)
      - Multiple Printer Support
      - Synchronizes spool usage with Spoolman
      - Lightweight Docker container for easy deployment
      - Web UI for manually merge or create Spools with collected data
      - Automatic Mode for automatically merge or create Spools with collected data

   - Changes from last pre release:
      - Add environment variable TZ to set the timzezone in your container
      - Remove environment variables SHOW_LOGS_WEB (integrated in seperate Site)
      - Add Button for access logs from the backend
      - Add extra site to handle backend logs
      - Empty Slots are now displayable
      - Slots that loaded 3rd party Filament are also shown but have no function
      - Special treatment for Bambu Lab Support Filament
      - minor bugfixes (reconnection error, handle recognized negative filament)
-----------------------------------------------------------------------------------------------
Pre release versions are not tagged
----------------------------------------------------------------------------
