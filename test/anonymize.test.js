import test from "node:test";
import assert from "node:assert/strict";

import {
    MASKED_CODE,
    exportPrinters,
    exportSettings,
    maskHost,
    maskIp,
    maskPath,
    maskSerial,
    maskTag,
    maskCloudUrl,
    maskText,
    maskUrl,
} from "../src/anonymize.js";

test("an IPv4 address keeps its network and loses its host", () => {
    assert.equal(maskIp("192.168.1.42"), "192.168.1.XXX");
    assert.equal(maskIp("10.0.0.1"), "10.0.0.XXX");
});

test("an IPv6 address keeps its first two groups", () => {
    assert.equal(maskIp("fd00:1234:5678:9abc::1"), "fd00:1234:XXXX:XXXX::XXXX");
});

test("something that is not an address is left alone", () => {
    assert.equal(maskIp("printer.local"), "printer.local");
    assert.equal(maskIp(""), "");
});

test("a serial number keeps its first five characters", () => {
    assert.equal(maskSerial("01P00A123456789"), "01P00XXXXXXXXXX");
    // Same length, so a log line does not change shape
    assert.equal(maskSerial("01P00A123456789").length, "01P00A123456789".length);
});

test("a serial too short to mask is returned unchanged", () => {
    assert.equal(maskSerial("01P0"), "01P0");
});

test("a host name keeps only its last label", () => {
    assert.equal(maskHost("spoolman.example.net"), "XXX.XXX.net");
    // A single label is not identifying and stays readable
    assert.equal(maskHost("localhost"), "localhost");
    assert.equal(maskHost("spoolman"), "spoolman");
});

test("a URL keeps everything that makes it debuggable", () => {
    assert.equal(maskUrl("http://192.168.1.9:30010"), "http://192.168.1.XXX:30010");
    assert.equal(maskUrl("https://spoolman.example.net/spoolman"), "https://XXX.XXX.net/spoolman");
});

test("a URL loses any credentials it carries", () => {
    assert.equal(maskUrl("https://user:secret@spoolman.example.net:7912/sub"), "https://XXX.XXX.net:7912/sub");
});

test("the mask survives the lower casing a URL normally applies", () => {
    // URL.hostname lower cases what it is given, which would turn XXX into xxx
    assert.ok(maskUrl("http://192.168.1.9:30010").includes("XXX"));
});

test("a path is shortened to its last two segments", () => {
    assert.equal(maskPath("/Users/somebody/checkout/printers"), ".../checkout/printers");
    assert.equal(maskPath("/app/printers"), "/app/printers");
});

test("a log line loses the address, the serial and the code", () => {
    const line = "Printer 01P00A123456789 with IP 192.168.1.250 code 12345678 is unreachable";
    const masked = maskText(line, { codes: ["12345678"], serials: ["01P00A123456789"] });

    assert.equal(masked, `Printer 01P00XXXXXXXXXX with IP 192.168.1.XXX code ${MASKED_CODE} is unreachable`);
});

test("an access code that sits inside a serial number does not cut it up", () => {
    // The regression this ordering exists for: masking the code first turns
    // 01P00A123456789 into 01P00AXXX9, which no serial pass recognises again.
    const masked = maskText("serial 01P00A123456789", {
        codes: ["12345678"],
        serials: ["01P00A123456789"],
    });

    assert.equal(masked, "serial 01P00XXXXXXXXXX");
});

test("a serial of a printer that is no longer configured is masked as well", () => {
    // Older log files still carry it, and nothing in the current list matches
    assert.equal(maskText("old 01S00B987654321 gone", {}), "old 01S00XXXXXXXXXX gone");
});

test("a P2S serial is caught by the generic pattern, not only a P1S one", () => {
    // The pattern used to require a leading zero, which the P1S examples in the
    // README have. A real P2S reports 22E8BJ581201877 and slipped through.
    assert.equal(maskText("Printer 22E8BJ581201877 offline", {}), "Printer 22E8BXXXXXXXXXX offline");
});

