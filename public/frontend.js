import {
    ACTIVE_PRINT_STATES,
    EXTERNAL_SLOT,
    SECOND_EXTERNAL_SLOT,
    SLOT_OPTIONS,
    allToday,
    correctRemainInt,
    filamentColors,
    formatCounter,
    formatDate,
    formatMoment,
    formatRemaining,
    humanLayers,
    normColor,
    slotColors,
    spoolWeightLimit,
} from "./shared.js";
import { bambuProfile, materialsAgree, presetVendor, slotMaterial, slotPreset } from "./materials.js";
import { catalogueColors, colorSetDistance, rankCatalogueEntries, uniqueSpoolForSlot } from "./match.js";
import { escapeHtml, fetchJson, sendJson } from "./ui.js";

let autoButton = null;
// When false (default) the spool weight is tracked from the sliced G-code, so the
// main table shows the Spoolman remaining weight instead of the AMS RFID remain %.
let legacyMode = false;
// Spoolman reachability, mirrored from /api/status. Read as a flag rather than
// parsed back out of the status pill's text, which carries a "● " prefix.
let spoolmanConnected = false;
// Render context of the last full legacy-table render, reused for single-row
// SSE updates (see upsertSpoolRow).
let lastLegacyCtx = null;
// Printer name, used to suggest a location matching the SET_LOCATION format.
let currentPrinterName = "";
// gcode_state of the shown printer, mirrored from /api/status and kept fresh by
// the G-code view, which reads it again from /api/print.
let printerGcodeState = "IDLE";
// Why a slot without an RFID tag is not a fault. Shown in both views: on the
// identity line of the row and on the warning triangle in the State column,
// which names no reason by itself.
// Read once at load, which is late enough: the language tables are loaded by
// plain script tags in the head, before any module runs.
const THIRD_PARTY_HINT = t("dashboard.hint.thirdParty");
const ARCHIVED_HINT = t("dashboard.hint.archived");

/**
 * What a slot action button shows for an option.
 *
 * The option itself is a contract with the server and the Home Assistant
 * integration and stays English: it is what the code compares, and it travels
 * on the button as `data-option`. Only the words on the button are translated.
 * An option this page has no key for, one a newer server learned, shows as it
 * arrives.
 */
function optionLabel(option) {
    const name = Object.keys(SLOT_OPTIONS).find(key => SLOT_OPTIONS[key] === option);
    return name && I18N.has(`dashboard.slotOption.${name}`) ? t(`dashboard.slotOption.${name}`) : option;
}

/**
 * The error a print ended with, in the viewer's language: the server's parts
 * put into words from the table, with Bambu Lab's sentence in that language
 * where its catalogue has one. A summary from before the parts existed shows
 * the English line it carries.
 */
function printErrorLine(summary) {
    const parts = summary.printErrorDetails;
    if (!Array.isArray(parts) || !parts.length) return summary.printError;
    const lang = I18N.language();
    return parts.map(part => {
        const text = part.texts?.[lang] ?? part.texts?.en;
        const key = part.kind === "fail" ? "print.error.fail" : "print.error.printer";
        return text ? t(`${key}Text`, { code: part.code, text }) : t(key, { code: part.code });
    }).join(", ");
}

// The slot states the server compares and hands out, by the key their words
// are looked up under.
const SLOT_STATE_KEYS = {
    "Empty": "empty",
    "Loaded (Bambu Lab)": "loadedBambuLab",
    "Loaded (3rd party)": "loadedThirdParty",
    "Loaded (archived)": "loadedArchived",
};

/** A slot state in the viewer's language, or as the server sent it where there is no key for it. */
function slotStateLabel(state) {
    const key = SLOT_STATE_KEYS[state];
    return key ? t(`dashboard.slotState.${key}`) : state;
}

/** Spoolman's multi_color_direction in words, the value itself where there is no key for it. */
function directionLabel(direction) {
    return I18N.has(`dashboard.direction.${direction}`) ? t(`dashboard.direction.${direction}`) : direction;
}

/** A value the server reports in English, in the viewer's language where a key for it exists. */
function serverWord(group, value) {
    const key = `dashboard.${group}.${value}`;
    return value != null && I18N.has(key) ? t(key) : value;
}

// Humidity, temperature and drying state per AMS unit, keyed by the unit part
// of a slot label ("A" for A1 to A4, "HT-A" for a single slot unit). Mirrored
// from /api/status and kept fresh by the ams_env SSE event, which arrives at
// most every 30 seconds because the readings never sit still.
let amsEnvByUnit = {};

// The payload behind every rendered row, by AMS slot id. The detail dialog is
// opened from a delegated listener, which sees the clicked element rather than
// the object the row was built from, and rows are recreated on every update.
const renderedSpools = new Map();

