import test from "node:test";
import assert from "node:assert/strict";

import { resolveRemotePaths, sliceFetchRetryDue, SLICE_FETCH_RETRY_MS, SLICE_FETCH_ATTEMPTS, slicedFileCandidates, SLICED_FILE_TIME_WINDOW_MS, reportedPlate, parseModelTitles, parsePlateIndices, judgeSlicedFile, settleSlicedFile, readSlicedFileFacts, parseModelIds, countPrintedLayers, parseSliceInfo, parseModelNames, modelTitleFor, readZipTailEntry } from "../src/gcode.js";
import AdmZip from "adm-zip";
import { randomBytes } from "crypto";
import { sliceFetchFailure, localFileName, printIdentity } from "../src/mqtt.js";

// Where the sliced file sits depends on how the job reached the printer, and
// the printer says which in gcode_file. Every name below is one a real printer
// reported in September 2026 through issue #146.

test("a cloud print is looked for under the name the printer reports, .3mf first", () => {
    // Schnuecks's P1S, seven cloud prints, every one of them gcode_file "<job>.3mf"
    // and never found under the .gcode.3mf spelling
    assert.deepEqual(resolveRemotePaths("Würfel", "Würfel.3mf"), [
        "/cache/Würfel.3mf",
        "/cache/Würfel.gcode.3mf",
        "/Würfel.gcode.3mf",
        "/Würfel.3mf",
    ]);

    const long = "Resqme Sunvisor Mount - 0.2mm layer, 2 walls, 15% infill";
    assert.equal(resolveRemotePaths(long, `${long}.3mf`)[0], `/cache/${long}.3mf`);
});

test("a LAN print is looked for under .gcode.3mf first, as before", () => {
    // beegee-tokyo's P1S, sent from OrcaSlicer over the LAN
    assert.deepEqual(resolveRemotePaths("BambuLab-AMS-Spoolman-Testprint_v2", "BambuLab-AMS-Spoolman-Testprint_v2.gcode.3mf"), [
        "/cache/BambuLab-AMS-Spoolman-Testprint_v2.gcode.3mf",
        "/cache/BambuLab-AMS-Spoolman-Testprint_v2.3mf",
        "/BambuLab-AMS-Spoolman-Testprint_v2.gcode.3mf",
        "/BambuLab-AMS-Spoolman-Testprint_v2.3mf",
    ]);
});

test("the printer's internal gcode path names no file and is ignored", () => {
    // The X1E reports /data/Metadata/plate_1.gcode for the whole print
    assert.deepEqual(resolveRemotePaths("Würfel", "/data/Metadata/plate_1.gcode"), [
        "/cache/Würfel.gcode.3mf",
        "/cache/Würfel.3mf",
        "/Würfel.gcode.3mf",
        "/Würfel.3mf",
    ]);
    assert.deepEqual(resolveRemotePaths("Würfel"), resolveRemotePaths("Würfel", null));
});

test("a job name that already carries an extension is not doubled", () => {
    assert.equal(resolveRemotePaths("My Print.gcode.3mf")[0], "/cache/My Print.gcode.3mf");
    assert.equal(resolveRemotePaths("My Print.3mf")[0], "/cache/My Print.gcode.3mf");
    assert.equal(resolveRemotePaths("/data/My Print.gcode")[0], "/cache/My Print.gcode.3mf");
    assert.deepEqual(resolveRemotePaths(""), []);
    assert.deepEqual(resolveRemotePaths(null, "Würfel.3mf"), ["/cache/Würfel.3mf"]);
});

