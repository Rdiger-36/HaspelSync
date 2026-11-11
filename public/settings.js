// Settings page. Renders the fields the backend describes in /api/settings, so
// a new setting only has to be added to the schema in src/settings.js, and
// manages the printer list through /api/printers.
//
// A module, so the HTTP and escaping helpers can be shared with the dashboard
// rather than kept as a second copy here. The menu bar and the export dialog
// stay classic scripts and are read off the global scope.
import { escapeHtml, fetchJson, sendJson } from "./ui.js";

// Order of the field groups. The group key comes from the schema, the fields
// the schema marks as advanced go into the collapsed part. The headline is
// `settings.group.<key>.title`, the label of the collapsed part
// `settings.group.<key>.advanced` where a group names it.
const GROUPS = ["spoolman", "tracking", "sync", "printer", "logging", "network"];

// The sections of the page, in the order of the navigation at the left. Each
// names the schema groups it shows; the hand written cards, the printer list,
// the Web UI choices and the service card, sit in the page's own markup under
// the section's name. The label is `settings.section.<key>`.
const SECTIONS = [
    { key: "printers", groups: ["printer"] },
    { key: "spoolman", groups: ["spoolman"] },
    { key: "tracking", groups: ["tracking", "sync"] },
    { key: "logging", groups: ["logging"] },
    { key: "access", groups: ["network"] },
    { key: "webui", groups: [] },
    { key: "system", groups: [] },
];

// One glyph per section, drawn in the colour of the entry: a printer, a spool
// seen from the side, a trend line, three log lines, a padlock, a window and
// a gear.
const SECTION_GLYPHS = {
    printers: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="5" width="12" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 5V2.5h6V5M5 12v1.5h6V12" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
    spoolman: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>`,
    tracking: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 12l3.5-4 3 2.5L14 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    logging: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12M2 8h12M2 13h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    access: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
    webui: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.5"/></svg>`,
    system: `<svg class="set-nav-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15M3 3l1.7 1.7M11.3 11.3L13 13M3 13l1.7-1.7M11.3 4.7L13 3" stroke="currentColor" stroke-width="2.2"/></svg>`,
};

/** The sections with unsaved changes, for the dot in the navigation. */
const dirtySections = new Set();

/**
 * The label, description or option label of a schema field in the viewer's
 * language.
 *
 * The server describes its fields in English and stays that way, because API
 * clients read the same schema. A table that knows the field wins, and a field
 * added on the server before any table knows it still shows its English text
 * rather than a key.
 *
 * @param {object} field - one entry of `fields`
 * @param {"label"|"description"} part - which text
 * @returns {string}
 */
function fieldText(field, part) {
    const key = `settings.field.${field.key}.${part}`;
    return window.I18N.has(key) ? t(key) : field[part];
}

/** The label of one option of a field, falling back to the value itself. */
function optionText(field, option) {
    const key = `settings.field.${field.key}.option.${option}`;
    return window.I18N.has(key) ? t(key) : option;
}

/**
 * A status word the server hands out in English, such as the MQTT state of a
 * printer, in the viewer's language. The value itself is never changed, only
 * what is shown for it.
 *
 * @param {string} prefix - the key group, "settings.status"
 * @param {string} value - the value as the server sent it
 */
function valueText(prefix, value) {
    const key = `${prefix}.${value}`;
    return window.I18N.has(key) ? t(key) : value;
}

let fields = [];
let values = {};
let sources = {};
// Which password fields hold a stored value. The values themselves are never
// sent, so this is all the page knows about them.
let hasValue = {};
let spoolmanUrl = "";
// Revision of the settings this page last read, sent back with a save so a
// state somebody else replaced is not overwritten
let revision = 0;
// True while a saved value waits for the next start of the service
let restartPending = false;
// True when a supervisor starts the service again by itself, so the page can
// say what will happen instead of listing conditions
let supervised = false;
let printers = [];
// The API keys as the server lists them: name, when it was created and when it
// was last used, never the key itself. Cached here because the Network access
// card is rebuilt from the settings response on every save and over SSE.
let apiKeys = [];
// Set once an input was touched. Blocks the save button while nothing changed,
// keeps a settings update pushed over SSE from overwriting what is being typed,
// and drives the warning when leaving the page.
let formDirty = false;

document.addEventListener("DOMContentLoaded", () => {
    // Menu bar, including the dark mode button
    initMenubar();
    renderSectionNav();
    openSectionFromHash();
    window.addEventListener("hashchange", openSectionFromHash);
    setupLanguageField();
    setupThemeField();

    document.getElementById("settings-form").addEventListener("submit", saveSettings);
    document.getElementById("reload-settings").addEventListener("click", () => loadSettings(true));
    document.getElementById("add-printer").addEventListener("click", () => openPrinterDialog(null));
    document.getElementById("restart-service").addEventListener("click", confirmRestart);
    document.getElementById("download-diagnostics").addEventListener("click", downloadDiagnostics);
    document.getElementById("reconnect-printers").addEventListener("click", reconnectPrinters);
    document.getElementById("toggle-monitoring").addEventListener("click", toggleAllMonitoring);
    document.getElementById("printer-dialog-cancel").addEventListener("click", () => closeDialog("printer-dialog"));
    document.getElementById("apikey-dialog-cancel").addEventListener("click", () => closeDialog("apikey-dialog"));
    document.getElementById("logdetail-dialog-cancel").addEventListener("click", () => closeDialog("logdetail-dialog"));
    document.getElementById("printer-dialog-test").addEventListener("click", testPrinterConnection);

    window.addEventListener("beforeunload", event => {
        if (!formDirty) return;
        event.preventDefault();
        event.returnValue = "";
    });

    loadSettings();
    loadEnvInfo();
    loadPrinters();
    loadApiKeys();
    loadSystemInfo();
    loadUpdate();

    document.getElementById("check-tags").addEventListener("click", checkSpoolTags);
    document.getElementById("migrate-tags").addEventListener("click", migrateSpoolTags);
    document.getElementById("cleanup-tags").addEventListener("click", cleanupSpoolTags);
    checkSpoolTags();

    const eventSource = new EventSource("./api/events");
    eventSource.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === "printers_update") {
            loadPrinters();
            // A renamed or removed printer changes the menu as well
            refreshMenubarPrinters();
        }
        if (data.type === "settings_update" && !formDirty) {
            loadSettings();
            // A save anywhere can be the one that takes the last variable out of
            // service, which is exactly when this note has to change.
            loadEnvInfo();
        }
    };
});

/* ---- The standing note about environment variables ---- */

/**
 * The standing note at the head of the page, for as long as a setting is still
 * taken from an environment variable.
 *
 * The badge on a field says that this one value comes from a variable. What it
 * cannot say is what happens on the next save, which is the part that surprises
 * people: the page sends every field, so the first save writes the whole
 * configuration into `settings.json` and every one of those variables goes
 * quiet, including the ones nobody touched.
 *
 * Shown exactly when a field carries the badge, and not dismissible, unlike the
 * dialog the dashboard shows once per installation: this is read again by
 * whoever opens the settings page a year later with the compose file in the
 * other window. An install that never used the variables never sees it, and one
 * that used them loses it the moment the save takes them out of service.
 */
async function loadEnvInfo() {
    const box = document.getElementById("set-env-info");
    if (!box) return;

    let notice;
    try {
        notice = (await fetchJson("./api/notices"))["env-config"];
    } catch {
        // A standing hint is not worth an error message of its own.
        box.hidden = true;
        return;
    }

    // Exactly the condition the badges follow: no field carries one, so there is
    // nothing here to explain. Emptied as well, so a save that ends the last
    // variable does not leave its own text behind the hidden attribute.
    if (!notice?.variables?.length) {
        box.hidden = true;
        box.innerHTML = "";
        return;
    }

    const code = list => `<code>${list.map(escapeHtml).join("</code>, <code>")}</code>`;
    const parts = [`<h2>${escapeHtml(t("settings.env.title"))}</h2>`];

    // The keys ending in Html carry their own markup. Only the variable list is
    // filled in, and code() has already escaped it.
    parts.push(`<p>${t("settings.env.deprecatedHtml", {
        variables: code(notice.variables),
        badge: `<span class="pill pill-gcode">${escapeHtml(t("settings.badge.environment"))}</span>`,
    })}</p>`);
    parts.push(`<p>${t("settings.env.saveWritesAllHtml")}</p>`);

    if (notice.printerVariables?.length) {
        parts.push(`<p>${t(notice.printerVariablesIgnored
            ? "settings.env.printerVariablesIgnoredHtml"
            : "settings.env.printerVariablesSeededHtml", { variables: code(notice.printerVariables) })}</p>`);
    }

    box.innerHTML = parts.join("");
    box.hidden = false;
}

/* ---- Banner and dirty state ---- */

function showBanner(message, kind = "ok") {
    const banner = document.getElementById("set-banner");
    banner.className = `set-banner set-banner-${kind}`;
    banner.textContent = message;
}

function clearBanner() {
    const banner = document.getElementById("set-banner");
    banner.className = "set-banner";
    banner.textContent = "";
}

