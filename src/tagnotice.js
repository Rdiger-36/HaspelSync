import { getAcknowledgedNotices } from "./settings.js";
import { state } from "./state.js";

/**
 * The notice for spools that are still linked through `extra.tag` alone.
 *
 * Spoolman 0.27.0 holds the tag of a spool natively, and every spool this
 * service creates or merges from then on carries it that way. The ones linked
 * before do not, and nothing forces them to: `extra.tag` is still read. The
 * dashboard asks once whether they should be migrated, and the settings page
 * keeps the button for whoever said no, or for the spools that came in later
 * through an older instance.
 *
 * The count comes from `state.tagMigrationPending`, which the Spoolman
 * bootstrap and every migration run fill, see spoolman.js. Asking Spoolman for
 * every spool whenever a dashboard opens would be the alternative, for a number
 * that changes when a migration runs and at no other time.
 *
 * This module must not import logger.js, for the reason settings.js gives.
 */

/** Identifies the notice on `/api/notices`. */
export const TAG_NOTICE = "native-tags";

/**
 * Describes whether there is something to migrate and whether that was said.
 *
 * `active` needs a Spoolman that knows native tags and at least one spool that
 * does not carry its tag that way yet. Dismissed once, it stays dismissed: the
 * settings page says the same thing for as long as it is true.
 *
 * @returns {{active: boolean, acknowledged: boolean, pending: number, version: string|null}}
 */
export function tagMigrationNotice() {
    const pending = state.tagMigrationPending ?? 0;

    return {
        active: state.spoolmanNativeTags === true && pending > 0,
        acknowledged: !!getAcknowledgedNotices()[TAG_NOTICE],
        pending,
        version: state.spoolmanVersion,
    };
}