test("a file the printer named itself is looked for first, in both places", () => {
    // A P2S printing A1mini.gcode.3mf off its USB stick, started on its screen:
    // the job was named after the model's title and the file after the project
    assert.deepEqual(resolveRemotePaths("Perfectly clean bed for perfect prints!", "/data/Metadata/plate_1.gcode", "A1mini.gcode.3mf"), [
        "/cache/A1mini.gcode.3mf",
        "/A1mini.gcode.3mf",
        "/cache/Perfectly clean bed for perfect prints!.gcode.3mf",
        "/cache/Perfectly clean bed for perfect prints!.3mf",
        "/Perfectly clean bed for perfect prints!.gcode.3mf",
        "/Perfectly clean bed for perfect prints!.3mf",
    ]);
    // The same name from both sources is one candidate
    assert.deepEqual(resolveRemotePaths("Würfel", "Würfel.3mf", "Würfel.3mf").slice(0, 3),
        ["/cache/Würfel.3mf", "/Würfel.3mf", "/cache/Würfel.gcode.3mf"]);
    // Only a 3MF counts as a name
    assert.deepEqual(resolveRemotePaths("Würfel", null, "plate_1.gcode"), resolveRemotePaths("Würfel"));
});

test("the file name comes off a file:// url only", () => {
    assert.equal(localFileName("file:///userdata/model/history/A1mini.gcode.3mf"), "A1mini.gcode.3mf");
    assert.equal(localFileName("file:///userdata/model/history/W%C3%BCrfel%20%2B%20W%C3%BCrfel.gcode.3mf"), "Würfel + Würfel.gcode.3mf");
    assert.equal(localFileName("https://or-cloud-upload-prod.s3-accelerate.amazonaws.com/users/1/models/x.3mf?X-Amz-Signature=y"), null);
    assert.equal(localFileName("ftp://192.168.1.96/cache/Würfel.gcode.3mf"), null);
    assert.equal(localFileName("file:///"), null);
    assert.equal(localFileName(undefined), null);
});

test("a job named after its print profile takes the model's title from the file", () => {
    // Read off a P2S on 2026-10-02: a MakerWorld model printed through one of
    // its print profiles from Bambu Studio
    const xml = `<model><metadata name="Application">BambuStudio-02.08.02.61</metadata>
<metadata name="ProfileTitle">0.2mm layer, 2 walls, 15% infill</metadata>
<metadata name="Title">Darts Holder &amp; Storage</metadata></model>`;
    assert.deepEqual(parseModelNames(xml), { title: "Darts Holder & Storage", profileTitle: "0.2mm layer, 2 walls, 15% infill" });
    assert.equal(modelTitleFor("0.2mm layer, 2 walls, 15% infill", parseModelNames(xml)), "Darts Holder & Storage");

    // The job carries the model's name already, a Handy print
    assert.equal(modelTitleFor("Darts Holder & Storage", parseModelNames(xml)), null);
    // The job is neither: a renamed project. The printer's name stands
    assert.equal(modelTitleFor("Dartholder large", parseModelNames(xml)), null);
    // A project of the user's own has no titles at all
    assert.deepEqual(parseModelNames("<model><metadata name=\"Title\"></metadata></model>"), { title: null, profileTitle: null });
    assert.equal(modelTitleFor("Würfel", parseModelNames("<model/>")), null);
    // Both titles the same says nothing
    assert.equal(modelTitleFor("Cube", { title: "Cube", profileTitle: "Cube" }), null);
});

test("a MakerWorld title escaped twice reads as the model's title", () => {
    // Issue #237, a P2S on 2026-10-11: MakerWorld escapes the title for HTML
    // and Bambu Studio once more for the XML, so the dashboard showed &quot;
    const xml = `<model><metadata name="ProfileTitle">Roter Leuchtturm</metadata>
<metadata name="Title">Maritimes &amp;quot;MOIN&amp;quot; Schild mit Leuchtturm Aufsteller</metadata></model>`;
    assert.equal(parseModelNames(xml).title, "Maritimes \"MOIN\" Schild mit Leuchtturm Aufsteller");
    assert.deepEqual(
        parseModelTitles("<metadata name=\"Title\">Cutest Oyster | Switch &amp;amp; 100% Printed Clicker</metadata>"),
        ["Cutest Oyster | Switch & 100% Printed Clicker"]);

    // Umlauts by name, by number and in hex, escaped once or twice
    const title = value => parseModelNames(`<metadata name="Title">${value}</metadata>`).title;
    assert.equal(title("Gr&amp;uuml;&amp;szlig;e f&amp;#252;r &amp;#xD6;fen"), "Grüße für Öfen");
    assert.equal(title("Gr&#252;&#xDF;e"), "Grüße");
    assert.equal(title("Grüße &amp;ndash; Br&amp;auml;u"), "Grüße – Bräu");
    // Neither an unknown name nor a code point outside Unicode is guessed at
    assert.equal(title("A &amp;foo; B &amp;#99999999;"), "A &foo; B &#99999999;");
});