/** Keeps the action buttons in sync with whether anything was edited. */
function setDirty(dirty) {
    formDirty = dirty;
    document.getElementById("save-settings").disabled = !dirty;
    document.getElementById("reload-settings").disabled = !dirty;
    if (!dirty) dirtySections.clear();
    renderDirtySections();
}

/**
 * Marks the section a changed field sits in, so the navigation shows where
 * the unsaved changes are while another section is open.
 *
 * @param {HTMLElement} input - the field that changed
 */
function markDirty(input) {
    const section = input.closest(".set-section")?.dataset.section;
    if (section) dirtySections.add(section);
    setDirty(true);
}

/**
 * The dots in the navigation and the sentence in the save bar: "Unsaved
 * changes in Spoolman, Tracking", in the order of the navigation.
 */
function renderDirtySections() {
    for (const button of document.querySelectorAll("#set-nav [data-section]")) {
        button.querySelector(".set-dot")?.remove();
        if (!dirtySections.has(button.dataset.section)) continue;
        const dot = document.createElement("span");
        dot.className = "set-dot";
        dot.title = t("settings.unsavedChanges");
        button.appendChild(dot);
    }

    const hint = document.getElementById("dirty-hint");
    if (!formDirty) {
        hint.textContent = "";
        return;
    }
    const names = SECTIONS.filter(section => dirtySections.has(section.key))
        .map(section => t(`settings.section.${section.key}`));
    hint.textContent = names.length
        ? t("settings.unsavedChangesIn", { sections: names.join(", ") })
        : t("settings.unsavedChanges");
}

/* ---- Sections ---- */

/**
 * Builds the navigation at the left: one entry per section, the open one
 * marked. Built once; the dots for unsaved changes are painted onto it.
 */
function renderSectionNav() {
    const nav = document.getElementById("set-nav");
    nav.innerHTML = "";
    for (const section of SECTIONS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "set-nav-item";
        button.dataset.section = section.key;
        button.innerHTML = `${SECTION_GLYPHS[section.key]}<span>${escapeHtml(t(`settings.section.${section.key}`))}</span>`;
        button.addEventListener("click", () => openSection(section.key, { pushHash: true }));
        nav.appendChild(button);
    }
}

/**
 * Shows one section and hides the others.
 *
 * The section is kept in the address as `settings.html#access`, so a link
 * from the documentation or from another page lands on the right one and a
 * reload stays where it was. The sections are hidden, not unmounted: the form
 * holds every field whichever one is shown, so a save takes all of them.
 *
 * @param {string} key - a key of SECTIONS
 * @param {object} [options]
 * @param {boolean} [options.pushHash] - write the section into the address
 */
function openSection(key, { pushHash = false } = {}) {
    if (!SECTIONS.some(section => section.key === key)) key = SECTIONS[0].key;

    for (const section of document.querySelectorAll(".set-section")) {
        section.hidden = section.dataset.section !== key;
    }
    for (const button of document.querySelectorAll("#set-nav [data-section]")) {
        const current = button.dataset.section === key;
        button.setAttribute("aria-current", current ? "true" : "false");
        // On a phone the navigation is a row that scrolls sideways, so the
        // open entry is brought into it; "nearest" leaves the page alone.
        if (current) button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    if (pushHash && window.location.hash !== `#${key}`) {
        history.replaceState(null, "", `#${key}`);
    }
}

/**
 * Opens the section the address names.
 *
 * The hash is a section key, or the id of an element inside one: the API page
 * links back to `#apikey-table`, which sits in the access section. An element
 * is scrolled to once its section is on screen.
 */
function openSectionFromHash() {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!hash) return openSection(SECTIONS[0].key);

    if (SECTIONS.some(section => section.key === hash)) return openSection(hash);

    const target = document.getElementById(hash);
    const section = target?.closest(".set-section")?.dataset.section;
    openSection(section || SECTIONS[0].key);
    if (section) target.scrollIntoView({ block: "start" });
}

/* ---- Settings form ---- */

async function loadSettings(userRequested = false) {
    try {
        applyView(await fetchJson("./api/settings"));
        if (userRequested) clearBanner();
        showRestartNotice();
    } catch (err) {
        showBanner(t("settings.error.load", { message: err.message }), "bad");
    }
}

/** Takes over a settings response and rebuilds the form from it. */
function applyView(view) {
    fields = view.fields;
    values = view.values;
    sources = view.sources;
    hasValue = view.hasValue ?? {};
    spoolmanUrl = view.spoolmanUrl;
    restartPending = view.restartPending;
    revision = view.revision;
    supervised = view.supervised;
    renderSettings();
    setDirty(false);
}

/**
 * A stored value that only takes effect on the next start keeps its notice on
 * the page, rather than showing it once after the save and losing it on the
 * next reload.
 */
function showRestartNotice() {
    if (!restartPending) return;

    // With the supervisor the button next to this does the whole job, so naming
    // the manual way would only send the user off to a terminal for nothing.
    showBanner(t(supervised ? "settings.restart.pendingSupervised" : "settings.restart.pendingManual"), "warn");
    // Straight from the notice, rather than sending the user looking for the
    // button further down the page.
    const action = document.createElement("button");
    action.className = "btn btn-small";
    action.type = "button";
    action.textContent = t("settings.restart.now");
    action.addEventListener("click", confirmRestart);
    document.getElementById("set-banner").append(" ", action);
}

/* ---- Service card ---- */

/**
 * The facts about this installation, rendered as a definition list.
 *
 * Shown rather than kept for the diagnostics bundle alone, because half of what
 * a support question asks for is on this line, and because "tracking" tells the
 * user what the process is actually doing, which is not always what the stored
 * setting says while a restart is pending.
 */
