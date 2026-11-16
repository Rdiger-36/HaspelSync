# Printer reports

One full MQTT report per file, as a Bambu Lab printer sends it on
`device/<serial>/report`: the `pushall` answer, which is a complete `print`
block, and the `get_version` answer with the printer's module list.

They are copied verbatim from the `pybambu/mock_data` directory of
[ha-bambulab](https://github.com/greghesp/ha-bambulab), the Home Assistant
integration for Bambu Lab printers, at commit
[`088e8bb`](https://github.com/greghesp/ha-bambulab/tree/088e8bb0fcd7bc8cf07dcaf8800e8f5be63cdf16/custom_components/bambu_lab/pybambu/mock_data)
of 2026-09-01. Serial numbers were already redacted there. ha-bambulab is
published under the MIT License, Copyright (c) 2023 ha-bambulab contributors;
the full text is in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

`p1s.json` is the exception: it is not from ha-bambulab but from the raw MQTT
trace a user attached to issue #131, captured with 1.3.0-dev.13 on 2026-09-06.
Serial numbers, RFID tags and the job name are masked in it, and next to the
`pushall` it carries a `deltas` list with one of the delta reports the printer
sends between two full ones, which is what that issue was about.

`h3c.json` is not from ha-bambulab either: it is the first report of the raw
MQTT trace a user attached to issue #262, captured with 1.3.7 on 2026-11-16
while a print was running. All 86 reports of that trace are full ones with
identical AMS data, so one of them stands for all. Serial numbers, RFID tags,
the last octet of the printer's address and the job name are masked in it.

Nothing else in them is edited. The value of a fixture is that it is what the
printer really sent, and most of these printers are not on anybody's desk
here: they answer questions the P2S this project is developed against cannot.

| File | Printer | What it shows |
| :--- | :--- | :--- |
| `a1.json` | A1 with AMS Lite | No `humidity_raw`, `temp` is `"0.0"`, the holder is a single `vt_tray` with id 254, no `print.mapping`. User presets on two slots (`tray_info_idx` `P8d19ba6`) |
| `a2l.json` | A2L | A four slot unit reported as id 16 with `ams_exist_bits` `"1000"`, a 32 entry `print.mapping` of unused markers, the holder as `vir_slot` 255 |
| `h2c.json` | H2C, dual nozzle | Two holders, `vir_slot` 254 and 255, `stg_cur` -1 on a FAILED job, `print.mapping` with unused markers before the used slots |
| `h3c.json` | H3C, nine tool changer with an AMS 3H, from issue #262 | The AMS 3H as one unit with id 32 and nine trays, four of them loaded with Bambu Lab spools, drying zones in `zone_info` instead of unit readings, nine holders as `vir_slot` 247 to 255, all empty, `print.mapping` and `device.extruder.info[0].snow` both 8194 (unit 32, slot 2) while RUNNING |
| `h2d.json` | H2D, dual nozzle | Two AMS units, two holders, `print.mapping` `[259]` naming B4 while RUNNING |
| `h2d-external-active.json` | H2D, dual nozzle | Four AMS plus two AMS HT (128 and 129), both holders loaded, `print.mapping` `[65280]` naming the holder |
| `h2d-pro.json` | H2D Pro | One AMS plus one AMS HT, two holders, an empty `print.mapping` |
| `h2s.json` | H2S | One AMS, one holder, `print.mapping` `[0]` |
| `misc.json` | unknown | An AMS HT as the only unit, the holder as `vt_tray` 254 with a `GFL99` spool |
| `p1p-no-ams.json` | P1P without AMS | Empty AMS block, `stg_cur` 255 on a FINISH, the holder as `vt_tray` 254 with a Sunlu preset (`GFSNL08`) |
| `p1s.json` | P1S with a first generation AMS, from issue #131 | The holder as `vt_tray` with id 254 in the full report, and in `deltas` a report with the AMS block and no `vt_tray` at all, which read as an empty holder before the fix |
| `p2s.json` | P2S | The reference printer of this project, one AMS, `print.mapping` `[3]` |
| `x1c-multi-ams.json` | X1C | Three AMS plus one AMS HT, `ams_exist_bits` `"17"`, both `vt_tray` and `vir_slot`, `print.mapping` `[258]` |
| `x2d.json` | X2D | One AMS, two holders, `print.mapping` `[65535, 1]` |

`test/reports.test.js` runs every file through the ingest pipeline and holds
the list of what they found that is not handled yet.