test("the log names the problem it actually had", () => {
    assert.equal(sliceFetchFailure(null), "No sliced file was fetched");
    // The login itself failed, so no path was tried: a P2S whose FTPS service
    // had hung answered the TLS handshake with plain text (2026-10-02), and
    // "No sliced file on the printer under ..." sent its owner after a name
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf"], path: null, error: "wrong version number (control socket)" }),
        "FTPS login to the printer failed: wrong version number (control socket)",
    );
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf", "/cache/Würfel.gcode.3mf"], path: null }),
        "No sliced file on the printer under /cache/Würfel.3mf, /cache/Würfel.gcode.3mf",
    );
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf"], path: "/cache/Würfel.3mf", sliceInfo: false }),
        "/cache/Würfel.3mf carries no Metadata/slice_info.config",
    );
    // The printer's answer per path, so a missing USB stick (550 on everything)
    // and a data connection that never opened are told apart in the ordinary log
    assert.equal(
        sliceFetchFailure({
            jobName: "Würfel",
            tried: ["/cache/Würfel.3mf", "/cache/Würfel.gcode.3mf"],
            reasons: { "/cache/Würfel.3mf": "550 Failed to open file." },
            path: null,
        }),
        "No sliced file on the printer under /cache/Würfel.3mf (550 Failed to open file.), /cache/Würfel.gcode.3mf",
    );
});

test("a fetch that found nothing is tried again, a few times, after a wait", () => {
    const at = 1_000_000;
    // A P2S recovering from an extruder error on 2026-09-23: the login timed
    // out, and the only fetch of the print was gone
    const timedOut = { jobName: "A1mini", attempt: 1, tried: [], error: "Timeout (control socket)", path: null, at };
    assert.equal(sliceFetchRetryDue(timedOut, at + 1000), false);
    assert.equal(sliceFetchRetryDue(timedOut, at + SLICE_FETCH_RETRY_MS), true);

    // A file not there yet is the same case from the other side
    const notFound = { jobName: "A1mini", attempt: 1, tried: ["/cache/A1mini.gcode.3mf"], path: null, at };
    assert.equal(sliceFetchRetryDue(notFound, at + SLICE_FETCH_RETRY_MS + 1), true);

    // The last attempt is the last one
    assert.equal(sliceFetchRetryDue({ ...notFound, attempt: SLICE_FETCH_ATTEMPTS }, at + 10 * SLICE_FETCH_RETRY_MS), false);
    assert.equal(sliceFetchRetryDue({ ...notFound, attempt: SLICE_FETCH_ATTEMPTS - 1 }, at + SLICE_FETCH_RETRY_MS), true);

    // A file that was found and carried no slice info will not change
    assert.equal(sliceFetchRetryDue({ ...notFound, path: "/cache/A1mini.gcode.3mf", sliceInfo: false }, at + 10 * SLICE_FETCH_RETRY_MS), false);
    // A record without an attempt count is the first attempt
    assert.equal(sliceFetchRetryDue({ jobName: "x", tried: [], path: null, at }, at + SLICE_FETCH_RETRY_MS), true);
    assert.equal(sliceFetchRetryDue(null, at), false);
    // The look before the print ran is attempt 0 and leaves all three
    assert.equal(sliceFetchRetryDue({ ...notFound, attempt: 0, beforeRunning: true }, at + SLICE_FETCH_RETRY_MS), true);
});

