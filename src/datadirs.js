/**
 * Write check for the two directories the service keeps its state in.
 *
 * The image runs as the unprivileged user `node`. Every earlier image ran as
 * root, so a bind mounted printers/ or logs/ and every file in it belongs to
 * root, and the service would only notice on
 * its first write: a settings save that fails, a log line that goes nowhere.
 * starting.js asks this module before the backend is loaded and stops with a
 * message naming the fix instead.
 *
 * Deliberately free of the logger: it runs before the console is overridden,
 * and the log directory is one of the things it checks.
 */

import fs from "fs";
import path from "path";

import { dataDir, logsDir } from "./config.js";

// More than this and the message lists the first ones and a count, since a
// logs/ directory with its rotations can hold dozens of files.
const MAX_LISTED = 5;

/**
 * Returns every path in the given directories the current process cannot write
 * to: the directory itself, then each file directly inside it.
 *
 * Only the top level is looked at, because that is all the service writes.
 * A directory that does not exist is skipped; creating it is up to the module
 * that owns it, as before. `access` and `readdir` are injectable for the tests,
 * since a process running as root passes every real write check.
 */
export function findUnwritable(dirs, { access = fs.accessSync, readdir = fs.readdirSync } = {}) {
    const unwritable = [];
    const writable = (target) => {
        try {
            access(target, fs.constants.W_OK);
            return true;
        } catch (err) {
            if (err?.code === "ENOENT") return true;
            return false;
        }
    };

    for (const dir of dirs) {
        let entries;
        try {
            entries = readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (err?.code === "ENOENT") continue;
            unwritable.push(dir);
            continue;
        }

        if (!writable(dir)) unwritable.push(dir);
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const file = path.join(dir, entry.name);
            if (!writable(file)) unwritable.push(file);
        }
    }

    return unwritable;
}

/**
 * The lines starting.js prints when findUnwritable() found something: what
 * failed, for which user, and the one command that fixes it on the host.
 *
 * The command is for a Linux host, which is the only place this comes up:
 * Docker Desktop on macOS and Windows shares a host folder through a layer
 * that lets any container user write to it, whatever the owner.
 *
 * The host path is unknown inside the container, so the command names the
 * mount points and the text says which host directories they stand for.
 */
export function unwritableMessage(paths, { uid, gid } = {}) {
    const user = uid === undefined ? "the user this service runs as" : `user ${uid}:${gid}`;
    const owner = uid === undefined ? "1000:1000" : `${uid}:${gid}`;
    const listed = paths.slice(0, MAX_LISTED).map(p => `  ${p}`);
    if (paths.length > MAX_LISTED) listed.push(`  and ${paths.length - MAX_LISTED} more`);

    return [
        `Cannot write to the data directories as ${user}:`,
        ...listed,
        "The image no longer runs as root. Directories and files written by an earlier version belong to root and have to be handed over once.",
        "On a Linux host, a NAS or inside WSL, run this for the directories mounted at /app/printers and /app/logs:",
        `  sudo chown -R ${owner} <printers directory> <logs directory>`,
        "Then start the container again. See docs/troubleshooting.md in the repository.",
    ];
}

/** Checks the configured data and log directories of this process. */
export function checkDataDirs() {
    const paths = findUnwritable([dataDir, logsDir]);
    if (paths.length === 0) return null;
    const ids = typeof process.getuid === "function"
        ? { uid: process.getuid(), gid: process.getgid() }
        : {};
    return unwritableMessage(paths, ids);
}
