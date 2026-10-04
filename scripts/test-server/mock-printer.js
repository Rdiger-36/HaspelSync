import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AMS_UNITS, EXTERNAL_SPOOL } from "./scenario.js";

/**
 * A Bambu Lab printer that only exists in this process.
 *
 * It answers on 8883 over TLS, speaks just enough MQTT 3.1.1 for the service to
 * connect and subscribe, and then publishes the scenario as a `push_status`
 * report on `device/<serial>/report` on a timer.
 *
 * The broker is written out here rather than pulled in as a dependency. Six
 * packet types are all this needs, and `package.json` is what the container
 * installs from, so a broker library would ship in the image for the sake of a
 * script that never runs there.
 *
 * The certificate is self signed and thrown away with the process. That is what
 * a real printer presents too, which is why `setupMqtt()` connects with
 * `rejectUnauthorized: false`.
 */

const CONNECT = 1;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const UNSUBSCRIBE = 10;
const PINGREQ = 12;
const DISCONNECT = 14;

/**
 * A throwaway key and certificate for the TLS listener.
 *
 * openssl is on the PATH on macOS and Linux and is installed in the image, so
 * shelling out avoids a dependency for something no production path uses.
 */
function selfSignedCertificate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ams-mock-printer-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");

    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "1", "-subj", "/CN=mock-printer",
    ], { stdio: "ignore" });

    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** MQTT encodes a packet length as a base 128 varint of up to four bytes. */
function encodeRemainingLength(length) {
    const bytes = [];
    let value = length;

    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) byte |= 128;
        bytes.push(byte);
    } while (value > 0);

    return Buffer.from(bytes);
}

/**
 * Reads the varint back.
 *
 * @returns {{value: number, bytes: number}|null} null while the buffer is still
 *          short of the whole varint
 */
function decodeRemainingLength(buffer, offset) {
    let multiplier = 1;
    let value = 0;
    let index = offset;
    let byte;

    do {
        if (index >= buffer.length) return null;
        if (index - offset === 4) throw new Error("Malformed remaining length");
        byte = buffer[index++];
        value += (byte & 127) * multiplier;
        multiplier *= 128;
    } while ((byte & 128) !== 0);

    return { value, bytes: index - offset };
}

/** A QoS 0 PUBLISH, the only packet the printer side ever sends unprompted. */
function publishPacket(topic, payload) {
    const topicBuffer = Buffer.from(topic, "utf8");
    const topicLength = Buffer.alloc(2);
    topicLength.writeUInt16BE(topicBuffer.length);

    const body = Buffer.concat([topicLength, topicBuffer, Buffer.from(payload, "utf8")]);
    return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);
}

/**
 * The topic and the payload of a PUBLISH the service sent, which is a command.
 *
 * @param {Buffer} payload - the packet body after the fixed header
 * @param {number} flags - the low nibble of the first byte, where the QoS sits
 */
function parsePublish(payload, flags) {
    const topicLength = payload.readUInt16BE(0);
    const topic = payload.toString("utf8", 2, 2 + topicLength);
    // A packet id follows the topic for QoS 1 and 2 only.
    const qos = (flags >> 1) & 3;
    const body = payload.subarray(2 + topicLength + (qos ? 2 : 0));
    return { topic, body: body.toString("utf8") };
}

/**
 * What a printer answers to `{"info":{"command":"get_version"}}`: one entry
 * per module, the AMS units named by family prefix and unit id, the way
 * `amsModelsFromVersion()` in src/ams.js reads them. Copied in shape from the
 * answers of a P1S and an X1E of 2026-09-07, serials left out.
 *
 * @param {string} serial - the printer's serial number
 * @param {object[]} units - the AMS units of the report, for their ids
 * @param {string} family - the prefix for the four slot units: `ams` for the
 *   original AMS, `ams_f1` for an AMS Lite, `n3f` for an AMS 2 Pro. An HT is
 *   always `n3s`, nothing else sits at unit id 128 and up
 */
function versionAnswer(serial, units, family) {
    const HARDWARE = { ams: "AMS08", ams_f1: "AMS_F102", n3f: "N3F01", n3s: "N3S01" };
    const NAMES = { ams: "AMS (1)", ams_f1: "AMS Lite", n3f: "AMS 2 Pro", n3s: "AMS HT" };
    const modules = [
        { name: "ota", sw_ver: "01.10.00.00", hw_ver: "OTA", loader_ver: "00.00.00.00", sn: serial, product_name: "Mock printer", visible: true, flag: 0 },
    ];

    for (const unit of units) {
        const id = Number(unit.id);
        if (!Number.isInteger(id)) continue;
        const prefix = id >= 128 ? "n3s" : family;
        modules.push({
            name: `${prefix}/${id}`,
            sw_ver: "01.00.06.00",
            hw_ver: HARDWARE[prefix],
            loader_ver: "00.00.00.00",
            sn: `00600MOCK${String(id).padStart(6, "0")}`,
            product_name: NAMES[prefix],
            visible: true,
            flag: 0,
        });
    }

    return JSON.stringify({ info: { command: "get_version", sequence_id: "0", module: modules, result: "success", reason: "" } });
}

