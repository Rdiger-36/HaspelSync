# Web UI

[← Documentation](README.md)

Reachable on `http://<host>:4000`. It asks for a password only if one is set under **Network access**, see [Settings](settings.md).

The dashboard shows the running print, its layer progress, and every loaded spool joined with what the print needs from it: what is on the spool, how much this print takes, and what is left afterwards.

![Dashboard](images/dashboard.png)

On a phone each unit is one card, with that header on top and its slots as sections inside it. Above each unit's table stands what the unit reports about itself: which unit it is, the relative humidity inside it, its temperature, and, while a drying cycle runs, its target temperature and the minutes left. The name is the one the printer gives in its module list, which the service asks for on every connection: **AMS**, **AMS Lite**, **AMS 2 Pro** or **AMS HT**. The status report itself cannot tell them apart, an original AMS on current firmware sends the same fields as a 2 Pro, dryer fields included. Until the answer arrives a single slot unit reads **AMS HT** and everything else plain **AMS**. Which readings appear depends on the model. An AMS 2 Pro and an AMS HT report all of it. The original AMS and the AMS Lite report only the five step humidity level, 1 being the driest, and have no temperature sensor. The AMS Lite has no humidity sensor either and always reports 5, so take that level for what it is. The external spool holder reports none of it; its header carries the name alone. Every header folds its unit away on a click and back on the next, with the chevron at its right end saying which way: a folded unit is one slim line with a swatch per loaded slot, so what is in it is seen without opening it. Which units are folded is kept per browser and printer, and a refresh leaves them as they are.

Under each spool stands whether its consumption can be booked:

| Marker | Meaning |
| :---- | :---- |
| **tag-linked** | An original Bambu Lab spool, linked through the `tag` extra field. Booked automatically |
| **assigned** | Linked by hand to a Spoolman spool. Booked onto that spool |
| **auto-assigned** | Linked by the service to the only spool in Spoolman of that material and colour without a tag, see below. Booked onto that spool. **Unassign** and pick another if it is the wrong one |
| **not tracked** | Nothing links this slot to Spoolman yet. The print runs, but nothing is booked. Use **Assign Spool** |

**Assign Spool** offers both ways of linking a slot the printer cannot identify. Picking a spool that already exists in Spoolman, which opens on the ones that fit the slot, same material and closest colour first, and searches the rest by name, vendor, material or location. When exactly one spool without a tag has the slot's material and colours, it is picked in advance, so the usual case is one click:

![Assign an existing spool](images/assign-dialog.png)

A spool of another material can still be chosen, and says so: the material a slot reports can be wrong, and only you know what is really in there.

Or creating filament and spool right there, filled in from the SpoolmanDB catalogue: manufacturer, then material, then the filament itself. Picking one fills in the colours, the density, the diameter, the temperatures and both weights, none of which a chipless spool reports. A filament that already exists in your Spoolman is used instead of created a second time, and multi colour spools are entered as what they are, one row per colour plus the direction they run in:

![Create a spool for a slot](images/assign-dialog-create.png)

A spool without an RFID tag reports nothing that identifies it: only the material and the colours set for its slot, and the preset somebody chose for it on the printer or in the slicer. Two spools of the same material and colour cannot be told apart by anything the printer sends, so the service never guesses between them. **Assign 3rd party spools automatically** in the settings, off by default, makes it act where there is nothing to guess: exactly one spool in Spoolman of that material and those colours, without a tag, and assigned to no other slot. That spool is assigned as soon as the slot is read, marked **auto-assigned**, and the assignment is dropped like a manual one when a different filament shows up in the slot. With two such spools the slot stays **not tracked** until one is picked. Nothing is ever created in Spoolman by this.

A print sliced with **Use Multicolor with External** in Bambu Studio runs every filament from the external spool holder, and the printer stops at each change for the spool to be swapped by hand. The printer goes on reporting the first spool for the whole print, and its screen offers no way to say which one is loaded, so the dashboard asks instead: under the **External** row each filament of the print gets a row of its own with what it needs and a **Choose spool** button, which opens the same picker with the filament's colour from the sliced file first. Each filament is booked on the spool chosen for it and on nothing else, not on the spool assigned to the holder. The choice can be changed until the print ends. A filament still without a spool then waits: the print card says how many do, the report marks them **Waiting for a spool**, and choosing a spool there or on the dashboard books it straight away, until the next print starts.

Clicking the filament name of a slot opens what Spoolman and the printer each hold about it. Remaining weight, lot number and comment are corrected in place, each behind a pencil in its row. The remaining weight stays read only while something else is about to write it, in legacy mode and while a print is running, and it cannot be set above what the spool can hold:

![The spool behind a slot](images/spool-dialog.png)

The second tab carries the filament behind the spool, shared by every spool of its kind and therefore edited in Spoolman itself. Both tabs link to their Spoolman page:

![The filament behind a spool](images/spool-dialog-filament.png)

In manual mode the merge and create actions of a Bambu Lab spool work the same way: a button per slot, opening a dialog with what would be written to Spoolman.

The same bar sits on every page and carries three things: who this is, where you can go, and your session. Left the HaspelSync logo and name, which lead back to the dashboard, then **Dashboard** and **Logs** as tabs with the one you are on underlined; right the dark and light mode switch and the gear. The gear is the [settings](settings.md) page; once a [password](settings.md#the-web-ui-password) is set it opens a small menu instead, with the settings page, **Log out** and, at its foot, the version and the release that is available when a newer one exists. The Web UI is English until another language is picked in the **Web UI** card of the settings page, and the choice is kept per browser; each language is listed in the one shown with its code, "German (DE)" or "Deutsch (DE)". Log lines and everything the API hands out stay English. How to add a language is in the [README](../README.md#translations). **Logs** lists the server log and one entry per printer, by name, so the log you open is the one you picked rather than the one belonging to whichever printer was selected last. On a phone Dashboard and Logs fold into one **Menu** button next to the logo and name, underlined like a tab while one of them is open; the gear stays in the bar. The [API page](api.md) is not in the bar; it opens from the API keys on the settings page.

What the page is showing is picked in the page. The dashboard headline names the printer and the log viewer names the log, and that name is the control: click "Loaded Spools on Bambu P2S" in the head of the status card and the printers drop down. With a single printer there is nothing to pick and the name is plain text. The download of a log sits with the log for the same reason, above the box it belongs to.

![Menu](images/menu.png)

Logs are read per printer and for the server, across the rotated history, and can be downloaded:

![Logs](images/logs.png)

Every page follows the dark mode switch:

![Dashboard in dark mode](images/dashboard-dark.png)
