import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createMockSpoolman } from "./mock-spoolman.js";
import { startMockPrinter, loadReport } from "./mock-printer.js";
import { AMS_UNITS, EXTERNAL_SPOOL } from "./scenario.js";

/**
 * A whole environment for this service in one process: a mock printer, a mock
 * Spoolman, and the service itself pointed at both.
 *
 * It exists for the parts that cannot be reached from a unit test and that
 * nobody has the hardware for. Multi colour filaments are the case it was
 * written for: the AMS reports every colour of a spool in `cols` and only the
 * first of them in `tray_color`, and there is no way to see whether that
 * survives to the browser without a printer holding one. The scenario fills all
 * 24 addressable AMS slots from the three Bambu Lab hex code tables.
 *
 * Nothing here is part of the running service. It writes to a temporary
 * directory, never to `printers/`, and starting it twice starts from the same
 * state both times.
 *
 * Usage:
 *   node scripts/test-server/index.js [--spoolman-port 7912] [--printer-port 8883]
 *                                     [--interval 3000] [--no-service]
 *                                     [--delta-reports] [--no-storage]
 *                                     [--real-printer <ip> <code> <serial>]
 *                                     [--spoolman <url>] [--mode manual|automatic]
 *                                     [--report <name>] [--ams-model n3f|ams|ams_f1]
 *                                     [--state-dir <dir>]
 *
 * Then open http://localhost:4000. `--no-service` runs only the two mocks, for
 * pointing an already running container at them.
 *
 * `--report <name>` makes the mock printer publish a captured report from
 * test/fixtures/reports instead of the scenario, for example `x1c-multi-ams`
 * for an X1C with three AMS and an AMS HT, or `a1` for an AMS Lite. Those are
 * what real printers sent, so this is the way to see the dashboard draw
 * hardware nobody here owns. The README next to the files says what each one
 * holds.
 *
 * `--ams-model` is what the mock's four slot units answer as when the service
 * asks `get_version` on connect: `n3f` for an AMS 2 Pro, which the scenario's
 * P2S carries and is the default, `ams` for an original AMS, `ams_f1` for an
 * AMS Lite. An HT always answers as one. The dashboard names the units from
 * that answer, so `--report p1s --ams-model ams` is a P1S with its original AMS.
 * A comma separated list gives each four slot unit its own, in unit order, the
 * last one standing for the rest: `ams,ams_f1,n3f` is A an original AMS, B a
 * Lite and C and D a 2 Pro.
 *
 * `--delta-reports` makes the mock printer leave the external spool holder out
 * of every second report, with `msg` 1, the way a P1S sends delta reports
 * between two full ones, confirmed by the trace of issue #131. The holder has to stay on
 * the dashboard through it; before the fix it vanished and came back with
 * every report.
 *
 * `--no-storage` makes the mock printer report `sdcard` false, a P2S with its
 * USB stick pulled. The print card has to say so, because such a printer keeps
 * printing from internal storage and only the booking goes missing.
 *
 * `--real-printer` skips the mock printer and points the service at a physical
 * one, while Spoolman stays the mock. That is the way to see how a spool nobody
 * here owns is really reported and really drawn, without a single write
 * reaching a Spoolman instance that matters.
 *
 * `--state-dir <dir>` keeps the service's state in that directory instead of
 * a fresh temporary one, so a second run finds what the first one wrote:
 * printstate.json with the running print's start and sliced file, which is
 * what a restart of the service mid print reads.
 *
 * `--spoolman <url>` skips the mock Spoolman and points the service at a real
 * instance. Everything the service writes then reaches that instance, so use it
 * only against one whose contents do not matter. The mock's catalogue is a
 * curated subset, which is enough for its own scenario and not for a real
 * printer full of spools nobody picked; a real Spoolman serves the whole of
 * SpoolmanDB.
 *
 * `--mode automatic` lets the service create and merge in the mock Spoolman
 * without waiting for a button. Pointed at a real printer it seeds the mock
 * with that printer's actual spools, tags and all, which is what makes a real
 * print bookable against a Spoolman nobody has to care about.
 *
 * This file runs outside the service, so `src/logger.js` and its three argument
 * console signature are not in play here. The plain console is correct.
 */