// Initialize the document once it has fully loaded
document.addEventListener("DOMContentLoaded", () => {

    document.getElementById("monitoring-toggle").addEventListener("change", toggleMonitoring);

    // Clicking a filament name opens the spool detail dialog. Delegated, because
    // both views rebuild their rows on every update and an SSE slot update
    // replaces a single row in place, which would drop a listener bound to it.
    document.getElementById("spool-list").addEventListener("click", event => {
        // The header of a unit folds its slots away and back. The whole line
        // is the control, the chevron in it only says so.
        const caption = event.target.closest("caption.ams-env");
        if (caption) {
            const table = caption.closest("table");
            setUnitCollapsed(caption.dataset.unit, !table.classList.contains("is-collapsed"));
            applyUnitCollapsed(table);
            return;
        }

        const name = event.target.closest(".spool-name-link");
        if (!name) return;
        const amsSpool = renderedSpools.get(name.dataset.amsid);
        if (amsSpool) showSpoolDetailDialog(amsSpool);
    });

    // The menu bar owns the printer list and the dark mode button. Picking a
    // printer switches the dashboard in place instead of navigating.
    initMenubar({
        onPrinters: showPrinters,
        onPrinterSelect: printer => {
            loadPrinterData(printer.id);
            return true;
        },
    });

    // Set up Server-Sent Events (SSE) connection for real-time updates
    const eventSource = new EventSource('./api/events'); // Backend URL for events

    // Handle incoming messages from SSE
    eventSource.onmessage = function (event) {
        // Parse the event data
        const data = JSON.parse(event.data);
        const printerId = document.getElementById('printer-serial').textContent;

        if (data.type === 'slot_update' && data.printer === printerId && !isDialogOpen()) {
            if (legacyMode) upsertSpoolRow(data.spool);
            else scheduleGcodeRefresh();
        } else if (data.type === 'status' && data.printer === printerId) {

            if (data.lastMqttUpdate) {
                updateElementText(
                   "last-mqtt-update",
                   formatDate(new Date(data.lastMqttUpdate))
                );
            }
            if (data.lastMqttAmsUpdate) {
                updateElementText(
                   "last-mqtt-ams-update",
                   formatDate(new Date(data.lastMqttAmsUpdate))
                );
            }
            // Keep the G-code dashboard (print state / progress) live
            if (!legacyMode) scheduleGcodeRefresh();
        } else if (data.type === 'ams_env' && data.printer === printerId) {
            // The captions only, not a table rebuild: the readings change on
            // their own schedule and a rebuild would drop an open row state and
            // fight the column width sync for nothing.
            setAmsEnv(data.amsEnv);
            refreshAmsEnvCaptions();
        } else if (data.type === 'print_filaments' && data.printer === printerId && !isDialogOpen()) {
            // A spool was named for a filament swapped onto the external
            // holder, here or in another tab
            if (!legacyMode) scheduleGcodeRefresh();
        } else if (data.type === 'print_result_cleared' && data.printer === printerId) {
            // Somebody cleared the finished print, here or in another tab
            if (!legacyMode) scheduleGcodeRefresh();
        } else if (data.type === 'refresh' && data.printer === printerId) {
            refreshMenubarPrinters();
        } else if (data.type === "monitoring_update") {
            if (data.printer === printerId) setMonitoringSwitch(data.enabled);
        } else if (data.type === "printers_update") {
            // A printer was added, renamed or removed on the settings page
            refreshMenubarPrinters();
        } else if (data.type === "settings_update") {
            // The status card shows the operation mode and the tracking mode,
            // so it has to be refetched when they change
            if (currentPrinterId) loadPrinterData(currentPrinterId);
        }
    };

    // Handle errors in SSE connection
    eventSource.onerror = function(error) {
        console.error("Error with the SSE connection:", error);
    };

    /**
     * Shows one notice in the dialog and resolves once it was dismissed.
     *
     * Every button dismisses it, because each means the hint was read, and the
     * dismissal is stored server side: a notice is shown once per installation
     * rather than once per browser. Escape closes the dialog without storing
     * anything, so it comes back on the next load, which is the safe way round.
     *
     * "Open the settings" is only offered where the settings page is the
     * answer to the notice; it leaves the page, and with it any notice still
     * waiting behind this one.
     *
     * @param {string} id - the notice id the server acknowledges
     * @param {string} title
     * @param {string[]} parts - the paragraphs, as markup
     * @param {boolean} [settingsButton] - whether to offer "Open the settings"
     * @returns {Promise<void>}
     */
    function showNoticeDialog(id, title, parts, settingsButton = false) {
        const dialog = document.getElementById("notice-dialog");
        document.getElementById("notice-dialog-title").textContent = title;
        document.getElementById("notice-dialog-content").innerHTML = parts.join("");
        document.getElementById("notice-dialog-open").hidden = !settingsButton;

        const acknowledge = async () => {
            try {
                await fetch(`./api/notices/${encodeURIComponent(id)}/ack`, { method: "POST" });
            } catch {
                // Then it is shown again on the next load.
            }
        };

        return new Promise(resolve => {
            document.getElementById("notice-dialog-close").onclick = async () => {
                await acknowledge();
                dialog.close();
                resolve();
            };

            document.getElementById("notice-dialog-open").onclick = async () => {
                await acknowledge();
                dialog.close();
                window.location.href = "settings.html";
            };

            dialog.showModal();
            document.getElementById("notice-dialog-close").focus();
        });
    }

    /**
     * An installation updated from 1.2.x is told what changed, once.
     *
     * The three things it can trip over are not visible on the dashboard: the
     * slot labels moved up by one, the API asks for a key, and a name the
     * service is reached under has to be allowed. The server decides whether
     * this installation is one, from its files, see src/upgradenotice.js.
     */
    async function showUpgradeNotice(notice) {
        if (!notice || !notice.active || notice.acknowledged) return;

        // The table texts carry the little markup these paragraphs need, <b>
        // and <code>; they come from this repository, not from a request.
        const docsLink = notice.docs
            ? `<p>${t("dashboard.notice.upgrade.docs", {
                link: `<a href="${escapeHtml(notice.docs)}" target="_blank" rel="noopener">${escapeHtml(t("dashboard.notice.upgrade.docsLink"))}</a>`,
            })}</p>`
            : "";

        await showNoticeDialog("upgrade-1.3.0", t("dashboard.notice.upgrade.title"), [
            `<p>${t("dashboard.notice.upgrade.intro")}</p>`,
            "<ul>",
            `<li>${t("dashboard.notice.upgrade.slots")}</li>`,
            `<li>${t("dashboard.notice.upgrade.apiKey")}</li>`,
            `<li>${t("dashboard.notice.upgrade.hostName")}</li>`,
            `<li>${t("dashboard.notice.upgrade.consumption")}</li>`,
            "</ul>",
            docsLink,
        ]);
    }

    /**
     * Configuration through environment variables is deprecated since 1.3.0.
     *
     * The notice stops being sent on its own as soon as the values have been
     * saved on the settings page.
     */
    async function showDeprecationNotice(notice) {
        if (!notice || !notice.active || notice.acknowledged) return;

        const code = list => `<code>${list.map(escapeHtml).join("</code>, <code>")}</code>`;
        const parts = [
            `<p>${t("dashboard.notice.env.intro")}</p>`,
            `<p>${t("dashboard.notice.env.keepWorking")}</p>`,
        ];

        if (notice.variables && notice.variables.length) {
            parts.push(`<p>${t("dashboard.notice.env.fromEnvironment", { list: code(notice.variables) })}</p>`);
        }

        if (notice.printerVariables && notice.printerVariables.length) {
            const list = code(notice.printerVariables);
            parts.push(notice.printerVariablesIgnored
                ? `<p>${t("dashboard.notice.env.printerVariablesIgnored", { list })}</p>`
                : `<p>${t("dashboard.notice.env.printerVariablesSeeded", { list })}</p>`);
        }

        parts.push(`<p>${t("dashboard.notice.env.compose")}</p>`);

        await showNoticeDialog("env-config", t("dashboard.notice.env.title"), parts, true);
    }

    /**
     * The container runs from the old image name, which will stop receiving
     * releases. Said once per start of the service on the dashboard, so a
     * restart and every new version ask again; the settings page keeps saying
     * it under System, and the log says it on every start.
     */
    async function showLegacyImageNotice(notice) {
        if (!notice || !notice.active || notice.acknowledged) return;

        const code = text => `<code>${escapeHtml(text)}</code>`;
        const parts = [
            `<p>${t("dashboard.notice.image.intro", { image: code(notice.image) })}</p>`,
            `<p>${t("dashboard.notice.image.renamed")}</p>`,
            `<p>${t("dashboard.notice.image.switch", { image: code(notice.replacement) })}</p>`,
        ];
        if (notice.docs) {
            parts.push(`<p>${t("dashboard.notice.image.docs", {
                link: `<a href="${escapeHtml(notice.docs)}" target="_blank" rel="noopener">${escapeHtml(t("dashboard.notice.image.docsLink"))}</a>`,
            })}</p>`);
        }

        await showNoticeDialog("legacy-image", t("dashboard.notice.image.title"), parts);
    }

    // One dialog at a time, the update notice first: an installation updated
    // from 1.2.x is by definition still configured through the environment, so
    // it gets both on its first visit, and what changed matters more than
    // where the settings live now. The image name comes last: it is the one
    // that can wait for the next pull.
    async function showNotices() {
        let notices;
        try {
            const response = await fetch("./api/notices");
            notices = await response.json();
        } catch {
            // A hint is not worth an error message of its own.
            return;
        }

        await showUpgradeNotice(notices["upgrade-1.3.0"]);
        await showDeprecationNotice(notices["env-config"]);
        await showLegacyImageNotice(notices["legacy-image"]);
    }

    showNotices();

    // Check if any modal dialog is currently open. A live update that rerenders
    // the table underneath an open dialog replaces the row it was opened from,
    // so every dialog that reads a row has to be listed here.
    function isDialogOpen() {
        return ["info-dialog", "spool-detail-dialog", "print-summary-dialog", "lookup-help-dialog"]
            .some(id => document.getElementById(id)?.open);
    }

    // Opens a printer whenever the menu bar has loaded or reloaded the list
    function showPrinters(printers) {
        if (!printers.length) {
            // A fresh install has no printers yet. Point at the page that can
            // add one instead of showing an empty dashboard.
            document.getElementById("status").style.display = "none";
            document.getElementById("spool-list").innerHTML =
                `<p style="text-align:center">${escapeHtml(t("dashboard.noPrinters.text", { link: "{link}" }))
                    .replace("{link}", `<a href="settings.html">${escapeHtml(t("dashboard.noPrinters.link"))}</a>`)}</p>`;
            currentPrinterId = null;
            return;
        }

        // Undo the empty state above, in case a printer was just added
        document.getElementById("status").style.display = "";

        // The remembered printer may have been removed on the settings page
        const lastSelectedPrinterId = sessionStorage.getItem("lastSelectedPrinterId");
        const known = printers.some(printer => printer.id === lastSelectedPrinterId);
        loadPrinterData(known ? lastSelectedPrinterId : printers[0].id);
    }

    // Fetch and display data for a specific printer
    async function loadPrinterData(printerId) {
        try {
            const [statusResponse, spoolsResponse] = await Promise.all([
                fetch(`./api/status/${printerId}`),
                fetch(`./api/spools/${printerId}`)
            ]);

            if (!statusResponse.ok || !spoolsResponse.ok) {
                throw new Error("Error fetching printer data.");
            }

            const status = await statusResponse.json();
            const spools = await spoolsResponse.json();

            currentPrinterId = printerId;
            setMonitoringSwitch(status.monitoringEnabled === true);

            updateStatus(status); // sets the global legacyMode flag

            if (legacyMode) {
                updateSpools(spools);            // classic AMS table
            } else {
                await loadGcodeView(printerId);  // G-code dashboard
            }
        } catch (error) {
            console.error(`Error loading data for printer ${printerId}:`, error);
        }
    }

    // One table per AMS unit: the four slot units in tables of four, the single
    // slot ones (AMS HT and the external spool holder) in a table of their own.
    //
    // Both views group their slots this way and each used to write the grouping
    // out itself, the classic one with its header block spelled out a second
    // time for the single slot tables. The view passes its columns as
    // `[label, alignment]` and the function that builds one of its rows.
    //
    // @param {object[]} spools - the slots to render
    // @param {Array[]} columns - the header cells
    // @param {function(object): HTMLTableRowElement} makeRow - one row
    // @param {string|null} emptyMessage - what to show when nothing is loaded
    // @returns {HTMLTableElement[]} the tables, in display order
    function buildSpoolTables(spools, columns, makeRow, emptyMessage = null) {
        const makeTable = (slots) => {
            const table = document.createElement("table");
            table.className = "spool-table";

            // First child, because that is where a caption belongs. Every unit
            // has one, named after the unit, with the readings the AMS reports
            // about itself where it reports any, the fold control, and the
            // swatches of the loaded slots for while it is folded.
            const caption = document.createElement("caption");
            caption.className = "ams-env";
            caption.dataset.unit = amsUnitKey(slots[0]?.amsId);
            caption.innerHTML = amsUnitHeaderHtml(caption.dataset.unit, slots);
            // The one table without a unit is the "nothing loaded" placeholder
            caption.hidden = !caption.dataset.unit;
            // Prepended, not appended: `display:flex` takes the element out of
            // the table layout, so it renders where it sits in the DOM rather
            // than where `caption-side` asks for it.
            table.prepend(caption);
            applyUnitCollapsed(table);

            const thead = document.createElement("thead");
            const headerRow = document.createElement("tr");
            for (const [label, align] of columns) {
                const th = document.createElement("th");
                th.textContent = label;
                if (align) th.style.textAlign = align;
                headerRow.appendChild(th);
            }
            thead.appendChild(headerRow);
            table.appendChild(thead);

            const tbody = document.createElement("tbody");
            for (const spool of slots) tbody.appendChild(makeRow(spool));
            table.appendChild(tbody);

            return table;
        };

        const normalAMS = spools.filter(s => !isSingleSlotUnit(s.amsId));
        const singles = spools.filter(s => isSingleSlotUnit(s.amsId));

        const tables = [];
        for (let i = 0; i < normalAMS.length; i += 4) tables.push(makeTable(normalAMS.slice(i, i + 4)));
        for (const single of singles) tables.push(makeTable([single]));

        if (!tables.length && emptyMessage) {
            const empty = makeTable([]);
            empty.querySelector("tbody").innerHTML =
                `<tr><td colspan="${columns.length}" style="opacity:0.5">${escapeHtml(emptyMessage)}</td></tr>`;
            tables.push(empty);
        }

        return tables;
    }

    // The unit a slot belongs to, as the AMS environment readings are keyed.
    // A four slot unit is the letter of its label, a single slot unit is the
    // whole label, because "HT-A" carries no slot number to strip.
    function amsUnitKey(amsId) {
        if (!amsId) return "";
        return isSingleSlotUnit(amsId) ? amsId : amsId.charAt(0);
    }

    // Mirrors the readings from /api/status or an ams_env event. A payload
    // without them leaves what is shown alone: the status endpoint is read on
    // several occasions and dropping the header on one of them would make it
    // flicker.
    function setAmsEnv(amsEnv) {
        if (!Array.isArray(amsEnv)) return;
        amsEnvByUnit = Object.fromEntries(amsEnv.map(entry => [entry.amsId, entry]));
    }

    // The header line of one unit's table: its name, what the AMS reports
    // about itself, the swatches shown while it is folded, and the chevron.
    //
    // The name is always there, so every unit can be folded, the external
    // spool holder and an AMS Lite included. The readings are what the unit
    // reports: the original AMS and the AMS Lite only the humidity level, the
    // AMS 2 Pro and the AMS HT a percentage and a temperature as well, the
    // holder nothing, so every part is optional and the readings get a span
    // of their own that the refresh rewrites without touching the rest.
    function amsUnitHeaderHtml(unitKey, slots) {
        const unit = amsUnitLabel(unitKey, amsEnvByUnit[unitKey]);
        const expand = t("dashboard.unit.expand");
        return `<span class="ams-env-unit"${unit.title ? ` title="${escapeHtml(unit.title)}"` : ""}>${escapeHtml(unit.label)}</span>` +
            `<span class="ams-env-readings">${amsEnvReadingsHtml(unitKey)}</span>` +
            `<span class="ams-summary">${amsSummaryHtml(slots)}</span>` +
            `<button type="button" class="ams-toggle" aria-expanded="true" title="${escapeHtml(expand)}" aria-label="${escapeHtml(expand)}">` +
                `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
            `</button>`;
    }

    // What a folded unit still shows: one swatch per loaded slot, in slot
    // order, so what is in the unit is seen without opening it. A slot
    // without a colour, which a 3rd party spool can be, shows nothing.
    function amsSummaryHtml(slots) {
        const loaded = slots.filter(spool => spool.slotState !== "Empty");
        if (!loaded.length) return `<span class="ams-summary-empty">${escapeHtml(t("dashboard.unit.empty"))}</span>`;
        return loaded.map(spool => {
            const swatch = swatchHtml(slotColors(spool.slot || {}));
            return swatch ? `<span class="ams-summary-slot" title="${escapeHtml(spool.amsId)}">${swatch}</span>` : "";
        }).join("");
    }

    // The readings of one unit, as the spans of its header.
    function amsEnvReadingsHtml(unitKey) {
        const env = amsEnvByUnit[unitKey];
        if (!env) return "";

        const parts = [];
        if (env.humidityPercent !== null && env.humidityPercent !== undefined) {
            const level = env.humidity ? ` (${t("dashboard.env.level", { level: env.humidity })})` : "";
            const title = t(level ? "dashboard.env.humidityTitleLevel" : "dashboard.env.humidityTitle");
            parts.push(`<span title="${escapeHtml(title)}">💧 ${env.humidityPercent} %${escapeHtml(level)}</span>`);
        } else if (env.humidity !== null && env.humidity !== undefined) {
            // The original AMS has no percentage, only the five step level the
            // printer shows as a bar. Spelled out rather than drawn, because
            // there is no percentage to put next to it.
            parts.push(`<span title="${escapeHtml(t("dashboard.env.levelOnlyTitle"))}">💧 ${escapeHtml(t("dashboard.env.level", { level: env.humidity }))}</span>`);
        }
        if (env.temperature !== null && env.temperature !== undefined) {
            parts.push(`<span title="${escapeHtml(t("dashboard.env.temperatureTitle"))}">🌡️ ${env.temperature} °C</span>`);
        }
        if (env.drying?.active) {
            const target = env.drying.targetTemp ? ` ${t("dashboard.env.dryingAt", { temp: env.drying.targetTemp })}` : "";
            const left = env.drying.remainingMinutes ? `, ${t("dashboard.env.dryingLeft", { minutes: env.drying.remainingMinutes })}` : "";
            parts.push(`<span class="ams-env-drying" title="${escapeHtml(t("dashboard.env.dryingTitle"))}">♨️ ${escapeHtml(t("dashboard.env.drying"))}${escapeHtml(target)}${escapeHtml(left)}</span>`);
        }

        return parts.join("");
    }

    /* ---- Folding a unit ----
     *
     * Which units are folded is a choice of this browser for this printer,
     * kept under collapsedUnits:<serial>. The tables are rebuilt on every
     * update, so the choice is applied as a table is built rather than kept
     * on the table; nothing springs open on a refresh. */

    function collapsedUnitsKey() {
        return `collapsedUnits:${document.getElementById("printer-serial")?.textContent || ""}`;
    }

    function collapsedUnits() {
        try {
            const stored = JSON.parse(localStorage.getItem(collapsedUnitsKey()) || "[]");
            return new Set(Array.isArray(stored) ? stored : []);
        } catch {
            return new Set();
        }
    }

    function setUnitCollapsed(unitKey, collapsed) {
        const units = collapsedUnits();
        if (collapsed) units.add(unitKey);
        else units.delete(unitKey);
        try {
            localStorage.setItem(collapsedUnitsKey(), JSON.stringify([...units]));
        } catch {
            // Storage blocked: the fold lasts until the next rebuild
            document.querySelector(`caption.ams-env[data-unit="${CSS.escape(unitKey)}"]`)?.closest("table")?.classList.toggle("is-collapsed", collapsed);
        }
    }

    /** Puts one table into the folded or open state its unit was left in. */
    function applyUnitCollapsed(table) {
        const caption = table.querySelector("caption.ams-env");
        if (!caption || !caption.dataset.unit) return;
        const collapsed = collapsedUnits().has(caption.dataset.unit);
        table.classList.toggle("is-collapsed", collapsed);
        const toggle = caption.querySelector(".ams-toggle");
        if (!toggle) return;
        toggle.setAttribute("aria-expanded", String(!collapsed));
        const label = t(collapsed ? "dashboard.unit.expand" : "dashboard.unit.collapse");
        toggle.title = label;
        toggle.setAttribute("aria-label", label);
    }

    // Names the unit as the printer names it.
    //
    // The model comes from the printer's get_version answer, which the server
    // asks for on every connection and folds into the readings as `model`. See
    // amsModelsFromVersion() in src/ams.js. The status report itself cannot
    // tell the units apart: an original AMS on current firmware sends the same
    // humidity, temperature and drying fields as an AMS 2 Pro, which is how
    // every unit with a dryer field used to be labelled a 2 Pro. Until the
    // answer arrives, or from a printer that never gives one, a single slot
    // unit is still an HT, because only the HT sits at unit id 128 and up, and
    // everything else is plainly "AMS".
    function amsUnitLabel(unitKey, env) {
        if (env?.model) {
            return { label: `${env.model} ${unitKey.startsWith("HT-") ? unitKey.slice(3) : unitKey}`, title: t("dashboard.env.unitTitleModel") };
        }

        if (unitKey.startsWith("HT-")) {
            return { label: `AMS HT ${unitKey.slice(3)}`, title: t("dashboard.env.unitTitleHt") };
        }
        // The external spool holder is a unit of this view too, under the
        // name its slot carries
        if (unitKey.startsWith("External")) {
            return { label: unitKey, title: t("dashboard.env.unitTitleExternal") };
        }

        return {
            label: `AMS ${unitKey}`,
            title: t("dashboard.env.unitTitleUnknown"),
        };
    }

    // Rewrites the headers of the tables already on screen. The readings arrive
    // on their own schedule, so this runs without rebuilding a single row.
    function refreshAmsEnvCaptions() {
        for (const caption of document.querySelectorAll("caption.ams-env")) {
            const unitKey = caption.dataset.unit || "";
            if (!unitKey) continue;
            const readings = caption.querySelector(".ams-env-readings");
            if (readings) readings.innerHTML = amsEnvReadingsHtml(unitKey);
            // The model arrives with the readings, and it is what names the unit
            const name = caption.querySelector(".ams-env-unit");
            const unit = amsUnitLabel(unitKey, amsEnvByUnit[unitKey]);
            if (name) {
                name.textContent = unit.label;
                if (unit.title) name.title = unit.title;
            }
        }
    }

    // Every column of the spool tables, the action column included. Left out, it
    // is the only column without a fixed width and therefore absorbs all the
    // leftover space of the full width table, which parks the button in the
    // middle of a wide empty cell and crams the other columns against the left
    // edge. Both views have these five columns, and all three call sites want
    // all of them.
    const SYNCED_COLUMNS = [0, 1, 2, 3, 4];

    // How often each filament identity is loaded across all units. Two slots the
    // automatic match cannot tell apart get the ⚠ in the Spool cell, which needs
    // the count over every slot and cannot be derived from one row. Both views
    // ask, and both used to count it themselves.
    function countSpoolKeys(spools) {
        const keyCount = {};
        for (const spool of spools) {
            if (spool.slotState === "Empty") continue;
            keyCount[spool.key] = (keyCount[spool.key] || 0) + 1;
        }
        return keyCount;
    }

    // Update the displayed list of spools based on fetched data
    async function updateSpools(spools) {
        const spoolListElement = getElementSafe("spool-list");
        if (!spoolListElement) return;

        spoolListElement.innerHTML = "";

        const columns = [
            [t("dashboard.table.spool")], [t("dashboard.table.remainingEstimated")],
            [t("dashboard.table.serial")], [t("dashboard.table.state")], [t("dashboard.table.action")],
        ];

        const ctx = { keyCount: countSpoolKeys(spools) };
        // Remembered so single-row SSE updates keep the duplicate-spool ⚠, which
        // needs the counts across all slots and can't be derived from one row.
        lastLegacyCtx = ctx;

        for (const table of buildSpoolTables(spools, columns, spool => createSpoolRow(spool, ctx))) {
            spoolListElement.appendChild(table);
        }

        // Every column to its widest cell, so the tables of the units line up.
        synchronizeSelectedColumns(SYNCED_COLUMNS);
    }

    function synchronizeSelectedColumns(indices) {
        const tables = Array.from(document.querySelectorAll('.spool-table'));
        if (tables.length === 0) return;

        // Measure the *content* width of each cell. The tables default to
        // width:100% (generic `table` rule), which stretches every cell; if we
        // measured in that state the per-column maxima would sum to far more
        // than the container and the table would overflow past the menubar /
        // status card. So shrink the tables to their content width first.
        tables.forEach(table => {
            table.style.tableLayout = 'auto';
            table.style.width = 'auto';
        });

        // A cell's padding, which offsetWidth counts and a width style does
        // not: pinning the measured outer width as the content width made
        // every column 20px wider than measured, five columns 100px, which is
        // what pushed the action column off the right edge of a narrow window.
        const paddingOf = cell => {
            const style = getComputedStyle(cell);
            return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        };

        const widths = indices.map(colIdx => {
            let maxWidth = 0;
            tables.forEach(table => {
                Array.from(table.rows).forEach(row => {
                    const cell = row.cells[colIdx];
                    if (!cell) return;
                    cell.style.width = 'auto';
                    cell.style.minWidth = 'unset';
                    const cellWidth = cell.offsetWidth - paddingOf(cell);
                    if (cellWidth > maxWidth) maxWidth = cellWidth;
                });
            });
            return maxWidth;
        });

        // The widest cells measured unwrapped, so on a narrow window their sum
        // can exceed the container. The first column is the one whose text can
        // wrap, the spool name, so it gives up what does not fit, down to a
        // width that still reads as a name.
        const container = tables[0].parentElement?.clientWidth || 0;
        const firstRow = tables[0].rows[0];
        const padding = firstRow ? indices.reduce((sum, colIdx) => sum + (firstRow.cells[colIdx] ? paddingOf(firstRow.cells[colIdx]) : 0), 0) : 0;
        const total = widths.reduce((sum, width) => sum + width, 0) + padding + 2;
        if (container && total > container) {
            widths[0] = Math.max(140, widths[0] - (total - container));
        }

        indices.forEach((colIdx, position) => {
            const width = widths[position];
            tables.forEach(table => {
                Array.from(table.rows).forEach(row => {
                    const cell = row.cells[colIdx];
                    if (!cell) return;
                    cell.style.minWidth = width + "px";
                    cell.style.width = width + "px";
                });
            });
        });

        // Restore full width so the table spans the same width as the menubar
        // and the status card; the synced columns keep their fixed px widths and
        // the remaining (non-synced) columns absorb the leftover space.
        tables.forEach(table => {
            table.style.width = '';
            table.style.tableLayout = '';
        });
    }

    // The CSS background showing a whole colour set in one box.
    //
    // `direction` is Spoolman's multi_color_direction. A "longitudinal"
    // filament changes colour along its length, which is what the gradient
    // spools do, so it fades. A "coaxial" one carries its colours side by side
    // down the strand and reads as hard bands. An unknown or missing direction
    // is drawn as bands too: equal hard stripes still show every colour, while
    // a fade would invent a transition that may not exist.
    function colorSetBackground(colors, direction) {
        if (!colors.length) return "";
        if (colors.length === 1) return `#${colors[0]}`;

        if (direction === "longitudinal") {
            return `linear-gradient(to right, ${colors.map(c => `#${c}`).join(", ")})`;
        }

        const stops = colors.map((color, index) => {
            const from = (index / colors.length) * 100;
            const to = ((index + 1) / colors.length) * 100;
            return `#${color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
        });
        return `linear-gradient(to right, ${stops.join(", ")})`;
    }

    // The small square in front of a filament name. Empty string when there is
    // no colour to show, so a caller can concatenate it unconditionally.
    function swatchHtml(colors, direction = null) {
        const background = colorSetBackground(colors, direction);
        if (!background) return "";
        // Uppercase only here: the sets arrive lowercased, because that is the
        // case the colour comparisons settled on, and a hex reads as a colour
        // in upper.
        const title = colors.map(c => `#${normColor(c)}`).join(" ");
        return `<span class="gc-swatch" style="background:${background}" title="${title}"></span>`;
    }

    // Build an action button with the shared Create/Merge/Show behaviour.
    function createActionButton(amsSpool) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-small";
        button.disabled = true;
        setupButton(button, amsSpool);

        button.addEventListener("click", () => {
            // Spool assignment has its own flow: it needs a picker populated from
            // Spoolman rather than a fixed confirmation text.
            // Compared by the option on the button, never by its text: the
            // text is translated, the option is what the server sent.
            const option = button.dataset.option;
            if (option === SLOT_OPTIONS.ASSIGN)   return showAssignDialog(button, amsSpool);
            if (option === SLOT_OPTIONS.UNASSIGN) return showUnassignDialog(button, amsSpool);

            const content = generateDialogContent(button, amsSpool);
            const actionMap = {
                [SLOT_OPTIONS.CREATE]: t("dashboard.dialog.create"),
                [SLOT_OPTIONS.MERGE]: t("dashboard.dialog.merge"),
                [SLOT_OPTIONS.CREATE_WITH_FILAMENT]: optionLabel(SLOT_OPTIONS.CREATE_WITH_FILAMENT),
                [SLOT_OPTIONS.SHOW_INFO]: t("dashboard.dialog.goToSpoolman"),
            };
            const actionText = actionMap[option] || optionLabel(SLOT_OPTIONS.NONE);
            const actionCallback = () => performAction(button, amsSpool);
            showDialog(button, content, actionText, actionCallback, option === SLOT_OPTIONS.SHOW_INFO);
        });

        return button;
    }

    // ---------------------------------------------------------------------
    // Manual spool assignment
    //
    // 3rd-party spools have no RFID chip, so nothing links them to a Spoolman
    // spool automatically and their consumption can't be booked. The same picker
    // also resolves two tagged spools that are identical in material and color,
    // which the automatic match can't tell apart.
    // ---------------------------------------------------------------------

    // Ranks Spoolman spools by how well they fit the slot: the same material and
    // the same colours first, then the same material by how close its colour is,
    // then the rest. An inventory of forty spools is otherwise a list to read
    // through rather than a choice to make.
    function rankSpoolsForSlot(spools, slot) {
        // The material of the profile the AMS names, compared by family: the
        // printer reports "PLA" where Spoolman holds "PLA Silk", so the exact
        // comparison this used to make put almost every spool in the last rank.
        const reported = slotMaterial(slot || {});
        // Compared as a set rather than as a single hex, so a multi colour spool
        // can reach the top for its own slot. Those carry no color_hex at all,
        // so against the single field they always ranked last.
        const slotColorSet = slotColors(slot);

        const score = (sp) => {
            const material = sp.filament?.material;
            const sameMaterial = Boolean(reported && material && materialsAgree(reported, material));
            const distance = colorSetDistance(slotColorSet, filamentColors(sp.filament));

            if (sameMaterial && distance === 0) return { rank: 0, distance };
            if (sameMaterial) return { rank: 1, distance };
            return { rank: 2, distance };
        };

        return [...spools]
            .map(sp => ({ sp, ...score(sp) }))
            .sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.sp.id - b.sp.id);
    }

    // The name of a spool as the picker writes it, and what is known about it
    // besides the name. Two pieces rather than one string, so the second can
    // drop onto its own line when the row runs out of width, aligned under the
    // name; while there is room the two sit on one line.
    function spoolPickerLabel(sp) {
        const fil   = sp.filament || {};
        const parts = [fil.vendor?.name, fil.material, fil.name].filter(Boolean);
        const swatch = swatchHtml(filamentColors(fil), fil.multi_color_direction);
        return `${swatch}#${sp.id} ${escapeHtml(parts.join(" · ") || t("dashboard.unknownFilament"))}`;
    }

    function spoolPickerWeight(sp) {
        return sp.remaining_weight != null
            ? t("dashboard.assign.gramsLeft", { grams: Math.round(sp.remaining_weight) })
            : t("dashboard.assign.unknownWeight");
    }

    async function showAssignDialog(button, amsSpool) {
        showDialog(button, `<p>${escapeHtml(t("dashboard.loadingSpoolman"))}</p>`, t("dashboard.assign.assign"), () => {});
        const dialogContent = document.getElementById("dialog-content");
        const actionButton  = document.getElementById("action-button");
        actionButton.disabled = true;

        let spools, lookups;
        try {
            [spools, lookups] = await Promise.all([
                fetchJson("./api/spoolman/spools"),
                fetchJson("./api/spoolman/lookups"),
            ]);
        } catch (err) {
            dialogContent.innerHTML = `<p class="gc-bad">${escapeHtml(t("dashboard.loadSpoolmanFailed", { error: err.message }))}</p>`;
            return;
        }

        const slot = amsSpool.slot || {};
        dialogContent.innerHTML = `
            <p style="margin-top:0">${escapeHtml(t("dashboard.assign.intro", {
                slot: "{slot}",
                filament: [slot.tray_type, slot.tray_sub_brands].filter(Boolean).join(" · ") || t("dashboard.assign.unknownFilament"),
            })).replace("{slot}", `<strong>${escapeHtml(amsSpool.amsId)}</strong>`)}</p>
            <div class="sp-tabs">
                <button type="button" class="sp-tab sp-tab-active" data-mode="assign">${escapeHtml(t("dashboard.assign.useExisting"))}</button>
                <button type="button" class="sp-tab" data-mode="create">${escapeHtml(t("dashboard.assign.createNew"))}</button>
            </div>
            <div id="sp-pane"></div>`;

        const pane = dialogContent.querySelector("#sp-pane");
        const tabs = [...dialogContent.querySelectorAll(".sp-tab")];

        const selectMode = (mode) => {
            for (const tab of tabs) tab.classList.toggle("sp-tab-active", tab.dataset.mode === mode);
            if (mode === "assign") renderAssignPane(pane, actionButton, button, amsSpool, spools, null);
            else renderCreatePane(pane, actionButton, button, amsSpool, lookups);
        };
        for (const tab of tabs) tab.addEventListener("click", () => selectMode(tab.dataset.mode));

        // Nothing to assign yet on a fresh Spoolman, so start on the form instead of
        // an empty picker.
        selectMode(spools.length ? "assign" : "create");
    }

    // How many spools the suggestion list offers before the rest is left to the
    // full list below it. Enough to hold the obvious candidates of a slot,
    // short enough to stay a suggestion.
    const ASSIGN_SUGGESTIONS = 6;

    // `onPick` takes the chosen spool id instead of assigning it to the slot,
    // for a picker that names a spool for something other than a slot.
    function renderAssignPane(pane, actionButton, button, amsSpool, spools, onPick) {
        actionButton.textContent = t("dashboard.assign.assign");
        actionButton.disabled = true;

        if (!spools.length) {
            pane.innerHTML = `<p class="gc-muted">${escapeHtml(t("dashboard.assign.noSpools", { create: t("dashboard.assign.createNew") }))}</p>`;
            return;
        }

        // The printer knows what material sits in the slot even for a spool it
        // cannot identify, so an assignment that would book PLA onto an ABS spool
        // can be pointed out. It is a warning, not a rule: the material a slot
        // reports can be wrong, and only the user knows what is really in there.
        const reported = slotMaterial(amsSpool.slot || {});
        const mismatched = new Set(spools
            .filter(sp => !materialsAgree(reported, sp.filament?.material))
            .map(sp => sp.id));

        const ranked = rankSpoolsForSlot(spools, amsSpool.slot || {});
        // The one spool that is this slot as far as the printer can tell: same
        // material, the same colours, no tag, and not assigned to another slot
        // on this printer. Picked in advance so the common case is one click;
        // with two such spools the choice is left open.
        const assignedElsewhere = new Set([...renderedSpools.values()]
            .filter(other => other.amsId !== amsSpool.amsId && other.connectedViaMapping && other.existingSpool?.id)
            .map(other => other.existingSpool.id));
        const preselected = uniqueSpoolForSlot(amsSpool.slot || {}, spools, assignedElsewhere);
        // Only a spool of the right material is ever suggested. Suggesting the
        // closest colour out of an inventory that holds nothing fitting would put
        // an ABS spool at the top of a PLA slot.
        const suggested = ranked.filter(entry => entry.rank < 2).slice(0, ASSIGN_SUGGESTIONS);
        const suggestedIds = new Set(suggested.map(entry => entry.sp.id));

        // Name and what is known about the spool: on one line while they fit,
        // on two when they do not, both starting at the same edge next to the
        // radio button.
        const pick = (entry) => `
            <label class="sp-pick">
                <input type="radio" name="assign-spool" value="${entry.sp.id}">
                <span class="sp-pick-text">
                    <span class="sp-pick-name">${spoolPickerLabel(entry.sp)}</span>
                    <span class="sp-pick-meta">
                        <span class="gc-muted">(${escapeHtml(spoolPickerWeight(entry.sp))})</span>${entry.rank === 0
                        ? `<span class="gc-ok" title="${escapeHtml(t("dashboard.assign.sameColourTitle"))}">● ${escapeHtml(t("dashboard.assign.sameColour"))}</span>`
                        : ""}${mismatched.has(entry.sp.id)
                        ? `<span class="gc-warn" title="${escapeHtml(t("dashboard.assign.reportsTitle", { material: reported }))}">⚠ ${escapeHtml(entry.sp.filament?.material ?? t("dashboard.assign.otherMaterial"))}</span>`
                        : ""}
                    </span>
                </span>
            </label>`;

        // Everything a spool can be recognised by, so the search does not have to
        // guess which of them the user typed.
        const haystack = (sp) => [
            `#${sp.id}`,
            sp.filament?.vendor?.name,
            sp.filament?.material,
            sp.filament?.name,
            sp.location,
            sp.lot_nr,
            sp.comment,
        ].filter(Boolean).join(" ").toLowerCase();

        pane.innerHTML = `
            <label class="sp-search">
                <input id="sp-search" type="search" autocomplete="off" placeholder="${escapeHtml(t("dashboard.assign.searchPlaceholder"))}">
            </label>
            <div class="sp-scroll" id="sp-list"></div>
            <p class="sp-note gc-warn" id="sp-material-warning"></p>`;

        const list = pane.querySelector("#sp-list");
        const search = pane.querySelector("#sp-search");
        const warning = pane.querySelector("#sp-material-warning");

        // Rerendered on every keystroke, so the selection has to be carried over
        // rather than read off the DOM that is about to be replaced.
        let selectedId = preselected?.id ?? null;
        if (preselected) {
            warning.className = "sp-note gc-muted";
            warning.textContent = t("dashboard.assign.preselected", { id: preselected.id });
        }

        const render = () => {
            const term = search.value.trim().toLowerCase();
            const matches = term ? ranked.filter(entry => haystack(entry.sp).includes(term)) : ranked;

            if (!matches.length) {
                list.innerHTML = `<p class="gc-muted sp-wide">${escapeHtml(t("dashboard.assign.noMatch", { term: search.value.trim() }))}</p>`;
                return;
            }

            // While searching, the split into suggestions and the rest only gets
            // in the way: what was typed is the filter, and the ranking still puts
            // the closest first.
            if (term) {
                list.innerHTML = `
                    <div class="sp-section">${escapeHtml(t("dashboard.assign.matchCount", { found: matches.length, count: ranked.length }))}</div>
                    ${matches.map(pick).join("")}`;
            } else {
                const rest = ranked.filter(entry => !suggestedIds.has(entry.sp.id));
                list.innerHTML = `
                    ${suggested.length ? `
                        <div class="sp-section" title="${escapeHtml(t("dashboard.assign.suggestedTitle"))}">${escapeHtml(t("dashboard.assign.suggested"))}</div>
                        ${suggested.map(pick).join("")}` : ""}
                    ${rest.length ? `
                        <div class="sp-section">${escapeHtml(t(suggested.length ? "dashboard.assign.otherSpools" : "dashboard.assign.allSpools"))} (${rest.length})</div>
                        ${rest.map(pick).join("")}` : ""}`;
            }

            const stillThere = selectedId != null && list.querySelector(`input[value="${selectedId}"]`);
            if (stillThere) stillThere.checked = true;
            actionButton.disabled = !stillThere;
        };

        list.addEventListener("change", () => {
            const picked = list.querySelector('input[name="assign-spool"]:checked');
            if (!picked) return;

            selectedId = Number(picked.value);
            actionButton.disabled = false;

            const spool = spools.find(sp => sp.id === selectedId);
            warning.className = "sp-note gc-warn";
            warning.textContent = spool && mismatched.has(spool.id)
                ? t("dashboard.assign.mismatch", {
                    reported,
                    id: spool.id,
                    material: spool.filament?.material ?? t("dashboard.assign.anotherMaterial"),
                })
                : "";
        });

        search.addEventListener("input", render);
        render();

        actionButton.onclick = () => {
            if (selectedId == null) return;
            document.getElementById("info-dialog").close();
            if (onPick) onPick(selectedId);
            else sendMapping(button, amsSpool, selectedId);
        };
    }

    // ---------------------------------------------------------------------
    // A spool per filament on a holder swapped by hand
    //
    // Bambu Studio's "Use Multicolor with External" runs several filaments from
    // the external holder, and the printer reports the first spool for the
    // whole print. The server books each of these filaments on the spool named
    // for it here and on nothing else; see holderSwapIndices() in src/ams.js.
    // ---------------------------------------------------------------------

    // The slot shape the picker ranks spools against, built from what the
    // sliced file says about the filament.
    function filamentAsSlot(filament) {
        const colors = filament.colors?.length ? filament.colors : [filament.color];
        return {
            tray_info_idx: filament.trayInfoIdx,
            tray_type: filament.type,
            tray_color: normColor(colors[0]),
            cols: colors.filter(Boolean).map(normColor),
        };
    }

    async function showFilamentSpoolDialog(button, filament) {
        showDialog(button, `<p>${escapeHtml(t("dashboard.loadingSpoolman"))}</p>`, t("dashboard.assign.assign"), () => {});
        const dialogContent = document.getElementById("dialog-content");
        const actionButton  = document.getElementById("action-button");
        actionButton.disabled = true;

        let spools;
        try {
            spools = await fetchJson("./api/spoolman/spools");
        } catch (err) {
            dialogContent.innerHTML = `<p class="gc-bad">${escapeHtml(t("dashboard.loadSpoolmanFailed", { error: err.message }))}</p>`;
            return;
        }

        const slot = filamentAsSlot(filament);
        const swatch = swatchHtml(slotColors(slot).map(normColor));
        dialogContent.innerHTML = `
            <p style="margin-top:0">${escapeHtml(t("dashboard.holder.dialogIntro", {
                filament: "{filament}",
                slot: filament.amsId,
            })).replace("{filament}", `${swatch}<strong>${escapeHtml(t("dashboard.holder.filament", { number: filament.index + 1 }))}</strong>`)}</p>
            <p class="gc-muted" style="font-size:0.85em">${escapeHtml(t(filament.status === "pending" ? "dashboard.holder.dialogBookNow" : "dashboard.holder.dialogBookLater"))}</p>
            <div id="sp-pane"></div>`;

        const pane = dialogContent.querySelector("#sp-pane");
        // The amsId keeps the picker from preselecting the spool assigned to
        // the holder itself, which is one of the spools this print swaps
        const pseudo = { amsId: `${filament.amsId}#${filament.index}`, slot };
        renderAssignPane(pane, actionButton, button, pseudo, spools, spoolId => sendFilamentSpool(button, filament, spoolId));
        actionButton.textContent = t(filament.status === "pending" ? "dashboard.holder.book" : "dashboard.assign.assign");
    }

    async function sendFilamentSpool(button, filament, spoolId) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = t("dashboard.sending");
        try {
            await sendJson(`./api/print/${encodeURIComponent(currentPrinterId)}/filament/${filament.index}`, "PUT", { spoolId });
            showNotification(t(filament.status === "pending" ? "dashboard.holder.booked" : "dashboard.holder.named",
                { number: filament.index + 1, id: spoolId }), "success");
            await loadPrinterData(currentPrinterId);
        } catch (err) {
            showNotification(t("dashboard.error", { error: err.message }), "error");
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    // Keeps the first spelling of every entry and drops the later duplicates, so
    // the local "PLA" is not listed a second time as the catalogue's "pla".
    function uniqueByCase(values) {
        const seen = new Set();
        const unique = [];

        for (const value of values) {
            const key = String(value ?? "").trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            unique.push(String(value).trim());
        }
        return unique;
    }

    // Runs the last call of a burst, once the typing has stopped.
    function debounce(fn, ms = 250) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function sameText(a, b) {
        return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
    }

    // What each catalogue entry is called in the picker.
    //
    // The name alone, because the two steps above it already said which
    // manufacturer and which material this is. The catalogue lists the same
    // filament once per spool it is sold on, so "Panchroma Regular Grey" is
    // three entries that differ in weight and in the spool they come on, and a
    // name that occurs more than once carries exactly the fields that differ
    // between its entries. Adding the manufacturer to all of them, as this did
    // at first, only printed the same qualifier twice.
    function catalogueLabels(entries) {
        const parts = {
            manufacturer: entry => entry.manufacturer,
            material: entry => entry.material,
            weight: entry => (entry.weight == null ? null : `${Math.round(entry.weight)} g`),
            diameter: entry => (entry.diameter == null ? null : `${entry.diameter} mm`),
            spool_type: entry => entry.spool_type,
        };

        const byName = new Map();
        for (const entry of entries) {
            const name = entry.name ?? "";
            byName.set(name, [...(byName.get(name) ?? []), entry]);
        }

        const labelled = [];
        for (const [name, group] of byName) {
            if (group.length === 1) {
                labelled.push([name, group[0]]);
                continue;
            }

            const telling = Object.entries(parts)
                .filter(([, read]) => new Set(group.map(read)).size > 1)
                .map(([, read]) => read);

            for (const entry of group) {
                const qualifiers = telling.map(read => read(entry)).filter(Boolean);
                labelled.push([[name, ...qualifiers].join(" · "), entry]);
            }
        }

        return labelled;
    }

    // Values a chipless spool does report, used to pre-fill the form.
    //
    // The AMS reports every colour of a multi colour spool, so all of them are
    // offered: taking only `tray_color` created a plain black spool for a
    // filament that is black and red. The material is the preset's where the
    // preset is a known one, "PLA-CF" rather than the "PLA" the AMS reports
    // next to it, and a vendor preset names the manufacturer as well.
    function slotDefaults(slot) {
        const colors = slotColors(slot).map(c => normColor(c));
        const preset = slotPreset(slot);
        const vendor = presetVendor(preset);
        return {
            material: slotMaterial(slot) || "",
            colors: colors.length ? colors : [normColor(slot.tray_color) || "000000"],
            vendor: vendor?.vendor ?? "",
            line: vendor?.line ?? null,
            presetName: preset?.name ?? null,
        };
    }

    function renderCreatePane(pane, actionButton, button, amsSpool, lookups) {
        actionButton.textContent = t("dashboard.dialog.create");
        actionButton.disabled = false;

        const slot = amsSpool.slot || {};
        const defaults = slotDefaults(slot);

        // What this Spoolman already holds comes first in every list, and the
        // SpoolmanDB catalogue fills in what it does not: a first spool would
        // otherwise be typed into empty fields with nothing to pick from.
        const materials = uniqueByCase([
            ...(lookups.materials || []),
            ...(lookups.externalMaterials || []).map(m => m.material),
        ]);

        const vendors = uniqueByCase([
            ...(lookups.vendors || []).map(v => v.name),
            ...(lookups.externalVendors || []),
        ]);

        const filamentOptions = (lookups.filaments || [])
            .map(f => `<option value="${f.id}">#${f.id} ${escapeHtml([f.vendor?.name, f.material, f.name].filter(Boolean).join(" · "))}</option>`)
            .join("");

        // The manufacturer the preset names, spelled the way this Spoolman or
        // the catalogue already spells it, so the vendor step narrows the
        // catalogue and the vendor field does not create "Sunlu" next to "SUNLU".
        const vendorSpelling = defaults.vendor
            ? (vendors.find(v => sameText(v, defaults.vendor)) ?? defaults.vendor)
            : "";

        pane.innerHTML = `
            <div class="sp-scroll">
                <div class="sp-section">${escapeHtml(t("dashboard.create.filament"))}</div>
                <label class="sp-field sp-wide">
                    <span>${escapeHtml(t("dashboard.create.useExistingFilament"))}</span>
                    <select id="sp-filament">
                        <option value="">+ ${escapeHtml(t("dashboard.create.newFilament"))}</option>
                        ${filamentOptions}
                    </select>
                </label>

                <div id="sp-filament-fields">
                    <div class="sp-wide sp-catalogue">
                        <div class="sp-catalogue-title">${escapeHtml(t("dashboard.create.catalogueTitle"))}</div>
                        <div class="sp-catalogue-steps">
                            <label class="sp-field">
                                <span>1. ${escapeHtml(t("dashboard.create.manufacturer"))}</span>
                                <input id="sp-cat-vendor" list="sp-cat-vendors" autocomplete="off" placeholder="${escapeHtml(t("dashboard.create.allManufacturers"))}"
                                    value="${escapeHtml(vendorSpelling)}">
                                <datalist id="sp-cat-vendors">${(lookups.externalVendors || []).map(v => `<option value="${escapeHtml(v)}">`).join("")}</datalist>
                            </label>
                            <label class="sp-field">
                                <span>2. ${escapeHtml(t("dashboard.create.material"))}</span>
                                <input id="sp-cat-material" list="sp-cat-materials" autocomplete="off" placeholder="${escapeHtml(t("dashboard.create.allMaterials"))}"
                                    value="${escapeHtml(defaults.material)}">
                                <datalist id="sp-cat-materials"></datalist>
                            </label>
                            <label class="sp-field">
                                <span>3. ${escapeHtml(t("dashboard.create.filament"))}</span>
                                <input id="sp-cat-filament" list="sp-cat-filaments" autocomplete="off" placeholder="${escapeHtml(t("dashboard.create.pickToFill"))}">
                                <datalist id="sp-cat-filaments"></datalist>
                            </label>
                        </div>
                        <small class="gc-muted" id="sp-catalogue-hint"></small>
                    </div>

                    <div class="sp-subsection">${escapeHtml(t("dashboard.create.filamentData"))}</div>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.manufacturer"))}</span>
                        <input id="sp-vendor" list="sp-vendors" autocomplete="off" placeholder="${escapeHtml(t("dashboard.create.vendorPlaceholder"))}" value="${escapeHtml(vendorSpelling)}">
                        <datalist id="sp-vendors">${vendors.map(v => `<option value="${escapeHtml(v)}">`).join("")}</datalist>
                        <small class="gc-muted" id="sp-vendor-hint"></small>
                    </label>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.material"))} *</span>
                        <input id="sp-material" list="sp-materials" autocomplete="off" value="${escapeHtml(defaults.material)}">
                        <datalist id="sp-materials">${materials.map(m => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
                        <small class="gc-muted" id="sp-material-hint"></small>
                    </label>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.name"))}</span>
                        <input id="sp-name" placeholder="${escapeHtml(t("dashboard.create.namePlaceholder"))}">
                    </label>

                    <div class="sp-subsection">${escapeHtml(t("dashboard.create.colour"))}</div>
                    <div class="sp-wide">
                        <div id="sp-colours" class="sp-colours"></div>
                        <div class="sp-colour-actions">
                            <button type="button" class="btn btn-small" id="sp-colour-add">${escapeHtml(t("dashboard.create.addColour"))}</button>
                            <select id="sp-direction" title="${escapeHtml(t("dashboard.create.directionTitle"))}">
                                <option value="coaxial">${escapeHtml(t("dashboard.direction.coaxial"))}</option>
                                <option value="longitudinal">${escapeHtml(t("dashboard.direction.longitudinal"))}</option>
                            </select>
                        </div>
                        <small class="gc-muted" id="sp-colour-hint"></small>
                    </div>

                    <div class="sp-subsection">${escapeHtml(t("dashboard.create.specifications"))}</div>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.density"))} * (g/cm³)</span>
                        <input type="number" id="sp-density" step="0.01" min="0.01">
                    </label>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.diameter"))} * (mm)</span>
                        <input type="number" id="sp-diameter" step="0.01" min="0.01" value="1.75">
                    </label>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.nozzleTemp"))} (°C)</span>
                        <input type="number" id="sp-extruder-temp">
                    </label>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.bedTemp"))} (°C)</span>
                        <input type="number" id="sp-bed-temp">
                    </label>

                    <div class="sp-subsection">${escapeHtml(t("dashboard.create.weights"))}</div>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.fullWeight"))} (g)</span>
                        <input type="number" id="sp-weight" min="0" value="1000">
                    </label>
                    <label class="sp-field">
                        <span>${escapeHtml(t("dashboard.create.emptySpool"))} (g)</span>
                        <input type="number" id="sp-spool-weight" min="0" value="250">
                    </label>
                </div>

                <div class="sp-section">${escapeHtml(t("dashboard.create.spool"))}</div>
                <label class="sp-field">
                    <span>${escapeHtml(t("dashboard.create.initialWeight"))} (g)</span>
                    <input type="number" id="sp-initial-weight" min="0" value="1000">
                </label>
                <label class="sp-field">
                    <span>${escapeHtml(t("dashboard.create.remaining"))} (g)</span>
                    <input type="number" id="sp-remaining-weight" min="0" placeholder="${escapeHtml(t("dashboard.create.remainingPlaceholder"))}">
                </label>
                <label class="sp-field">
                    <span>${escapeHtml(t("dashboard.create.location"))}</span>
                    <input id="sp-location" list="sp-locations" autocomplete="off" value="${escapeHtml(currentPrinterName ? `${currentPrinterName} - ${amsSpool.amsId}` : "")}">
                    <datalist id="sp-locations">${(lookups.locations || []).map(l => `<option value="${escapeHtml(l)}">`).join("")}</datalist>
                </label>
                <label class="sp-field sp-wide">
                    <span>${escapeHtml(t("dashboard.create.comment"))}</span>
                    <input id="sp-comment" placeholder="${escapeHtml(t("dashboard.create.optional"))}">
                </label>
                <p class="gc-muted sp-note">${escapeHtml(t("dashboard.create.note"))}</p>
                <p id="sp-error" class="gc-bad"></p>
            </div>`;

        const $ = (id) => pane.querySelector(`#${id}`);

        // Picking an existing filament makes every filament field irrelevant
        $("sp-filament").addEventListener("change", (e) => {
            $("sp-filament-fields").style.display = e.target.value ? "none" : "";
        });

        // The SpoolmanDB catalogue, narrowed down in steps rather than searched in
        // one go: it holds around seven thousand entries, and reading a list of
        // that length is what picking a manufacturer first avoids. Every step is
        // an input with its own suggestions, so a name can also just be typed.
        //
        // Picking an entry fills in the colours, the density, the temperatures and
        // the weights, none of which can be read off a chipless spool at all.
        const catalogue = new Map();
        // Answers can come back out of order, and the first load is the slowest
        // one: without this the unfiltered list of the initial load landed after
        // the narrowed one and put the whole catalogue back on screen. The two
        // lists count separately, they are loaded together and neither of them
        // supersedes the other.
        const pending = { materials: 0, entries: 0 };

        const catalogueQuery = (extra = {}) => {
            const params = new URLSearchParams();
            const vendor = $("sp-cat-vendor").value.trim();
            const material = $("sp-cat-material").value.trim();
            if (vendor) params.set("manufacturer", vendor);
            if (material) params.set("material", material);
            for (const [key, value] of Object.entries(extra)) params.set(key, value);
            return params;
        };

        const askCatalogue = async (params) => {
            try {
                return await fetchJson(`./api/spoolman/external/filaments?${params}`);
            } catch {
                // The form works without it, so a catalogue that cannot be reached
                // costs the suggestions and nothing else.
                $("sp-catalogue-hint").textContent = t("dashboard.create.catalogueFailed");
                return null;
            }
        };

        const fillDatalist = (id, values) => {
            document.getElementById(id).innerHTML = values
                .map(value => `<option value="${escapeHtml(value)}">`).join("");
        };

        // The materials the chosen manufacturer actually sells.
        const loadMaterials = async () => {
            const request = ++pending.materials;
            const materials = await askCatalogue(catalogueQuery({ facet: "material" }));
            if (materials && request === pending.materials) fillDatalist("sp-cat-materials", materials);
        };

        // The entries left once manufacturer and material have been narrowed down.
        const loadEntries = async () => {
            const request = ++pending.entries;
            const entries = await askCatalogue(catalogueQuery({ limit: 500 }));
            if (!entries || request !== pending.entries) return;

            const ordered = [...entries].sort((a, b) =>
                String(a.name ?? "").localeCompare(String(b.name ?? "")));

            catalogue.clear();
            for (const [label, entry] of catalogueLabels(ordered)) catalogue.set(label, entry);

            fillDatalist("sp-cat-filaments", [...catalogue.keys()]);
            $("sp-catalogue-hint").textContent = ordered.length
                ? t("dashboard.create.catalogueEntries", { count: ordered.length, more: ordered.length === 500 ? "+" : "" })
                : t("dashboard.create.catalogueNothing");

            suggestFromPreset();
        };

        // The first list for a slot whose preset names the manufacturer is
        // narrowed to that maker and this material already, so the entry nearest
        // the slot's colour is most likely the spool, and it is filled in as a
        // proposal. Once only, when the dialog opens: after that the steps are
        // the user's. A generic preset or a custom one names no maker, and the
        // nearest colour among every maker's filaments would be a guess.
        let suggested = !defaults.vendor;
        const suggestFromPreset = () => {
            if (suggested || !catalogue.size) return;
            suggested = true;

            const ranked = rankCatalogueEntries([...catalogue.values()], slot, {
                external: amsSpool.amsId === EXTERNAL_SLOT || amsSpool.amsId === SECOND_EXTERNAL_SLOT,
                line: defaults.line,
            });
            const best = ranked[0];
            if (!best || best.tooHeavy || !Number.isFinite(best.distance)) return;

            const label = [...catalogue.entries()].find(([, entry]) => entry === best.entry)?.[0];
            if (!label) return;

            $("sp-cat-filament").value = label;
            applyCatalogueEntry();

            const slotColours = defaults.colors.join(", ");
            const catalogueColours = catalogueColors(best.entry).join(", ");
            $("sp-catalogue-hint").textContent = best.distance === 0
                ? t("dashboard.create.proposedSame", { preset: defaults.presetName, name: best.entry.name })
                : t("dashboard.create.proposedNearest", {
                    preset: defaults.presetName,
                    name: best.entry.name,
                    catalogueColours,
                    slotColours,
                });
        };

        // What the catalogue knows about the manufacturer of the picked entry.
        // A vendor this Spoolman does not have yet is created on save, and
        // without this it would be created with its name alone, while the
        // catalogue also names it and knows what its empty spool weighs.
        // Dropped again as soon as the manufacturer field says something else.
        let catalogueVendor = null;

        // Picking an entry fills the form. A filament this Spoolman already holds
        // wins over the catalogue: creating a second one that only differs in its
        // id is how an inventory ends up with four "Sunlu PLA Grey".
        const applyCatalogueEntry = () => {
            const entry = catalogue.get($("sp-cat-filament").value.trim());
            if (!entry) return;

            const sameVendorAndName = (lookups.filaments || []).filter(f =>
                sameText(f.name, entry.name) && sameText(f.vendor?.name, entry.manufacturer));
            const local = sameVendorAndName.find(f => sameText(f.material, entry.material));

            if (local) {
                $("sp-filament").value = String(local.id);
                $("sp-filament-fields").style.display = "none";
                showNotification(t("dashboard.create.filamentExists", { id: local.id }), "success");
                return;
            }

            catalogueVendor = entry.manufacturer
                ? { name: entry.manufacturer, spoolWeight: entry.spool_weight ?? null }
                : null;

            $("sp-vendor").value = entry.manufacturer ?? "";
            $("sp-material").value = entry.material ?? "";
            $("sp-name").value = entry.name ?? "";
            if (entry.density != null) $("sp-density").value = entry.density;
            if (entry.diameter != null) $("sp-diameter").value = entry.diameter;
            if (entry.extruder_temp != null) $("sp-extruder-temp").value = entry.extruder_temp;
            if (entry.bed_temp != null) $("sp-bed-temp").value = entry.bed_temp;
            if (entry.weight != null) $("sp-weight").value = entry.weight;
            if (entry.spool_weight != null) $("sp-spool-weight").value = entry.spool_weight;
            if (entry.weight != null) $("sp-initial-weight").value = entry.weight;

            const colors = catalogueColors(entry);
            if (colors.length) {
                drawColours(colors.map(c => normColor(c)));
                if (entry.multi_color_direction) $("sp-direction").value = entry.multi_color_direction;
            }

            const notes = [t("dashboard.create.filledIn")];
            if (sameVendorAndName.length) {
                notes.push(t("dashboard.create.alreadyHolds", {
                    id: sameVendorAndName[0].id,
                    material: sameVendorAndName[0].material ?? "",
                }).replace(/\s+/g, " ").trim());
            }
            $("sp-catalogue-hint").textContent = notes.join(", ");
        };

        // A step that changes invalidates the ones below it, otherwise a filament
        // picked for one manufacturer stays in the field for the next.
        const onVendorStep = debounce(() => {
            $("sp-cat-filament").value = "";
            loadMaterials();
            loadEntries();
        });

        const onMaterialStep = debounce(() => {
            $("sp-cat-filament").value = "";
            loadEntries();
        });

        $("sp-cat-vendor").addEventListener("input", onVendorStep);
        $("sp-cat-material").addEventListener("input", onMaterialStep);
        $("sp-cat-filament").addEventListener("input", applyCatalogueEntry);
        $("sp-cat-filament").addEventListener("change", applyCatalogueEntry);

        loadMaterials();
        loadEntries();

        // Density is required and cannot be read off the spool, so fill it (and the
        // temperatures) from Spoolman's material catalogue as soon as one matches.
        const applyMaterialDefaults = () => {
            const value = $("sp-material").value.trim().toLowerCase();
            const known = (lookups.externalMaterials || []).find(m => m.material.toLowerCase() === value);
            const hint = $("sp-material-hint");
            if (!known) {
                hint.textContent = value ? t("dashboard.create.unknownMaterial") : "";
                return;
            }
            hint.textContent = t("dashboard.create.materialDefaults", { material: known.material });
            if (!$("sp-density").value) $("sp-density").value = known.density ?? "";
            if (!$("sp-extruder-temp").value && known.extruder_temp != null) $("sp-extruder-temp").value = known.extruder_temp;
            if (!$("sp-bed-temp").value && known.bed_temp != null) $("sp-bed-temp").value = known.bed_temp;
        };
        $("sp-material").addEventListener("input", applyMaterialDefaults);
        applyMaterialDefaults();

        // Typing a manufacturer that does not exist yet creates it on save
        const vendorNames = new Set((lookups.vendors || []).map(v => v.name.toLowerCase()));
        const noteNewVendor = () => {
            const value = $("sp-vendor").value.trim();
            $("sp-vendor-hint").textContent = value && !vendorNames.has(value.toLowerCase())
                ? t("dashboard.create.newManufacturer")
                : "";
        };
        $("sp-vendor").addEventListener("input", noteNewVendor);
        // The field can start filled in from the slot's preset, and a
        // manufacturer this Spoolman has not seen deserves the note then too.
        noteNewVendor();

        // A filament can carry more than one colour, and both the AMS and the
        // catalogue report all of them. Spoolman keeps them as a list plus the
        // direction they run in, so the form does the same: one row per colour,
        // and the direction only asked for once there is more than one.
        const colourRow = (hex) => `
            <span class="sp-colour">
                <input type="color" class="sp-colour-pick" value="#${hex}">
                <input class="sp-colour-hex" value="${hex}" maxlength="6" autocomplete="off">
                <button type="button" class="sp-colour-remove" title="${escapeHtml(t("dashboard.create.removeColour"))}">✕</button>
            </span>`;

        const currentColours = () => [...pane.querySelectorAll(".sp-colour-hex")]
            .map(input => normColor(input.value))
            .filter(hex => /^[0-9A-F]{6}$/.test(hex));

        const drawColours = (colours) => {
            $("sp-colours").innerHTML = colours.map(colourRow).join("");
            // A single colour has no direction to run in, and Spoolman stores it
            // in the plain colour field then.
            $("sp-direction").style.display = colours.length > 1 ? "" : "none";
            $("sp-colours").classList.toggle("sp-colours-single", colours.length < 2);
            $("sp-colour-hint").textContent = colours.length > 1
                ? t("dashboard.create.multiColour", { count: colours.length })
                : "";
        };

        $("sp-colours").addEventListener("input", (event) => {
            const row = event.target.closest(".sp-colour");
            if (!row) return;

            if (event.target.classList.contains("sp-colour-pick")) {
                row.querySelector(".sp-colour-hex").value = event.target.value.replace("#", "").toUpperCase();
            } else {
                const hex = normColor(event.target.value);
                if (/^[0-9A-F]{6}$/.test(hex)) row.querySelector(".sp-colour-pick").value = `#${hex}`;
            }
        });

        $("sp-colours").addEventListener("click", (event) => {
            if (!event.target.classList.contains("sp-colour-remove")) return;
            const colours = currentColours();
            const index = [...pane.querySelectorAll(".sp-colour")].indexOf(event.target.closest(".sp-colour"));
            colours.splice(index, 1);
            drawColours(colours.length ? colours : ["000000"]);
        });

        $("sp-colour-add").addEventListener("click", () => {
            drawColours([...currentColours(), "FFFFFF"]);
        });

        drawColours(defaults.colors);

        // Full weight is the usual starting point for a spool's initial weight
        $("sp-weight").addEventListener("input", () => { $("sp-initial-weight").value = $("sp-weight").value; });

        actionButton.onclick = () => submitNewSpool(pane, actionButton, button, amsSpool, lookups, catalogueVendor);
    }

    async function submitNewSpool(pane, actionButton, button, amsSpool, lookups, catalogueVendor = null) {
        const $ = (id) => pane.querySelector(`#${id}`);
        const error = $("sp-error");
        error.textContent = "";

        const filamentId = $("sp-filament").value;
        const payload = { spool: {
            initialWeight:   $("sp-initial-weight").value,
            remainingWeight: $("sp-remaining-weight").value,
            location:        $("sp-location").value,
            comment:         $("sp-comment").value,
        } };

        if (filamentId) {
            payload.filamentId = Number(filamentId);
        } else {
            const vendorName = $("sp-vendor").value.trim();
            const known = (lookups.vendors || []).find(v => v.name.toLowerCase() === vendorName.toLowerCase());

            payload.filament = {
                vendorId:     known?.id ?? null,
                vendorName:   known ? null : vendorName,
                name:         $("sp-name").value,
                material:     $("sp-material").value,
                density:      $("sp-density").value,
                diameter:     $("sp-diameter").value,
                colorHexes:   [...pane.querySelectorAll(".sp-colour-hex")].map(input => input.value),
                multiColorDirection: $("sp-direction").value,
                weight:       $("sp-weight").value,
                spoolWeight:  $("sp-spool-weight").value,
                extruderTemp: $("sp-extruder-temp").value,
                bedTemp:      $("sp-bed-temp").value,
            };

            // Only when the field still names the manufacturer the catalogue
            // entry did. Typing over it makes this a vendor of the user's own,
            // and the catalogue has nothing to say about that one.
            if (!known && catalogueVendor && sameText(catalogueVendor.name, vendorName)) {
                payload.filament.vendorExternalId = catalogueVendor.name;
                payload.filament.vendorSpoolWeight = catalogueVendor.spoolWeight;
            }

            if (!payload.filament.material.trim()) { error.textContent = t("dashboard.create.materialRequired"); return; }
            if (!(Number(payload.filament.density) > 0))  { error.textContent = t("dashboard.create.densityRequired"); return; }
            if (!(Number(payload.filament.diameter) > 0)) { error.textContent = t("dashboard.create.diameterRequired"); return; }
        }

        const original = actionButton.textContent;
        actionButton.disabled = true;
        actionButton.textContent = t("dashboard.create.creating");

        try {
            const res = await fetch(`./api/thirdparty/spool/${encodeURIComponent(currentPrinterId)}/${encodeURIComponent(amsSpool.amsId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const body = await res.json().catch(() => ({}));

            if (!res.ok) {
                error.textContent = body.error || t("dashboard.requestFailedStatus", { status: res.status });
                actionButton.disabled = false;
                actionButton.textContent = original;
                return;
            }

            document.getElementById("info-dialog").close();
            showNotification(t("dashboard.create.created", { id: body.spoolId, slot: amsSpool.amsId }), "success");
            await loadPrinterData(currentPrinterId);
        } catch (err) {
            console.error("Spool creation failed:", err);
            error.textContent = t("dashboard.requestFailedConnection");
            actionButton.disabled = false;
            actionButton.textContent = original;
        }
    }

    function showUnassignDialog(button, amsSpool) {
        const sp = amsSpool.existingSpool;
        // The placeholders are filled after escaping, because they carry markup
        const question = escapeHtml(t(sp ? "dashboard.unassign.questionSpool" : "dashboard.unassign.question", {
            slot: "{slot}",
            spool: "{spool}",
        }))
            .replace("{slot}", `<strong>${escapeHtml(amsSpool.amsId)}</strong>`)
            .replace("{spool}", sp ? `<strong>#${sp.id}</strong>` : "");
        const content = `
            <p>${question}</p>
            <p class="gc-muted" style="font-size:0.85em">${escapeHtml(t("dashboard.unassign.note"))}</p>`;
        showDialog(button, content, t("dashboard.unassign.unassign"), () => sendMapping(button, amsSpool, null));
    }

    // null spoolId removes the assignment.
    async function sendMapping(button, amsSpool, spoolId) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = t("dashboard.sending");

        const url = `./api/mappings/${encodeURIComponent(currentPrinterId)}/${encodeURIComponent(amsSpool.amsId)}`;

        try {
            const res = spoolId == null
                ? await fetch(url, { method: "DELETE" })
                : await fetch(url, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ spoolId }),
                  });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showNotification(t("dashboard.error", { error: err.error || t("dashboard.assign.failed") }), "error");
                button.textContent = originalText;
                button.disabled = false;
                return;
            }

            showNotification(spoolId == null
                ? t("dashboard.assign.removed")
                : t("dashboard.assign.assigned", { id: spoolId }), "success");
            // The backend also pushes a slot_update over SSE, but re-render right
            // away so the row never sits on "Sending..." if that event is missed.
            await loadPrinterData(currentPrinterId);
        } catch (err) {
            console.error("Assignment failed:", err);
            showNotification(t("dashboard.requestFailedConnection"), "error");
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    // ---- Spool detail dialog -------------------------------------------------
    // Opened from a filament name in either table. One tab for the spool, one for
    // the filament behind it, each showing the whole Spoolman record next to a
    // large colour swatch and a link to its Spoolman page. The dashboard payload
    // is narrowed on purpose, so the record is fetched here rather than carried
    // on every slot of every update.

    // The name both tables print, without any of the markup around it.
    function spoolReadableName(amsSpool) {
        const slot = amsSpool.slot || {};
        const fil = amsSpool.existingSpool?.filament;

        if (amsSpool.slotState === "Empty") {
            // An empty slot the AMS is busy with is a spool going in or out, which
            // reports nothing the backend could tell from a truly empty slot.
            return amsSpool.option === SLOT_OPTIONS.WAITING ? t("dashboard.spool.reading") : t("dashboard.spool.emptySlot");
        }

        // A spool without a tag reports no name of its own, only the preset
        // chosen for its slot, so that is what it is called until a Spoolman
        // spool is assigned. The word "preset" stays in the name on purpose: a
        // chipless spool set to Bambu PLA Basic is not one.
        if (amsSpool.slotState === "Loaded (3rd party)" && !fil) {
            return presetReadableName(slot);
        }

        const parts = [
            fil?.vendor?.name ?? amsSpool.matchingExternalFilament?.manufacturer,
            fil?.material     ?? slot.tray_type,
            fil?.name         ?? amsSpool.matchingExternalFilament?.name ?? slot.tray_sub_brands,
        ].filter(Boolean);
        return parts.length ? parts.join(" · ") : t("dashboard.unknownFilament");
    }

    /**
     * The name of a chipless slot: "Generic PLA preset", "SUNLU PETG preset",
     * "PLA · custom preset" for a hash the slicer knows and the printer does
     * not, and the bare material where the slot names no preset.
     */
    function presetReadableName(slot) {
        const preset = slotPreset(slot);
        if (preset?.name) return t("dashboard.preset.named", { name: preset.name });
        const material = slot.tray_type || null;
        if (preset?.kind === "custom") {
            return material ? t("dashboard.preset.customWithMaterial", { material }) : t("dashboard.preset.custom");
        }
        return material ?? t("dashboard.unknownFilament");
    }

    // The em dash is this UI's "no value", so an absent field reads the same here
    // as it does in the tables.
    function detailText(value) {
        return value == null || value === "" ? "—" : escapeHtml(value);
    }

    /**
     * The profile row of the detail dialog: the name and the id where the id is
     * a shipped one, the id and where its name lives where it is a slicer hash,
     * and what a chipless slot's preset is not.
     */
    function presetDetail(preset, chipless) {
        if (!preset) return "—";
        const id = `<span class="gc-muted">(${escapeHtml(preset.id)})</span>`;
        // The value cell lays its children out as a row, so the label and the
        // note under it travel as one block.
        const withNote = (label, note) => `<span>${label}<br><span class="gc-muted">${note}</span></span>`;
        if (preset.kind === "custom") {
            if (preset.name) {
                return withNote(`${escapeHtml(preset.name)} ${id}`, escapeHtml(t("dashboard.preset.learnedNote")));
            }
            return withNote(`${escapeHtml(t("dashboard.preset.custom"))} ${id}`, escapeHtml(t("dashboard.preset.unlearnedNote")));
        }
        const label = preset.name ? `${escapeHtml(preset.name)} ${id}` : escapeHtml(preset.id);
        if (!chipless) return label;
        return withNote(label, escapeHtml(t("dashboard.preset.chosenNote")));
    }

    // Nominal weights are whole grams; what a print books off a spool is not,
    // and the table shows those to the hundredth, so the dialog does the same.
    function detailGrams(value, decimals = 0) {
        return value == null ? "—" : `${Number(value).toFixed(decimals)} g`;
    }

    // Whether the weight on the spool is Spoolman's to say: only when the slot
    // is linked to that spool, by tag, by assignment or as the archived spool
    // still sitting there. A mere candidate in existingSpool, the one a Merge
    // would use, is not this slot's spool and must not lend it its weight.
    function spoolmanSaysWeight(amsSpool) {
        const sp = amsSpool.existingSpool;
        const linked = amsSpool.connectedViaTag || amsSpool.connectedViaMapping || amsSpool.archived;
        return !!linked && !!sp && sp.remaining_weight != null;
    }

    /** A weight to the hundredth of a gram, always with both decimals: "30.00g". */
    function grams2(value) {
        return `${Number(value).toFixed(2)}g`;
    }

    function detailDate(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? escapeHtml(value) : formatDate(date);
    }

    // Spoolman stores an extra field as its JSON representation, so a tag comes
    // back wrapped in quotes and would be shown with them.
    function detailExtra(value) {
        if (value == null || value === "") return "—";
        try {
            return detailText(JSON.parse(value));
        } catch {
            return detailText(value);
        }
    }

    // Which colours a slot is drawn in: the linked Spoolman spool's, and the ones
    // the printer reports for a slot that has no spool behind it.
    //
    // The AMS reports what physically sits in the tray, which is the only source
    // for an unlinked slot. As soon as a spool is linked, the Spoolman record is
    // the one a user keeps, so the swatch follows it and stops disagreeing with
    // the spool page it links to. Where the two differ, the detail dialog names
    // both under "Colour (printer)" and "Colour (Spoolman)".
    //
    // The direction is never reported by the AMS, so it always comes from
    // whichever filament record was matched.
    function spoolSwatchColors(amsSpool, spool = null) {
        const filament = (spool ?? amsSpool.existingSpool)?.filament || null;
        const spoolmanColors = filamentColors(filament || {});
        const direction = filament?.multi_color_direction ?? amsSpool.matchingExternalFilament?.multi_color_direction ?? null;

        return {
            colors: spoolmanColors.length ? spoolmanColors : slotColors(amsSpool.slot || {}),
            direction,
        };
    }

    // A colour set as the small swatch plus the hex codes behind it. The AMS and
    // Spoolman each report their own, and the two disagreeing is what explains a
    // spool the automatic match will not connect.
    function detailColors(colors, direction) {
        if (!colors.length) return "—";
        return `${swatchHtml(colors, direction)}${colors.map(c => `#${normColor(c)}`).join(" ")}`;
    }

    // Same colours as the inline swatch, drawn large enough to tell two shades of
    // one filament apart, which is what the 12px one in the table cannot do.
    function bigSwatchHtml(colors, direction) {
        const background = colorSetBackground(colors, direction);
        if (!background) return "";
        const title = colors.map(c => `#${normColor(c)}`).join(" ");
        return `<span class="sd-swatch" style="background:${background}" title="${title}"></span>`;
    }

    // A row is `[label, value]`, or `[label, value, field]` for one of the three
    // fields that can be corrected here. The pencil turns that row into an input
    // in place, so the values stay where they are read instead of being repeated
    // in a form of their own further down.
    //
    // It sits in front of the value rather than behind it. Behind it, every row
    // had to reserve its width to keep the values on one right edge, which left
    // a gap along the whole list; in front, it takes the empty space between the
    // label and the value that every row already has.
    function detailRows(rows) {
        return `<div class="sd-grid">${rows
            .filter(Boolean)
            .map(([label, value, field]) => `
                <div class="sd-row"${field ? ` data-field="${field}"` : ""}>
                    <span class="sd-label">${escapeHtml(label)}</span>
                    <span class="sd-value">${field ? editButtonHtml(field) : ""}${value}</span>
                </div>`)
            .join("")}</div>`;
    }

    function editButtonHtml(field) {
        // One key per field rather than "Change {field}": the English label
        // was lowercased into the sentence, which a German noun must not be.
        const what = t(`dashboard.detail.edit.${field}`);
        return `<button type="button" class="sd-edit" data-field="${field}" title="${escapeHtml(what)}" aria-label="${escapeHtml(what)}">✎</button>`;
    }

    // The link out to Spoolman belongs to whichever tab is open, so it sits in
    // that pane's head rather than in the button row, where it read as a third
    // action next to Close and Save.
    function spoolmanLinkHtml(path, label) {
        return `<a class="sd-link gc-link" href="${spoolmanBase()}${path}" target="_blank" rel="noopener">${escapeHtml(label)} ↗</a>`;
    }

    function spoolmanBase() {
        return (document.getElementById("spoolmanLink")?.href || "").replace(/\/+$/, "");
    }

    // Why a spool cannot be edited right now, or null when it can. Legacy mode
    // closes the whole form, a running print only the remaining weight: both of
    // them write that number afterwards, and neither touches comment or lot
    // number. The backend refuses the same two cases.
    function spoolEditBlockedReason() {
        if (legacyMode) {
            return {
                everything: true,
                reason: t("dashboard.detail.blockedLegacy"),
            };
        }
        if (ACTIVE_PRINT_STATES.includes(printerGcodeState)) {
            return {
                everything: false,
                reason: t("dashboard.detail.blockedPrinting", { state: printerGcodeState }),
            };
        }
        return null;
    }

    async function showSpoolDetailDialog(amsSpool) {
        const dialog  = document.getElementById("spool-detail-dialog");
        const content = document.getElementById("spool-detail-content");
        const close   = document.getElementById("spool-detail-close");

        updateElementText("spool-detail-title", `${amsSpool.amsId} · ${spoolReadableName(amsSpool)}`);
        content.innerHTML = `<p>${escapeHtml(t("dashboard.loadingSpoolman"))}</p>`;
        close.onclick = () => dialog.close();
        dialog.showModal();
        close.focus();

        let spool = null;
        if (amsSpool.existingSpool?.id) {
            try {
                spool = await fetchJson(`./api/spoolman/spool/${amsSpool.existingSpool.id}`);
            } catch (err) {
                content.innerHTML = `<p class="gc-bad">${escapeHtml(t("dashboard.detail.loadFailed", { error: err.message }))}</p>`;
                return;
            }
        }

        renderSpoolDetail(amsSpool, spool);
    }

    // Rerendered after a save as well, from the record Spoolman answered with
    // rather than from what was sent, so the dialog shows what was really stored.
    function renderSpoolDetail(amsSpool, spool) {
        const content = document.getElementById("spool-detail-content");

        content.innerHTML = `
            <div class="sp-tabs">
                <button type="button" class="sp-tab sp-tab-active" data-tab="spool">${escapeHtml(t("dashboard.detail.spool"))}</button>
                <button type="button" class="sp-tab" data-tab="filament">${escapeHtml(t("dashboard.detail.filament"))}</button>
            </div>
            <div id="sd-pane"></div>`;

        const pane = content.querySelector("#sd-pane");
        const tabs = [...content.querySelectorAll(".sp-tab")];

        const selectTab = (tab) => {
            for (const other of tabs) other.classList.toggle("sp-tab-active", other.dataset.tab === tab);
            if (tab === "spool") renderSpoolPane(pane, amsSpool, spool);
            else renderFilamentPane(pane, amsSpool, spool);
        };
        for (const other of tabs) other.addEventListener("click", () => selectTab(other.dataset.tab));

        selectTab("spool");
    }

    function renderSpoolPane(pane, amsSpool, spool) {
        const slot = amsSpool.slot || {};
        const isEmpty = amsSpool.slotState === "Empty";

        // The record the dialog just fetched, where there is one: it is fresher
        // than the copy the table was drawn from.
        const { colors, direction } = spoolSwatchColors(amsSpool, spool);
        const swatch = isEmpty ? "" : bigSwatchHtml(colors, direction);

        const linkState = amsSpool.connectedViaMapping
            ? `<span class="gc-ok">${escapeHtml(t(amsSpool.assignedAutomatically ? "dashboard.detail.assignedAutomatically" : "dashboard.detail.assignedByHand"))}</span>`
            : amsSpool.connectedViaTag
                ? `<span class="gc-ok">${escapeHtml(t("dashboard.detail.linkedByTag"))}</span>`
                : `<span class="gc-warn">${escapeHtml(t("dashboard.notLinked"))}</span>`;

        const profile = bambuProfile(slot.tray_info_idx);
        const preset = slotPreset(slot);
        const chipless = amsSpool.slotState === "Loaded (3rd party)";

        // The two sides disagreeing about the material is what a spool assigned to
        // the wrong slot looks like, so it is marked where both are shown.
        const materialsDiffer = spool && !materialsAgree(slotMaterial(slot), spool.filament?.material)
            ? ` <span class="gc-warn" title="${escapeHtml(t("dashboard.detail.materialDiffers", { material: spool.filament?.material ?? t("dashboard.detail.anotherMaterial") }))}">⚠</span>`
            : "";

        const slotRows = detailRows([
            [t("dashboard.detail.slot"), detailText(amsSpool.amsId)],
            [t("dashboard.detail.state"), detailText(slotStateLabel(amsSpool.slotState))],
            // The id alone says nothing to read, so the filament Bambu Studio would
            // print it as leads and the id follows it. An id no profile is known
            // for stands on its own. On a spool without a tag the row is the
            // preset chosen for the slot, and says so, because the printer then
            // reports a Bambu id for a spool that is not one.
            [t(chipless ? "dashboard.detail.slotPreset" : "dashboard.detail.trayProfile"), presetDetail(preset, chipless)],
            [t("dashboard.detail.materialPrinter"), `${detailText(profile?.material ?? slot.tray_type)}${materialsDiffer}`],
            [t("dashboard.detail.colourPrinter"), detailColors(slotColors(slot), direction)],
            [t("dashboard.table.serial"), detailText(slot.tray_uuid)],
            // An empty slot and a spool without a tag both report 0 rather than
            // nothing, and neither of them weighs nothing.
            [t("dashboard.detail.trayWeight"), Number(slot.tray_weight) ? detailGrams(slot.tray_weight) : "—"],
            // Without a tag there is nothing to read a percentage from, and the
            // printer reports 0 rather than nothing for such a slot.
            [t("dashboard.detail.rfidRemain"), slot.tray_uuid == null || slot.remain == null ? "—" : `${slot.remain}%`],
            [t("dashboard.detail.spoolmanLink"), linkState],
        ]);

        if (!spool) {
            pane.innerHTML = `
                <div class="sd-head">${swatch}<div>
                    <div class="sd-name">${escapeHtml(spoolReadableName(amsSpool))}</div>
                    <div class="gc-muted sd-sub">${escapeHtml(t("dashboard.detail.noSpoolLinked"))}</div>
                </div></div>
                <div class="sd-scroll">
                    <div class="sd-section">${escapeHtml(t("dashboard.detail.printer"))}</div>
                    ${slotRows}
                </div>`;
            return;
        }

        const blocked = spoolEditBlockedReason();
        // A pencil on a field something else is about to write would promise an
        // edit that does not hold, so the reason is shown instead of the pencil.
        const weightField = blocked ? null : "remainingWeight";
        const textField = (field) => (blocked?.everything ? null : field);

        pane.innerHTML = `
            <div class="sd-head">${swatch}<div>
                <div class="sd-name">${escapeHtml(spoolReadableName(amsSpool))}</div>
                <div class="gc-muted sd-sub">${escapeHtml(t("dashboard.detail.spoolmanSpool", { id: spool.id }))}</div>
                ${spoolmanLinkHtml(`/spool/show/${spool.id}`, t("dashboard.detail.openSpool"))}
            </div></div>
            <div class="sd-scroll">
                <div class="sd-section">${escapeHtml(t("dashboard.detail.spool"))}</div>
                ${blocked ? `<p class="sd-note gc-warn">${escapeHtml(blocked.reason)}</p>` : ""}
                ${detailRows([
                    [t("dashboard.detail.remaining"), `${detailGrams(spool.remaining_weight, 2)}${spool.remaining_percentage == null ? "" : ` (${Math.round(spool.remaining_percentage)}%)`}`, weightField],
                    [t("dashboard.detail.used"), detailGrams(spool.used_weight, 2)],
                    [t("dashboard.detail.initialWeight"), detailGrams(spool.initial_weight)],
                    [t("dashboard.detail.emptySpool"), detailGrams(spool.spool_weight)],
                    [t("dashboard.detail.materialSpoolman"), detailText(spool.filament?.material)],
                    [t("dashboard.detail.colourSpoolman"), detailColors(filamentColors(spool.filament || {}), spool.filament?.multi_color_direction)],
                    [t("dashboard.detail.location"), detailText(spool.location)],
                    [t("dashboard.detail.price"), spool.price == null ? "—" : detailText(spool.price)],
                    [t("dashboard.detail.registered"), detailDate(spool.registered)],
                    [t("dashboard.detail.firstUsed"), detailDate(spool.first_used)],
                    [t("dashboard.detail.lastUsed"), detailDate(spool.last_used)],
                    [t("dashboard.detail.archived"), escapeHtml(t(spool.archived ? "dashboard.detail.yes" : "dashboard.detail.no")), textField("archived")],
                    [t("dashboard.detail.lotNumber"), detailText(spool.lot_nr), textField("lotNr")],
                    [t("dashboard.detail.comment"), detailText(spool.comment), textField("comment")],
                    [t("dashboard.detail.tag"), detailExtra(spool.extra?.tag)],
                ])}

                <div class="sd-section">${escapeHtml(t("dashboard.detail.printer"))}</div>
                ${slotRows}
            </div>`;

        pane.addEventListener("click", event => {
            const button = event.target.closest(".sd-edit");
            if (button) startFieldEdit(button.closest(".sd-row"), button.dataset.field, amsSpool, spool);
        });
    }

    // What each editable row holds, reads back and refuses. The three entries are
    // the only fields this dialog writes; everything else about a spool is either
    // derived, owned by this service, or belongs to the shared filament record.
    const SPOOL_EDIT_FIELDS = {
        remainingWeight: {
            type: "number",
            unit: "g",
            value: spool => (spool.remaining_weight == null ? "" : String(Math.round(spool.remaining_weight))),
            check: (raw, spool) => {
                const weight = Number(raw);
                if (raw === "" || !Number.isFinite(weight)) return { error: t("dashboard.detail.enterGrams") };
                if (weight < 0) return { error: t("dashboard.detail.negativeWeight") };

                const limit = spoolWeightLimit(spool);
                if (limit != null && weight > limit) return { error: t("dashboard.detail.weightLimit", { limit: Math.round(limit) }) };

                return { value: Math.round(weight) };
            },
        },
        lotNr: {
            type: "text",
            value: spool => spool.lot_nr ?? "",
            check: raw => ({ value: raw.trim() }),
        },
        comment: {
            type: "text",
            value: spool => spool.comment ?? "",
            check: raw => ({ value: raw.trim() }),
        },
        // Archiving is what the service does by itself for an empty spool, and
        // this row is both the manual way there and the way back from one that
        // was archived too early.
        archived: {
            type: "select",
            options: [["false", "dashboard.detail.no"], ["true", "dashboard.detail.yes"]],
            value: spool => (spool.archived ? "true" : "false"),
            check: raw => ({ value: raw === "true" }),
        },
    };

    // Turns one row into an input in place. The row is rebuilt from the record
    // Spoolman answers with, so what stays on screen is what was really stored.
    function startFieldEdit(row, field, amsSpool, spool) {
        const spec = SPOOL_EDIT_FIELDS[field];
        if (!spec || row.classList.contains("sd-row-editing")) return;

        const value = row.querySelector(".sd-value");
        const before = value.innerHTML;

        row.classList.add("sd-row-editing");
        // A select rather than an input for a field with a fixed set of values:
        // the same class, so the confirm, cancel and key handling below do not
        // have to know which of the two they are driving.
        const control = spec.type === "select"
            ? `<select class="sd-input">${spec.options
                .map(([option, label]) => `<option value="${option}"${spec.value(spool) === option ? " selected" : ""}>${escapeHtml(t(label))}</option>`)
                .join("")}</select>`
            : `<input class="sd-input" type="${spec.type}" ${spec.type === "number" ? 'min="0" step="1"' : 'autocomplete="off"'}
                    value="${escapeHtml(spec.value(spool))}">`;

        value.innerHTML = `
            <span class="sd-editing">
                ${control}
                ${spec.unit ? `<span class="gc-muted">${spec.unit}</span>` : ""}
                <button type="button" class="sd-confirm" title="${escapeHtml(t("dashboard.detail.save"))}">✓</button>
                <button type="button" class="sd-cancel" title="${escapeHtml(t("dashboard.detail.cancel"))}">✕</button>
            </span>
            <span class="sd-inline-error gc-bad"></span>`;

        const input = value.querySelector(".sd-input");
        const error = value.querySelector(".sd-inline-error");

        const stop = () => {
            row.classList.remove("sd-row-editing");
            value.innerHTML = before;
        };

        const submit = async () => {
            const checked = spec.check(input.value, spool);
            if (checked.error) {
                error.textContent = checked.error;
                input.focus();
                return;
            }

            error.textContent = "";
            input.disabled = true;
            try {
                await saveSpoolField(field, checked.value, amsSpool, spool);
            } catch (err) {
                error.textContent = err.message;
                input.disabled = false;
                input.focus();
            }
        };

        value.querySelector(".sd-confirm").addEventListener("click", submit);
        value.querySelector(".sd-cancel").addEventListener("click", stop);
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); submit(); }
            if (event.key === "Escape") { event.preventDefault(); stop(); }
        });

        input.focus();
        if (typeof input.select === "function") input.select();
    }

    async function saveSpoolField(field, value, amsSpool, spool) {
        const updated = await fetchJson(`./api/spoolman/spool/${spool.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [field]: value }),
        });

        showNotification(t("dashboard.detail.updated", { id: spool.id }), "success");
        renderSpoolDetail(amsSpool, updated);

        // The table shows the remaining weight of this spool, so it has to be
        // refetched rather than waiting for the next AMS report.
        if (currentPrinterId) await loadPrinterData(currentPrinterId);
    }

    function renderFilamentPane(pane, amsSpool, spool) {

        const fil = spool?.filament || null;
        const external = amsSpool.matchingExternalFilament;

        if (!fil) {
            pane.innerHTML = external
                ? `
                    <div class="sd-head">${bigSwatchHtml(slotColors(amsSpool.slot || {}), external.multi_color_direction)}<div>
                        <div class="sd-name">${escapeHtml([external.manufacturer, external.material, external.name].filter(Boolean).join(" · "))}</div>
                        <div class="gc-muted sd-sub">${escapeHtml(t("dashboard.detail.fromCatalogue"))}</div>
                    </div></div>
                    <div class="sd-scroll">
                        <div class="sd-section">${escapeHtml(t("dashboard.detail.catalogueEntry"))}</div>
                        ${detailRows([
                            [t("dashboard.detail.manufacturer"), detailText(external.manufacturer)],
                            [t("dashboard.detail.material"), detailText(external.material)],
                            [t("dashboard.detail.name"), detailText(external.name)],
                            [t("dashboard.detail.density"), external.density == null ? "—" : `${external.density} g/cm³`],
                            [t("dashboard.detail.diameter"), external.diameter == null ? "—" : `${external.diameter} mm`],
                            [t("dashboard.detail.externalId"), detailText(external.id)],
                        ])}
                    </div>`
                : `<p class="gc-muted">${escapeHtml(t("dashboard.detail.noFilament"))}</p>`;
            return;
        }

        pane.innerHTML = `
            <div class="sd-head">${bigSwatchHtml(filamentColors(fil), fil.multi_color_direction)}<div>
                <div class="sd-name">${escapeHtml([fil.vendor?.name, fil.material, fil.name].filter(Boolean).join(" · ") || t("dashboard.unknownFilament"))}</div>
                <div class="gc-muted sd-sub">${escapeHtml(t("dashboard.detail.spoolmanFilament", { id: fil.id }))}</div>
                ${spoolmanLinkHtml(`/filament/show/${fil.id}`, t("dashboard.detail.openFilament"))}
            </div></div>
            <div class="sd-scroll">
                <div class="sd-section">${escapeHtml(t("dashboard.detail.filament"))}</div>
                ${detailRows([
                    [t("dashboard.detail.manufacturer"), detailText(fil.vendor?.name)],
                    [t("dashboard.detail.material"), detailText(fil.material)],
                    [t("dashboard.detail.name"), detailText(fil.name)],
                    [t("dashboard.detail.colour"), detailText((filamentColors(fil).map(c => `#${normColor(c)}`).join(" ")) || null)],
                    [t("dashboard.detail.multiColour"), detailText(fil.multi_color_direction ? directionLabel(fil.multi_color_direction) : null)],
                    [t("dashboard.detail.density"), fil.density == null ? "—" : `${fil.density} g/cm³`],
                    [t("dashboard.detail.diameter"), fil.diameter == null ? "—" : `${fil.diameter} mm`],
                    [t("dashboard.detail.fullWeight"), detailGrams(fil.weight)],
                    [t("dashboard.detail.emptySpool"), detailGrams(fil.spool_weight)],
                    [t("dashboard.detail.nozzleTemp"), fil.settings_extruder_temp == null ? "—" : `${fil.settings_extruder_temp} °C`],
                    [t("dashboard.detail.bedTemp"), fil.settings_bed_temp == null ? "—" : `${fil.settings_bed_temp} °C`],
                    [t("dashboard.detail.externalId"), detailText(fil.external_id)],
                    [t("dashboard.detail.comment"), detailText(fil.comment)],
                ])}
            </div>`;
    }

    // Combined "Spool" identity cell shared by both the G-code dashboard and the
    // (legacy) classic table: color swatch + readable filament name
    // (vendor · material · name) with an optional ambiguity warning, then a muted
    // second line with the AMS slot id, tray index, Spoolman link and the
    // tag/booking status. Pass `ctx` with a `keyCount` map to enable the
    // duplicate-spool ⚠ marker (only meaningful when all slots are known).
    function spoolIdentityHtml(amsSpool, ctx = null) {
        const slot = amsSpool.slot || {};
        const isEmpty = amsSpool.slotState === "Empty";

        const readable = spoolReadableName(amsSpool);

        // A linked spool is drawn in its Spoolman colours, an unlinked slot in the
        // ones the printer reports for it. See spoolSwatchColors().
        const { colors, direction } = spoolSwatchColors(amsSpool);
        const color = isEmpty ? "" : swatchHtml(colors, direction);

        // A spool without an RFID tag: the AMS reports the generic profile and no
        // serial, so nothing but this label separates it from a Bambu spool the
        // printer simply has not read yet. Both views show it, the classic table
        // only had the ⚠ in its State column, which names no reason.
        const thirdParty = amsSpool.slotState === "Loaded (3rd party)"
            ? ` · <span class="gc-warn" title="${escapeHtml(THIRD_PARTY_HINT)}">${escapeHtml(t("dashboard.spool.thirdParty"))}</span>`
            : "";

        // The spool is still in the slot, so the row is not an empty one, but
        // nothing is offered for it until it is taken out or restored.
        const archived = amsSpool.archived
            ? ` · <span class="gc-muted" title="${escapeHtml(ARCHIVED_HINT)}">${escapeHtml(t("dashboard.spool.archived"))}</span>`
            : "";

        const spoolman = amsSpool.existingSpool?.id
            ? `<a class="gc-link" href="${spoolmanBase()}/spool/show/${amsSpool.existingSpool.id}" target="_blank">Spoolman #${amsSpool.existingSpool.id}</a>`
            : `<span class="gc-muted">${escapeHtml(t("dashboard.notLinked"))}</span>`;

        // Tag/booking status is G-code-consumption semantics, so only shown there.
        let booking = "";
        if (!isEmpty && ctx?.showBooking) {
            if (amsSpool.connectedViaMapping && amsSpool.assignedAutomatically) {
                booking = ` · <span class="gc-ok" title="${escapeHtml(t("dashboard.booking.autoAssignedTitle"))}">● ${escapeHtml(t("dashboard.booking.autoAssigned"))}</span>`;
            } else if (amsSpool.connectedViaMapping) {
                booking = ` · <span class="gc-ok" title="${escapeHtml(t("dashboard.booking.assignedTitle"))}">● ${escapeHtml(t("dashboard.booking.assigned"))}</span>`;
            } else if (amsSpool.connectedViaTag) {
                booking = ` · <span class="gc-ok" title="${escapeHtml(t("dashboard.booking.tagLinkedTitle"))}">● ${escapeHtml(t("dashboard.booking.tagLinked"))}</span>`;
            } else {
                booking = ` · <span class="gc-warn" title="${escapeHtml(t("dashboard.booking.notTrackedTitle"))}">● ${escapeHtml(t("dashboard.booking.notTracked"))}</span>`;
            }
        }

        // A manual assignment resolves the ambiguity for this slot, so the warning
        // only applies while the slot still relies on the automatic match.
        const ambiguous = (!isEmpty && !amsSpool.connectedViaMapping && ctx?.keyCount && ctx.keyCount[amsSpool.key] > 1)
            ? ` <span class="gc-warn" title="${escapeHtml(t("dashboard.spool.ambiguousTitle"))}">⚠</span>`
            : "";

        // The name opens the detail dialog. A button rather than a styled span, so
        // it is reachable by keyboard and announced as the control it is.
        const name = `<button type="button" class="spool-name-link" data-amsid="${escapeHtml(amsSpool.amsId)}"
            title="${escapeHtml(t("dashboard.spool.showDetails"))}">${escapeHtml(readable)}</button>`;

        return `
            ${color}${name}${ambiguous}<br>
            <span style="font-size:0.82em">
                <span class="gc-muted">${amsSpool.amsId} · <code>${isEmpty ? "—" : (slot.tray_info_idx ?? "—")}</code></span>${thirdParty}${archived} · ${spoolman}${booking}
            </span>`;
    }

    function createSpoolRow(amsSpool, ctx = null) {
        const tr = document.createElement("tr");
        tr.setAttribute("data-amsid", amsSpool.amsId);
        renderedSpools.set(amsSpool.amsId, amsSpool);

        let amsSpoolRemainingWeight = amsSpool.amsWeight ?? (amsSpool.slot.remain == null
            ? null
            : (amsSpool.slot.tray_weight / 100) * amsSpool.slot.remain);
        let correctedRemain = amsSpool.correctedRemain ?? amsSpool.slot.remain;
        let totalWeight = amsSpool.slot.tray_weight;

        // In G-code mode the AMS RFID remain % is not tracked, so show the actual
        // Spoolman remaining weight/percentage of the linked spool instead.
        const sp = amsSpool.existingSpool;
        if (!legacyMode && spoolmanSaysWeight(amsSpool)) {
            const full = sp.filament?.weight;
            amsSpoolRemainingWeight = Math.round(sp.remaining_weight);
            if (sp.remaining_percentage != null) {
                correctedRemain = Math.round(sp.remaining_percentage);
            } else if (full) {
                correctedRemain = Math.round((sp.remaining_weight / full) * 100);
            }
            if (full) totalWeight = Math.round(full);
        }

        const button = createActionButton(amsSpool);

        tr.innerHTML = `
            <td data-label="${escapeHtml(t("dashboard.table.spool"))}" style="text-align:left">${spoolIdentityHtml(amsSpool, ctx)}</td>
            <td data-label="${escapeHtml(t("dashboard.table.remaining"))}">${amsSpoolRemainingWeight == null ? "—" : `${amsSpoolRemainingWeight} g`} / ${totalWeight} g (${correctedRemain == null ? "—" : `${correctedRemain}%`})</td>
            <td data-label="${escapeHtml(t("dashboard.table.serial"))}">${amsSpool.slot.tray_uuid ?? "—"}</td>
            <td data-label="${escapeHtml(t("dashboard.table.state"))}">${setIcon(amsSpool.error, amsSpool.slotState)}</td>
        `;
        const tdBtn = document.createElement("td");
        // styles.css finds the cell by its class, the label is only shown text
        tdBtn.className = "action-cell";
        tdBtn.setAttribute("data-label", t("dashboard.table.action"));
        tdBtn.appendChild(button);
        tr.appendChild(tdBtn);

        return tr;
    }

    function upsertSpoolRow(amsSpool) {
        const selector = `[data-amsid="${amsSpool.amsId}"]`;
        const existingRow = document.querySelector(selector);
        const newRow = createSpoolRow(amsSpool, lastLegacyCtx);

        if (existingRow && existingRow.parentElement) {
            existingRow.parentElement.replaceChild(newRow, existingRow);
        } else {
            const tables = document.querySelectorAll('.spool-table tbody');
            const targetTbody = tables[tables.length - 1] || null;
            if (targetTbody) {
                targetTbody.appendChild(newRow);
                if (typeof synchronizeSelectedColumns === 'function') {
                    try { synchronizeSelectedColumns(SYNCED_COLUMNS); } catch (e) {}
                }
            } else {
                if (currentPrinterId) loadPrinterData(currentPrinterId);
            }
        }
    }

    // =======================================================================
    // G-code mode main view
    //
    // Replaces the classic AMS table with a print-centric dashboard: live print
    // state + each loaded spool joined with its consumption requirement (on spool
    // / needed / rest) and the same action button as the classic table. Driven by
    // /api/spools (full spool objects, for the buttons) + /api/print (print
    // state and per-filament consumption). Refreshed on SSE events.
    // =======================================================================

    let gcodeRefreshTimer = null;

    // Coalesce bursts of SSE events into at most one dashboard refresh per second.
    // Skip while an action dialog is open so the table doesn't change mid-action.
    function scheduleGcodeRefresh() {
        if (gcodeRefreshTimer) return;
        gcodeRefreshTimer = setTimeout(() => {
            gcodeRefreshTimer = null;
            if (currentPrinterId && !legacyMode && !isDialogOpen()) loadGcodeView(currentPrinterId);
        }, 1000);
    }

    // Slots that stand alone rather than filling a four slot AMS unit. An
    // external spool holder reports one spool and gets a table of its own, like
    // an AMS HT unit, because it belongs to no four slot unit and would
    // otherwise break their grouping. A dual nozzle printer has two of them.
    function isSingleSlotUnit(amsId) {
        return amsId === EXTERNAL_SLOT || amsId === SECOND_EXTERNAL_SLOT || amsId.startsWith("HT-");
    }

    function gcodeStateBadge(state) {
        const variants = {
            RUNNING: "gc-state-running", FINISH: "gc-state-done",
            FAILED:  "gc-state-error",   CANCEL: "gc-state-error",
            PAUSE:   "gc-state-paused",  PREPARE: "gc-state-prepare",
        };
        return `<span class="gc-state ${variants[state] || ""}">${state || "—"}</span>`;
    }

    /**
     * The stage badge next to the state, while the printer is doing something
     * other than laying down filament.
     *
     * Amber while it is getting ready — heating, homing, levelling, loading —
     * and neutral for everything else it names, so a glance at the card says
     * whether a print that has started is actually printing yet. Nothing is
     * shown when the printer reports no stage, which is most of a running
     * print.
     */
    function printStageBadge(printData) {
        if (!printData.stage) return "";
        const variant = printData.preparing ? "gc-state-prepare" : "";
        // By its number, which every language has a name for; the English
        // name the server sends is what a stage without a key shows.
        const key = `print.stage.${printData.stageCode}`;
        const stage = printData.stageCode != null && I18N.has(key) ? t(key) : printData.stage;
        return `<span class="gc-state gc-stage ${variant}">${escapeHtml(stage)}</span>`;
    }

    async function loadGcodeView(printerId) {
        const el = getElementSafe("spool-list");
        if (!el) return;
        try {
            const [spoolsRes, printRes] = await Promise.all([
                fetch(`./api/spools/${printerId}`),
                fetch(`./api/print/${printerId}`),
            ]);
            if (!spoolsRes.ok || !printRes.ok) {
                const failed = !spoolsRes.ok ? spoolsRes : printRes;
                const body = await failed.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${failed.status}`);
            }

            const spools = await spoolsRes.json();
            const printData = await printRes.json();
            printerGcodeState = printData.gcodeState || "IDLE";

            el.innerHTML = "";
            el.appendChild(buildGcodeCard(printData));

            for (const table of buildGcodeSpoolTables(spools, printData)) {
                el.appendChild(table);
            }

            // Every column to its widest cell, so AMS A / AMS B / … line up.
            synchronizeSelectedColumns(SYNCED_COLUMNS);

            const missing = buildGcodeMissing(printData);
            if (missing) el.appendChild(missing);
        } catch (err) {
            el.innerHTML = `<p class="gc-required">${escapeHtml(t("dashboard.requestFailed", { error: err.message }))}</p>`;
        }
    }

    function buildGcodeCard(printData) {
        const active = ACTIVE_PRINT_STATES.includes(printData.gcodeState);
        const { layer: humanLayer, total: humanTotal, percent: progressPct } =
            humanLayers(printData.layerNum, printData.totalLayers);

        // The printer reports RUNNING from the first second of a job, through
        // minutes of heating, homing and calibration, and read "RUNNING" next
        // to "Homing toolhead" like a contradiction. The state badge says
        // PREPARE for as long as the stage is one of those and no layer has
        // been printed; the stage badge next to it still names which. A
        // filament load in the middle of a print is the same stage and stays
        // RUNNING. The state itself stays RUNNING for everything that decides
        // on it, the tracking included.
        const beforeFirstLayer = !(Number(printData.layerNum) >= 1);
        const shownState = printData.gcodeState === "RUNNING" && printData.preparing && beforeFirstLayer
            ? "PREPARE"
            : printData.gcodeState;

        const card = document.createElement("div");
        card.className = "gc-card";

        let html = `<div class="gc-card-head">
            ${gcodeStateBadge(shownState)}
            ${printStageBadge(printData)}
            <strong${printData.modelTitle ? ` title="${escapeHtml(t("dashboard.print.profileJob", { job: printData.jobName }))}"` : ""}>${escapeHtml(printData.modelTitle || printData.jobName || t("dashboard.print.noActive"))}</strong>
            <span class="gc-card-note">${printResultControls(printData)}</span>
        </div>`;
        if (active && humanTotal) {
            html += `<div class="gc-progress">
                <div class="gc-progress-labels">
                    <span>${escapeHtml(t("dashboard.print.layer", { layer: humanLayer, total: humanTotal }))}</span><span>${progressPct}%</span>
                </div>
                <div class="gc-progress-track">
                    <div class="gc-progress-bar" style="width:${progressPct}%"></div>
                </div>
            </div>`;
        }
        if (active) html += printProgressFacts(printData);
        // The printer has no USB stick or SD card in, which is the storage the
        // sliced file is read from. Said while idle as well, so the stick is in
        // before the next print rather than found missing by it, and it makes
        // the lookup line below redundant: the file cannot be there.
        // Each line carries an i that opens the help dialog: what the line
        // means and what to do about it, which the line itself cannot hold.
        const helpButton = kind => `<button type="button" class="gc-card-help" data-lookup-help="${kind}" title="${escapeHtml(t("dashboard.print.helpButton"))}" aria-label="${escapeHtml(t("dashboard.print.helpButton"))}">i</button>`;
        const noStorage = printData.storagePresent === false;
        if (noStorage) {
            html += `<p class="gc-card-lookup gc-required">${escapeHtml(t(active ? "dashboard.print.noStorageActive" : "dashboard.print.noStorage"))}${helpButton("storage")}</p>`;
        }
        // The sliced file was not found. While attempts are left the card says
        // so quietly, after the last one in red: nothing will be booked, and a
        // job that ran with a bare name used to say that only in its summary.
        // A login the printer did not answer is its own sentence: that is the
        // printer's file transfer, not a file, and the fix is another one.
        if (active && printData.sliceFetch && !noStorage) {
            const lookup = printData.sliceFetch;
            const kind = lookup.kind === "connection" ? "connection" : "missing";
            if (lookup.final) {
                html += `<p class="gc-card-lookup gc-required" title="${escapeHtml(lookup.reason)}">${escapeHtml(t(kind === "connection" ? "dashboard.print.noFileTransfer" : "dashboard.print.noSlicedFile"))}${helpButton(kind)}</p>`;
            } else {
                // Attempt 0 is the look before the print ran, which does not count
                const text = lookup.attempt
                    ? t("dashboard.print.lookingAgain", { attempt: lookup.attempt, attempts: lookup.attempts })
                    : t("dashboard.print.lookingBeforeRunning");
                html += `<p class="gc-card-lookup gc-card-lookup-open" title="${escapeHtml(lookup.reason)}">${escapeHtml(text)}${helpButton(kind)}</p>`;
            }
        }
        // The backend reports why consumption data is missing (e.g. the FTPS
        // download failed); without this the table would just show a placeholder with no
        // explanation.
        if (printData.error) {
            html += `<p class="gc-required gc-error">${escapeHtml(printData.error)}</p>`;
        }
        card.innerHTML = html;

        for (const button of card.querySelectorAll("[data-lookup-help]")) {
            button.onclick = () => showLookupHelpDialog(button.dataset.lookupHelp, printData.sliceFetch?.reason || null);
        }

        const summaryButton = card.querySelector("[data-print-summary]");
        if (summaryButton) {
            summaryButton.onclick = () => showPrintSummaryDialog(printData.lastPrintSummary);
        }

        armCardTicker(card, printData.printResetAt);

        const clearButton = card.querySelector("[data-print-clear]");
        if (clearButton) {
            clearButton.onclick = async () => {
                clearButton.disabled = true;
                try {
                    await sendJson(`./api/print/${currentPrinterId}/clear`, "POST", {});
                    await loadGcodeView(currentPrinterId);
                } catch (err) {
                    clearButton.disabled = false;
                    alert(t("dashboard.print.clearFailed", { error: err.message }));
                }
            };
        }

        return card;
    }

    /**
     * When the running print started, when it is expected to end, and how long
     * it has been going.
     *
     * Every value is left out rather than guessed when the printer has not said
     * it: a service restarted mid print knows no start time, because the
     * printer reports none and the measurement was this process's own.
     */
    function printProgressFacts(printData) {
        const facts = [];

        // One decision for both ends of the print, the same way the summary
        // dialog makes it: the times alone while the whole job falls on today,
        // the full date as soon as it runs over midnight at either end.
        const withDate = !allToday(printData.startedAt, printData.estimatedEndAt);

        // "at" on every moment and a unit on every duration: a start at 19:14 and
        // a run of 14 min 50 s used to be "19:14" and "14:50" side by side.
        if (printData.startedAt) facts.push([t("dashboard.print.startedAt"), formatMoment(printData.startedAt, withDate)]);
        // Carries the start so the ticker can keep it moving between two SSE
        // events, which are up to a slot update interval apart.
        if (printData.startedAt != null) {
            // formatCounter, not formatDuration: the ticker rewrites this every
            // second, so it is a counter and has to be rendered as one from the
            // first paint rather than changing shape on the first tick.
            facts.push([
                t("dashboard.print.runningFor"),
                formatCounter(printData.elapsedMs),
                `class="gc-counter" data-elapsed-since="${printData.startedAt}"`,
            ]);
        }
        // Not the clock shape the counters use: the printer reports whole
        // minutes and revises them as it goes, so a clock would claim a second
        // hand this number does not have.
        const left = formatRemaining(printData.remainingMinutes);

        if (printData.gcodeState === "PAUSE") {
            // No end time while it is paused. What the printer still reports is
            // the work left, not a moment, and putting that on the clock would
            // name an end that moves further away the longer the pause lasts.
            if (left) facts.push([t("dashboard.print.leftAfterResuming"), left]);
        } else if (printData.estimatedEndAt) {
            facts.push([t("dashboard.print.expectedEnd"), `${formatMoment(printData.estimatedEndAt, withDate)} (${left})`]);
        }

        return factsRow(facts);
    }

    /**
     * The right hand side of the card head after a print has ended.
     *
     * Three states, in the order they happen: the booking label with a
     * countdown while the result is still shown, nothing at all while a print
     * is running, and a quiet button on its own once the result has been
     * cleared but its summary is still there. The summary is dropped by the
     * server when the next print starts, so this stops offering it by itself.
     */
    function printResultControls(printData) {
        const summary = printData.lastPrintSummary;
        const hasSummary = !!summary;

        if (printData.consumptionBooked) {
            // A real button, because it does something to the dashboard, unlike
            // the label next to it that only opens a description of what
            // already happened. The number is its own element inside it so the
            // ticker replaces only that and the word in front keeps its place.
            const countdown = printData.printResetAt
                ? `<button class="btn btn-small" data-print-clear
                        title="${escapeHtml(t("dashboard.print.clearNowTitle"))}">${escapeHtml(t("dashboard.print.clear"))} <span
                        class="gc-counter" data-countdown>${formatCountdown(printData.printResetAt)}</span></button>`
                : `<button class="btn btn-small" data-print-clear
                        title="${escapeHtml(t("dashboard.print.clearTitle"))}">${escapeHtml(t("dashboard.print.clear"))}</button>`;
            // The flag says the booking ran, not that it booked anything: a
            // print from a slot nobody assigned ends with every row skipped, and
            // the card used to read "consumption booked" over it. The rows say
            // what happened, so the label counts them. A filament the plate did
            // not use is not a row that could have been booked.
            const rows = (summary?.rows || []).filter(row => row.status !== "unused");
            const booked = rows.filter(row => row.status === "booked" || row.status === "ambiguous").length;
            // A print that ended before it used anything, a cancel during the
            // preparation, has only unused rows: nothing was booked and nothing
            // went wrong, and "consumption booked" over it claimed a booking
            // that never happened.
            const nothingUsed = !!summary?.rows?.length && !rows.length;
            // A summary with a note and no rows at all is a print that had no
            // sliced file: nothing was booked because nothing could be read
            const noFile = !!summary?.note && !summary.rows?.length;
            // Filaments swapped onto the holder by hand that still wait for a
            // spool, which is something the user can do now rather than a
            // result to read
            const pending = rows.filter(row => row.status === "pending").length;
            // The note comes from the server and stays English
            const label = pending
                ? { text: `⚠ ${t("dashboard.result.choosePending", { count: pending })}`, className: "gc-card-partly", title: t("dashboard.result.choosePendingTitle") }
                : noFile
                ? { text: `✖ ${t("dashboard.result.noSlicedFile")}`, className: "gc-card-unbooked", title: `${summary.note} ${t("dashboard.result.openReport")}` }
                : nothingUsed
                    ? { text: t("dashboard.result.nothingToBook"), className: "gc-card-nothing", title: t("dashboard.result.nothingToBookTitle") }
                    : !rows.length || booked === rows.length
                    ? { text: `✔ ${t("dashboard.result.booked")}`, className: "gc-card-booked", title: t("dashboard.result.openReport") }
                    : booked === 0
                        ? { text: `✖ ${t("dashboard.result.nothingBooked")}`, className: "gc-card-unbooked", title: t("dashboard.result.nothingBookedTitle") }
                        : { text: `✔ ${t("dashboard.result.partlyBooked", { booked, count: rows.length })}`, className: "gc-card-partly", title: t("dashboard.result.partlyBookedTitle") };
            return `<button class="gc-card-link ${label.className}" data-print-summary title="${escapeHtml(label.title)}">${escapeHtml(label.text)}</button>${countdown}`;
        }

        if (hasSummary && printData.printResultCleared) {
            return `<button class="gc-card-link" data-print-summary>${escapeHtml(t("dashboard.summary.lastPrint"))}</button>`;
        }

        return "";
    }

    // The one timer that keeps the card's clocks moving. Held outside the card
    // because every rebuild of it has to replace the previous one; two tickers
    // on two cards would both reload the view at the deadline.
    let cardTicker = null;

    /**
     * Keeps the two moving labels on the card current: how long the running
     * print has been going, and how long the finished one still has before it
     * clears itself. Asks the server once when that deadline runs out.
     *
     * The dashboard is otherwise redrawn only when an SSE event arrives, which
     * follows the slot update interval: at its default of two minutes both
     * labels would move in two minute steps and a finished result would sit
     * there for up to two minutes past its deadline. The server still decides
     * when a result is cleared, in printResultCleared(); this only makes the
     * client ask at the moment the answer changes.
     */
    function armCardTicker(card, resetAt) {
        clearInterval(cardTicker);
        cardTicker = null;

        const countdown = resetAt ? card.querySelector("[data-countdown]") : null;
        const elapsed = card.querySelector("[data-elapsed-since]");
        if (!countdown && !elapsed) return;

        cardTicker = setInterval(() => {
            // The card was replaced by a later render, or the printer changed
            if (!card.isConnected) {
                clearInterval(cardTicker);
                cardTicker = null;
                return;
            }

            if (elapsed) {
                elapsed.textContent = formatCounter(Date.now() - Number(elapsed.dataset.elapsedSince));
            }

            if (!countdown) return;

            if (Date.now() >= resetAt) {
                // An open dialog keeps the ticker alive rather than ending it:
                // rebuilding the view underneath one is what isDialogOpen()
                // exists to prevent, and dropping the ticker here would leave
                // the result standing until the next SSE event.
                if (isDialogOpen() || !currentPrinterId) return;
                clearInterval(cardTicker);
                cardTicker = null;
                loadGcodeView(currentPrinterId);
                return;
            }
            countdown.textContent = formatCountdown(resetAt);
        }, 1000);
    }

    /**
     * The time left on the Clear button, brackets and all.
     *
     * The brackets belong to this function rather than to the markup around it,
     * because the ticker rewrites the whole thing every second and the two
     * would otherwise have to agree on them separately.
     */
    function formatCountdown(resetAt) {
        return `(${formatCounter(Math.max(0, resetAt - Date.now()))})`;
    }

    /**
     * How long a finished print took, in the same shape the live counters use,
     * so a duration reads the same whether it is still running or over. The one
     * difference is that this one can be unknown: a service restarted mid print
     * never saw the job start.
     */
    function formatDuration(ms) {
        if (ms == null) return t("dashboard.summary.unknown");
        return formatCounter(ms);
    }

    /**
     * A row of label and value pairs that turns into a column when the space
     * runs out.
     *
     * The same block the running print uses above the slot tables, so the two
     * read alike; it wraps per pair rather than breaking a value away from its
     * label.
     */
    function factsRow(facts) {
        if (!facts.length) return "";

        return `<div class="gc-facts">${facts
            .map(([term, value, attrs = ""]) =>
                `<span class="gc-fact"><span class="gc-fact-term">${escapeHtml(term)}</span> <span ${attrs}>${escapeHtml(value)}</span></span>`)
            .join("")}</div>`;
    }

    /**
     * What to call the filament of one summary row.
     *
     * The same three fields, in the same order, that name a spool in the slot
     * tables, so one print reads the same in both places. They are only there
     * for a filament that was actually booked, because they come off the
     * Spoolman record the booking wrote; anything else falls back to what the
     * sliced file knew, which is a material and a hex code.
     */
    function summaryFilamentName(row) {
        const named = [row.vendor, row.material, row.spoolName].filter(Boolean);
        if (named.length) return named.join(" · ");

        return [row.type, row.color].filter(Boolean).join(" ") || t("dashboard.unknownFilament");
    }

    // How each outcome of a filament is labelled and coloured in the dialog.
    const SUMMARY_STATUS = {
        booked:    { label: "dashboard.summary.status.booked",    className: "gc-ok" },
        ambiguous: { label: "dashboard.summary.status.booked",    className: "gc-warn" },
        skipped:   { label: "dashboard.summary.status.notBooked", className: "gc-warn" },
        pending:   { label: "dashboard.summary.status.pending",   className: "gc-warn" },
        booking:   { label: "dashboard.summary.status.pending",   className: "gc-muted" },
        unused:    { label: "dashboard.summary.status.unused",    className: "" },
        failed:    { label: "dashboard.summary.status.failed",    className: "gc-bad" },
    };

    /**
     * How many steps the help dialog lists per kind of lookup problem, and
     * where the troubleshooting guide says more. The texts are i18n keys
     * `dashboard.print.help.<kind>.step<n>`; a kind the server does not name
     * falls back to the missing file, which is what it meant before `kind`.
     */
    const LOOKUP_HELP = {
        connection: { steps: 4, url: "https://github.com/Rdiger-36/HaspelSync/blob/main/docs/troubleshooting.md#the-printer-does-not-answer-the-file-transfer" },
        missing:    { steps: 4, url: "https://github.com/Rdiger-36/HaspelSync/blob/main/docs/troubleshooting.md#no-sliced-file-on-a-p2s-h2-or-x2d" },
        storage:    { steps: 2, url: "https://github.com/Rdiger-36/HaspelSync/blob/main/docs/troubleshooting.md#no-sliced-file-on-a-p2s-h2-or-x2d" },
    };

    /**
     * Why the sliced file of the running print is not read, and what to do.
     *
     * Opened from the i next to the line on the print card. The line says
     * that nothing will be booked; this says why, with the printer's answer
     * as the log has it, and the steps that have helped: a P2S whose FTPS
     * service had hung on 2026-10-02 was rebooted for a file name that was
     * right all along, because the card could not tell the two apart.
     *
     * @param {string} kind - `connection`, `missing` or `storage`
     * @param {string|null} reason - what the printer answered, from `/api/print`
     */
    function showLookupHelpDialog(kind, reason) {
        const help = LOOKUP_HELP[kind] ? kind : "missing";
        const dialog = document.getElementById("lookup-help-dialog");
        document.getElementById("lookup-help-title").textContent = t(`dashboard.print.help.${help}.title`);

        let html = `<p>${escapeHtml(t(`dashboard.print.help.${help}.intro`))}</p>`;
        if (reason && help !== "storage") html += `<pre class="gc-help-reason">${escapeHtml(reason)}</pre>`;
        html += "<ol>";
        for (let n = 1; n <= LOOKUP_HELP[help].steps; n++) {
            html += `<li>${escapeHtml(t(`dashboard.print.help.${help}.step${n}`))}</li>`;
        }
        html += `</ol><p><a href="${LOOKUP_HELP[help].url}" target="_blank" rel="noopener">${escapeHtml(t("dashboard.print.help.more"))}</a></p>`;
        document.getElementById("lookup-help-content").innerHTML = html;

        const close = document.getElementById("lookup-help-close");
        close.onclick = () => dialog.close();
        dialog.showModal();
        close.focus();
    }

    /**
     * The closing report of the last print.
     *
     * Read only, and built from what the server recorded when the print ended
     * rather than from the slots as they are now: a spool swapped since then
     * must not change what the dialog says was booked onto it.
     */
    function showPrintSummaryDialog(summary) {
        if (!summary) return;

        const dialog = document.getElementById("print-summary-dialog");
        const title = document.getElementById("print-summary-title");
        const content = document.getElementById("print-summary-content");

        // The model's title where the job was named after its print profile,
        // the same name the card showed while it ran
        const name = summary.modelTitle || summary.jobName;
        title.textContent = name
            ? t("dashboard.summary.title", { job: name })
            : t("dashboard.summary.lastPrint");

        const { layer: humanLayer, total: humanTotal } = humanLayers(summary.layerNum, summary.totalLayers);

        // One decision for both ends of the print, so they are never written
        // two different ways next to each other. A print whose start was lost
        // to a restart falls back to the long form, which is the one that says
        // what it knows without leaning on "today".
        const sameDay = allToday(summary.startedAt, summary.endedAt);

        const facts = [
            // The state is the printer's own word, FINISH or FAILED, the same
            // one the badge on the card shows, and stays as it is.
            [t("dashboard.summary.result"), summary.state],
            [t("dashboard.print.startedAt"), summary.startedAt ? formatMoment(summary.startedAt, !sameDay) : t("dashboard.summary.unknown")],
            [t("dashboard.summary.endedAt"), summary.endedAt ? formatMoment(summary.endedAt, !sameDay) : t("dashboard.summary.unknown")],
            [t("dashboard.summary.duration"), formatDuration(summary.durationMs)],
            [t("dashboard.summary.layers"), humanTotal ? `${humanLayer} / ${humanTotal}` : `${humanLayer}`],
        ];

        let html = factsRow(facts);

        if (summary.printError) {
            html += `<p class="gc-required">${escapeHtml(printErrorLine(summary))}</p>`;
        }
        if (summary.note) {
            html += `<p class="gc-required">${escapeHtml(summary.note)}</p>`;
        }

        if (summary.rows?.length) {
            const rows = summary.rows.map(row => {
                const known = SUMMARY_STATUS[row.status];
                const status = known ? { ...known, label: t(known.label) } : { label: row.status, className: "" };
                // A filament swapped onto the holder by hand waits for its
                // spool to be named, and is booked the moment it is
                const spool = row.spoolId
                    ? `#${row.spoolId}`
                    : row.status === "pending"
                        ? `<button type="button" class="btn btn-small" data-choose-filament="${row.index}">${escapeHtml(t("dashboard.holder.choose"))}</button>`
                        : "—";
                // The same square the slot tables draw, from the whole colour
                // set when the slice named one. normColor takes both shapes
                // these arrive in, "#F55A74" from the slice and "F55A74FF"
                // from the AMS.
                const colors = (row.colors?.length ? row.colors : [row.color])
                    .map(normColor)
                    .filter(Boolean);
                return `<tr>
                    <td data-label="${escapeHtml(t("dashboard.summary.slot"))}">${escapeHtml(row.amsId ?? "—")}</td>
                    <td data-label="${escapeHtml(t("dashboard.summary.filament"))}">${swatchHtml(colors)}${escapeHtml(summaryFilamentName(row))}</td>
                    <td data-label="${escapeHtml(t("dashboard.summary.amount"))}" style="text-align:right">${row.grams}g</td>
                    <td data-label="${escapeHtml(t("dashboard.summary.spool"))}">${spool}</td>
                    <td data-label="${escapeHtml(t("dashboard.summary.result"))}"><span class="${status.className}">${escapeHtml(status.label)}</span>${
                        row.note
                            ? (row.refill
                                ? `<div class="gc-summary-note"><span class="gc-warn">⚠</span> ${escapeHtml(row.note)}</div>`
                                : `<div class="gc-summary-note">${escapeHtml(row.note)}</div>`)
                            : ""
                    }</td>
                </tr>`;
            }).join("");

            // Said once above the table rather than repeated per row: every
            // line here is a filament of the sliced file, including the ones
            // that were never booked, and without that the table reads like a
            // list of bookings with gaps in it.
            html += `<p class="gc-summary-lead">${escapeHtml(t("dashboard.summary.lead"))}</p>`;

            // .spool-table as well, so the dialog inherits the card stacking
            // every other table on this page falls back to under 760px rather
            // than pushing five columns sideways inside a modal.
            html += `<table class="spool-table gc-summary-table"><thead><tr>
                <th>${escapeHtml(t("dashboard.summary.slot"))}</th><th>${escapeHtml(t("dashboard.summary.filament"))}</th><th style="text-align:right">${escapeHtml(t("dashboard.summary.amount"))}</th><th>${escapeHtml(t("dashboard.summary.spool"))}</th><th>${escapeHtml(t("dashboard.summary.result"))}</th>
            </tr></thead><tbody>${rows}</tbody></table>`;
        } else if (!summary.note) {
            html += `<p class="gc-required">${escapeHtml(t("dashboard.summary.nothingBooked"))}</p>`;
        }

        content.innerHTML = html;
        for (const choose of content.querySelectorAll("[data-choose-filament]")) {
            const row = summary.rows.find(r => r.index === Number(choose.dataset.chooseFilament) && r.status === "pending");
            choose.addEventListener("click", () => {
                dialog.close();
                showFilamentSpoolDialog(choose, {
                    index: row.index, amsId: row.amsId, type: row.type, trayInfoIdx: row.trayInfoIdx,
                    color: row.color, colors: row.colors, status: "pending",
                });
            });
        }
        document.getElementById("print-summary-close").onclick = () => dialog.close();
        dialog.showModal();
        document.getElementById("print-summary-close").focus();
    }

    // Build one table per AMS unit, like the classic view: normal AMS up to 4
    // slots per table, AMS HT a single slot per table. The generic `table`
    // margin gives a clear gap between units.
    function buildGcodeSpoolTables(spools, printData) {
        const fullCons = printData.fullConsumption || {};
        const partCons = printData.consumption || {};

        // Once the booking has run, "On spool" already carries the print, and
        // subtracting "Needed" from it a second time showed every spool lighter
        // than it is. Seen on a P2S after a finished two colour print.
        const booked = !!printData.consumptionBooked && !printData.printResultCleared;
        // Whether the server said what the print actually used. A cancel before
        // the first layer books 0 g, and 0 is an answer, not a missing one.
        const usedKnown = printData.consumption != null;
        // Slots the print ran empty while it went on taking filament from them.
        // The server still books them on the spool they held and says which.
        const emptied = Object.fromEntries((printData.emptiedSlots || []).map(e => [e.amsId, e]));
        // What the booking left on each spool, for an emptied slot whose spool
        // is no longer in the AMS list to read it from
        const bookedRemaining = Object.fromEntries((printData.lastPrintSummary?.rows || [])
            .filter(row => row.spoolId && row.remainingWeight != null)
            .map(row => [row.spoolId, row.remainingWeight]));
        // The filaments that take turns on a holder swapped by hand, under the
        // holder they ran from. Their grams are on these rows, not on the slot's.
        const holderFilaments = {};
        for (const filament of printData.holderFilaments || []) (holderFilaments[filament.amsId] ||= []).push(filament);
        const printing = ACTIVE_PRINT_STATES.includes(printData.gcodeState);
        const ctx = { fullCons, partCons, keyCount: countSpoolKeys(spools), showBooking: true, booked, usedKnown, emptied, bookedRemaining, holderFilaments, printing };

        const columns = [
            [t("dashboard.table.spool"), "left"],
            [t("dashboard.table.onSpool"), "right"],
            [t("dashboard.table.needed"), "right"],
            [t("dashboard.table.afterPrint"), "right"],
            [t("dashboard.table.action")],
        ];

        return buildSpoolTables(spools, columns, spool => createGcodeSpoolRow(spool, ctx), t("dashboard.table.noSpools"));
    }

    // The grams a slot carries in a consumption map.
    //
    // The server decides which sliced filament belongs to which slot, in
    // matchConsumption() (src/ams.js), the same function the booking uses, and
    // names the slot on every entry as `matchedAmsId`. This used to be a second
    // implementation of that decision, and both defects fixed at the end of
    // PR #89 sat in it.
    //
    // Summed rather than picked: one slot can serve two filaments of a print,
    // and the booking writes both of their amounts onto its spool.
    function consumedGrams(cons, amsId) {
        // A filament swapped onto the holder by hand has its own row and its
        // own spool, see holderFilamentRow()
        return Object.values(cons)
            .filter(e => e.matchedAmsId && e.matchedAmsId === amsId && !e.holderSwap)
            .reduce((total, e) => total + (e.grams || 0), 0);
    }

    // The Spool cell of a slot that ran empty during the print: the warning,
    // and the spool it held, which is where its grams are booked.
    function emptiedIdentityHtml(amsSpool, emptied) {
        const sp = emptied.spool || {};
        const colors = filamentColors({ color_hex: sp.colorHex, multi_color_hexes: sp.multiColorHexes });
        const name = [sp.vendor, sp.name].filter(Boolean).join(" ") || sp.material || `#${sp.id}`;
        const title = emptied.refill
            ? t("dashboard.table.ranOutRefillTitle", { to: emptied.refill.to, layer: emptied.refill.layer })
            : t("dashboard.table.ranOutTitle");
        const spoolman = sp.id
            ? `<a class="gc-link" href="${spoolmanBase()}/spool/show/${sp.id}" target="_blank">Spoolman #${sp.id}</a>`
            : "";
        return `
            <span class="gc-warn" title="${escapeHtml(title)}">⚠ ${escapeHtml(t("dashboard.table.ranOut"))}</span><br>
            ${swatchHtml(colors)}${escapeHtml(name)}<br>
            <span style="font-size:0.82em">
                <span class="gc-muted">${escapeHtml(amsSpool.amsId)}</span>${spoolman ? ` · ${spoolman}` : ""}
            </span>`;
    }

    function createGcodeSpoolRow(amsSpool, ctx) {
        const { fullCons, partCons, keyCount, booked, usedKnown } = ctx;
        const tr = document.createElement("tr");
        tr.setAttribute("data-amsid", amsSpool.amsId);
        renderedSpools.set(amsSpool.amsId, amsSpool);

        const slot   = amsSpool.slot || {};
        const isEmpty = amsSpool.slotState === "Empty";
        // An empty slot the running print still takes filament from, see
        // emptiedPrintSlots() in src/mqtt.js. Its grams stay on its row.
        const emptied = isEmpty ? (ctx.emptied?.[amsSpool.amsId] ?? null) : null;
        const counted = !isEmpty || emptied;
        const needed = counted ? consumedGrams(fullCons, amsSpool.amsId) : 0;
        const used   = counted ? consumedGrams(partCons, amsSpool.amsId) : 0;

        // On spool: Spoolman remaining/initial weight whenever we know which spool
        // this is (tag link, manual assignment, or the archived spool still in
        // the slot), else the AMS-reported remaining/total weight (g/g, like the
        // legacy MQTT table but without the percentage).
        const sp = amsSpool.existingSpool;
        let onSpool = amsSpool.amsWeight ?? null;
        // tray_weight arrives from MQTT as a string, so a weightless 3rd party
        // spool reports "0", which is truthy. Left as-is it passed the guard
        // below, divided by zero in the remain% fallback and rendered "NaNg".
        let totalSpool = Number(slot.tray_weight) || null;
        if (spoolmanSaysWeight(amsSpool)) {
            // To the hundredth of a gram, which is what the booking writes and
            // what "After print" is computed from: rounded to whole grams first,
            // 62.13 g minus 5.87 g read 56.13 g instead of 56.26 g.
            onSpool = Math.round(sp.remaining_weight * 100) / 100;
            if (sp.initial_weight != null) totalSpool = Math.round(sp.initial_weight);
        } else if (emptied) {
            // The spool as it was last seen in the slot, or as the booking left it
            const left = booked ? ctx.bookedRemaining?.[emptied.spool.id] : emptied.spool.remainingWeight;
            onSpool = left != null ? Math.round(left * 100) / 100 : null;
            totalSpool = emptied.spool.initialWeight != null ? Math.round(emptied.spool.initialWeight) : null;
        } else if (onSpool == null && !isEmpty && slot.remain != null && totalSpool) {
            // Fallback if the backend had no AMS weight yet: derive it here from
            // the AMS remain%, same as the legacy table does.
            const pct = correctRemainInt(slot.remain, totalSpool, slot.tray_type);
            onSpool = Math.round((pct / 100) * totalSpool);
        }

        let neededCell     = "—";
        let afterPrintCell = "—";
        if (needed > 0 && booked) {
            // The print is over and booked: what it used is the figure, and the
            // spool's weight above already has it taken off. `used || needed`
            // stood here and showed the whole plate as booked for a print
            // cancelled at layer 0, whose 0 g fell through to the fallback.
            neededCell = `${needed}g<br><span class="gc-muted" style="font-size:0.8em">${escapeHtml(t("dashboard.table.bookedGrams", { grams: usedKnown ? used : needed }))}</span>`;
            if (onSpool != null) {
                afterPrintCell = `<span class="gc-muted" title="${escapeHtml(t("dashboard.table.alreadyBookedTitle"))}">${grams2(onSpool)}</span>`;
            }
        } else if (needed > 0) {
            neededCell = `${needed}g${used ? `<br><span class="gc-muted" style="font-size:0.8em">${escapeHtml(t("dashboard.table.printedGrams", { grams: used }))}</span>` : ""}`;
            if (onSpool != null) {
                const afterPrint = onSpool - needed;
                afterPrintCell = `<span class="${afterPrint < 0 ? "gc-bad" : "gc-ok"}">${grams2(afterPrint)}</span>`;
            }
        }

        // 3rd-party spools report tray_weight 0, so only show the total when the
        // AMS or Spoolman actually knows it. The weight always carries its two
        // decimals, "30.00g", so a column of them lines up and a whole number
        // is not read as a rounded one.
        const onSpoolCell = onSpool != null && counted
            ? `${grams2(onSpool)}${totalSpool ? ` / ${totalSpool}g` : ""}`
            : "—";

        const identity = emptied ? emptiedIdentityHtml(amsSpool, emptied) : spoolIdentityHtml(amsSpool, ctx);
        tr.innerHTML = `
            <td data-label="${escapeHtml(t("dashboard.table.spool"))}" style="text-align:left">${identity}</td>
            <td data-label="${escapeHtml(t("dashboard.table.onSpool"))}" style="text-align:right">${onSpoolCell}</td>
            <td data-label="${escapeHtml(t("dashboard.table.needed"))}" style="text-align:right">${neededCell}</td>
            <td data-label="${escapeHtml(t("dashboard.table.afterPrint"))}" style="text-align:right">${afterPrintCell}</td>
        `;

        const tdBtn = document.createElement("td");
        // styles.css finds the cell by its class, the label is only shown text
        tdBtn.className = "action-cell";
        tdBtn.setAttribute("data-label", t("dashboard.table.action"));
        tdBtn.appendChild(createActionButton(amsSpool));
        tr.appendChild(tdBtn);

        const filaments = ctx.holderFilaments?.[amsSpool.amsId];
        if (!filaments?.length) return tr;
        const rows = document.createDocumentFragment();
        rows.appendChild(tr);
        for (const filament of filaments) rows.appendChild(holderFilamentRow(filament, ctx));
        return rows;
    }

    // One filament of a print that swaps spools on the holder by hand, under
    // the holder's row: what it needs and the spool named for it.
    function holderFilamentRow(filament, ctx) {
        const tr = document.createElement("tr");
        tr.className = "gc-subrow";
        const sp = filament.spool;
        const colors = (filament.colors?.length ? filament.colors : [filament.color]).map(normColor).filter(Boolean);
        const label = `${swatchHtml(colors)}${escapeHtml(t("dashboard.holder.filament", { number: filament.index + 1 }))}${
            filament.type ? ` <span class="gc-muted">${escapeHtml(filament.type)}</span>` : ""}`;

        let spoolLine;
        if (sp) {
            const name = [sp.vendor, sp.name].filter(Boolean).join(" ") || sp.material || `#${sp.id}`;
            spoolLine = `${swatchHtml(filamentColors({ color_hex: sp.colorHex, multi_color_hexes: sp.multiColorHexes }))}${escapeHtml(name)} · <a class="gc-link" href="${spoolmanBase()}/spool/show/${sp.id}" target="_blank">Spoolman #${sp.id}</a>`;
        } else {
            spoolLine = `<span class="gc-warn">⚠ ${escapeHtml(t(filament.status === "pending" ? "dashboard.holder.waiting" : "dashboard.holder.noSpool"))}</span>`;
        }

        // The booking has taken the grams off the spool already once it ran,
        // so the weight is shown as it is and not reduced a second time
        const done = filament.status != null && filament.status !== "pending";
        const left = done && sp ? ctx.bookedRemaining?.[sp.id] : sp?.remainingWeight;
        const onSpool = left != null ? Math.round(left * 100) / 100 : null;
        const onSpoolCell = onSpool != null ? `${grams2(onSpool)}${sp.initialWeight ? ` / ${Math.round(sp.initialWeight)}g` : ""}` : "—";
        const used = filament.usedGrams;
        const neededCell = `${filament.grams}g${used != null && !done
            ? `<br><span class="gc-muted" style="font-size:0.8em">${escapeHtml(t("dashboard.table.printedGrams", { grams: used }))}</span>`
            : done ? `<br><span class="gc-muted" style="font-size:0.8em">${escapeHtml(t("dashboard.table.bookedGrams", { grams: used ?? filament.grams }))}</span>` : ""}`;
        const afterPrintCell = onSpool == null
            ? "—"
            : done
                ? `<span class="gc-muted" title="${escapeHtml(t("dashboard.table.alreadyBookedTitle"))}">${grams2(onSpool)}</span>`
                : `<span class="${onSpool - filament.grams < 0 ? "gc-bad" : "gc-ok"}">${grams2(onSpool - filament.grams)}</span>`;

        tr.innerHTML = `
            <td data-label="${escapeHtml(t("dashboard.table.spool"))}" style="text-align:left">
                <span class="gc-subrow-mark">↳</span> ${label}<br>
                <span style="font-size:0.82em">${spoolLine}</span>
            </td>
            <td data-label="${escapeHtml(t("dashboard.table.onSpool"))}" style="text-align:right">${onSpoolCell}</td>
            <td data-label="${escapeHtml(t("dashboard.table.needed"))}" style="text-align:right">${neededCell}</td>
            <td data-label="${escapeHtml(t("dashboard.table.afterPrint"))}" style="text-align:right">${afterPrintCell}</td>
        `;

        const tdBtn = document.createElement("td");
        tdBtn.className = "action-cell";
        tdBtn.setAttribute("data-label", t("dashboard.table.action"));
        // While the print runs the choice can still change; afterwards only a
        // filament still waiting for a spool can be given one
        if (ctx.printing || filament.status === "pending") {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-small";
            button.textContent = t(sp ? "dashboard.holder.change" : "dashboard.holder.choose");
            button.addEventListener("click", () => showFilamentSpoolDialog(button, filament));
            tdBtn.appendChild(button);
        }
        tr.appendChild(tdBtn);
        return tr;
    }

    function buildGcodeMissing(printData) {
        const fullCons = printData.fullConsumption || {};

        // An entry the server could place on a loaded slot is by definition not
        // missing. It matched the slots over every loaded one, not only the
        // bookable ones, which is exactly the question this list asks.
        const missing = Object.values(fullCons).filter(e => !e.matchedAmsId);
        if (!missing.length) return null;

        const wrap = document.createElement("div");
        let html = `<h4 class="gc-required" style="margin:16px 0 4px">${escapeHtml(t("dashboard.missing.title"))}</h4>`;
        html += `<table class="data-table gc-required-table">`;
        for (const e of missing) {
            // The sliced file names one colour per filament, so there is never a
            // set to draw here, unlike on a slot.
            const swatch = swatchHtml(e.color ? [normColor(e.color)] : []);
            const label = e.type ? `${e.type} <code>${e.tray_info_idx}</code>` : `<code>${e.tray_info_idx}</code>`;
            html += `<tr><td>${swatch}${label}</td>
                <td class="gc-required-amount">${escapeHtml(t("dashboard.missing.needed", { grams: e.grams }))}</td></tr>`;
        }
        html += `</table>`;
        wrap.innerHTML = html;
        return wrap;
    }

    // The options this button knows how to label. Anything else, including an
    // option a newer server has learned, reads as no action rather than putting
    // a word on a button that does nothing. SLOT_OPTIONS.WAITING is in the list
    // and is not an action: the AMS has not reported the remaining percentage
    // yet, and creating a spool without it would store a partly used one as
    // brand new. The server offers the real action as soon as the reading
    // arrives, or after five updates without one.
    const KNOWN_OPTIONS = new Set([
        SLOT_OPTIONS.MERGE,
        SLOT_OPTIONS.CREATE,
        SLOT_OPTIONS.CREATE_WITH_FILAMENT,
        SLOT_OPTIONS.ASSIGN,
        SLOT_OPTIONS.UNASSIGN,
        SLOT_OPTIONS.SHOW_INFO,
        SLOT_OPTIONS.WAITING,
    ]);

    function setupButton(button, amsSpool) {
        if (amsSpool.error && amsSpool.slotState === "Loaded (Bambu Lab)") {
            setButtonOption(button, SLOT_OPTIONS.SHOW_INFO);
            button.disabled = false;
            return;
        }

        setButtonOption(button, KNOWN_OPTIONS.has(amsSpool.option) ? amsSpool.option : SLOT_OPTIONS.NONE);
        button.disabled = amsSpool.enableButton !== "true" || !spoolmanConnected;
        if (amsSpool.option === SLOT_OPTIONS.WAITING) {
            button.title = t("dashboard.slotOption.waitingTitle");
        }
    }

    // The option travels on the button as data, the words on it are only what
    // it shows. Every comparison reads the data.
    function setButtonOption(button, option) {
        button.dataset.option = option;
        button.textContent = optionLabel(option);
    }

    // What the printer reports about the slot the action is about. The same row
    // opens all three confirmations, which used to spell it out once each.
    function amsSpoolRow(amsSpool) {
        return `<tr>
                        <th>${escapeHtml(t("dashboard.dialog.amsSpool"))}</th>
                        <td>${escapeHtml(amsSpool.slot.tray_sub_brands)} - ${escapeHtml(amsSpool.matchingExternalFilament.name)} - ${escapeHtml(amsSpool.slot.tray_uuid)}</td>
                    </tr>`;
    }

    // Generate the content of the confirmation dialog
    function generateDialogContent(button, amsSpool) {
        const option = button.dataset.option;
        if (option === SLOT_OPTIONS.CREATE) {
            return `
                <p>${escapeHtml(t("dashboard.dialog.createQuestion"))}</p>
                <table class="data-table">
                    ${amsSpoolRow(amsSpool)}
                    <tr>
                        <th>${escapeHtml(t("dashboard.dialog.spoolmanFilament"))}</th>
                        <td>Bambu Lab - ${escapeHtml(amsSpool.matchingInternalFilament.material)} - ${escapeHtml(amsSpool.matchingInternalFilament.name)}</td>
                    </tr>
                </table>
            `;
        } else if (option === SLOT_OPTIONS.MERGE) {
            // The server's figure, which applies the same correction the row
            // shows; the raw percentage is only a fallback for an entry that
            // carries none.
            const remain = amsSpool.amsWeight ?? (amsSpool.slot.remain == null
                ? null
                : (amsSpool.slot.remain / 100) * amsSpool.slot.tray_weight);

            return `
                <p>${escapeHtml(t("dashboard.dialog.mergeQuestion"))}</p>
                <table class="data-table">
                    ${amsSpoolRow(amsSpool)}
                    <tr>
                        <th>${escapeHtml(t("dashboard.dialog.spoolmanSpool"))}</th>
                        <td>${escapeHtml(t("dashboard.dialog.spoolId", { id: amsSpool.mergeableSpool.id }))} - Bambu Lab - ${escapeHtml(amsSpool.mergeableSpool.filament.material)} - ${escapeHtml(amsSpool.mergeableSpool.filament.name)} - ${escapeHtml(t("dashboard.dialog.leftOnSpool", { grams: remain == null ? t("dashboard.summary.unknown") : grams2(remain) }))}</td>
                    </tr>
                </table>
            `;
        } else if (option === SLOT_OPTIONS.CREATE_WITH_FILAMENT) {
            return `
                <p>${escapeHtml(t("dashboard.dialog.createWithFilamentQuestion"))}</p>
                <table class="data-table">
                    ${amsSpoolRow(amsSpool)}
                    <tr>
                        <th>${escapeHtml(t("dashboard.dialog.newSpoolAndFilament"))}</th>
                        <td>${escapeHtml(amsSpool.matchingExternalFilament.manufacturer)} - ${escapeHtml(amsSpool.matchingExternalFilament.material)} - ${escapeHtml(amsSpool.matchingExternalFilament.name)} - ${amsSpool.matchingExternalFilament.density} g/cm³ - ${amsSpool.matchingExternalFilament.diameter} mm</td>
                    </tr>
                </table>
            `;
        } else {
            return `
                <p>${escapeHtml(t("dashboard.dialog.noMatch"))}</p>
                <p>${escapeHtml(t("dashboard.dialog.noMatchWhy"))}</p>
                <p>${escapeHtml(t("dashboard.dialog.guide"))}</p>
                <p>&emsp;1. ${escapeHtml(t("dashboard.dialog.guideStep1", { button: t("dashboard.dialog.goToSpoolman") }))}</p>
                <p>&emsp;2. ${escapeHtml(t("dashboard.dialog.guideStep2"))}</p>
                <p>&emsp;3. ${escapeHtml(t("dashboard.dialog.guideStep3"))}</p>
                <p>&emsp;4. ${escapeHtml(t("dashboard.dialog.guideStep4"))}</p>
                <p>&emsp;5. ${escapeHtml(t("dashboard.dialog.guideStep5"))}</p>
            `;
        }
    }

    // Show a confirmation dialog
    //
    // `opensSpoolman` marks the action that leaves for Spoolman's create page.
    // It used to be recognised by the words on the button, which are
    // translated now.
    function showDialog(button, content, actionButtonText, actionCallback, opensSpoolman = false) {
        const dialog = document.getElementById("info-dialog");
        const dialogContent = document.getElementById("dialog-content");
        const closeDialog = document.getElementById("close-dialog");
        const actionButton = document.getElementById("action-button");

        dialogContent.innerHTML = content;
        updateElementText("action-button", actionButtonText);
        // The dialog is shared, and whatever ran in it last may have left the
        // button disabled: the create form disables it while it saves and then
        // closes the dialog, which is what made the next Unassign do nothing
        // until the page was reloaded.
        actionButton.disabled = false;

        if (opensSpoolman) {
            actionButton.onclick = () => {
                actionCallback();
                dialog.close();

                window.open(`${spoolmanBase()}/spool/create`, "_blank");
            };
        } else {
            actionButton.onclick = () => {
                actionCallback();
                dialog.close();
            };
        }

        closeDialog.onclick = () => dialog.close();
        dialog.showModal();
        // The harmless choice takes the focus, not the one that writes to Spoolman
        closeDialog.focus();
    }

    // Send the selected action to the backend
    async function performAction(button, amsSpool) {
        const endpointMap = {
            [SLOT_OPTIONS.CREATE]: "./api/createSpool",
            [SLOT_OPTIONS.MERGE]: "./api/mergeSpool",
            [SLOT_OPTIONS.CREATE_WITH_FILAMENT]: "./api/createSpoolWithFilament"
        };

        const endpoint = endpointMap[button.dataset.option];
        if (!endpoint) return;

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = t("dashboard.sending");

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ printerId: currentPrinterId, amsId: amsSpool.amsId })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showNotification(t("dashboard.error", { error: err.error || t("dashboard.actionFailed") }), "error");
                button.textContent = originalText;
                button.disabled = false;
                return;
            }

            setButtonOption(button, SLOT_OPTIONS.NONE);
            showNotification(t("dashboard.actionSent"), "success");
        } catch (err) {
            console.error("Action failed:", err);
            showNotification(t("dashboard.requestFailedConnection"), "error");
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    function showNotification(message, type = "success") {
        let note = document.getElementById("action-notification");
        if (!note) {
            note = document.createElement("div");
            note.id = "action-notification";
            note.className = "action-note";
            document.body.appendChild(note);
        }
        note.textContent = message;
        note.classList.toggle("action-note-error", type === "error");
        note.classList.add("action-note-shown");
        clearTimeout(note._timeout);
        note._timeout = setTimeout(() => note.classList.remove("action-note-shown"), 3500);
    }

    // Update various status elements in the UI
    function updateStatus(data) {

        data.lastMqttUpdate = data.lastMqttUpdate
            ? formatDate(new Date(data.lastMqttUpdate))
            : t("dashboard.status.noUpdate");

        data.lastMqttAmsUpdate = data.lastMqttAmsUpdate
            ? formatDate(new Date(data.lastMqttAmsUpdate))
            : t("dashboard.status.noUpdate");

        setAmsEnv(data.amsEnv);

        if (typeof data.LEGACY_MODE === "boolean") legacyMode = data.LEGACY_MODE;
        printerGcodeState = data.gcodeState || "IDLE";

        // Active tracking mode badge
        const modeEl = getElementSafe("tracking-mode");
        if (modeEl) {
            if (legacyMode) {
                modeEl.className = "pill pill-legacy";
                modeEl.textContent = t("dashboard.status.legacyMode");
                modeEl.title = t("dashboard.status.legacyModeTitle");
            } else {
                modeEl.className = "pill pill-gcode";
                modeEl.textContent = t("dashboard.status.gcodeMode");
                modeEl.title = t("dashboard.status.gcodeModeTitle");
            }
        }

        spoolmanConnected = data.spoolmanStatus === "Connected";

        updateStatusWithIcon("spoolman-status", data.spoolmanStatus);
        updateStatusWithIcon("mqtt-status", data.mqttStatus);
        updateElementText("last-mqtt-update", data.lastMqttUpdate);
        updateElementText("last-mqtt-ams-update", data.lastMqttAmsUpdate);
        currentPrinterName = data.printerName || "";
        // The headline names the printer and is the picker over the others, so
        // it is written by menu.js rather than here. This only says which
        // printer the dashboard settled on, which it decides itself on the
        // first load.
        syncMenuPrinter(data.PRINTER_ID);
        updateElementText("mode", serverWord("operationMode", data.MODE));
        updateElementText("printer-serial", data.PRINTER_ID);

        const footer = document.getElementById("dynamic-footer");

        if (footer) {
            const URL = data.SPOOLMAN_FQDN || data.SPOOLMAN_URL;
            footer.innerHTML = `
                <div class="container">
                    <div class="content">
                        ${new Date().getFullYear()} - v.${escapeHtml(data.VERSION)} |
                        <a href="https://github.com/Rdiger-36/HaspelSync" target="_blank">${escapeHtml(t("dashboard.footer.repository"))}</a> -
                        ${escapeHtml(t("dashboard.footer.createdBy"))}
                        <a href="https://github.com/Rdiger-36" target="_blank">Rdiger-36</a> |
                        <a id="spoolmanLink" href="${URL}" target="_blank">${escapeHtml(t("dashboard.footer.spoolmanLink"))}</a>
                    </div>
                </div>
            `;
        }
    }

    // Set status icon for element
    function updateStatusWithIcon(elementId, status) {
        const el = getElementSafe(elementId);
        if (!el) return;
        const ok = status === "Connected";
        // "Connected" and the other states the server compares are looked up,
        // an error text arrives as it is.
        el.innerHTML = `<span class="pill ${ok ? "pill-ok" : "pill-bad"}">● ${escapeHtml(serverWord("connection", status) ?? "")}</span>`;
    }

    // Set status icon for spool behavior
    function setIcon(status, slotState) {
        if (slotState === "Loaded (Bambu Lab)") return status ? "❗️" : "✅";
        if (slotState === "Loaded (archived)") return `<span title="${escapeHtml(ARCHIVED_HINT)}">📦</span>`;
        // Everything else is a warning triangle, so it carries the reason as a
        // tooltip: an untagged 3rd party spool is a normal state, not a fault.
        const title = slotState === "Loaded (3rd party)"
            ? THIRD_PARTY_HINT
            : t("dashboard.spool.noData");
        return `<span title="${escapeHtml(title)}">⚠️</span>`;
    }

    // Safely get an element by ID and log a warning if it doesn't exist
    function getElementSafe(id) {
        const element = document.getElementById(id);
        if (!element) {
            console.warn(`Element with ID "${id}" was not found.`);
        }
        return element;
    }

    // Update the text content of a specific element
    function updateElementText(id, text) {
        const element = getElementSafe(id);
        if (element) element.textContent = text;
    }

});

let currentPrinterId = null;


/**
 * Puts the switch into a state.
 *
 * Off is red rather than the grey the settings switches use, because off here
 * is not a preference but a stopped service: the MQTT connection is closed, so
 * nothing is read from the printer and nothing reaches Spoolman. The row under
 * it says the same thing in words, with "Printer (MQTT)" going to "Disabled".
 *
 * @param {boolean} enabled - whether this printer is being monitored
 */
function setMonitoringSwitch(enabled) {
    const toggle = document.getElementById("monitoring-toggle");
    if (toggle) toggle.checked = enabled;
}

async function toggleMonitoring() {
    if (!currentPrinterId) return;

    const toggle = document.getElementById("monitoring-toggle");
    const enable = toggle.checked;
    const action = enable ? "start" : "stop";

    await fetch(`./api/printer/${currentPrinterId}/monitoring/${action}`, {
        method: "POST"
    });
}