async function loadSystemInfo() {
    const container = document.getElementById("system-info");
    if (!container) return;

    let info;
    try {
        info = await fetchJson("./api/system");
    } catch (err) {
        container.innerHTML = `<div class="set-fact"><dt>${escapeHtml(t("settings.system.system"))}</dt><dd>${escapeHtml(t("settings.system.unreadable", { message: err.message }))}</dd></div>`;
        return;
    }

    const rows = [
        [t("settings.system.version"), info.version],
        // Only a published image knows its name; a checkout has none to show
        ...(info.image ? [[t("settings.system.image"), info.image]] : []),
        [t("settings.system.node"), info.node],
        [t("settings.system.platform"), info.platform],
        [t("settings.system.uptime"), formatUptime(info.uptime)],
        [t("settings.system.memory"), `${info.memoryMB} MB`],
        [t("settings.system.tracking"), trackingText(info.tracking)],
        [t("settings.system.supervisor"), t(info.supervised ? "settings.on" : "settings.off")],
        [t("settings.system.printers"), String(info.printers)],
        [t("settings.system.apiKeys"), String(info.apiKeys ?? 0)],
        [t("settings.system.spoolman"), valueText("settings.status", info.spoolman)],
    ];

    container.innerHTML = rows
        .map(([label, value]) => `<div class="set-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join("");

    // Said here for as long as it is true, where the dashboard says it once:
    // the facts are what somebody looks at before pulling a new image.
    const imageNote = document.getElementById("image-note");
    if (imageNote) {
        imageNote.hidden = !info.imageDeprecated;
        imageNote.innerHTML = info.imageDeprecated
            ? t("settings.system.imageDeprecatedHtml", {
                image: `<code>ghcr.io/rdiger-36/haspelsync</code>`,
                link: `<a href="https://github.com/Rdiger-36/HaspelSync/blob/main/docs/installation.md" target="_blank" rel="noopener">${escapeHtml(t("settings.system.imageDocsLink"))}</a>`,
            })
            : "";
    }
}

/**
 * The tracking mode as the diagnostics name it, in the viewer's language. The
 * server hands out a description rather than a key, so it is matched here and
 * anything else is shown as it came.
 */
function trackingText(tracking) {
    if (tracking === "G-code") return t("settings.system.trackingGcode");
    if (typeof tracking === "string" && tracking.startsWith("legacy")) return t("settings.system.trackingLegacy");
    return tracking;
}

/** Seconds into the coarsest unit that still says something useful. */
function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return t("settings.unknown");
    const number = (value, digits) => value.toLocaleString(window.I18N.language(), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
    if (seconds < 60) return t("settings.uptime.seconds", { value: seconds });
    if (seconds < 3600) return t("settings.uptime.minutes", { value: Math.round(seconds / 60) });
    if (seconds < 86400) return t("settings.uptime.hours", { value: number(seconds / 3600, 1) });
    return t("settings.uptime.days", { value: number(seconds / 86400, 1) });
}

/**
 * Compares this version against the latest GitHub release.
 *
 * Nothing is installed and nothing about the installation is sent. A failure is
 * reported as "could not check" rather than as an error, because a printer
 * network without internet access is a normal setup, not a broken one.
 */
async function loadUpdate() {
    const note = document.getElementById("update-note");
    if (!note) return;

    let update;
    try {
        update = await fetchJson("./api/update");
    } catch {
        note.textContent = t("settings.update.unreachable");
        return;
    }

    if (update.error) {
        note.textContent = t("settings.update.failed", { message: update.error });
        return;
    }

    if (update.ahead) {
        // A dev or release candidate image. Saying "up to date" here would
        // suggest this version is the released one, which it is not.
        note.textContent = t("settings.update.prerelease", { latest: update.latest });
        return;
    }

    if (!update.updateAvailable) {
        note.textContent = t("settings.update.upToDate", { latest: update.latest });
        return;
    }

    note.innerHTML = `${t("settings.update.availableHtml", { latest: `<strong>${escapeHtml(update.latest)}</strong>` })}
        ${update.url ? `<a href="${escapeHtml(update.url)}" target="_blank" rel="noopener">${escapeHtml(t("settings.update.releaseNotes"))}</a>` : ""}`;
}

/**
 * Asks whether the bundle should be anonymised and which logs it carries,
 * then downloads it.
 *
 * The configuration files are in every bundle; the choice is over the logs,
 * because a raw MQTT trace runs at about 22 MB an hour per printer and an
 * installation with several printers usually has a question about one.
 */
async function downloadDiagnostics() {
    let list = [];
    try {
        list = await fetchJson("./api/printers");
    } catch {
        // Without the list the dialog offers the server log alone, and the
        // bundle still carries every configuration file
    }

    downloadWithExportMode({
        url: "./api/diagnostics/download",
        title: t("settings.diagnostics.title"),
        what: t("settings.diagnostics.what"),
        choices: {
            // export.js puts the heading into markup as it is
            heading: escapeHtml(t("settings.diagnostics.heading")),
            options: [
                { id: "server", label: escapeHtml(t("settings.diagnostics.serverLog")) },
                ...list.map(printer => ({ id: printer.id, label: `${escapeHtml(printer.name)} (${escapeHtml(printer.id)})` })),
            ],
        },
    });
}

/**
 * Rebuilds every MQTT connection without ending the process.
 *
 * Deliberately without a confirmation, unlike the restart: the consumption of a
 * running print is tracked in memory and booked when the job ends, and that
 * state survives a reconnect. It is the smaller hammer of the two.
 */
async function reconnectPrinters() {
    const button = document.getElementById("reconnect-printers");
    button.disabled = true;

    try {
        const result = await sendJson("./api/printers/reconnect", "POST", {});
        const count = result.reconnected.length;
        showBanner(result.skipped
            ? t("settings.service.reconnectingSkipped", { count, skipped: result.skipped })
            : t("settings.service.reconnecting", { count }), "ok");
        loadPrinters();
    } catch (err) {
        showBanner(t("settings.error.reconnect", { message: err.message }), "bad");
    } finally {
        button.disabled = false;
    }
}

/** Whether at least one printer is currently being monitored. */
function anyMonitoring() {
    return printers.some(printer => printer.monitoringEnabled);
}

/** Keeps the label of the monitoring button on what pressing it would do. */
function renderMonitoringButton() {
    const button = document.getElementById("toggle-monitoring");
    if (!button) return;

    button.disabled = !printers.length;
    button.textContent = t(anyMonitoring() ? "settings.service.pauseMonitoring" : "settings.service.resumeMonitoring");
    document.getElementById("service-note").textContent = printers.length && !anyMonitoring()
        ? t("settings.service.monitoringPaused")
        : "";
}

/**
 * Turns monitoring off or on for every printer at once.
 *
 * The per printer switch on the dashboard is the same thing; this is for the
 * case the switch exists for, a Spoolman that is being worked on, where doing it
 * one printer at a time is busywork.
 */
async function toggleAllMonitoring() {
    const button = document.getElementById("toggle-monitoring");
    const enable = !anyMonitoring();
    button.disabled = true;

    try {
        const result = await sendJson(`./api/monitoring/${enable ? "start" : "stop"}`, "POST", {});
        showBanner(
            result.changed.length
                ? t(enable ? "settings.service.monitoringResumedFor" : "settings.service.monitoringPausedFor",
                    { changed: result.changed.length, count: result.total })
                : t(enable ? "settings.service.monitoringAlreadyOn" : "settings.service.monitoringAlreadyOff"),
            "ok",
        );
        await loadPrinters();
    } catch (err) {
        showBanner(t("settings.error.monitoring", { message: err.message }), "bad");
    } finally {
        button.disabled = false;
        renderMonitoringButton();
    }
}

/* ---- Restarting the service ---- */

/** Asks before the service is restarted, and says what a running print keeps. */
async function confirmRestart() {
    // The print note is the same promise the backend makes when it refuses a
    // change during a print
    const printNote = escapeHtml(t("settings.restart.printNote"));
    const warning = supervised
        ? `<p class="set-note">${printNote}</p>`
        : `<p class="set-note">${t("settings.restart.containerNoteHtml")} ${printNote}</p>`;

    const confirmed = await confirmAction({
        title: t("settings.restart.confirmTitle"),
        html: `<p>${escapeHtml(t(supervised ? "settings.restart.confirmSupervised" : "settings.restart.confirmManual"))}</p>${warning}`,
        okLabel: t("settings.restart.ok"),
    });

    if (confirmed) restartNow(false);
}

async function restartNow(force) {
    try {
        await sendJson("./api/restart", "POST", { force });
        showBanner(t("settings.restart.waiting"), "warn");
        waitForService();
    } catch (err) {
        if (err.printInFlight) {
            await confirmWhilePrinting(err, () => restartNow(true));
            return;
        }
        showBanner(t("settings.error.restart", { message: err.message }), "bad");
    }
}

/**
 * Polls until the service answers again and reloads the page.
 *
 * A service that does not come back is the whole risk of the restart button, so
 * the wait ends with a message that says what to look at rather than spinning
 * forever.
 */
function waitForService(deadline = Date.now() + 60000) {
    setTimeout(async () => {
        try {
            const response = await fetch("./api/printers", { cache: "no-store" });
            if (response.ok) return window.location.reload();
        } catch {
            // still down, keep waiting
        }

        if (Date.now() < deadline) return waitForService(deadline);
        showBanner(t("settings.restart.notBack"), "bad");
    }, 1500);
}

function renderSettings() {
    // Every group goes into the host its section provides; a host whose group
    // has no fields stays empty. Cleared first, because a rebuild after a save
    // or a discard would otherwise stack a second card under the first.
    for (const host of document.querySelectorAll("[data-group]")) host.innerHTML = "";
    const container = document.querySelector(".set-sections");

    for (const key of GROUPS) {
        const host = document.querySelector(`[data-group="${key}"]`);
        if (!host) continue;
        const advancedKey = `settings.group.${key}.advanced`;
        const group = {
            key,
            title: t(`settings.group.${key}.title`),
            advancedLabel: window.I18N.has(advancedKey) ? t(advancedKey) : t("settings.advanced"),
        };
        const groupFields = fields.filter(field => field.group === group.key);
        if (!groupFields.length) continue;

        // A field the schema hands to a dialog is not part of the card's grid.
        // It still arrives in `fields`, which is what lets the dialog render it
        // from the schema rather than holding a second copy of it.
        const carded = groupFields.filter(field => !field.dialog);
        const header = carded.filter(field => field.header);
        const main = carded.filter(field => !field.advanced && !field.header);
        const advanced = carded.filter(field => field.advanced && !field.header);

        const card = document.createElement("div");
        card.className = "set-card";
        card.innerHTML = `
            <div class="set-card-head">
                <h2>${escapeHtml(group.title)}</h2>
                ${header.map(renderHeaderField).join("")}
            </div>
            <div class="set-form">${main.map(renderField).join("")}</div>
            ${group.key === "spoolman" ? renderEffectiveUrl() : ""}
            ${advanced.length ? `
                <details class="set-advanced">
                    <summary>${escapeHtml(group.advancedLabel)}</summary>
                    <div class="set-form">${advanced.map(renderField).join("")}</div>
                </details>` : ""}
            ${group.key === "spoolman" ? renderSpoolmanTest() : ""}
            ${group.key === "logging" ? renderLogDetailShell() : ""}
            ${group.key === "network" ? renderApiKeyShell() : ""}`;
        host.appendChild(card);
    }

    container.querySelectorAll("[data-group] input, [data-group] select").forEach(input => {
        input.addEventListener("input", () => markDirty(input));
    });

    container.querySelectorAll("[data-reset]").forEach(button => {
        button.addEventListener("click", () => resetField(button.dataset.reset));
    });

    container.querySelectorAll("[data-clear]").forEach(button => {
        button.addEventListener("click", () => clearPassword(button.dataset.clear));
    });

    document.getElementById("test-spoolman")?.addEventListener("click", testSpoolmanConnection);
    document.getElementById("open-logdetail")?.addEventListener("click", () => openLogDetailDialog(null));
    // The printer list loads on its own, so this line may already be known
    renderLogDetailOverrides();
    document.getElementById("add-apikey")?.addEventListener("click", () => openApiKeyDialog());
    // The card was just rebuilt, so the list has to be painted into the new one
    renderApiKeys();
}

/* ---- Connection tests ---- */

function renderSpoolmanTest() {
    return `<div class="set-test-row">
                <button class="btn btn-small" type="button" id="test-spoolman">${escapeHtml(t("settings.testConnection"))}</button>
                <span class="set-test-result" id="test-spoolman-result"></span>
            </div>`;
}

/* ---- Log detail ----
 *
 * Level, areas and the raw MQTT trace live in a dialog rather than in the card,
 * because they belong together and because a printer can override them. The
 * dialog renders from the schema fields the server marks `dialog: "logDetail"`,
 * so a new one appears here without this file learning about it.
 */

/** The fields the log detail dialog owns, in schema order. */
function logDetailFields() {
    return fields.filter(field => field.dialog === "logDetail");
}

/** One field of that set, by key. */
function logDetailField(key) {
    return logDetailFields().find(field => field.key === key);
}

/** The button in the Logging card, under a line saying what is set right now. */
function renderLogDetailShell() {
    const level = values.LOG_LEVEL;
    const categories = values.LOG_CATEGORIES ?? [];
    const all = logDetailField("LOG_CATEGORIES")?.options ?? [];
    const areas = categories.length === all.length
        ? t("settings.logDetail.areasAll")
        : categories.length
            ? t("settings.logDetail.areasSome", { selected: categories.length, count: all.length })
            : t("settings.logDetail.areasNone");
    const levelField = logDetailField("LOG_LEVEL");

    // The line about printers that decided something of their own is filled by
    // renderPrinters(): the two cards are loaded independently, and this one is
    // rebuilt on every settings save while the printer list is not.
    return `<div class="set-test-row">
                <button class="btn btn-small" type="button" id="open-logdetail">${escapeHtml(t("settings.logDetail.open"))}</button>
                <span class="set-test-reason">${escapeHtml(
                    // One text node, no inline markup: the row is a flex
                    // container, so an element inside this span would become a
                    // flex item and swallow the spaces around it
                    t(values.MQTT_TRACE ? "settings.logDetail.summaryTraceOn" : "settings.logDetail.summaryTraceOff", {
                        level: level && levelField ? optionText(levelField, level) : (level ?? ""),
                        areas,
                    })
                )}</span>
            </div>
            <p class="set-note" id="logdetail-overrides" hidden></p>`;
}

/**
 * Names the printers that log by their own rules, in the Logging card.
 *
 * Without it the card describes settings that a printer is quietly ignoring,
 * which is exactly the confusion an override creates.
 */
function renderLogDetailOverrides() {
    const note = document.getElementById("logdetail-overrides");
    if (!note) return;

    const overriding = printers.filter(printer => Object.keys(printer.logDetail || {}).length);
    note.hidden = overriding.length === 0;
    note.textContent = overriding.length
        ? t("settings.logDetail.overrides", {
            count: overriding.length,
            names: overriding.map(printer => printer.name).join(", "),
        })
        : "";
}

/**
 * Opens the log detail dialog, globally or for one printer.
 *
 * The printer variant carries one switch more: a printer follows the global
 * settings until it is told not to, and that is stored as an absent field
 * rather than as a copy of the global value, so a later change to the global
 * one still reaches it.
 *
 * @param {object|null} printer - the printer to edit, or null for the global settings
 */
function openLogDetailDialog(printer) {
    const dialog = document.getElementById("logdetail-dialog");
    const detail = printer?.logDetail || {};
    const inherits = !printer ? false : Object.keys(detail).length === 0;

    const levelField = logDetailField("LOG_LEVEL");
    const categoryField = logDetailField("LOG_CATEGORIES");
    const traceField = logDetailField("MQTT_TRACE");

    const level = detail.level ?? values.LOG_LEVEL;
    const categories = detail.categories ?? values.LOG_CATEGORIES ?? [];
    const trace = detail.mqttTrace ?? values.MQTT_TRACE;

    document.getElementById("logdetail-dialog-title").textContent =
        printer ? t("settings.logDetail.titleFor", { name: printer.name }) : t("settings.logDetail.title");
    document.getElementById("logdetail-dialog-error").textContent = "";

    const inheritRow = printer
        ? `<div class="set-field set-field-toggle">
               <label class="set-field-label" for="ld-inherit"><span>${escapeHtml(t("settings.logDetail.inherit"))}</span></label>
               <label class="set-switch" for="ld-inherit">
                   <input type="checkbox" id="ld-inherit" ${inherits ? "checked" : ""}>
                   <span class="set-switch-track"></span>
               </label>
               <small>${escapeHtml(t("settings.logDetail.inheritHelp"))}</small>
           </div>`
        : "";

    // The rotation budget of the trace file is global: it is disk space, not a
    // decision about one printer, and every trace file shares the setting.
    const budget = printer
        ? ""
        : ["MQTT_TRACE_MAX_SIZE_MB", "MQTT_TRACE_KEEP"]
            .map(key => renderField(logDetailField(key)))
            .join("");

    // The export sits under the settings of the printer whose logs they are,
    // because "which log do I attach" is asked in the same breath as "how
    // much does it log". Both files by default; the trace is the one worth
    // leaving out, at about 22 MB an hour.
    const exportRow = printer
        ? `<div class="set-field" id="ld-export">
               <label class="set-field-label"><span>${escapeHtml(t("settings.logDetail.export"))}</span></label>
               <div class="set-checks set-export-row">
                   <label class="set-check">
                       <input type="checkbox" value="log" checked>
                       <span>${escapeHtml(t("settings.logDetail.printerLog"))}</span>
                   </label>
                   <label class="set-check">
                       <input type="checkbox" value="trace" checked>
                       <span>${escapeHtml(t("settings.logDetail.rawTrace"))}</span>
                   </label>
                   <button class="btn btn-small" type="button" id="ld-export-download">${escapeHtml(t("settings.logDetail.download"))}</button>
               </div>
               <small>${escapeHtml(t("settings.logDetail.exportHelp"))}</small>
           </div>`
        : "";

    document.getElementById("logdetail-dialog-body").innerHTML = `
        <div class="set-form">
            ${inheritRow}
            <div class="set-field">
                <label class="set-field-label" for="ld-level"><span>${escapeHtml(fieldText(levelField, "label"))}</span></label>
                <input type="range" id="ld-level" class="set-slider"
                       min="0" max="${levelField.options.length - 1}" step="1"
                       value="${Math.max(0, levelField.options.indexOf(level))}">
                <div class="set-slider-scale">
                    ${levelField.options.map(option => `<span>${escapeHtml(optionText(levelField, option))}</span>`).join("")}
                </div>
                <small>${escapeHtml(fieldText(levelField, "description"))}</small>
            </div>
            <div class="set-field">
                <label class="set-field-label"><span>${escapeHtml(fieldText(categoryField, "label"))}</span></label>
                <div class="set-checks" id="ld-categories">
                    ${categoryField.options.map(option => `
                        <label class="set-check">
                            <input type="checkbox" value="${escapeHtml(option)}"
                                   ${categories.includes(option) ? "checked" : ""}>
                            <span>${escapeHtml(optionText(categoryField, option))}</span>
                        </label>`).join("")}
                </div>
                <small>${escapeHtml(fieldText(categoryField, "description"))}</small>
            </div>
            <div class="set-field set-field-toggle">
                <label class="set-field-label" for="ld-trace"><span>${escapeHtml(fieldText(traceField, "label"))}</span></label>
                <label class="set-switch" for="ld-trace">
                    <input type="checkbox" id="ld-trace" ${trace ? "checked" : ""}>
                    <span class="set-switch-track"></span>
                </label>
                <small>${escapeHtml(fieldText(traceField, "description"))}</small>
            </div>
            ${budget}
            ${exportRow}
        </div>`;

    // Everything below the inherit switch is only editable once this printer has
    // been taken off the global settings, so the dialog shows what applies
    // rather than an empty form. The export is not a setting and stays live.
    const applyInherit = () => {
        const off = document.getElementById("ld-inherit")?.checked;
        document.querySelectorAll("#logdetail-dialog-body input:not(#ld-inherit):not(#ld-export input)")
            .forEach(input => { input.disabled = !!off; });
    };

    const exportButton = document.getElementById("ld-export-download");
    if (exportButton) {
        const ticked = () => [...document.querySelectorAll("#ld-export input:checked")].map(input => input.value);
        const guard = () => { exportButton.disabled = ticked().length === 0; };
        document.querySelectorAll("#ld-export input").forEach(input => input.addEventListener("change", guard));
        guard();
        exportButton.onclick = () => {
            const scope = ticked().map(file => `${printer.id}/${file}`).join(",");
            downloadWithExportMode({
                url: `./api/diagnostics/download?scope=${encodeURIComponent(scope)}`,
                title: t("settings.logDetail.exportTitle", { name: printer.name }),
                what: t("settings.logDetail.exportWhat", { name: printer.name }),
            });
        };
    }
    document.getElementById("ld-inherit")?.addEventListener("change", applyInherit);
    applyInherit();

    // The two budget fields come from renderField(), which builds a "default"
    // button the card's own handler would normally wire up
    dialog.querySelectorAll("[data-reset]").forEach(button => {
        button.onclick = () => resetField(button.dataset.reset);
    });

    document.getElementById("logdetail-dialog-save").onclick = () => saveLogDetail(printer);
    dialog.showModal();
}

/** Reads the dialog back and writes it, to the settings or to the printer. */
async function saveLogDetail(printer) {
    const error = document.getElementById("logdetail-dialog-error");
    const save = document.getElementById("logdetail-dialog-save");
    const options = logDetailField("LOG_LEVEL").options;

    const level = options[Number(document.getElementById("ld-level").value)];
    const categories = [...document.querySelectorAll("#ld-categories input:checked")].map(input => input.value);
    const trace = document.getElementById("ld-trace").checked;

    save.disabled = true;
    error.textContent = "";

    try {
        if (printer) {
            const inherits = document.getElementById("ld-inherit").checked;
            await sendJson(`./api/printers/${encodeURIComponent(printer.id)}/logdetail`, "PUT",
                inherits ? {} : { level, categories, mqttTrace: trace });
            await loadPrinters();
        } else {
            const payload = {
                LOG_LEVEL: level,
                LOG_CATEGORIES: categories,
                MQTT_TRACE: trace,
                MQTT_TRACE_MAX_SIZE_MB: document.getElementById("set-MQTT_TRACE_MAX_SIZE_MB").value,
                MQTT_TRACE_KEEP: document.getElementById("set-MQTT_TRACE_KEEP").value,
            };
            // Sent with the revision, like every other save on this page, so a
            // second tab cannot be overwritten silently.
            applyView(await sendJson("./api/settings", "PUT", { revision, values: payload }));
        }

        closeDialog("logdetail-dialog");
        showBanner(t("settings.savedApplied"), "ok");
    } catch (err) {
        error.textContent = err.conflict
            ? t("settings.error.conflict")
            : t("settings.error.save", { message: err.message });
    } finally {
        save.disabled = false;
    }
}

/**
 * One check result as a pill plus, when there is one, the reason next to it.
 * A warning means the connection came up but could not be fully confirmed, so
 * it gets its own colour rather than being sold as a clean result.
 */
function testPill(label, result) {
    const kind = !result.ok ? "pill-bad" : result.warning ? "pill-legacy" : "pill-ok";
    const state = !result.ok ? "failed" : result.warning ? "unconfirmed" : "reachable";
    // Worded by the code the server sends where the tables know it, see errorText() in i18n.js
    const message = result.ok
        ? (result.warning ? I18N.errorText({ error: result.warning, code: result.code, params: result.params }) : "")
        : I18N.errorText(result);
    const reason = message ? ` <span class="set-test-reason">${escapeHtml(message)}</span>` : "";

    return `<span class="pill ${kind}">${escapeHtml(t(`settings.test.${state}`, { label }))}</span>${reason}`;
}

/**
 * Tries the Spoolman address currently in the form, not the stored one, so a
 * new endpoint can be verified before it is saved. The host and port from the
 * collapsed section count too, which is why the button sits below it.
 */
async function testSpoolmanConnection() {
    const button = document.getElementById("test-spoolman");
    const output = document.getElementById("test-spoolman-result");
    button.disabled = true;
    output.textContent = t("settings.test.testing");

    try {
        const payload = {};
        for (const key of ["SPOOLMAN_ENDPOINT", "SPOOLMAN_IP", "SPOOLMAN_PORT", "SPOOLMAN_SUBFOLDER"]) {
            payload[key] = document.getElementById(`set-${key}`)?.value ?? "";
        }

        const result = await sendJson("./api/test/spoolman", "POST", payload);
        output.innerHTML = `${testPill("Spoolman", result)}
            ${result.url ? `<span class="set-test-reason">${escapeHtml(result.url)}</span>` : ""}`;
    } catch (err) {
        output.innerHTML = testPill("Spoolman", { ok: false, error: err.message });
    } finally {
        button.disabled = false;
    }
}

/* ---- Spool tags ----
 *
 * Whether the spools carry their tag natively, and the button that makes them.
 * The server counts and decides, see planTagMigration() in src/ams.js; this
 * card words the answer.
 */

/** One line of the tag card, as a note. */
function tagNote(text, warn = false) {
    return `<p class="set-note${warn ? " set-note-warn" : ""}">${escapeHtml(text)}</p>`;
}

/**
 * Paints what `/api/spoolman/tags` answered.
 *
 * The migrate button is offered only where it would do something: a Spoolman
 * with native tags and at least one spool to link. A conflict is listed with
 * both spools, because resolving it is a decision in Spoolman, which of the two
 * records the tag belongs to, and nothing this page can make.
 *
 * Clearing the extra field is offered last and only where it would last: every
 * spool is linked natively, the field is no longer written, and it still sits
 * on spools where it says nothing the native tag does not. The server refuses
 * the rest anyway, see removeLegacyTags() in src/spoolman.js.
 */
function renderTagStatus(status) {
    const lines = [];
    const canCleanUp = status.supported && !status.legacyWritten && status.pending === 0 && status.redundant > 0;

    if (!status.supported) {
        lines.push(tagNote(t("settings.tags.unsupported", { version: status.version ?? "?" })));
    } else if (status.total === 0) {
        lines.push(tagNote(t("settings.tags.none")));
    } else if (status.pending === 0 && status.conflicts.length === 0) {
        lines.push(tagNote(t("settings.tags.allNative", { total: status.total })));
    } else if (status.pending > 0) {
        // With nothing left to link, the conflicts below are the whole answer
        lines.push(tagNote(t("settings.tags.pending", { pending: status.pending, total: status.total }), true));
    }

    if (status.supported && status.conflicts.length) {
        lines.push(tagNote(t("settings.tags.conflicts", { count: status.conflicts.length }), true));
        for (const conflict of status.conflicts) {
            lines.push(tagNote(t("settings.tags.conflict", { id: conflict.id, heldBy: conflict.heldBy })));
        }
    }

    if (canCleanUp) lines.push(tagNote(t("settings.tags.redundant", { count: status.redundant })));

    const cleanup = document.getElementById("cleanup-tags");
    cleanup.hidden = !canCleanUp;
    cleanup.dataset.count = status.redundant ?? 0;

    document.getElementById("tags-status").innerHTML = lines.join("");
    document.getElementById("migrate-tags").hidden = !(status.supported && status.pending > 0);
}

/** Asks the server how the tags stand. Runs once on load and on the button. */
async function checkSpoolTags() {
    const button = document.getElementById("check-tags");
    const output = document.getElementById("tags-result");
    button.disabled = true;
    output.textContent = t("settings.tags.checking");

    try {
        renderTagStatus(await fetchJson("./api/spoolman/tags"));
        output.textContent = "";
    } catch (err) {
        document.getElementById("tags-status").innerHTML = "";
        document.getElementById("migrate-tags").hidden = true;
        document.getElementById("cleanup-tags").hidden = true;
        output.innerHTML = `<span class="set-test-reason set-test-failed">${escapeHtml(err.message)}</span>`;
    } finally {
        button.disabled = false;
    }
}

/**
 * Runs the migration and then reads the state again, so the card shows what is
 * true now rather than what the run reported. What Spoolman refused is listed
 * below it with its reason.
 */
async function migrateSpoolTags() {
    const button = document.getElementById("migrate-tags");
    const output = document.getElementById("tags-result");
    button.disabled = true;
    output.textContent = t("settings.tags.migrating");

    try {
        const result = await sendJson("./api/spoolman/tags/migrate", "POST", {});
        await checkSpoolTags();

        const failed = (result.failed ?? [])
            .map(entry => tagNote(t("settings.tags.failed", { id: entry.id, error: entry.error }), true));
        document.getElementById("tags-status").insertAdjacentHTML("beforeend", failed.join(""));
        output.innerHTML = `<span class="pill ${failed.length ? "pill-legacy" : "pill-ok"}">${escapeHtml(t("settings.tags.migrated", { migrated: result.migrated }))}</span>`;
    } catch (err) {
        output.innerHTML = `<span class="set-test-reason set-test-failed">${escapeHtml(err.message)}</span>`;
    } finally {
        button.disabled = false;
    }
}

/**
 * Clears the extra field where the native tag says the same, after asking.
 *
 * The question is the point of this function: it is the one step on this card
 * that takes something away, and what it breaks is not on this page but in
 * whatever else still reads the field.
 */
async function cleanupSpoolTags() {
    const button = document.getElementById("cleanup-tags");
    const output = document.getElementById("tags-result");

    const confirmed = await confirmAction({
        title: t("settings.tags.cleanupTitle"),
        html: `<p>${escapeHtml(t("settings.tags.cleanupText", { count: button.dataset.count }))}</p>
               <p class="set-note set-note-warn">${escapeHtml(t("settings.tags.cleanupWarn"))}</p>`,
        okLabel: t("settings.tags.cleanupOk"),
    });
    if (!confirmed) return;

    button.disabled = true;
    output.textContent = t("settings.tags.cleaning");

    try {
        const result = await sendJson("./api/spoolman/tags/cleanup", "POST", {});
        await checkSpoolTags();

        const failed = (result.failed ?? [])
            .map(entry => tagNote(t("settings.tags.failed", { id: entry.id, error: entry.error }), true));
        document.getElementById("tags-status").insertAdjacentHTML("beforeend", failed.join(""));
        output.innerHTML = `<span class="pill ${failed.length ? "pill-legacy" : "pill-ok"}">${escapeHtml(t("settings.tags.cleaned", { removed: result.removed }))}</span>`;
    } catch (err) {
        output.innerHTML = `<span class="set-test-reason set-test-failed">${escapeHtml(err.message)}</span>`;
    } finally {
        button.disabled = false;
    }
}

/**
 * Tries both connections a printer needs: MQTT for the AMS data and FTPS for
 * the sliced file the consumption is read from. An empty access code means the
 * stored one is used, which is how an edit without retyping it is tested.
 */
async function testPrinterConnection() {
    const button = document.getElementById("printer-dialog-test");
    const output = document.getElementById("printer-test-result");
    button.disabled = true;
    output.textContent = t("settings.test.testing");

    try {
        const result = await sendJson("./api/test/printer", "POST", {
            id: document.getElementById("printer-id").value,
            ip: document.getElementById("printer-ip").value,
            code: document.getElementById("printer-code").value,
        });

        output.innerHTML = `<div>${testPill("MQTT", result.mqtt)}</div>
                            <div>${testPill("FTPS", result.ftps)}</div>`;
    } catch (err) {
        output.innerHTML = `<span class="set-test-reason set-test-failed">${escapeHtml(err.message)}</span>`;
    } finally {
        button.disabled = false;
    }
}

/**
 * Shows the URL the service actually talks to. The endpoint field alone does
 * not say it: a subfolder is appended, and with no endpoint the host and port
 * from the advanced section are used instead.
 */
function renderEffectiveUrl() {
    return spoolmanUrl
        ? `<p class="set-note">${t("settings.spoolman.talkingToHtml", { url: `<code>${escapeHtml(spoolmanUrl)}</code>` })}</p>`
        : `<p class="set-note set-note-warn">${escapeHtml(t("settings.spoolman.noEndpoint"))}</p>`;
}

/**
 * A field that belongs to the whole card rather than to a row of its own.
 *
 * Only the label, the switch and an info icon carrying the description, so the
 * card header stays a header. Everything else about it works as usual, the id
 * is the same one the form is read back from.
 */
function renderHeaderField(field) {
    const id = `set-${field.key}`;
    const reset = isDefault(field)
        ? ""
        : `<button type="button" class="set-reset" data-reset="${field.key}">${escapeHtml(t("settings.badge.default"))}</button>`;
    const description = fieldText(field, "description");

    return `<div class="set-head-field">
                <label for="${id}">${escapeHtml(fieldText(field, "label"))}</label>
                ${reset}
                <label class="set-switch" for="${id}">
                    <input type="checkbox" id="${id}" ${values[field.key] ? "checked" : ""}>
                    <span class="set-switch-track"></span>
                </label>
                <span class="set-info" tabindex="0" role="note"
                      aria-label="${escapeHtml(description)}"
                      data-tip="${escapeHtml(description)}">i</span>
            </div>`;
}

/** Builds the input for one field, chosen by the type the schema reports. */
function renderField(field) {
    const value = values[field.key];
    const id = `set-${field.key}`;
    let input;

    if (field.type === "boolean") {
        input = `<label class="set-switch" for="${id}">
                     <input type="checkbox" id="${id}" ${value ? "checked" : ""}>
                     <span class="set-switch-track"></span>
                 </label>`;
    } else if (field.type === "enum") {
        const options = field.options
            .map(option => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(optionText(field, option))}</option>`)
            .join("");
        input = `<select id="${id}">${options}</select>`;
    } else if (field.type === "integer") {
        input = `<input type="number" id="${id}" value="${escapeHtml(value)}"
                        ${field.min !== null ? `min="${field.min}"` : ""}
                        ${field.max !== null ? `max="${field.max}"` : ""}>`;
    } else if (field.type === "password") {
        // Never prefilled, because the stored value is a hash the server does
        // not send. Left empty it keeps what is stored, which is the same rule
        // the printer access code follows.
        input = `<input type="password" id="${id}" autocomplete="new-password"
                        placeholder="${escapeHtml(t(hasValue[field.key] ? "settings.placeholder.unchanged" : "settings.placeholder.notSet"))}">`;
    } else {
        input = `<input type="text" id="${id}" value="${escapeHtml(value ?? "")}">`;
    }

    const badges = [
        field.restartRequired ? `<span class="pill pill-legacy">${escapeHtml(t("settings.badge.restartRequired"))}</span>` : "",
        sources[field.key] === "environment" ? `<span class="pill pill-gcode">${escapeHtml(t("settings.badge.environment"))}</span>` : "",
        // Once saved, the file owns every field, so this is the only way back to
        // the documented value.
        isDefault(field) ? "" : `<button type="button" class="set-reset" data-reset="${field.key}">${escapeHtml(t("settings.badge.default"))}</button>`,
        // Emptying the field means "unchanged", so removing a stored password
        // needs a gesture of its own.
        field.type === "password" && hasValue[field.key]
            ? `<button type="button" class="set-reset" data-clear="${field.key}">${escapeHtml(t("settings.badge.remove"))}</button>`
            : "",
    ].join("");

    // A checkbox reads better next to its label than under it, so it sits in
    // the label row and the description stays where it is for every field.
    return `<div class="set-field${field.type === "boolean" ? " set-field-toggle" : ""}">
                <label class="set-field-label" for="${id}">
                    <span>${escapeHtml(fieldText(field, "label"))}</span>${badges}
                </label>
                ${input}
                <small>${escapeHtml(fieldText(field, "description"))}</small>
            </div>`;
}

