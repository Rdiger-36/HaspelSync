import { imageName } from "./config.js";
import { state } from "./state.js";

/**
 * The notice for a container that runs from the old image name.
 *
 * The project was renamed to HaspelSync and its image moved with it. GHCR
 * does not redirect an image name, so the old one is published as well for a
 * transition period, and an installation that still pulls it keeps updating
 * without noticing anything. This notice is what makes it notice: the old
 * name will stop receiving releases, and the switch is one line in a compose
 * file. An image cannot see the tag it was pulled by, so the name is baked
 * into each published image by its Dockerfile, see HASPELSYNC_IMAGE.
 *
 * Unlike the other notices, closing this one holds only until the next start
 * of the service: a restart and every new version show the dialog again for
 * as long as the container runs from the old name. The notice is not a one
 * time hint about something that already happened, it asks for a change that
 * has not been made yet, and a dialog dismissed once and forever is never
 * acted on. The log lines and the line under System on the settings page say
 * it regardless.
 *
 * This module must not import logger.js, for the reason settings.js gives.
 */

/** Identifies the notice on `/api/notices`. */
export const IMAGE_NOTICE = "legacy-image";

/** The name the image was published under before the rename. */
export const LEGACY_IMAGE = "bambulab-ams-spoolman-filamentstatus";

/**
 * The first version that is no longer published under the old name. Named in
 * every place the notice appears, because "a transition period" gave nobody a
 * reason to act before the updates had already stopped.
 */
export const LEGACY_IMAGE_STOPS_AT = "1.5.0";

/** Where every published image lives. */
const REGISTRY_PATH = "ghcr.io/rdiger-36";

/** The image to switch to. */
export const CURRENT_IMAGE = `${REGISTRY_PATH}/haspelsync`;

/** The page that says how the image is referenced. */
const INSTALL_DOCS_URL = "https://github.com/Rdiger-36/HaspelSync/blob/main/docs/installation.md";

/**
 * Describes whether this container runs from the deprecated image name.
 *
 * `image` is the full name the container was started from, null for a
 * checkout or a locally built image, which is also never deprecated.
 * `acknowledged` is whether the dialog was closed since this process started;
 * a value an older version left in settings.json is not read.
 *
 * @param {string|null} [name] - the baked in image name, `imageName` unless a test says otherwise
 * @returns {{active: boolean, acknowledged: boolean, image: string|null, replacement: string, stopsAt: string, docs: string}}
 */
export function legacyImageNotice(name = imageName) {
    return {
        active: name === LEGACY_IMAGE,
        acknowledged: state.legacyImageNoticeDismissed,
        image: name ? `${REGISTRY_PATH}/${name}` : null,
        replacement: CURRENT_IMAGE,
        stopsAt: LEGACY_IMAGE_STOPS_AT,
        docs: INSTALL_DOCS_URL,
    };
}

/**
 * Records that the dialog was closed, for the lifetime of this process only.
 *
 * Nothing is written: the dialog is meant to come back on the next start.
 */
export function dismissLegacyImageNotice() {
    state.legacyImageNoticeDismissed = true;
}

/**
 * The startup lines for `docker logs`, empty unless the container runs from
 * the old name. Printed on every start, dismissed or not: the log is what an
 * installation nobody opens the dashboard of still has.
 *
 * @param {object} [notice] - the result of `legacyImageNotice()`
 * @returns {string[]} one line per message
 */
export function legacyImageLogLines(notice = legacyImageNotice()) {
    if (!notice.active) return [];
    return [
        `[Deprecated] This container runs from the image ${notice.image}. The project is called HaspelSync now, and from version ${notice.stopsAt} on releases are published under the new name only.`,
        `[Deprecated] Switch the image in docker run or docker-compose to ${notice.replacement}; the configuration and the volumes stay as they are. See ${notice.docs}`,
    ];
}
