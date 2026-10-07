import fs from "fs";
import os from "os";
import path from "path";

/**
 * Points DATA_DIR and LOG_DIR at a throwaway directory, for a test file that
 * imports the service modules statically.
 *
 * config.js reads both once at import time, and a static import is evaluated
 * before the body of the file that names it, so a test cannot set them in its
 * own code in time. Imported first, this module is evaluated first. Without
 * it, a test that drives the print handler writes printers/printstate.json of
 * the checkout it runs in, and the next run reads that back as a print the
 * service found already running.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-test-"));
process.env.DATA_DIR = path.join(dir, "printers");
process.env.LOG_DIR = path.join(dir, "logs");
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LOG_DIR, { recursive: true });
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
