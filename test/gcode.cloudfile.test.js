// First, so the modules below read a throwaway DATA_DIR, see the helper
import "./helpers/tempdata.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

import { cloudFileLink, cloudLinkUsable, matchesMd5, fetchSliceInfo, CLOUD_FILE_PATH } from "../src/gcode.js";
import { notePrintCommand, handlePrintStateChange, runningPrint, sliceFetchFailure } from "../src/mqtt.js";
import { rememberPrintStart, rememberCloudFile, recallCloudFile } from "../src/printstate.js";

// Bambu Studio 2.9.2 sends a print to a printer bound to the cloud through the
// cloud first, and the printer downloads it into its internal storage, so the
// stick never sees the file (issue #281). The link the printer downloads from
// is in the project_file echo. Shape as read off a P2S on 2026-11-25, with the
// account, the credential and the signature replaced.
const S3_LINK = "https://or-cloud-upload-prod.s3-accelerate.amazonaws.com/users/1/US181b662677aae1_1180932654_1.3mf"
    + "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=X%2F20261125%2Fus-west-2%2Fs3%2Faws4_request"
    + "&X-Amz-Date=20261125T191116Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&x-id=GetObject&X-Amz-Signature=0";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "p2s_cube.gcode.3mf");

test("the cloud link of a project_file command is read with its expiry", () => {
    assert.deepEqual(cloudFileLink(S3_LINK), { url: S3_LINK, expiresAt: Date.UTC(2026, 10, 25, 20, 11, 16) });
    // A link without the S3 fields is still a link, only its expiry is unknown
    assert.deepEqual(cloudFileLink("https://example.invalid/job.3mf"), { url: "https://example.invalid/job.3mf", expiresAt: null });
    // A LAN print names an ftp:// object, a start on the printer's screen a
    // file:// one, and neither can be fetched from here
    assert.equal(cloudFileLink("ftp://Cube.gcode.3mf"), null);
    assert.equal(cloudFileLink("file:///userdata/model/history/A1mini.gcode.3mf"), null);
    assert.equal(cloudFileLink(""), null);
    assert.equal(cloudFileLink(undefined), null);
});

test("a cloud link is used until it expires, and one without an expiry is tried", () => {
    const link = cloudFileLink(S3_LINK);
    assert.equal(cloudLinkUsable(link, link.expiresAt - 1), true);
    assert.equal(cloudLinkUsable(link, link.expiresAt), false);
    assert.equal(cloudLinkUsable({ url: "https://example.invalid/job.3mf", expiresAt: null }, Date.now()), true);
    assert.equal(cloudLinkUsable(null, Date.now()), false);
});

test("a download counts only when it is the file the command announced", () => {
    const buf = Buffer.from("sliced");
    const md5 = createHash("md5").update(buf).digest("hex");
    // The printer reports it in capitals
    assert.equal(matchesMd5(buf, md5.toUpperCase()), true);
    assert.equal(matchesMd5(buf, "0430C0F3F2A6510DDB6DDD342DA06BAE"), false);
    assert.equal(matchesMd5(buf, null), true);
});

test("the echo's cloud link is taken by the print of that name and survives a restart", async () => {
    const printer = {
        id: "CLOUD1", name: "Test Printer", logFilePath: "/dev/null",
        currentGcodeState: "IDLE", currentJobName: null, currentLayerNum: 0, currentSliceInfo: null,
        sliceFetchDone: true, consumptionBooked: false, currentMapping: null, pendingMapping: null,
        lastPrintSummary: null, lastPrintError: null,
    };
    const command = {
        command: "project_file",
        subtask_name: "Dr._Doom__Mask_plate_1",
        url: S3_LINK,
        md5: "9A111318E1FFE63788A16DAE15452104",
        plate_idx: 1,
        ams_mapping: [-1, -1, 2, -1],
    };
    assert.equal(notePrintCommand(printer, Buffer.from(JSON.stringify({ print: command }))), true);
    // A cloud url is no file name on the printer
    assert.equal(printer.pendingFileName, null);

    await handlePrintStateChange(printer, { gcode_state: "PREPARE", subtask_name: "Dr._Doom__Mask_plate_1", layer_num: 0 });
    const expected = { url: S3_LINK, expiresAt: Date.UTC(2026, 10, 25, 20, 11, 16), md5: "9A111318E1FFE63788A16DAE15452104" };
    assert.deepEqual(printer.currentCloudFile, expected);
    assert.equal(printer.pendingCloudFile, null);
    assert.deepEqual(runningPrint(printer).cloudFile, expected);
    // On disk for a restart within the hour the link is valid
    assert.deepEqual(recallCloudFile("CLOUD1", "Dr._Doom__Mask_plate_1"), expected);
    assert.equal(recallCloudFile("CLOUD1", "Another job"), null);

    // An echo for another job is not used
    printer.currentGcodeState = "FINISH";
    notePrintCommand(printer, Buffer.from(JSON.stringify({ print: { ...command, subtask_name: "Something else" } })));
    await handlePrintStateChange(printer, { gcode_state: "PREPARE", subtask_name: "Dr._Doom__Mask_plate_1", layer_num: 0 });
    assert.equal(printer.currentCloudFile, null);
});

