# Docker

Everything that builds or runs HaspelSync as a container. The image itself is
described in [Installation](../docs/installation.md); this folder holds the
files behind it.

| File | What it is for | Start |
| :---- | :---- | :---- |
| [`compose.yml`](compose.yml) | The latest stable image, `ghcr.io/rdiger-36/haspelsync:latest`. The file the installation guide shows | `docker compose -f docker/compose.yml up -d` |
| [`compose.dev.yml`](compose.dev.yml) | The rolling `:dev` image, which every `-dev` pre-release moves. For testing what is about to be released | `docker compose -f docker/compose.dev.yml up -d` |
| [`compose.local.yml`](compose.local.yml) | An image built from this checkout, tagged `haspelsync:local`. For trying a branch before it is published | `docker compose -f docker/compose.local.yml up -d --build` |
| [`compose.spoolman.yml`](compose.spoolman.yml) | The stable image together with a Spoolman of its own, HaspelSync already pointed at it. For an installation that has neither yet | `docker compose -f docker/compose.spoolman.yml up -d` |
| [`Dockerfile`](Dockerfile) | The image. Built from the repository root, which is where `.dockerignore` lives: `docker build -f docker/Dockerfile .` | |
| [`Dockerfile.legacy`](Dockerfile.legacy) | The same image under the old name `bambulab-ams-spoolman-filamentstatus`, published for a transition period after the rename. Built by the publish workflow on top of the image it just pushed, never by hand | |

Every Compose file is complete on its own and can be copied anywhere. The data
directories are created next to the file: `data/printers` holds the
configuration, `data/logs` the logs, `data/spoolman` Spoolman's database in the
stack. Under `docker/` they are ignored by git.

HaspelSync runs as the unprivileged user `node`, uid and gid 1000, and
nothing in the container runs as root. `data/printers` and `data/logs` have to
be writable by that user, which every Compose file says above its volumes;
`user:` picks another one. The service checks both directories on start and
stops with the `chown` that fixes them when it cannot write to them.

All four run the service on port 4000 with the time zone `Europe/Berlin`;
change `TZ` to yours, it only affects the timestamps in the logs. Everything
else, the Spoolman endpoint, the printers and the operation mode, is configured
in the Web UI on `http://<host>:4000` after the first start.