test("an RFID tag keeps its first four characters", () => {
    assert.equal(maskTag("A5F4AA83"), "A5F4XXXX");
    assert.equal(maskTag("18F1DE9B4FF74902A7CAA100D8F2CB5F"), "18F1XXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    // Same length, so a log line does not change shape
    assert.equal(maskTag("A5F4AA83").length, "A5F4AA83".length);
});

test("what a slot reports instead of a tag is not a tag and stays", () => {
    assert.equal(maskTag("N/A"), "N/A");
    assert.equal(maskTag(""), "");
    // The all zero uuid is how a chipless spool reads, which is the answer to
    // half the questions a report is about
    assert.equal(maskTag("00000000000000000000000000000000"), "00000000000000000000000000000000");
});

test("the RFID tag of a spool is masked in a log line", () => {
    const uuid = "18F1DE9B4FF74902A7CAA100D8F2CB5F";
    assert.equal(
        maskText(`[A1] PLA Basic 000000FF [[ ${uuid} ]]`, {}),
        "[A1] PLA Basic 000000FF [[ 18F1XXXXXXXXXXXXXXXXXXXXXXXXXXXX ]]",
    );
    // The eight character tag of an older AMS has the shape of a tray colour,
    // so only the brackets tell the two apart
    assert.equal(
        maskText("[A1] PLA Basic FF6A13FF [[ A5F4AA83 ]]", {}),
        "[A1] PLA Basic FF6A13FF [[ A5F4XXXX ]]",
    );
});

test("a colour is not mistaken for a tag", () => {
    assert.equal(maskText("[A1] PLA Basic FF6A13FF (85%)", {}), "[A1] PLA Basic FF6A13FF (85%)");
});

test("the tag is masked in the debug dumps as well", () => {
    assert.equal(
        maskText(`{"tray_color":"FF6A13FF","tray_uuid":"A5F4AA83"}`, {}),
        `{"tray_color":"FF6A13FF","tray_uuid":"A5F4XXXX"}`,
    );
    // extra.tag holds the tag JSON encoded inside the JSON, escaped quotes and
    // all, which is what Spoolman stores
    assert.equal(
        maskText(`{"extra":{"tag":"\\"A5F4AA83\\""}}`, {}),
        `{"extra":{"tag":"\\"A5F4XXXX\\""}}`,
    );
});

test("the md5 of a print command is not taken for a tag", () => {
    // Bambu Studio sends it uppercase, which is the shape of a current AMS tag.
    // It names the sliced file and nothing else, and ties the print to it
    const command = `{ "print": { "command": "project_file", "md5": "8E9BB94962BAD047A4EDB1596F7029F9", "tray_uuid": "A5F4AA8300000000000000000000ABCD" } }`;
    assert.equal(
        maskText(command, {}),
        `{ "print": { "command": "project_file", "md5": "8E9BB94962BAD047A4EDB1596F7029F9", "tray_uuid": "A5F4XXXXXXXXXXXXXXXXXXXXXXXXXXXX" } }`,
    );
    // The same value anywhere else is still masked
    assert.equal(maskText("seen 8E9BB94962BAD047A4EDB1596F7029F9", {}), "seen 8E9BXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
});

test("a placeholder tag survives every pass of the masking", () => {
    assert.equal(maskText(`[External] N/A [[ N/A ]] {"tray_uuid":"N/A"}`, {}), `[External] N/A [[ N/A ]] {"tray_uuid":"N/A"}`);
});

test("every address in a log is masked, configured or not", () => {
    assert.equal(maskText("from 10.1.2.3 to 172.16.9.100", {}), "from 10.1.2.XXX to 172.16.9.XXX");
});

test("the access code is replaced in the full export as well", () => {
    const entries = [{ id: "01P00A123456789", ip: "192.168.1.250", name: "P2S", code: "12345678" }];

    assert.deepEqual(exportPrinters(entries, false), [
        { id: "01P00A123456789", ip: "192.168.1.250", name: "P2S", code: MASKED_CODE },
    ]);
    assert.deepEqual(exportPrinters(entries, true), [
        { id: "01P00XXXXXXXXXX", ip: "192.168.1.XXX", name: "P2S", code: MASKED_CODE },
    ]);
});

test("only the settings that carry an address are masked", () => {
    const values = {
        SPOOLMAN_ENDPOINT: "http://192.168.1.9:7912",
        SPOOLMAN_FQDN: "https://spoolman.example.net",
        SPOOLMAN_IP: "192.168.1.9",
        UPDATE_INTERVAL: 60000,
        MODE: "automatic",
    };

    const masked = exportSettings(values, true);
    assert.equal(masked.SPOOLMAN_ENDPOINT, "http://192.168.1.XXX:7912");
    assert.equal(masked.SPOOLMAN_FQDN, "https://XXX.XXX.net");
    assert.equal(masked.SPOOLMAN_IP, "192.168.1.XXX");
    assert.equal(masked.UPDATE_INTERVAL, 60000);
    assert.equal(masked.MODE, "automatic");

    assert.deepEqual(exportSettings(values, false), values);
});

test("the upload address in a Studio echo keeps its host and nothing else", () => {
    const line = '2026-09-09_16:55:23 {"print":{"command":"project_file","subtask_name":"Würfel","ams_mapping":[0,1,3],'
        + '"url":"https://or-cloud-upload-prod.s3.us-west-2.amazonaws.com/users/2160108466/models/20260909225520.711/USf0c790810afb1e_988629317_1.3mf'
        + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAXY6FH2ERJ3UALUNL%2F20260909%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Signature=e46388b1561a2c87","reason":"success"}}';
    const masked = maskText(line);
    assert.ok(masked.includes('"url":"https://or-cloud-upload-prod.s3.us-west-2.amazonaws.com/XXX"'), masked);
    assert.ok(!masked.includes("2160108466"));
    assert.ok(!masked.includes("X-Amz-Signature"));
    // The rest of the echo is what a report is about and stays
    assert.ok(masked.includes('"ams_mapping":[0,1,3]'));
});

test("a LAN print's address in a Studio echo is not a cloud address and stays", () => {
    const line = '{"print":{"command":"project_file","url":"ftp:///cache/Cube.gcode.3mf"}}';
    assert.equal(maskText(line), line);
});

test("a cloud address that is not a URL is masked whole", () => {
    assert.equal(maskCloudUrl("not a url"), "XXX");
    assert.equal(maskCloudUrl("https://example.com:8443/a/b?c=d"), "https://example.com:8443/XXX");
});

test("maskText masks the uid of a native Spoolman tag, whatever its length", () => {
    assert.equal(
        maskText(`{"tags":[{"uid":"04A1B2C3D4E5F6","format":"ntag"},{"uid":"0417584A3ABE4274838571DB6AA6CABA","format":"bambu"}]}`, {}),
        `{"tags":[{"uid":"04A1XXXXXXXXXX","format":"ntag"},{"uid":"0417XXXXXXXXXXXXXXXXXXXXXXXXXXXX","format":"bambu"}]}`,
    );
});