test("a stored cloud link that does not have the shape it was written in is dropped", () => {
    rememberPrintStart("CLOUD2", "Cube", Date.now() - 1000);
    rememberCloudFile("CLOUD2", { url: "ftp://Cube.gcode.3mf", expiresAt: 1, md5: null });
    assert.equal(recallCloudFile("CLOUD2", "Cube"), null);
    rememberCloudFile("CLOUD2", { url: "https://example.invalid/Cube.3mf", expiresAt: "soon", md5: "" });
    assert.deepEqual(recallCloudFile("CLOUD2", "Cube"), { url: "https://example.invalid/Cube.3mf", expiresAt: null, md5: null });
});

test("the log says why the cloud link did not help either", () => {
    const tried = ["/cache/Cube.3mf"];
    assert.equal(
        sliceFetchFailure({ jobName: "Cube", tried, path: null, listed: 3, cloudError: "the job's cloud link answered 403" }),
        "No sliced file on the printer under /cache/Cube.3mf. Listed 3 3MF files on the printer: no 3MF was written at the start, and the job's cloud link answered 403",
    );
    assert.equal(
        sliceFetchFailure({ jobName: "Cube", tried, path: null, error: "Timeout (control socket)", cloudError: "the job's cloud link expired at 2026-11-25T20:11:16.000Z" }),
        "FTPS to the printer failed: Timeout (control socket), and the job's cloud link expired at 2026-11-25T20:11:16.000Z",
    );
    // A login that failed before the link was read is not what failed
    assert.equal(
        sliceFetchFailure({ jobName: "Cube", tried, path: CLOUD_FILE_PATH, error: "Timeout (control socket)", sliceInfo: false }),
        "the cloud download carries no Metadata/slice_info.config",
    );
});

/** Serves `body` once per request on a local port, the way S3 serves the job. */
async function serve(body, status = 200) {
    const server = http.createServer((_, res) => {
        res.writeHead(status, { "Content-Type": "binary/octet-stream" });
        res.end(body);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/job.3mf` };
}

test("a printer without a copy of the job is read from the job's cloud link", async (t) => {
    const buf = fs.readFileSync(FIXTURE);
    const md5 = createHash("md5").update(buf).digest("hex").toUpperCase();
    const { server, url } = await serve(buf);
    t.after(() => server.close());
    // The FTPS login goes to port 990 of the printer's ip, and nothing on this
    // machine answers there, which stands in for a printer that keeps the file
    // to itself. cloudFileLink() takes https only, so the link is built here.
    const printer = { id: "CLOUD3", name: "Test Printer", logFilePath: "/dev/null", ip: "127.0.0.1", code: "x" };

    const sliceInfo = await fetchSliceInfo(printer, "Cube", null, null, { startedAt: Date.now(), cloudFile: { url, expiresAt: null, md5 } });
    assert.ok(sliceInfo, "the slice info comes from the cloud download");
    assert.ok(sliceInfo.filaments.length > 0);
    assert.equal(printer.lastSliceFetch.path, CLOUD_FILE_PATH);
    assert.equal(printer.lastSliceFetch.cloud, true);
});

test("a cloud download that is not the announced file is not used", async (t) => {
    const buf = fs.readFileSync(FIXTURE);
    const { server, url } = await serve(buf);
    t.after(() => server.close());
    const printer = { id: "CLOUD4", name: "Test Printer", logFilePath: "/dev/null", ip: "127.0.0.1", code: "x" };

    const sliceInfo = await fetchSliceInfo(printer, "Cube", null, null, { startedAt: Date.now(), cloudFile: { url, expiresAt: null, md5: "0430C0F3F2A6510DDB6DDD342DA06BAE" } });
    assert.equal(sliceInfo, null);
    assert.equal(printer.lastSliceFetch.path, null);
    assert.match(printer.lastSliceFetch.cloudError, /md5 differs/);
});

test("an expired cloud link is not fetched, and without a link a refused login still throws", async () => {
    const printer = { id: "CLOUD5", name: "Test Printer", logFilePath: "/dev/null", ip: "127.0.0.1", code: "x" };
    const sliceInfo = await fetchSliceInfo(printer, "Cube", null, null, { startedAt: Date.now(), cloudFile: { url: "http://127.0.0.1:9/job.3mf", expiresAt: Date.now() - 1, md5: null } });
    assert.equal(sliceInfo, null);
    assert.match(printer.lastSliceFetch.cloudError, /expired at/);

    await assert.rejects(fetchSliceInfo(printer, "Cube", null, null, { startedAt: Date.now() }));
});
