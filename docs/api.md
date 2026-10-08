# API

[← Documentation](README.md)

Everything the Web UI does, it does over this API, and a script, a home automation or the [Home Assistant integration](https://github.com/Rdiger-36/ha-bambulab-ams-spoolman-filamentstatus) can do the same. Every route answers JSON, a failure as `{ "ok": false, "error": "..." }` with a 4xx or 5xx status, and the ones that hand out a file or a stream of events say so below.

## Who may call it

Two kinds of caller: the Web UI of this installation, and a request carrying an [API key](settings.md#api-keys). Without a Web UI [password](settings.md#the-web-ui-password) a request the browser marks as the Web UI's own passes as it is; once a password is set, the Web UI needs the session `POST /api/auth/login` hands out, and a request without one is answered with 401 like any other. Anything else is answered with 401 and a sentence saying so. Only the three login routes are open.

Before any of that, every request passes the request guard configured in the **Network access** card of the settings page: a `Host` header that is not on the allowed list, or a request that changes something and comes from another origin, is answered with 403, the login routes included.

The key travels in a header, never in the URL:

```bash
curl -H "Authorization: Bearer ams_..." http://192.168.1.50:4000/api/printers
curl -H "X-API-Key: ams_..." http://192.168.1.50:4000/api/printers
```

A key is a full session. It reads and changes everything the Web UI can.

## The API page

The **i** next to **API keys** in the **Network access** card of the settings page opens the API page, and **Back to the settings** at its top leads back to that card. It lists every route, grouped the way this page groups them, and each one opens into a form:

- The path and query parameters as fields. A serial number is prefilled with a printer of this installation, so the first click sends something that exists.
- An example body for the routes that take one, as JSON to edit in place.
- **Send**, which sends the request from the browser and shows the status, the time it took, the headers and the answer. A route that downloads a file opens it in a new tab so the browser saves it, the event stream is followed live until **Disconnect**, and the routes that end the process or remove something ask before they send.
- A **curl** line under every request. The key typed at the top of the page goes into it, and only into it: the page itself is the Web UI and is already allowed to call the API, so the line is what to copy into a script as it will be run there.
- **Request and response shapes**: every field of the body and of each documented answer, with its type and what it means.

The bar at the top stays put while the list scrolls: a filter that narrows the list by path or description, the key field, and the buttons that expand or fold every route and open the document. Every route has a link of its own, `api.html#get-api-printers` for example, that opens it on load.

## The OpenAPI document

The page renders `GET /api/openapi.json`, an [OpenAPI 3.0](https://spec.openapis.org/oas/v3.0.3) description of every route with its parameters, bodies and answers. The same document imports into Swagger UI, Postman, Bruno, Insomnia or a client generator, which is why it is a standard format rather than something only the page could read. Like every other route it needs the Web UI or a key:

```bash
curl -H "Authorization: Bearer ams_..." http://192.168.1.50:4000/api/openapi.json > openapi.json
```

It is written by hand in `src/openapi.js`, next to the routes, and a test holds it to the routes the service registers in both directions, so a route without a description does not get in.

## Slot labels

A slot is named the way the printer names it: `A1` is the first slot of the first AMS unit, `D4` the last slot of a fourth unit, `HT-A` the first AMS HT, `External` the spool holder on the printer itself, and `External-2` the second holder of a dual nozzle printer. That label is what `amsId` carries wherever a slot is addressed, and what the Spoolman location of a spool ends in.

## Live updates

`GET /api/events` is a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream for every printer at once. The `data:` field of every event is a JSON document whose `type` says what happened and whose `printer` names the serial number it is about; `printers_update` and `settings_update` are about the installation and carry no `printer`:

| Type | When | Carries |
| :---- | :---- | :---- |
| `slot_update` | A slot changed | `spool`, the slot as `GET /api/spools/{printerId}` lists it |
| `status` | The printer reported | `lastMqttUpdate`, `lastMqttAmsUpdate` |
| `refresh` | The first AMS report of a connection was processed; the dashboard reloads its lists | |
| `ams_env` | Humidity, temperature or drying changed, at most every 30 seconds | `amsEnv`, one entry per unit |
| `monitoring_update` | Monitoring was paused or resumed | `enabled` |
| `printers_update` | A printer was added, changed or removed | |
| `print_result_cleared` | The finished print was cleared from the dashboard | |
| `settings_update` | The settings were saved | `values` |

```bash
curl -N -H "Authorization: Bearer ams_..." http://192.168.1.50:4000/api/events
```

## Every route

What follows is the list the page shows, in short. The parameters, the bodies and the shapes of the answers are on the page and in the document.

### Login

The Web UI password. A script sends an API key instead and never needs these.

| Route | Does |
| :---- | :---- |
| `GET /api/auth/state` | Whether a password is set, and whether this request is logged in (no key needed) |
| `POST /api/auth/login` | Log in with the Web UI password (no key needed) |
| `POST /api/auth/logout` | End the session of this browser (no key needed) |

### Printers

The printer list, as the settings page edits it.

| Route | Does |
| :---- | :---- |
| `GET /api/printers` | The printers, by serial number and name |
| `POST /api/printers` | Add a printer |
| `GET /api/printers/config` | The printers with address and connection state |
| `PUT /api/printers/{printerId}` | Rename a printer or change its address or access code |
| `DELETE /api/printers/{printerId}` | Remove a printer |
| `PUT /api/printers/{printerId}/logdetail` | Set how much this printer writes to its log |
| `POST /api/printers/reconnect` | Rebuild the MQTT connection of every monitored printer |
| `POST /api/test/printer` | Test the MQTT and FTPS connection to a printer |

### Status

What the dashboard shows: connection state, slots, the running print, and the live stream behind it.

| Route | Does |
| :---- | :---- |
| `GET /api/status/{printerId}` | The connection state of a printer and of Spoolman, and the slot whose filament is in the printing nozzle |
| `GET /api/spools/{printerId}` | Every slot of a printer, with what is in it, what the tag and the printer's filament table say about it, and what Spoolman holds for it |
| `GET /api/print/{printerId}` | The running or last print: state, progress and consumption per slot |
| `POST /api/print/{printerId}/clear` | Clear the finished print from the dashboard now |
| `PUT /api/print/{printerId}/filament/{index}` | Name the spool a filament swapped onto the external holder came from, booked at once after the print |
| `DELETE /api/print/{printerId}/filament/{index}` | Take that spool back while the print runs |
| `GET /api/events` | Live updates as Server-Sent Events (SSE stream) |

### Monitoring

Pausing and resuming the connection to a printer, per printer or for all of them.

| Route | Does |
| :---- | :---- |
| `POST /api/printer/{printerId}/monitoring/start` | Resume monitoring a printer |
| `POST /api/printer/{printerId}/monitoring/stop` | Pause monitoring a printer |
| `POST /api/monitoring/{action}` | Resume or pause monitoring of every printer at once |

### Slot actions

The three Spoolman writes the dashboard offers per slot in manual mode.

| Route | Does |
| :---- | :---- |
| `POST /api/mergeSpool` | Link the spool in a slot to the matching Spoolman spool |
| `POST /api/createSpool` | Create a Spoolman spool for a slot from an existing filament |
| `POST /api/createSpoolWithFilament` | Create filament and spool for a slot from the SpoolmanDB catalogue |

### Assignments

Linking a slot the printer cannot identify to a Spoolman spool, which is what makes its consumption bookable.

| Route | Does |
| :---- | :---- |
| `GET /api/mappings/{printerId}` | The slot assignments of a printer |
| `PUT /api/mappings/{printerId}/{amsId}` | Assign a Spoolman spool to a slot |
| `DELETE /api/mappings/{printerId}/{amsId}` | Remove the assignment of a slot |
| `POST /api/thirdparty/spool/{printerId}/{amsId}` | Create a spool for a slot and assign it in one step |

### Spoolman

What the dialogs read from Spoolman and the SpoolmanDB catalogue, and the spool fields edited in place.

| Route | Does |
| :---- | :---- |
| `GET /api/spoolman/spools` | Every spool in Spoolman, as Spoolman answers it |
| `GET /api/spoolman/spool/{id}` | One spool in Spoolman, the whole record |
| `PATCH /api/spoolman/spool/{id}` | Correct the remaining weight, lot number, comment or archived flag of a spool |
| `GET /api/spoolman/lookups` | What the create spool dialog picks from: vendors, materials, locations, filaments |
| `GET /api/spoolman/external/filaments` | Search the SpoolmanDB catalogue |
| `POST /api/test/spoolman` | Test a Spoolman address |

### Settings

The runtime configuration, stored in printers/settings.json.

| Route | Does |
| :---- | :---- |
| `GET /api/settings` | The runtime configuration with its schema |
| `PUT /api/settings` | Change settings |

### API keys

Keys for callers that have no browser to log in with. A key is a full session.

| Route | Does |
| :---- | :---- |
| `GET /api/apikeys` | The API keys, without the keys themselves |
| `POST /api/apikeys` | Create an API key |
| `DELETE /api/apikeys/{id}` | Revoke an API key |

### Logs

The log and the raw MQTT trace of each printer, and the server log.

| Route | Does |
| :---- | :---- |
| `GET /api/logs/{printerId}` | The last lines of a log |
| `GET /api/logs/download` | Download several logs as one zip (download) |
| `GET /api/logs/{printerId}/download` | Download a log with its rotated history (download) |

### Service

Facts about the installation, the update check, the support bundle, the restart, the notices the dashboard shows, and this document.

| Route | Does |
| :---- | :---- |
| `GET /api/system` | Facts about this installation |
| `GET /api/update` | Whether a newer release exists on GitHub |
| `GET /api/diagnostics/download` | Download the support bundle (download) |
| `POST /api/restart` | Restart the service |
| `GET /api/notices` | The notices the dashboard may show |
| `POST /api/notices/{id}/ack` | Dismiss a notice |
| `GET /api/openapi.json` | This document |