test("the time only picks the candidates, closest to the start first", () => {
    // The X2D of issue #179 on 2026-09-26: the job was named after the print
    // profile, the file on the USB stick after the project, written at the start
    const startedAt = Date.parse("2026-09-26T13:44:17Z");
    const cartPicker = { path: "/CartPicker.gcode.3mf", modifiedAt: Date.parse("2026-09-26T13:44:05Z") };
    const yesterday = { path: "/cache/Benchy.gcode.3mf", modifiedAt: Date.parse("2026-09-25T18:02:00Z") };
    // Closest rather than newest: a file sent after the start belongs to the next print
    const next = { path: "/Next.gcode.3mf", modifiedAt: startedAt + 5 * 60 * 1000 };
    assert.deepEqual(slicedFileCandidates([yesterday, next, cartPicker], startedAt), [cartPicker, next]);

    assert.deepEqual(slicedFileCandidates([yesterday], startedAt), []);
    assert.deepEqual(slicedFileCandidates([{ path: "/x.3mf", modifiedAt: startedAt - SLICED_FILE_TIME_WINDOW_MS - 1 }], startedAt), []);
    assert.deepEqual(slicedFileCandidates([{ path: "/x.3mf", modifiedAt: NaN }], startedAt), []);
    assert.deepEqual(slicedFileCandidates([cartPicker], null), []);
});

test("the plate comes off gcode_file", () => {
    assert.equal(reportedPlate("/data/Metadata/plate_1.gcode"), 1);
    assert.equal(reportedPlate("Metadata/plate_12.gcode"), 12);
    assert.equal(reportedPlate("Würfel.gcode.3mf"), null);
    assert.equal(reportedPlate(undefined), null);
});

test("a file names itself through MakerWorld's titles", () => {
    // Heads of 3D/3dmodel.model as Bambu Studio 2.8 writes them, read off the P2S stick
    const clippy = `<model>
 <metadata name="Designer">iLab 3D</metadata>
 <metadata name="ProfileTitle">0.2mm layer - 10 clips</metadata>
 <metadata name="Title">CLIPPY - Filament clip</metadata>
 <resources>`;
    assert.deepEqual(parseModelTitles(clippy), ["0.2mm layer - 10 clips", "CLIPPY - Filament clip"]);
    // A project of one's own leaves both empty
    assert.deepEqual(parseModelTitles(`<metadata name="ProfileTitle"></metadata>\n <metadata name="Title"></metadata>`), []);
    assert.deepEqual(parseModelTitles(`<metadata name="Title">Tom &amp; Jerry &quot;v2&quot;</metadata>`), ['Tom & Jerry "v2"']);

    assert.deepEqual(parsePlateIndices(`<config>\n  <plate>\n    <metadata key="index" value="1"/>\n  </plate>\n  <plate>\n    <metadata key="index" value="3"/>`), [1, 3]);
});

test("the content of a candidate proves it, rules it out or leaves it open", () => {
    const x2d = { jobName: "0.2mm layer, 3 walls, 15% infill", plate: 1, layers: 15 };
    const makerWorld = { titles: ["0.2mm layer, 3 walls, 15% infill", "CartPicker"], plates: [1], layers: 15 };

    assert.equal(judgeSlicedFile(makerWorld, x2d).verdict, "confirmed");
    // The exclusions come first, a matching title does not outweigh them
    assert.equal(judgeSlicedFile({ ...makerWorld, plates: [2] }, x2d).verdict, "rejected");
    assert.equal(judgeSlicedFile({ ...makerWorld, layers: 16 }, x2d).verdict, "rejected");
    // A title that is not the job name rules the file out
    assert.equal(judgeSlicedFile({ ...makerWorld, titles: ["0.2mm layer - 10 clips"] }, x2d).verdict, "rejected");
    // A project of one's own carries no title and is left open
    assert.equal(judgeSlicedFile({ titles: [], plates: [1], layers: 15 }, x2d).verdict, "possible");
    // What the printer has not reported checks nothing
    assert.equal(judgeSlicedFile({ titles: [], plates: [2], layers: 99 }, { jobName: "x", plate: null, layers: null }).verdict, "possible");
});