/** Whether a field currently holds the value the schema documents as default. */
function isDefault(field) {
    const value = values[field.key];
    return value === field.default || (value === null && field.default === null);
}

/** Puts the schema default into a field without touching the rest of the form. */
function resetField(key) {
    const field = fields.find(f => f.key === key);
    const input = document.getElementById(`set-${key}`);
    if (!field || !input) return;

    if (field.type === "boolean") input.checked = !!field.default;
    else input.value = field.default ?? "";

    document.querySelector(`[data-reset="${key}"]`)?.remove();
    // A dialog field is not part of the page form, so it must not arm the save
    // button or the warning about leaving with unsaved changes
    if (!field.dialog) markDirty(input);
}

/**
 * Marks a stored password for removal on the next save.
 *
 * Nothing is sent here. The field says what will happen and the save button
 * does it, like every other change on this page.
 */
function clearPassword(key) {
    const input = document.getElementById(`set-${key}`);
    if (!input) return;

    input.value = "";
    input.dataset.clear = "true";
    input.placeholder = t("settings.placeholder.removedOnSave");
    document.querySelector(`[data-clear="${key}"]`)?.remove();
    markDirty(input);
}

/**
 * The language field of the Web UI card: every registered language, the shown
 * one selected. A pick is stored in this browser and reloads the page in it,
 * see I18N.setLanguage. It is a choice of the browser, not a setting of the
 * installation, so it never reaches the form or settings.json: two phones on
 * the same installation can read it in two languages.
 */
