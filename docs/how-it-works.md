# How it works

[← Documentation](README.md)

The printers publish their state via MQTT, this service listens and talks to Spoolman through its API.

From what the printer reports about its slots, the AMS units and the external spool holder alike, it can:

- **Merge spools**: a spool in a slot whose material, colour and remaining weight match a spool in Spoolman that carries no tag is merged with it. The serial number of the detected spool is written into the spool's extra field `tag`, which links the two from then on.
- **Create spools**: a detected spool with a matching registered filament in Spoolman, but no spool, gets one created, tag included.
- **Create filaments and spools**: with no matching filament either, the filament is imported from the SpoolmanDB, registered, and the spool created on top of it.

## G-code tracking

While a print is running, the sliced `.gcode.3mf` is downloaded from the printer via FTPS and the needed grams per filament are read from it. When the print reaches a final state, that amount is booked onto the matching Spoolman spool; a cancelled or failed print is booked proportionally to the layers that were actually printed.

Because the numbers come from the slicer and not from the RFID chip, this works for 3rd party spools as well. Those carry no chip, so the printer cannot say which spool is loaded: link the slot to a Spoolman spool once in the Web UI and the consumption of that slot is booked onto it. The dialog offers both, picking a spool that already exists in Spoolman and creating filament and spool right there. The form starts from what the AMS does report, material and colour, and fills density and temperatures from Spoolman's material catalogue; manufacturers, materials and locations are pick-or-type and a value that does not exist yet is created on save. Full weight and remaining weight have to be entered by hand, a chipless spool cannot report them.

The link is dropped automatically as soon as a different filament is detected in that slot. It also resolves the rare case of two loaded spools that are identical in material and colour, which the RFID tag alone cannot tell apart.

Two things follow from booking per print rather than per report:

- **A slot needs a link before its consumption can be booked**, either the tag of a Bambu Lab spool or a manual assignment. A filament the print uses from a slot that has neither is named in the log and skipped, so it is visible which spool is missing its link rather than silently going untracked.
- **Filaments swapped onto the external holder by hand are booked per filament.** A print sliced with "Use Multicolor with External" sends every filament to the holder, and the printer reports neither the swaps nor which spool was loaded. Each of those filaments is booked on the spool named for it in the Web UI, during the print or after it, and never on the spool assigned to the holder, see [the dashboard](web-ui.md).
- **Nothing is written to Spoolman while a print runs.** The whole amount is booked when the job reaches its final state, so a spool in Spoolman stands still during the print and then jumps. The Web UI shows the progress in the meantime, per spool in the columns "On spool / total", "Needed" and "After print".

The download needs LAN access to the printer on port 990 (FTPS) with the printer's access code, the same code MQTT already uses. Without it the print is logged as running but nothing is booked.

## Operation modes

| Mode | Behaviour |
| :---- | :---- |
| `automatic` | Merging and creating happen on their own, no interaction needed |
| `manual` | Every merge or creation waits for a click in the Web UI (default) |

Example of a merge in automatic mode:

```bash
 [A1] PETG HF 000000FF (18%) [[ A012456878ABCDEF ]]
    Found mergeable Spool => Spoolman Spool ID: 1, Material: PETG HF, Color: HF Black
    Spool successfully merged with Spool-ID 1 => HF Black
```

From then on the slot is linked and the consumption of every print is booked onto that spool.

## Slot names

| Slot in log | Slot on the printer | Slot in log | Slot on the printer |
|--------------|----------------------|--------------|---------------------|
| `A1` – `A4` | first AMS, slot 1 – 4 | `B1` – `B4` | second AMS, slot 1 – 4 |
| `HT-A` | first AMS HT | `HT-B` | second AMS HT |
| `External` | external spool holder | `External-2` | second holder of a dual nozzle printer |

Continues up to `D4` for the normal AMS (max. 4 per printer) and up to `HT-H` for all connected AMS HT. The external spool holder is reported outside the AMS block and has no slot number of its own, so it is one slot named `External`. A dual nozzle printer (H2C, H2D, X2D) has two holders: `External` feeds the first extruder and `External-2` the second.

## Archiving empty spools

Off by default. **Settings → Synchronisation → Archive empty spools** archives a spool in Spoolman as soon as it runs empty, so a used up spool leaves the inventory without being deleted. **Empty threshold** (collapsed, advanced) says how many grams left still count as empty; zero by default.

What counts is the weight Spoolman holds after this service wrote to it: the consumption booked at the end of a print, or, in legacy mode, the weight derived from the RFID reading. The AMS remain percentage is never the trigger on its own. It is an estimate and reaches 0 % while there is still filament on the spool, which is why the default threshold is the weight itself rather than the percentage.

Nothing is deleted. An archived spool can be restored in Spoolman, or in the spool dialog of the Web UI, which archives and restores by hand in the same row.

A spool archived while it is still in its slot keeps being recognised by its RFID tag. The slot then reads **Loaded (archived)** and offers no action until the spool is taken out or restored, so the automatic mode cannot create a second record for it.