test("a guess between two files books nothing", () => {
    const confirmed = { path: "/a.3mf", verdict: "confirmed" };
    const possible = { path: "/b.3mf", verdict: "possible" };
    const other = { path: "/c.3mf", verdict: "possible" };
    const rejected = { path: "/d.3mf", verdict: "rejected" };

    assert.equal(settleSlicedFile([possible, confirmed]).file, confirmed);
    assert.equal(settleSlicedFile([rejected, possible]).file, possible);
    assert.equal(settleSlicedFile([possible, other]).file, null);
    assert.match(settleSlicedFile([possible, other]).reason, /2 files/);
    assert.equal(settleSlicedFile([rejected]).file, null);
    assert.equal(settleSlicedFile([]).file, null);
});

test("an entry at the end of a zip is read from its tail alone", () => {
    // A 3MF the way Bambu Studio writes it: the G-code in front, slice_info
    // and the small files after it. Random bytes, so deflate cannot shrink
    // the G-code into the tail.
    const zip = new AdmZip();
    zip.addFile("3D/3dmodel.model", Buffer.from("<model><metadata name=\"Title\">Darts Holder and Storage</metadata></model>"));
    zip.addFile("Metadata/plate_1.gcode", randomBytes(300 * 1024));
    const sliceInfo = "<config><plate><metadata key=\"index\" value=\"1\"/><layer_filament_list layer_ranges=\"0 434\" filament_list=\"1\"/></plate></config>";
    zip.addFile("Metadata/slice_info.config", Buffer.from(sliceInfo));
    zip.addFile("_rels/.rels", Buffer.from("<Relationships/>"));
    const whole = zip.toBuffer();

    const tailStart = whole.length - 64 * 1024;
    const tail = whole.subarray(tailStart);
    assert.equal(readZipTailEntry(tail, tailStart, "Metadata/slice_info.config")?.toString("utf8"), sliceInfo);
    // In front of the tail: the G-code, the model and, AdmZip writing the
    // entries in name order, _rels/.rels as the very first one
    assert.equal(readZipTailEntry(tail, tailStart, "Metadata/plate_1.gcode"), null);
    assert.equal(readZipTailEntry(tail, tailStart, "3D/3dmodel.model"), null);
    assert.equal(readZipTailEntry(tail, tailStart, "_rels/.rels"), null);
    assert.equal(readZipTailEntry(tail, tailStart, "Metadata/none.config"), null);
    // The whole file is a tail that starts at 0
    assert.equal(readZipTailEntry(whole, 0, "3D/3dmodel.model")?.toString("utf8").includes("Darts Holder"), true);
    // A tail too short for the central directory
    assert.equal(readZipTailEntry(whole.subarray(whole.length - 10), whole.length - 10, "_rels/.rels"), null);
    assert.equal(readZipTailEntry(Buffer.alloc(0), 0, "_rels/.rels"), null);
});

test("the settlement names which files were judged", () => {
    const possible = { path: "/a.3mf", verdict: "possible" };
    assert.equal(settleSlicedFile([possible], "on the printer").reason, "the only file on the printer that nothing rules out");
    assert.equal(settleSlicedFile([possible, { path: "/b.3mf", verdict: "possible" }], "on the printer").reason, "2 files on the printer could be it, so none is taken");
    assert.equal(settleSlicedFile([{ path: "/a.3mf", verdict: "rejected" }], "on the printer").reason, "every file on the printer was ruled out");
    assert.equal(settleSlicedFile([possible]).reason, "the only file written at the start that nothing rules out");
});

test("the log says when the listing found nothing either", () => {
    assert.equal(
        sliceFetchFailure({ jobName: "Würfel", tried: ["/cache/Würfel.3mf"], path: null, listed: 2, settled: "2 files written at the start could be it, so none is taken" }),
        "No sliced file on the printer under /cache/Würfel.3mf. Listed 2 3MF files on the printer: 2 files written at the start could be it, so none is taken",
    );
});