function setupLanguageField() {
    const select = document.getElementById("ui-language");
    if (!select) return;

    const current = window.I18N.language();
    select.innerHTML = window.I18N.languages()
        .map(([code]) => `<option value="${escapeHtml(code)}"${code === current ? " selected" : ""}>${escapeHtml(window.I18N.languageLabel(code))}</option>`)
        .join("");

    select.addEventListener("change", () => window.I18N.setLanguage(select.value));
}

/**
 * The theme field of the Web UI card, the moon of the menu bar as a select.
 *
 * It does not switch the theme itself: it clicks the moon, which owns the
 * class on <html>, its own icon and the stored choice, so the two can never
 * disagree. And when the moon is clicked, the field follows; its listener runs
 * after the one of menu.js, so it reads the state the click left behind.
 */
function setupThemeField() {
    const select = document.getElementById("ui-theme");
    const toggle = document.getElementById("dark-mode-toggle");
    if (!select || !toggle) return;

    const isDark = () => document.documentElement.classList.contains("dark-mode");
    const follow = () => { select.value = isDark() ? "dark" : "light"; };
    follow();

    select.addEventListener("change", () => {
        if ((select.value === "dark") !== isDark()) toggle.click();
    });
    toggle.addEventListener("click", follow);
}

/** Reads every field back out of the form, in the type the backend expects. */
function collectSettings() {
    const payload = {};

    for (const field of fields) {
        // A dialog field is saved by that dialog. It shares the id scheme, so
        // an open dialog would otherwise smuggle what is typed in it into a
        // save of the page behind it.
        if (field.dialog) continue;

        const input = document.getElementById(`set-${field.key}`);
        if (!input) continue;

        if (field.type === "boolean") payload[field.key] = input.checked;
        // An empty password field keeps what is stored, so removing one is an
        // explicit null rather than the empty string every save would send.
        else if (field.type === "password") payload[field.key] = input.dataset.clear === "true" ? null : input.value;
        else payload[field.key] = input.value;
    }

    return payload;
}

