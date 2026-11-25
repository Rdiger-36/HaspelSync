# Installation

[← Documentation](README.md)

## Prerequisites

- A running Spoolman instance
- Serial number, access code and IP address of every printer
- LAN access to the printer on port **8883** (MQTT, AMS data) and **990** (FTPS, sliced file)
- On a P2S, an H2 series printer or an X2D: a USB stick in the printer for prints sent over the LAN. These printers only expose the stick over FTPS, and the sliced file of a print is read from it. Without a stick only a print sent through the cloud is tracked, its file downloaded from the job's cloud link, and the print card on the dashboard says "No USB stick or SD card in the printer" for as long as none is in, see [troubleshooting](troubleshooting.md#no-sliced-file-on-a-p2s-h2-or-x2d)
- How the printer is bound does not matter: cloud mode, LAN only mode and developer mode all work. Both ports above are served locally in every one of them, and nothing is read through the Bambu cloud
- "Update remaining capacity" turned on in Bambu Studio. The consumption itself comes from the sliced file, but the remaining weight the AMS reports is what a spool is matched against when it is merged into an existing Spoolman spool, and it is the only source [legacy mode](legacy-mode.md) has:

![Bambu Studio setting](https://github.com/user-attachments/assets/fe6cf018-b211-4fd6-8931-1c895842d71b) 

![Bambu Studio setting](https://github.com/user-attachments/assets/23c60d83-e5ed-41af-9fbc-24cc9dd8ede7)

## Supported architectures

Pulling `ghcr.io/rdiger-36/haspelsync:latest` retrieves the right image for your machine. The image was published as `ghcr.io/rdiger-36/bambulab-ams-spoolman-filamentstatus` before the project became HaspelSync; that name still receives every release up to the 1.4 line, but 1.5.0 and later are published under the new name only, so an installation that pulls it should switch. The old images stay available. A container started from the old name says so itself: in `docker logs` on every start, on the dashboard once after every start, and under **System** on the settings page for as long as it is true.

| Docker platform | Also known as | Supported | Typical hardware |
| :---- | :---- | :----: | :---- |
| `linux/amd64` | x86-64, x64 | ✅ | PCs, servers, most NAS boxes |
| `linux/arm64` | aarch64, arm64v8 | ✅ | Raspberry Pi 3 and newer on a 64 bit OS, Apple Silicon |
| `linux/arm/v7` | armhf (Debian, Raspberry Pi OS), armv7 (Alpine) | ✅ | Raspberry Pi 2 and newer on a 32 bit OS, older ARM SBCs and NAS boxes |
| `linux/arm/v6` | armhf (Alpine), armel | ❌ | Raspberry Pi 1, Pi Zero, Pi Zero W |

"armhf" means two different things: Debian and Raspberry Pi OS use it for 32 bit ARMv7, which is supported, Alpine uses it for ARMv6, which is not. The Docker platform in the first column is the unambiguous identifier. A `no matching manifest for linux/arm/v6` on `docker pull` means the device is from the last row; those are not built.

## Running the container

```bash
docker run -d \
  -e TZ=Europe/Berlin \
  -p 4000:4000 \
  -v /path/to/your/config/printers:/app/printers \
  -v /path/to/your/config/logs:/app/logs \
  --name haspelsync \
  ghcr.io/rdiger-36/haspelsync:latest
```

or as Docker Compose:

```yaml
services:
  haspelsync:
    image: ghcr.io/rdiger-36/haspelsync:latest
    container_name: haspelsync
    ports:
      - 4000:4000
    environment:
      - TZ=Europe/Berlin
    volumes:
      - /path/to/your/config/printers:/app/printers
      - /path/to/your/config/logs:/app/logs
    restart: unless-stopped
```

The Compose file above is [`docker/compose.yml`](../docker/compose.yml) in the repository, next to one for the `:dev` image, one that builds the image from a checkout and one that starts a Spoolman alongside; [its README](../docker/README.md) says which is which.

Both volumes are worth mounting: `/app/printers` holds `printers.json`, `settings.json`, `mappings.json`, `apikeys.json`, `presets.json` and `printstate.json` and makes the configuration survive a container update, `/app/logs` keeps the logs.

The container runs as the unprivileged user `node` (uid and gid 1000), nothing in it runs as root. On a Linux host the two host directories have to be writable by that user: create them before the first start, or Docker creates them as root, and run `sudo chown -R 1000:1000` on them. Docker Desktop on macOS and Windows needs nothing, a shared folder is writable for every user in the container. To run as another user, set `user: "UID:GID"` in the Compose file or `--user UID:GID` on `docker run` and give the directories to that user. If the service cannot write to them it stops on start and says so, see [troubleshooting](troubleshooting.md#the-container-stops-cannot-write-to-the-data-directories).

`TZ` sets the time zone the log timestamps follow. Without it the container runs on UTC.

## First start

1. Open `http://<host>:4000` and follow the link to **Settings**.
2. Enter the **Spoolman endpoint** and test the connection.
3. Add your printers under **Printers**, each with name, serial number, IP and access code. The dialog tests MQTT and FTPS before saving.
4. Pick the **operation mode**, `automatic` or `manual`, see [Operation modes](how-it-works.md#operation-modes).

Nothing has to be prepared in Spoolman. The extra field `tag` for spools is created by the service on the first start, on a Spoolman with native tags as well, where it is kept for the tools that still read it, the vendor "Bambu Lab" when the first filament is created.