test("Bambu Studio's command and the file carry md5 and MakerWorld ids", () => {
    // The X2D's project_file echo of 2026-09-22, md5 anonymised
    assert.deepEqual(printIdentity({
        command: "project_file", md5: "774F0000000000000000000000000000", model_id: "USac90b077599b7c",
        profile_id: "1017501024", plate_idx: "1", design_id: "3071033",
    }), { md5: "774F0000000000000000000000000000", modelId: "USac90b077599b7c", profileId: "1017501024", plate: 1 });
    // A print without a cloud project sends zeros and empty strings
    assert.equal(printIdentity({ model_id: "", profile_id: "0", project_id: "0" }), null);

    assert.deepEqual(parseModelIds(`<metadata name="DesignModelId">USc2c7ad817530fc</metadata>
 <metadata name="DesignProfileId">167787430</metadata>`), { modelId: "USc2c7ad817530fc", profileId: "167787430" });
    assert.deepEqual(parseModelIds(`<metadata name="Title"></metadata>`), { modelId: null, profileId: null });
});

test("the md5 decides both ways, a MakerWorld id only confirms", () => {
    // A P2S printing PenroseTriangle from Bambu Handy on 2026-09-26: the
    // command's md5 was the whole file's, its ids the file's Design ids
    const file = { titles: ["Fast print and less filament - 0.2mm layer, 2 walls", "PenroseTriangle"], plates: [1], layers: 248,
        modelId: "US911eafb6a009f0", profileId: "801288487", fileMd5: "0d1b4dabe3b479109f4e64cd875daff7" };
    const base = { jobName: "PenroseTriangle", plate: 1, layers: 248 };

    assert.equal(judgeSlicedFile(file, { ...base, md5: "0D1B4DABE3B479109F4E64CD875DAFF7" }).verdict, "confirmed");
    assert.equal(judgeSlicedFile(file, { ...base, md5: "774f0000000000000000000000000000" }).verdict, "rejected");
    // After a restart mid print only the ids are left, which every report repeats
    assert.equal(judgeSlicedFile(file, { ...base, profileId: "801288487" }).verdict, "confirmed");
    assert.equal(judgeSlicedFile(file, { ...base, modelId: "US911eafb6a009f0" }).verdict, "confirmed");

    // An X2D printing a changed MakerWorld model sent ids of the user's own
    // cloud copy, so differing ids hand on to the title
    const cloudCopy = { ...base, jobName: "0.2mm layer, 3 walls, 15% infill", modelId: "USac90b077599b7c", profileId: "1017501024" };
    const cartPicker = { ...file, titles: ["0.2mm layer, 3 walls, 15% infill", "CartPicker"], modelId: "US59c38024b82730", profileId: "885007612", fileMd5: null };
    assert.equal(judgeSlicedFile(cartPicker, cloudCopy).verdict, "confirmed");
    assert.match(judgeSlicedFile(cartPicker, cloudCopy).reason, /profile id 885007612 differs/);
    assert.equal(judgeSlicedFile({ ...cartPicker, titles: [] }, cloudCopy).verdict, "possible");
    // The exclusions still come first
    assert.equal(judgeSlicedFile({ ...file, layers: 250 }, { ...base, md5: "0d1b4dabe3b479109f4e64cd875daff7" }).verdict, "rejected");
});

test("only the layers that print filament are counted", () => {
    // PenroseTriangle again: 248 layers in the G-code header and in total_layer_num
    const xml = `<layer_filament_lists>
      <layer_filament_list filament_list="" layer_ranges="248 249" />
      <layer_filament_list filament_list="0" layer_ranges="0 247" />
    </layer_filament_lists>`;
    assert.equal(countPrintedLayers(xml), 248);
    assert.equal(countPrintedLayers(""), null);
    // The booking maths counts the same way, as a 0-based last index
    assert.equal(parseSliceInfo(xml).totalLayers, 247);
    assert.deepEqual(parseSliceInfo(xml).rangesByFilamentIdx, { 0: [[0, 247]] });
});