async function saveSettings(event) {
    event.preventDefault();
    const values = collectSettings();
    if (!await confirmKeysSurvivePassword(values)) return;

    const button = document.getElementById("save-settings");
    button.disabled = true;

    try {
        const result = await sendJson("./api/settings", "PUT", { revision, values });
        applyView(result);
        // This save may have been the one that took the variables out of service
        loadEnvInfo();

        if (restartPending) {
            showRestartNotice();
        } else if (result.changed.length) {
            showBanner(t("settings.savedApplied"), "ok");
        } else {
            showBanner(t("settings.nothingChanged"), "ok");
        }
    } catch (err) {
        showBanner(err.conflict
            ? t("settings.error.conflict")
            : t("settings.error.save", { message: err.message }), "bad");
        button.disabled = false;
    }
}

/**
 * Says what a first password does not do, before it is saved.
 *
 * Setting one ends every browser session, which is what people expect it to do,
 * and leaves every API key working, which is what they do not: a key is not
 * signed with the password and nothing about it changes here. Somebody turning
 * the password on is usually closing the Web UI to the network, and a key
 * created while it stood open keeps full access afterwards.
 *
 * Only for the step from no password to a password. Changing one that is
 * already set is not the surprising case: the keys were created next to it.
 *
 * @param {object} values - what the form is about to send
 * @returns {Promise<boolean>} whether the save should go ahead
 */
