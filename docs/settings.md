# Settings

[← Documentation](README.md)

Everything is stored in `printers/settings.json` and applied to the running service as soon as it is saved, unless a field says otherwise.

![Settings](images/settings.png)

The page is split into sections, listed in a navigation card at the left; on a window narrower than about 1000 px the card becomes a row above the content. The section is part of the address, `settings.html#access`, so a link lands on the right one. One save covers every section: a section with unsaved changes carries a green dot in the navigation, and the save bar names it.

| Section | Holds |
| :---- | :---- |
| **Printers** | Add, edit and remove printers, each with a connection test for MQTT and FTPS, and the **Printer connection** card: offline check interval, the backoff limit for a printer that stays offline and the retry limit |
| **Spoolman** | Endpoint, plus host, port, subfolder and public URL in a collapsed section. The line under the field says which URL the service actually talks to |
| **Tracking** | Operation mode, whether a [3rd party spool is assigned automatically](web-ui.md), **Clear print result after**, the minutes a finished print stays on the dashboard before the card returns to idle (ten by default, 0 keeps the result until it is cleared by hand), and [legacy mode](legacy-mode.md). Below it the **Synchronisation** card: slot update interval, writing the slot as the spool location, with the template it is written in (**Location format**, `{printer} - {slot}` by default; `{printer}` is required, `{unit}` names the AMS unit, so `{printer} AMS {unit}` gives the four spools of a unit one location), never merging a tagged spool, [archiving empty spools](how-it-works.md#archiving-empty-spools) |
| **Logging** | Log file size and how many rotated files are kept, for the server and per printer, plus **Log detail...**: the [log level, the areas and the raw MQTT capture](troubleshooting.md#how-much-gets-logged). The same dialog per printer, **Log** in the Printers card, also [exports that printer's logs](troubleshooting.md#diagnostics-and-privacy) |
| **Access** | The Web UI password, the host names this service may be addressed under, and the API keys for callers that have no browser. All three are empty by default: without a password the Web UI is open to the network, and IP addresses, `localhost` and `.local` names are accepted whatever the host list says |
| **Web UI** | The language and the theme of the pages. Choices of this browser rather than of the installation: they apply at once, are kept in the browser and never reach `settings.json`, so two people on two phones can read the same installation in two languages |
| **System** | Version, Node, platform, uptime, memory, the tracking mode the process actually runs in, the supervisor state and the Spoolman connection, and the actions on the running service |

A new printer connects right away, a removed one is disconnected and its assignments are dropped. Removing a printer, or changing its address or access code, asks first while a print is running, because the consumption of a running job is booked only when it ends. The serial number cannot be changed, it keys the MQTT topic, the log file and the assignments. **Test connection** checks MQTT on port 8883 and FTPS on port 990 with the values in the form, so an address can be verified before it is saved:

![Printer dialog](images/printer-dialog.png)

The access code is stored on the server and never sent back to the browser; leave the field empty while editing to keep the stored one.

**Log** next to a printer opens the same log detail dialog the **Logging** card offers, for that printer alone. It follows the global settings until **Follow the global settings** is switched off, and a star on the button marks a printer that no longer does. That is what lets one machine be turned up to `trace`, with its raw MQTT capture running, while the rest of the service stays quiet.

The **System** section is what a support question usually asks for first, plus the actions that work on the running service rather than on a stored setting:

![Service card](images/settings-service.png)

- **Restart service**: the container runs a small supervisor, so this works whether or not the container has a restart policy. While a print is running it asks first.
- **Reconnect all printers**: rebuilds the MQTT connections without ending the process, so the consumption tracking of a running print is kept.
- **Pause all monitoring**: nothing is processed and nothing written to Spoolman, for while Spoolman is being worked on.
- **Download diagnostics...**: see [Diagnostics and privacy](troubleshooting.md#diagnostics-and-privacy).
The card also says whether a newer release exists, checked against the GitHub releases: "Up to date, the latest release is 1.3.0.", or the version that is available with a link to its release notes. There is no button for it. Nothing is downloaded or installed and nothing about the installation is sent, it is one request for the latest version number, cached for six hours.

## The Web UI password

Type one into **Web UI password** in the **Network access** card and save. From then on every page and every API call asks for it first, and the browser stays signed in for 30 days. Leave the field empty and nothing changes: that is how every installation behaved before this existed, and it is still the right setting for a service only your own network can reach.

The password is stored as a scrypt hash in `printers/settings.json` and is never sent back to the browser, so the field says "unchanged" rather than showing anything. Typing into it replaces the password, **remove** next to the label takes it away again on the next save, and both take effect without a restart. Repeated wrong guesses from one address have to wait, doubling up to fifteen minutes.

Changing or removing the password ends every session that exists, on every device, because the cookie is signed with it. The browser that made the change keeps working, every other one asks again. **Log out** in the menu ends the session of that browser.

Forgotten it? Stop the container, remove the `AUTH_PASSWORD` line from `printers/settings.json`, start it again. The Web UI is then open until a new one is set.

Both the password and the host names can also be set from the environment before the first start, `AUTH_PASSWORD` and `ALLOWED_HOSTS` in the compose file, which is the way for a template or an add-on to ship an installation that asks for a password from its first page and answers under its domain name right away. The password is hashed as it is read in and never stored in clear. The environment only seeds a setting that `printers/settings.json` does not own yet: once the value has been saved there, the file wins and a changed variable is ignored, so a forgotten password is not undone by a new variable but by removing the line as above, and a host name that stopped working is added on the settings page or, if only the name reaches the service, under the IP address, which is always accepted.

> [!IMPORTANT]
> The Web UI asks for a password only once you set one under **Network access**. Without one it is open to everyone on the network and can change the printer list and the Spoolman endpoint, so do not expose the port to the internet either way. The access code of a printer is stored in plain text in `printers/printers.json` and is never sent back to the browser.
>
> Other websites cannot reach the API of an installation on your network: the service answers only requests addressed to it, and refuses a writing request that comes from another site. A Web UI reached under a real domain name or through a reverse proxy has to name that host under **Network access** as well.

## API keys

Home Assistant, Node-RED and a shell script have no browser to log in with, and a password typed into an automation is a password stored in clear text somewhere else. **Add key** under **API keys** in the **Network access** card creates one, under a name you pick so you know later which one to revoke.

The key is shown once, when it is created. Only a SHA-256 of it is stored, in `printers/apikeys.json`, so a lost key is replaced rather than looked up. Copy it into the tool that needs it and send it as a header:

```bash
curl -H "Authorization: Bearer ams_..." http://192.168.1.50:4000/api/printers
```

`X-API-Key: ams_...` works just as well, which is the header most home automations ask for by name.

What there is to call is on the [API page](api.md): every route with its parameters and a button that sends it, opened with the **i** next to the **API keys** heading, and as an OpenAPI document for Swagger UI or Postman.

A key is a full session: it reads and it changes everything the Web UI can, including the settings and other keys. There is no permission split, because an installation of this size has no two kinds of caller to separate. What a key does buy over the password is that each one can be revoked on its own, without signing anybody out and without the other keys noticing.

The list shows when each key was created and when it was last used, so a key nothing uses any more is easy to spot. The last use is written at most once a minute: a polling home automation would otherwise rewrite the file a few times a minute forever, and the column is there to say "still in use", not to be an access log.

The API answers only two kinds of caller, whether or not a password is set: the Web UI of this installation, and a request carrying a key. Anything else gets a 401 that says so. Without a password the pages themselves stay open to the network, exactly as before — it is `/api/` that asks.

That is a change from earlier versions, where an installation without a password answered every caller on the network. **A script, a home automation or an integration that called this API without a key stops working and needs one.** The [Home Assistant integration](https://github.com/Rdiger-36/ha-bambulab-ams-spoolman-filamentstatus) is the one to look at first.

How the Web UI is recognised is the `Sec-Fetch-Site` header the browser sets on every request a page makes, with the `Referer` as the fallback for browsers too old to send it. That is a fence, not a proof: anybody who can open the Web UI can read those headers off their own browser, or simply create a key. The proof is the password, which is a secret the caller has to hold. The fence is what keeps the key list an honest answer to "what is using this API".

Locked out of everything, keys included? Stop the container, delete `printers/apikeys.json` and remove the `AUTH_PASSWORD` line from `printers/settings.json`, start it again. The key file is read once at start, so editing it by hand takes effect on the next one.

Setting a password does not touch the keys. Every browser session ends, every key keeps working, so a key created while the Web UI stood open to the network still has full access afterwards. The settings page says so and names the keys when you turn the password on for the first time; revoke the ones you do not recognise before you do.

> [!NOTE]
> The key travels in a header on purpose, never in the URL. A URL ends up in the log of every proxy in front of this service, and a value a browser can put in a URL is one a page on another site could put there too. A header cannot be set on a cross site request without a preflight, which the request guard refuses, so a key cannot be used against you by a page you happen to have open.

## A printer that is switched off

Nothing has to be configured for a printer that is off most of the time. The monitor loop probes it with a plain TCP connect, and the wait between two probes doubles from **Offline check interval** up to **Offline backoff limit** (five minutes by default) for as long as it stays away. The log says so once per step and then goes quiet, instead of repeating the same line every twenty seconds all day, and it says when the printer answered again.

Setting the backoff limit to the check interval keeps the old constant pace.

Anything the user does clears the wait, so a printer switched back on is picked up at once rather than after the current backoff: resuming its monitoring, **Reconnect all printers**, and saving its address. Monitoring can also be switched off per printer, in the Web UI or over the API, which is what the [Home Assistant integration](https://github.com/Rdiger-36/ha-bambulab-ams-spoolman-filamentstatus) drives from a switch, with an [API key](#api-keys): nothing is probed at all while it is off.
