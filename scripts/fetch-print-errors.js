import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regenerates src/data/print-errors.json from Bambu Lab's error catalogue.
 *
 * The printer reports a print error as a number, `print_error` and
 * `fail_reason` in the MQTT report, and the catalogue that turns that number
 * into a sentence is served by Bambu Lab's own error lookup, the one Bambu
 * Studio and the Bambu Handy app query:
 *
 *   https://e.bambulab.com/query.php?lang=en&d=<serial prefix>
 *
 * The answer depends on the printer model, which the service picks by the
 * first three characters of a serial number, so the catalogue is fetched once
 * per known prefix and merged. Of the 964 codes with a sentence, 48 differed
 * in wording between models, mostly a mention of the AMS HT or of a second
 * nozzle; the wording most models share is what is kept, so the file stays
 * one sentence per code. Nine codes come without a sentence and are left out.
 *
 * Only `device_error` is kept, which is what the two fields above carry. The
 * catalogue also serves `device_hms`, the HMS notifications in `print.hms`,
 * three times as many codes and three times the bytes for a field this
 * service does not read.
 *
 * One file per language. English is `print-errors.json`, which the log and
 * the API speak, and every other language `print-errors.<lang>.json`, which
 * the Web UI shows in that language. A code a language lacks falls back to
 * English there. German and Polish are shipped because the Web UI speaks
 * them; another language is one more run with its code.
 *
 * Usage: node scripts/fetch-print-errors.js [lang]   (default en)
 *
 * The output is sorted and stable, so a rerun that changes nothing produces
 * no diff and a rerun that does shows exactly which sentences moved. ha-bambulab
 * keeps the same catalogue current through its scripts/update_error_text.py,
 * which is where the endpoint and the prefixes were learnt from.
 *
 * This file runs outside the service, so `src/logger.js` and its three
 * argument console signature are not in play here. The plain console is
 * correct.
 */

/**
 * The serial number prefixes the catalogue answers for, by printer model.
 *
 * A prefix the catalogue does not know answers `result` 201 and no data. The
 * X2D, H2C and A2L were tried with guessed prefixes and answered that, so they
 * are not listed: a serial of one of those printers would settle it.
 */
const SERIAL_PREFIXES = {
    X1: "00M",
    X1E: "03W",
    A1: "039",
    A1MINI: "030",
    P1P: "01S",
    P1S: "01P",
    P2S: "22E",
    H2S: "093",
    H2D: "094",
};

const LANG = (process.argv[2] || "en").toLowerCase();

const OUTPUT = path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "src", "data", LANG === "en" ? "print-errors.json" : `print-errors.${LANG}.json`,
);

/** One model's catalogue, or null when the endpoint has none for the prefix. */
async function fetchCatalogue(prefix) {
    const response = await fetch(`https://e.bambulab.com/query.php?lang=${LANG}&d=${prefix}`);
    if (!response.ok) throw new Error(`${prefix}: HTTP ${response.status}`);

    const body = await response.json();
    const entries = body?.data?.device_error?.[LANG];
    if (body?.result !== 0 || !Array.isArray(entries)) return null;

    return { version: body.ver, entries };
}

/**
 * The sentence most models agree on for a code.
 *
 * Ties go to the sentence seen first, which is the model listed first above,
 * so the choice is stable across runs.
 */
function majorityText(texts) {
    const counts = new Map();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    let best = null;
    for (const [text, count] of counts) {
        if (best === null || count > best.count) best = { text, count };
    }
    return best.text;
}

async function main() {
    const textsByCode = new Map();
    const versions = new Set();
    const models = [];

    for (const [model, prefix] of Object.entries(SERIAL_PREFIXES)) {
        const catalogue = await fetchCatalogue(prefix);
        if (!catalogue) {
            console.log(`${model} (${prefix}): no catalogue served, skipped`);
            continue;
        }
        models.push(model);
        versions.add(catalogue.version);
        console.log(`${model} (${prefix}): ${catalogue.entries.length} codes, catalogue version ${catalogue.version}`);

        for (const entry of catalogue.entries) {
            const code = String(entry.ecode).toUpperCase();
            const text = String(entry.intro).replace(/\s+/g, " ").trim();
            if (!/^[0-9A-F]{8}$/.test(code) || !text) continue;
            if (!textsByCode.has(code)) textsByCode.set(code, []);
            textsByCode.get(code).push(text);
        }
    }

    if (!models.length) throw new Error("no catalogue could be fetched");

    const errors = {};
    let differing = 0;
    for (const code of [...textsByCode.keys()].sort()) {
        const texts = textsByCode.get(code);
        if (new Set(texts).size > 1) differing++;
        errors[code] = majorityText(texts);
    }

    const output = {
        source: `https://e.bambulab.com/query.php?lang=${LANG}&d=<serial prefix>`,
        version: [...versions].sort().at(-1),
        models,
        errors,
    };

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`${Object.keys(errors).length} codes written to ${path.relative(process.cwd(), OUTPUT)}, ` +
        `${differing} of them worded differently between models, majority wording kept`);
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