async function confirmKeysSurvivePassword(values) {
    const typed = typeof values.AUTH_PASSWORD === "string" && values.AUTH_PASSWORD !== "";
    if (!typed || hasValue.AUTH_PASSWORD || !apiKeys.length) return true;

    const list = apiKeys.map(key => `<li>${escapeHtml(key.name)}</li>`).join("");
    return confirmAction({
        title: t("settings.password.keysTitle"),
        html: `<p>${escapeHtml(t("settings.password.keysText", { count: apiKeys.length }))}</p>
               <ul class="set-list">${list}</ul>
               <p class="set-note">${escapeHtml(t("settings.password.keysNote"))}</p>`,
        okLabel: t("settings.password.set"),
    });
}

/* ---- Printers ---- */

async function loadPrinters() {
    try {
        printers = await fetchJson("./api/printers/config");
        renderPrinters();
        // The Logging card names the printers that log by their own rules
        renderLogDetailOverrides();
        // The Service card offers the opposite of what is currently the case,
        // so it has to follow every change to the list.
        renderMonitoringButton();
    } catch (err) {
        document.getElementById("printer-table").innerHTML =
            `<p class="set-error">${escapeHtml(t("settings.error.loadPrinters", { message: err.message }))}</p>`;
    }
}

/** Maps an MQTT status onto one of the shared status pill styles. */
function statusPill(status) {
    const kind = status === "Connected" ? "pill-ok" : status === "Disabled" ? "pill-legacy" : "pill-bad";
    return `<span class="pill ${kind}">${escapeHtml(valueText("settings.status", status))}</span>`;
}

function renderPrinters() {
    const container = document.getElementById("printer-table");

    if (!printers.length) {
        container.innerHTML = `<p class="set-note">${escapeHtml(t("settings.printers.empty"))}</p>`;
        return;
    }

    // The data-label of a cell is what the phone layout puts above its value,
    // where there is no header row to read it off. See the responsive block in
    // styles.css, which the spool tables use the same way.
    const name = escapeHtml(t("settings.printers.name"));
    const serial = escapeHtml(t("settings.printers.serial"));
    const address = escapeHtml(t("settings.printers.address"));
    const rows = printers.map(printer => `
        <tr>
            <td data-label="${name}">${escapeHtml(printer.name)}</td>
            <td class="set-mono" data-label="${serial}">${escapeHtml(printer.id)}</td>
            <td class="set-mono" data-label="${address}">${escapeHtml(printer.ip)}</td>
            <td data-label="MQTT">${statusPill(printer.mqttStatus)}</td>
            <td class="set-row-actions" data-label="">
                <button class="btn btn-small" data-edit="${escapeHtml(printer.id)}">${escapeHtml(t("settings.printers.edit"))}</button>
                <button class="btn btn-small" data-logdetail="${escapeHtml(printer.id)}">${escapeHtml(t("settings.printers.log"))}${
                    Object.keys(printer.logDetail || {}).length ? " *" : ""}</button>
                <button class="btn btn-small btn-danger" data-delete="${escapeHtml(printer.id)}">${escapeHtml(t("settings.delete"))}</button>
            </td>
        </tr>`).join("");

    container.innerHTML = `<table class="data-table">
            <thead><tr><th>${name}</th><th>${serial}</th><th>${address}</th><th>MQTT</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="set-note">${t("settings.printers.noteHtml", { log: `<strong>${escapeHtml(t("settings.printers.log"))}</strong>` })}</p>`;

    container.querySelectorAll("[data-edit]").forEach(button => {
        button.onclick = () => openPrinterDialog(printers.find(p => p.id === button.dataset.edit));
    });
    container.querySelectorAll("[data-logdetail]").forEach(button => {
        button.onclick = () => openLogDetailDialog(printers.find(p => p.id === button.dataset.logdetail));
    });
    container.querySelectorAll("[data-delete]").forEach(button => {
        button.onclick = () => confirmDeletePrinter(printers.find(p => p.id === button.dataset.delete));
    });
}

/**
 * Opens the add or edit dialog. The serial number is read only while editing:
 * it keys the MQTT topic, the log file and the spool assignments, so a
 * different one describes a different printer.
 */
function openPrinterDialog(printer) {
    const editing = !!printer;
    const dialog = document.getElementById("printer-dialog");

    document.getElementById("printer-dialog-title").textContent = editing ? t("settings.printers.editTitle", { name: printer.name }) : t("settings.printers.add");
    document.getElementById("printer-dialog-error").textContent = "";
    document.getElementById("printer-test-result").textContent = "";
    document.getElementById("printer-dialog-fields").innerHTML = `
        <div class="set-field">
            <label class="set-field-label" for="printer-name"><span>${escapeHtml(t("settings.printers.name"))}</span></label>
            <input type="text" id="printer-name" value="${escapeHtml(printer?.name ?? "")}">
            <small>${escapeHtml(t("settings.printers.nameHelp"))}</small>
        </div>
        <div class="set-field">
            <label class="set-field-label" for="printer-id"><span>${escapeHtml(t("settings.printers.serial"))}</span></label>
            <input type="text" id="printer-id" value="${escapeHtml(printer?.id ?? "")}" ${editing ? "disabled" : ""}>
            <small>${escapeHtml(t(editing ? "settings.printers.serialLocked" : "settings.printers.serialHelp"))}</small>
        </div>
        <div class="set-field">
            <label class="set-field-label" for="printer-ip"><span>${escapeHtml(t("settings.printers.address"))}</span></label>
            <input type="text" id="printer-ip" value="${escapeHtml(printer?.ip ?? "")}">
            <small>${escapeHtml(t("settings.printers.addressHelp"))}</small>
        </div>
        <div class="set-field">
            <label class="set-field-label" for="printer-code"><span>${escapeHtml(t("settings.printers.code"))}</span></label>
            <input type="password" id="printer-code" value="" autocomplete="new-password"
                   placeholder="${editing ? escapeHtml(t("settings.placeholder.unchanged")) : ""}">
            <small>${escapeHtml(t(editing ? "settings.printers.codeKeep" : "settings.printers.codeHelp"))}</small>
        </div>`;

    document.getElementById("printer-dialog-save").onclick = () => savePrinter(printer);
    dialog.showModal();
    // Straight into the first field, rather than on whatever the dialog focuses
    document.getElementById("printer-name").focus();
}

async function savePrinter(printer, force = false) {
    const error = document.getElementById("printer-dialog-error");
    const payload = {
        name: document.getElementById("printer-name").value,
        ip: document.getElementById("printer-ip").value,
        code: document.getElementById("printer-code").value,
        force,
    };

    try {
        if (printer) {
            await sendJson(`./api/printers/${encodeURIComponent(printer.id)}`, "PUT", payload);
            showBanner(t("settings.printers.saved", { name: payload.name || printer.name }), "ok");
        } else {
            await sendJson("./api/printers", "POST", { ...payload, id: document.getElementById("printer-id").value });
            showBanner(t("settings.printers.added", { name: payload.name }), "ok");
        }
        closeDialog("printer-dialog");
        loadPrinters();
    } catch (err) {
        if (err.printInFlight) {
            // The dialog would sit on top of the confirmation, so it goes first
            // and comes back if the change is not carried out after all.
            closeDialog("printer-dialog");
            const done = await confirmWhilePrinting(err, () => savePrinter(printer, true));
            if (!done) document.getElementById("printer-dialog").showModal();
            return;
        }
        error.textContent = err.message;
    }
}

/**
 * Opens the confirmation dialog and resolves with what the user picked.
 *
 * @param {{title: string, html: string, okLabel?: string}} options
 * @returns {Promise<boolean>} whether the action was confirmed
 */
function confirmAction({ title, html, okLabel = t("settings.delete") }) {
    const dialog = document.getElementById("confirm-dialog");
    const ok = document.getElementById("confirm-dialog-ok");
    const cancel = document.getElementById("confirm-dialog-cancel");

    document.getElementById("confirm-dialog-title").textContent = title;
    document.getElementById("confirm-dialog-text").innerHTML = html;
    ok.textContent = okLabel;

    return new Promise(resolve => {
        const finish = (result) => {
            ok.onclick = null;
            cancel.onclick = null;
            dialog.close();
            resolve(result);
        };
        ok.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        dialog.showModal();
        // The harmless choice takes the focus, not the one that deletes
        cancel.focus();
    });
}

/**
 * Asks whether an action that would interrupt a running print should go ahead
 * anyway, and repeats it with `force` when it should.
 *
 * @param {Error} err - the rejected request, carrying the reason from the server
 * @param {function(): Promise} retry - the same request with force set
 * @returns {Promise<boolean>} whether the action was carried out
 */
