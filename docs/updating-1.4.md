# Updating to 1.4.0

[← Documentation](README.md)

1.4.0 follows 1.3.7. Most of what changed needs nothing from you: the container starts, finds its configuration and carries on. One thing can stop it on an existing installation, one thing has a deadline, and one is offered but never required. An installation still on 1.2.x reads [Updating from 1.2.x](updating.md) first, everything there applies on top.

## What can need you

### The data directories belong to the `node` user

The image runs as the unprivileged user `node`, uid and gid 1000, instead of root, and nothing in the container runs as root any more, `docker exec` and `debug-printers` included. Everything the earlier images wrote into `/app/printers` and `/app/logs` belongs to root, and the new image cannot write there.

- **A Linux host or a NAS with bind mounted directories** hands them to that user once, on the host:

  ```bash
  sudo chown -R 1000:1000 <printers directory> <logs directory>
  ```

  Until then the container stops on start, and `docker logs` names the directories and this command, rather than failing on the first save. See [troubleshooting](troubleshooting.md#the-container-stops-cannot-write-to-the-data-directories).
- **Docker Desktop on macOS and Windows** needs nothing, a folder shared from the host is writable for every user in the container. Only a folder inside the WSL file system follows Linux permissions, and the same command is run in the WSL shell there.
- **A named volume** needs nothing.
- **Another user** is set with `user: "UID:GID"` in the Compose file or `--user UID:GID` on `docker run`, and the directories then belong to that user instead.

### The old image name ends with 1.5.0

The image is `ghcr.io/rdiger-36/haspelsync`. The old name `ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus` receives its last release before 1.5.0, from 1.5.0 on every version is published under the new name only. An installation that still pulls the old name stops getting updates then, without an error.

- Switch the image in `docker run` or in the Compose file. The configuration and the volumes stay as they are.
- A container that runs from the old name says so in its log, in a dialog on the dashboard and under **System** on the settings page, each naming the version it ends with. `/api/notices` carries that version as `stopsAt` in `legacy-image`, `/api/system` as `imageStopsAt`.

## What is offered

### Native Spoolman tags

Spoolman 0.27.0 and newer holds the tag of a spool natively, and a spool created or merged against such a Spoolman gets the serial number of its RFID chip as a native tag. A native tag belongs to one spool only, so two records can no longer claim the same physical spool.

- **Nothing has to be done.** The extra field `tag` is still read, a spool linked before is recognised exactly as it was, and an older Spoolman is linked through the extra field as before.
- **The migration is optional.** The **Spool tags** card in the Spoolman section of the settings says how many spools carry their tag only in the extra field, and **Migrate now** gives each of them the native tag. The extra field stays in place, so the migration can be repeated. The dashboard offers it once, the first time it finds spools to migrate.
- **Also write extra.tag**, on by default, keeps writing the extra field for the tools that still read it. **Clear extra fields** empties it once every spool is migrated and that switch is off. Nothing needs it, the field can stay for good. See [Spool tags](settings.md#spool-tags).

## What books differently

Nothing to do here, but a print can now end up on a different spool than it would have before:

- **A slot the printer names is the only one considered.** A filament printed from a slot without an assigned or tag-linked spool is skipped, and the print summary asks for an assignment. Before, the grams went to another slot with the same profile and colour, so with two identical spools loaded and only one assigned, the assigned one paid for both.
- **An AMS refill on an A1 or a P1 is split** between the spool that ran out and the backup spool, as on the other printers since 1.3.4. A refill onto a slot the same job prints other parts from cannot be told from a colour change yet and is still booked on the spool that ran out.
- **The assignment of a spool a refill ran empty is released** at the end of the print, so the next spool of the same filament in that slot is not booked on the empty one. A spool taken out by hand keeps its slot as before.

The full list of what changed is in the [CHANGELOG](../CHANGELOG.md).
