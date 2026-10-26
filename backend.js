import express from "express";
import path from "path";
import fs from "fs-extra";

import "./src/logger.js"; // must be first, sets up console overrides
import { PORT, serverLogFilePath, version } from "./src/config.js";
import { rotateLogFile } from "./src/logger.js";
import { deprecatedConfig, deprecationLogLines } from "./src/deprecation.js";
import { upgradeLogLines, upgradeNotice } from "./src/upgradenotice.js";
import { legacyImageLogLines, legacyImageNotice } from "./src/imagenotice.js";
import { printers } from "./src/printers.js";
import { requireAuth } from "./src/auth.js";
import { registerRoutes } from "./src/routes.js";
import { hostGuard } from "./src/security.js";
import { startService } from "./src/service.js";
import { formatDateLog } from "./src/utils.js";
import { readLanguageBundle } from "./src/languages.js";

const app = express();

// In front of everything, the static files included. There is no CORS layer any
// more: the Web UI is served from this same app under the same origin, so it
// never needed one, and the wildcard it used to send was an invitation to every
// page the user has open elsewhere. See src/security.js.
app.use(hostGuard());
// Behind the guard and in front of the static files, so a page is not served to
// somebody who cannot use it. Does nothing until a password is set.
app.use(requireAuth());
// Behind the password, so a request turned away there never has its body
// inflated or parsed: the Brotli decoder Node bundles could be made to run code
// by one (CVE-2026-111497). The public /api/auth/ routes are still parsed.
app.use(express.json());
// Every language table in one script, so a table added to public/i18n/ is
// picked up without touching a page. Before the static files, which have no
// file of that name. See src/languages.js.
app.get("/i18n/all.js", (req, res) => {
    res.type("application/javascript").set("Cache-Control", "no-cache").send(readLanguageBundle(path.resolve("public", "i18n")));
});
app.use(express.static("public", { maxAge: 0 }));

app.get("/", (req, res) => {
    res.sendFile(path.resolve("public", "index.html"));
});

registerRoutes(app, printers);

app.listen(PORT, "0.0.0.0", () => {
    console.log("Server", serverLogFilePath, `Version: ${version}`);
    console.log("Server", serverLogFilePath, "Setting up configuration...");

    // Append rather than replace, so a restart does not take the lines with it
    // that explain why it happened. Rotated when it has grown too large.
    rotateLogFile(serverLogFilePath).finally(() => {
        fs.appendFile(serverLogFilePath, `Log started at: ${formatDateLog(new Date())}\n`, err => {
            if (err) {
                process.stderr.write(`Failed to write the log file: ${err.message}\n`);
            }
        });
    });

    console.log("Server", serverLogFilePath, `Backend running on http://localhost:${PORT}`);

    // Printed on every start rather than once, so it is in the log of whichever
    // run somebody attaches to a bug report. Says nothing when the installation
    // is already configured through the Web UI.
    for (const line of [...legacyImageLogLines(legacyImageNotice()), ...upgradeLogLines(upgradeNotice()), ...deprecationLogLines(deprecatedConfig())]) {
        console.log("Server", serverLogFilePath, line);
    }

    startService();
});