/** The topic filters of a SUBSCRIBE, with the packet id in front of them. */
function parseSubscribe(payload) {
    const packetId = payload.readUInt16BE(0);
    const topics = [];
    let offset = 2;

    while (offset + 2 <= payload.length) {
        const length = payload.readUInt16BE(offset);
        offset += 2;
        topics.push(payload.toString("utf8", offset, offset + length));
        // One byte of requested QoS follows every filter.
        offset += length + 1;
    }

    return { packetId, topics };
}

/**
 * Whether a subscription covers a topic. Only the two wildcards MQTT defines,
 * which is more than the service needs but keeps a mistyped filter honest.
 */
function topicMatches(filter, topic) {
    const filterParts = filter.split("/");
    const topicParts = topic.split("/");

    for (let i = 0; i < filterParts.length; i++) {
        if (filterParts[i] === "#") return true;
        if (i >= topicParts.length) return false;
        if (filterParts[i] !== "+" && filterParts[i] !== topicParts[i]) return false;
    }

    return filterParts.length === topicParts.length;
}

/**
 * The report the printer publishes, in the shape `handleMqttMessage()` reads.
 *
 * A full report carries the external spool holder next to the AMS block, the
 * way a P2S sends it in every report. A delta report is what a P1S sends
 * between two full ones, confirmed by the raw trace of issue #131: the AMS
 * block is there, the holder is not mentioned at all, and `msg` is 1 rather
 * than 0. The service has to read the missing key as "nothing changed" rather
 * than as an empty holder, or the External slot vanishes on every delta.
 *
 * @param {object|null} fixture - a captured `print` block, published as it was
 *   captured apart from the sequence id, which is the one field a printer
 *   never repeats. The point of a fixture is to see what the service makes of
 *   a report nobody here can produce, so nothing else is touched
 * @param {boolean} delta - leave the holder out, as a delta report does
 * @param {boolean} storage - what the scenario reports as `sdcard`
 */
function buildReport(fixture, delta, storage) {
    if (fixture) {
        return JSON.stringify({ print: { ...fixture, sequence_id: String(Date.now()) } });
    }

    return JSON.stringify({
        print: {
            command: "push_status",
            msg: delta ? 1 : 0,
            sequence_id: String(Date.now()),
            gcode_state: "IDLE",
            layer_num: 0,
            subtask_name: "",
            // Whether the USB stick is in. A real P2S reports true with one.
            sdcard: storage,
            // The external spool holder, which the printer reports outside the
            // AMS block. Older firmware called the same thing vt_tray.
            ...(delta ? {} : { vir_slot: EXTERNAL_SPOOL }),
            nozzle_temper: 24.4,
            bed_temper: 23.1,
            ams: {
                ams: AMS_UNITS,
                ams_exist_bits: "f",
                tray_exist_bits: "ffff",
                tray_is_bbl_bits: "ffff",
                tray_now: "0",
                tray_pre: "0",
                tray_read_done_bits: "ffff",
                tray_reading_bits: "0",
                version: 1,
            },
        },
    });
}

/**
 * The `print` block of a captured report under test/fixtures/reports.
 *
 * Those files are what real printers sent, most of them printers nobody here
 * owns, so publishing one is the only way to see the dashboard draw an AMS
 * Lite, an AMS HT or a second external holder. The README in that directory
 * says what each one holds.
 *
 * @param {string} name - file name without the extension, for example "x1c-multi-ams"
 * @returns {object} the report's `print` block
 */
