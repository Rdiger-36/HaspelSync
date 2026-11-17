import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";

let dir, findUnwritable, unwritableMessage;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-datadirs-"));
    process.env.DATA_DIR = path.join(dir, "printers");
    process.env.LOG_DIR = path.join(dir, "logs");
    ({ findUnwritable, unwritableMessage } = await import("../src/datadirs.js"));
});

after(() => { fs.removeSync(dir); });

/** A fake file system: a map of directory to file names, and the set of paths that refuse a write. */
function fakeFs(tree, readOnly) {
    const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
    return {
        readdir: (d) => {
            if (!(d in tree)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return tree[d].map(name => ({ name, isFile: () => !name.endsWith("/") }));
        },
        access: (p) => { if (readOnly.has(p)) throw denied(); },
    };
}

test("writable directories and files report nothing", () => {
    const api = fakeFs({ "/p": ["settings.json"], "/l": ["server.log"] }, new Set());
    assert.deepEqual(findUnwritable(["/p", "/l"], api), []);
});

test("a directory and a file left to root are both listed, a missing directory is skipped", () => {
    const api = fakeFs(
        { "/p": ["settings.json", "mappings.json", "sub/"], "/l": ["server.log"] },
        new Set(["/p", "/l/server.log"]),
    );
    assert.deepEqual(findUnwritable(["/p", "/l", "/gone"], api), ["/p", "/l/server.log"]);
});

test("the message names the user, the paths and the chown for it", () => {
    const lines = unwritableMessage(["/app/printers"], { uid: 1000, gid: 1000 });
    assert.ok(lines[0].includes("user 1000:1000"));
    assert.ok(lines.includes("  /app/printers"));
    assert.ok(lines.some(l => l.includes("sudo chown -R 1000:1000")));
});

test("a long list is cut after five paths with a count", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `/app/logs/server.log.${i}`);
    const lines = unwritableMessage(paths, { uid: 1000, gid: 1000 });
    assert.ok(lines.includes("  and 3 more"));
    assert.ok(!lines.includes("  /app/logs/server.log.5"));
});

test("a real read only file is found when not running as root", { skip: process.getuid?.() === 0 }, () => {
    const p = path.join(dir, "printers");
    fs.ensureDirSync(p);
    const file = path.join(p, "settings.json");
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o444);
    assert.deepEqual(findUnwritable([p]), [file]);
    fs.chmodSync(file, 0o644);
});