const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const PRINTER_SERIAL = "01P00A000000000";
const PRINTER_CODE = "00000000";

/** Reads `--name value` pairs and `--flag` switches off the command line. */
function readOptions(argv) {
    const options = {
        spoolmanPort: 7912,
        printerPort: 8883,
        interval: 3000,
        service: true,
        deltaReports: false,
        storage: true,
        realPrinter: null,
        spoolman: null,
        mode: "manual",
        report: null,
        amsModel: "n3f",
    };

    for (let i = 0; i < argv.length; i++) {
        const value = argv[i + 1];
        switch (argv[i]) {
            case "--spoolman-port": options.spoolmanPort = Number(value); i++; break;
            case "--printer-port": options.printerPort = Number(value); i++; break;
            case "--interval": options.interval = Number(value); i++; break;
            case "--no-service": options.service = false; break;
            case "--delta-reports": options.deltaReports = true; break;
            case "--no-storage": options.storage = false; break;
            case "--state-dir": options.stateDir = value; i++; break;
            case "--spoolman":
                if (!value || !/^https?:\/\//.test(value)) {
                    console.error("--spoolman takes a base URL, for example http://spoolman.example:7912");
                    process.exit(2);
                }
                options.spoolman = value.replace(/\/+$/, "");
                i++;
                break;
            case "--mode":
                if (value !== "manual" && value !== "automatic") {
                    console.error("--mode takes manual or automatic");
                    process.exit(2);
                }
                options.mode = value;
                i++;
                break;
            case "--real-printer":
                if (argv.length - i < 4) {
                    console.error("--real-printer takes an ip, an access code and a serial number");
                    process.exit(2);
                }
                options.realPrinter = { ip: argv[i + 1], code: argv[i + 2], serial: argv[i + 3] };
                i += 3;
                break;
            case "--ams-model":
                if (!value || !value.split(",").every(model => ["n3f", "ams", "ams_f1"].includes(model))) {
                    console.error("--ams-model takes n3f (AMS 2 Pro), ams (original AMS) or ams_f1 (AMS Lite), or a comma separated list of them, one per four slot unit");
                    process.exit(2);
                }
                options.amsModel = value;
                i++;
                break;
            case "--report":
                if (!value) {
                    console.error("--report takes the name of a file under test/fixtures/reports, without .json");
                    process.exit(2);
                }
                try {
                    options.report = { name: value, print: loadReport(value) };
                } catch (error) {
                    console.error(error.message);
                    process.exit(2);
                }
                i++;
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`);
                process.exit(2);
        }
    }

    return options;
}

/** Prefixes every line of a mock so two of them can share one terminal. */
const prefixed = name => line => console.log(`[${name}] ${line}`);

/** Counts what the scenario holds, so a run says what it is showing. */
function describeScenario() {
    const trays = AMS_UNITS.flatMap(ams => ams.tray);
    const loaded = trays.filter(tray => Array.isArray(tray.cols));

    return {
        units: AMS_UNITS.length,
        slots: trays.length + EXTERNAL_SPOOL.length,
        multiColour: loaded.filter(tray => tray.cols.length > 1).length,
        singleColour: loaded.filter(tray => tray.cols.length === 1).length,
        other: trays.length - loaded.length,
    };
}

async function main() {
    const options = readOptions(process.argv.slice(2));

    // A real Spoolman takes the mock's place entirely. Starting both would leave
    // a listener nothing talks to and a store nothing writes to.
    let store = null;
    let spoolman = null;

    if (options.spoolman) {
        console.log(`[spoolman] using ${options.spoolman}, the mock is not started`);
        console.log("[spoolman] every write the service makes reaches that instance");
    } else {
        const mock = createMockSpoolman(prefixed("spoolman"));
        store = mock.store;
        spoolman = http.createServer(mock.app);
        await new Promise((resolve, reject) => {
            spoolman.once("error", reject);
            spoolman.listen(options.spoolmanPort, () => {
                console.log(`[spoolman] listening on ${options.spoolmanPort}`);
                resolve();
            });
        });
    }

    // A physical printer takes the mock's place entirely. Running both would
    // mean two printers in the list reporting different things, and the point
    // of the real one is to see what it alone reports.
    let printer = null;

    if (options.realPrinter) {
        console.log(`[printer] using the real printer at ${options.realPrinter.ip}, the mock is not started`);
    } else {
        printer = await startMockPrinter({
            serial: PRINTER_SERIAL,
            port: options.printerPort,
            interval: options.interval,
            log: prefixed("printer"),
            report: options.report?.print ?? null,
            deltaReports: options.deltaReports,
            storage: options.storage,
            amsModel: options.amsModel,
        });

        if (options.report) {
            const { name, print } = options.report;
            const units = print.ams?.ams ?? [];
            const holders = Array.isArray(print.vir_slot) ? print.vir_slot.length : (print.vt_tray ? 1 : 0);
            console.log(`[scenario] report fixture "${name}": ${units.length} AMS unit(s) ` +
                `[${units.map(unit => unit.id).join(", ")}], ${holders} external holder(s), ` +
                `state ${print.gcode_state}, stage ${print.stg_cur ?? "none"}`);
        } else {
            const scenario = describeScenario();
            console.log(`[scenario] ${scenario.units} AMS units, ${scenario.slots} slots: ` +
                `${scenario.multiColour} multi colour, ${scenario.singleColour} single colour, ` +
                `${scenario.other} empty, being read or 3rd party, plus the external holder`);
        }
    }

    let service = null;
    let dataDir = null;

    if (options.service) {
        // A directory of its own, so a run cannot touch the printers.json,
        // settings.json or mappings.json of a real installation.
        dataDir = options.stateDir
            ? path.resolve(options.stateDir)
            : fs.mkdtempSync(path.join(os.tmpdir(), "ams-test-server-"));
        fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });

        service = spawn(process.execPath, ["entrypoint.js"], {
            cwd: rootDir,
            stdio: "inherit",
            env: {
                ...process.env,
                DATA_DIR: dataDir,
                LOG_DIR: path.join(dataDir, "logs"),
                SPOOLMAN_ENDPOINT: options.spoolman ?? `http://127.0.0.1:${options.spoolmanPort}`,
                PRINTER_ID: options.realPrinter?.serial ?? PRINTER_SERIAL,
                PRINTER_CODE: options.realPrinter?.code ?? PRINTER_CODE,
                PRINTER_IP: options.realPrinter?.ip ?? "127.0.0.1",
                // Manual by default, so that nothing is created in the mock
                // Spoolman until a button is pressed and every slot keeps
                // showing its state. Automatic is for exercising the write
                // paths, which no unit test reaches.
                MODE: options.mode,
                // The default of two minutes would mean one processed report per
                // run. This is a scenario nobody is waiting on.
                UPDATE_INTERVAL: "5000",
                OFFLINE_CHECK_INTERVAL: "5000",
                DEBUG: process.env.DEBUG ?? "false",
            },
        });

        console.log(`[service] started, state in ${dataDir}`);
        console.log("[service] open http://localhost:4000");

        service.on("exit", code => {
            console.log(`[service] exited with code ${code}`);
            shutdown(0);
        });
    } else {
        console.log("[service] not started, point one at " +
            `${options.spoolman ?? `http://127.0.0.1:${options.spoolmanPort}`} and at ` +
            `127.0.0.1:${options.printerPort} with serial ${PRINTER_SERIAL} ` +
            `and access code ${PRINTER_CODE}`);
    }

    if (options.realPrinter) {
        console.log("[spoolman] every write below comes from the real printer, " +
            "and none of them reaches a Spoolman instance that matters");
    }

    let shuttingDown = false;

    async function shutdown(code) {
        if (shuttingDown) return;
        shuttingDown = true;

        if (service && service.exitCode === null) service.kill("SIGTERM");
        if (printer) await printer.close();
        if (spoolman) await new Promise(done => spoolman.close(() => done()));

        if (store) {
            console.log(`[spoolman] ${store.writes.length} write(s) received:`);
            for (const write of store.writes) console.log(`[spoolman]   ${write}`);
        }
        if (printer) console.log(`[printer] published ${printer.reports()} report(s)`);
        // A directory the caller named is theirs to keep, see --state-dir
        if (dataDir && !options.stateDir) fs.rmSync(dataDir, { recursive: true, force: true });

        process.exit(code);
    }

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