export function loadReport(name) {
    const file = path.join(REPORTS_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
        const available = fs.readdirSync(REPORTS_DIR)
            .filter(entry => entry.endsWith(".json"))
            .map(entry => entry.replace(/\.json$/, ""))
            .sort();
        throw new Error(`no report fixture "${name}", available: ${available.join(", ")}`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8")).pushall.print;
}

const REPORTS_DIR = path.join(
    path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    "test", "fixtures", "reports",
);

/**
 * Starts the mock printer.
 *
 * @param {object} options
 * @param {string} options.serial - serial number, which is part of the topic
 * @param {number} options.port - TLS port, 8883 on a real printer
 * @param {number} options.interval - milliseconds between two reports
 * @param {(line: string) => void} options.log - where connection lines go
 * @param {object} [options.report] - a captured `print` block from `loadReport()`, published instead of the scenario
 * @param {boolean} [options.deltaReports] - make every second report a delta
 *   that leaves the external spool holder out, the way a P1S does. See
 *   `buildReport()`
 * @param {boolean} [options.storage] - what the scenario reports as `sdcard`,
 *   true unless `--no-storage` was given. A fixture carries its own value
 * @param {string} [options.amsModel] - what the four slot units answer as in
 *   `get_version`: `n3f` (AMS 2 Pro, the default, which is what the scenario's
 *   P2S carries), `ams` (original AMS) or `ams_f1` (AMS Lite). See
 *   `versionAnswer()`
 * @returns {Promise<{close: () => Promise<void>, reports: () => number}>}
 */
export function startMockPrinter({ serial, port, interval, log, report = null, deltaReports = false, storage = true, amsModel = "n3f" }) {
    const topic = `device/${serial}/report`;
    const units = report?.ams?.ams ?? AMS_UNITS;
    const clients = new Set();
    let reports = 0;
    let built = 0;

    const server = tls.createServer({ ...selfSignedCertificate() }, socket => {
        const client = { socket, subscriptions: [] };
        clients.add(client);
        log(`client connected from ${socket.remoteAddress}`);

        let buffer = Buffer.alloc(0);

        socket.on("data", chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            for (;;) {
                if (buffer.length < 2) return;

                let header;
                try {
                    header = decodeRemainingLength(buffer, 1);
                } catch (error) {
                    log(`dropping a client: ${error.message}`);
                    socket.destroy();
                    return;
                }
                if (!header) return;

                const total = 1 + header.bytes + header.value;
                if (buffer.length < total) return;

                const type = buffer[0] >> 4;
                const flags = buffer[0] & 0x0F;
                const payload = buffer.subarray(1 + header.bytes, total);
                buffer = buffer.subarray(total);

                handlePacket(client, type, flags, payload, log, answerCommand);
            }
        });

        socket.on("error", () => { /* a client going away is not an event here */ });
        socket.on("close", () => {
            clients.delete(client);
            log("client disconnected");
        });
    });

    // The service checks whether the printer answers on the port at all before
    // it connects, with a bare TCP socket that never completes a handshake.
    server.on("tlsClientError", () => {});

    /**
     * Answers the two commands the service sends, `get_version` and `pushall`,
     * on the report topic the way a printer does. Everything else a real
     * printer would act on and this one has no state for.
     */
    function answerCommand(client, command) {
        let parsed;
        try {
            parsed = JSON.parse(command.body);
        } catch {
            return;
        }
        if (!client.subscriptions.some(filter => topicMatches(filter, topic))) return;

        if (parsed?.info?.command === "get_version") {
            client.socket.write(publishPacket(topic, versionAnswer(serial, units, amsModel)));
            log(`answered get_version with ${units.length} AMS unit(s) as ${amsModel}`);
        } else if (parsed?.pushing?.command === "pushall") {
            client.socket.write(publishPacket(topic, buildReport(report, false, storage)));
            log("answered pushall with a full report");
        }
    }

    const timer = setInterval(() => {
        // Full, delta, full, delta: the first report a client sees is the one
        // it has to build the slots from, so the full one comes first.
        const payload = buildReport(report, deltaReports && built % 2 === 1, storage);
        built++;
        let sent = 0;

        for (const client of clients) {
            if (!client.subscriptions.some(filter => topicMatches(filter, topic))) continue;
            client.socket.write(publishPacket(topic, payload));
            sent++;
        }

        if (sent) reports++;
    }, interval);

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            log(`listening on ${port}, publishing ${topic} every ${interval} ms` +
                (deltaReports ? ", every second one a delta without the holder" : ""));
            resolve({
                reports: () => reports,
                close: () => new Promise(done => {
                    clearInterval(timer);
                    for (const client of clients) client.socket.destroy();
                    server.close(() => done());
                }),
            });
        });
    });
}

/** Answers the packets a subscribing client sends, and ignores the rest. */
function handlePacket(client, type, flags, payload, log, answerCommand) {
    switch (type) {
        case CONNECT:
            // Accepted unconditionally: the access code a real printer checks is
            // not what this is here to exercise.
            client.socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
            break;

        case SUBSCRIBE: {
            const { packetId, topics } = parseSubscribe(payload);
            client.subscriptions.push(...topics);
            log(`subscribed to ${topics.join(", ")}`);

            const granted = Buffer.alloc(2 + topics.length);
            granted.writeUInt16BE(packetId, 0);
            client.socket.write(Buffer.concat([
                Buffer.from([0x90]),
                encodeRemainingLength(granted.length),
                granted,
            ]));
            break;
        }

        case UNSUBSCRIBE: {
            const packetId = payload.readUInt16BE(0);
            client.subscriptions = [];
            const acknowledgement = Buffer.alloc(2);
            acknowledgement.writeUInt16BE(packetId, 0);
            client.socket.write(Buffer.concat([Buffer.from([0xB0, 0x02]), acknowledgement]));
            break;
        }

        case PINGREQ:
            client.socket.write(Buffer.from([0xD0, 0x00]));
            break;

        case DISCONNECT:
            client.socket.end();
            break;

        case PUBLISH:
            // A command. The service sends two, get_version and pushall, right
            // after it subscribes; see answerCommand() in startMockPrinter().
            answerCommand(client, parsePublish(payload, flags));
            break;

        default:
            log(`ignoring packet type ${type}`);
    }
}