async function confirmWhilePrinting(err, retry) {
    const confirmed = await confirmAction({
        title: t("settings.printing.title"),
        html: `<p>${escapeHtml(err.message)}</p>
               <p class="set-note">${escapeHtml(t("settings.printing.note"))}</p>`,
        okLabel: t("settings.printing.anyway"),
    });

    if (!confirmed) return false;
    await retry();
    return true;
}

function confirmDeletePrinter(printer) {
    confirmAction({
        title: t("settings.printers.deleteTitle", { name: printer.name }),
        html: `<p>${escapeHtml(t("settings.printers.deleteText"))}</p>
               <p class="set-note">${escapeHtml(t("settings.printers.deleteNote"))}</p>`,
    }).then(confirmed => confirmed && deletePrinter(printer, false));
}

async function deletePrinter(printer, force) {
    const url = `./api/printers/${encodeURIComponent(printer.id)}`;

    try {
        await fetchJson(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
        });
        showBanner(t("settings.printers.removed", { name: printer.name }), "ok");
        loadPrinters();
    } catch (err) {
        if (err.printInFlight) {
            await confirmWhilePrinting(err, () => deletePrinter(printer, true));
            return;
        }
        showBanner(t("settings.error.removePrinter", { message: err.message }), "bad");
    }
}

/* ---- API keys ---- */

/**
 * The shell the key list is painted into, rendered as part of the Network
 * access card.
 *
 * Below the two fields rather than in a card of its own, because a key is the
 * same question those fields answer: who may talk to this service. The list
 * itself is filled by renderApiKeys(), which runs whenever the card is rebuilt
 * and after every change to the keys.
 */
function renderApiKeyShell() {
    return `<div class="set-subsection">
                <div class="set-subhead">
                    <h3>${escapeHtml(t("settings.apikeys.title"))}
                        <a class="set-info set-info-link" href="api.html" id="open-api-page"
                           data-tip="${escapeHtml(t("settings.apikeys.apiPageTip"))}"
                           aria-label="${escapeHtml(t("settings.apikeys.apiPageLabel"))}">i</a>
                    </h3>
                    <button class="btn btn-small" type="button" id="add-apikey">${escapeHtml(t("settings.apikeys.add"))}</button>
                </div>
                <div id="apikey-table"></div>
            </div>`;
}

async function loadApiKeys() {
    try {
        apiKeys = (await fetchJson("./api/apikeys")).keys ?? [];
    } catch (err) {
        apiKeys = [];
        const container = document.getElementById("apikey-table");
        if (container) container.innerHTML = `<p class="set-error">${escapeHtml(t("settings.error.loadApiKeys", { message: err.message }))}</p>`;
        return;
    }
    renderApiKeys();
}

function renderApiKeys() {
    const container = document.getElementById("apikey-table");
    if (!container) return;

    if (!apiKeys.length) {
        container.innerHTML = `<p class="set-note">${escapeHtml(t("settings.apikeys.empty"))}</p>`;
        return;
    }

    const name = escapeHtml(t("settings.apikeys.name"));
    const created = escapeHtml(t("settings.apikeys.created"));
    const lastUsed = escapeHtml(t("settings.apikeys.lastUsed"));
    const rows = apiKeys.map(key => `
        <tr>
            <td data-label="${name}">${escapeHtml(key.name)}</td>
            <td data-label="${created}">${escapeHtml(formatStamp(key.createdAt))}</td>
            <td data-label="${lastUsed}">${escapeHtml(key.lastUsedAt ? formatStamp(key.lastUsedAt) : t("settings.apikeys.never"))}</td>
            <td class="set-row-actions" data-label="">
                <button class="btn btn-small btn-danger" data-revoke="${escapeHtml(key.id)}">${escapeHtml(t("settings.apikeys.revoke"))}</button>
            </td>
        </tr>`).join("");

    container.innerHTML = `<table class="data-table">
            <thead><tr><th>${name}</th><th>${created}</th><th>${lastUsed}</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="set-note">${t("settings.apikeys.noteHtml", { bearer: BEARER_HEADER, header: KEY_HEADER, lastUsed })}</p>`;

    container.querySelectorAll("[data-revoke]").forEach(button => {
        button.onclick = () => confirmRevokeApiKey(apiKeys.find(key => key.id === button.dataset.revoke));
    });
}

// The two ways to send a key, the same in every language
const BEARER_HEADER = "<code>Authorization: Bearer &lt;key&gt;</code>";
const KEY_HEADER = "<code>X-API-Key: &lt;key&gt;</code>";

/**
 * A stored timestamp in the language of the page, or "unknown".
 *
 * Every part two digits, so the column lines up rather than jumping between
 * "3.9.2026" and "13.10.2026". The order stays whatever the browser's language
 * puts it in; only the padding is asked for.
 */
function formatStamp(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return t("settings.unknown");

    return date.toLocaleString(window.I18N.language(), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

/** Asks for a name and creates the key. */
function openApiKeyDialog() {
    const dialog = document.getElementById("apikey-dialog");
    const save = document.getElementById("apikey-dialog-save");

    document.getElementById("apikey-dialog-title").textContent = t("settings.apikeys.newTitle");
    document.getElementById("apikey-dialog-error").textContent = "";
    document.getElementById("apikey-dialog-body").innerHTML = `
        <div class="set-form">
            <div class="set-field">
                <label class="set-field-label" for="apikey-name"><span>${escapeHtml(t("settings.apikeys.name"))}</span></label>
                <input type="text" id="apikey-name" maxlength="64" placeholder="Home Assistant">
                <small>${escapeHtml(t("settings.apikeys.nameHelp"))}</small>
            </div>
        </div>`;

    save.textContent = t("settings.apikeys.create");
    save.hidden = false;
    save.onclick = createApiKey;
    document.getElementById("apikey-dialog-cancel").textContent = t("settings.cancel");

    dialog.showModal();
    document.getElementById("apikey-name").focus();
}

async function createApiKey() {
    const error = document.getElementById("apikey-dialog-error");
    const save = document.getElementById("apikey-dialog-save");
    error.textContent = "";
    save.disabled = true;

    let result;
    try {
        result = await sendJson("./api/apikeys", "POST", { name: document.getElementById("apikey-name").value });
    } catch (err) {
        error.textContent = err.message;
        return;
    } finally {
        save.disabled = false;
    }

    apiKeys = result.keys ?? apiKeys;
    renderApiKeys();
    // The Service card counts the keys, so it is stale the moment one is added
    loadSystemInfo();
    showCreatedApiKey(result.entry?.name ?? "", result.key);
}

/**
 * Shows the key, once.
 *
 * In a field rather than as text, so it can be selected on the installations
 * where the clipboard is not available: the browser hands that API only to a
 * page served over HTTPS or from localhost, and most installations of this
 * service are reached over plain HTTP under their address.
 */
function showCreatedApiKey(name, key) {
    document.getElementById("apikey-dialog-title").textContent = t("settings.apikeys.keyFor", { name });
    document.getElementById("apikey-dialog-error").textContent = "";
    document.getElementById("apikey-dialog-body").innerHTML = `
        <p>${escapeHtml(t("settings.apikeys.copyNow"))}</p>
        <div class="set-key-row">
            <input type="text" id="apikey-value" class="set-mono" readonly value="${escapeHtml(key)}">
            <button class="btn btn-small" type="button" id="apikey-copy">${escapeHtml(t("settings.apikeys.copy"))}</button>
        </div>
        <p class="set-note">${t("settings.apikeys.sendAsHtml", { bearer: BEARER_HEADER, header: KEY_HEADER })}</p>`;

    const save = document.getElementById("apikey-dialog-save");
    save.hidden = true;
    save.onclick = null;
    document.getElementById("apikey-dialog-cancel").textContent = t("settings.apikeys.done");

    const field = document.getElementById("apikey-value");
    field.focus();
    field.select();

    document.getElementById("apikey-copy").onclick = async () => {
        field.select();
        try {
            await navigator.clipboard.writeText(key);
            document.getElementById("apikey-copy").textContent = t("settings.apikeys.copied");
        } catch {
            // No clipboard permission, or no secure context. The field is
            // selected, so the key is one keyboard shortcut away either way.
            document.getElementById("apikey-copy").textContent = t("settings.apikeys.pressCtrlC");
        }
    };
}

function confirmRevokeApiKey(key) {
    if (!key) return;

    confirmAction({
        title: t("settings.apikeys.revokeTitle", { name: key.name }),
        html: `<p>${escapeHtml(t("settings.apikeys.revokeText"))}</p>
               <p class="set-note">${escapeHtml(t("settings.apikeys.revokeNote"))}</p>`,
        okLabel: t("settings.apikeys.revoke"),
    }).then(confirmed => confirmed && revokeApiKey(key));
}

async function revokeApiKey(key) {
    try {
        const result = await fetchJson(`./api/apikeys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
        apiKeys = result.keys ?? apiKeys;
        renderApiKeys();
        loadSystemInfo();
        showBanner(t("settings.apikeys.revoked", { name: key.name }), "ok");
    } catch (err) {
        showBanner(t("settings.error.revoke", { message: err.message }), "bad");
    }
}

function closeDialog(id) {
    document.getElementById(id).close();
}
