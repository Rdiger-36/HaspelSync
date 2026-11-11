// Shared mutable runtime state accessed by multiple modules
export const state = {
    spoolmanStatus: "Disconnected",
    vendorID: null,
    clients: [],       // SSE client connections
    // Last known Spoolman spool list for change detection. null means "not yet
    // seeded". Deliberately not [], which is a legitimate value for an empty
    // Spoolman and must still be comparable against the next fetch.
    lastSpoolData: null,
    // Startup bookkeeping. The monitor loops must be started exactly once, and
    // the Spoolman bootstrap must not run twice in parallel when the endpoint is
    // changed repeatedly in the Web UI.
    monitorsRunning: false,
    spoolmanBootstrapRunning: false,
    // The SpoolmanDB catalogue, kept for the create-spool dialog. It is around
    // seven thousand entries and a few megabytes, the dialog queries it while
    // the user types, and it changes about as often as Spoolman ships a
    // release, so it is fetched once and reused rather than pulled per request.
    externalFilamentCache: { fetchedAt: 0, entries: [] },
    // Request refusals already written to the server log, see security.js. A
    // Web UI left open on a refused host retries forever, so each distinct
    // reason is logged once instead of on every attempt.
    refusedRequestsLogged: new Set(),
    // Failed login attempts per remote address, see auth.js. Deliberately not
    // persisted: a restart clearing the lockouts costs an attacker the seconds
    // it takes to restart the service, which they cannot trigger anyway.
    loginFailures: new Map(),
    // Whether the dashboard dialog about the deprecated image name was closed
    // since this process started, see imagenotice.js. Deliberately not
    // persisted: the dialog comes back on every start, a new version included,
    // because the switch is a one line change that a dialog dismissed once and
    // forever is never acted on.
    legacyImageNoticeDismissed: false,
    // What the connected Spoolman can do about tags, see spoolman.js. null
    // means "not asked yet" and is treated as "no native tags", because
    // extra.tag works on every version. Asked again with every bootstrap, the
    // answer belongs to the instance and not to the process.
    spoolmanVersion: null,
    spoolmanNativeTags: null,
    // A tag migration walks every spool with one request each, so a second
    // click must not start a second walk over the same list.
    tagMigrationRunning: false,
    // How many spools carry their tag in extra.tag alone, as of the last look:
    // the bootstrap, a check on the settings page or a migration run. null
    // means nobody looked yet. It feeds the dashboard notice, see tagnotice.js.
    tagMigrationPending: null,
};
