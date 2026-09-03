/**
 * Turning a `--wsid` flag into an open tenant database, shared by both commands
 * under this directory.
 *
 * ## There is no default wsid, and there is no `DEFAULT_WSID` to import
 *
 * The client repos this code comes from re-exported a `DEFAULT_WSID` constant
 * from their own `src/shared/workspace.ts` and used it as the `--wsid` default.
 * That constant is one repo's identity, not a property of the convention, so it
 * stayed behind: `../lib/workspaces.ts` has no default wsid at all, and inventing
 * one here would put a specific customer's workspace id inside a package every
 * customer runs.
 *
 * What replaces it is a resolution with nothing to be wrong about:
 * {@link resolveWsid} takes `--wsid` when it is given, and otherwise reads the
 * SOLE workspace the consumer's own `databrill.config.json` declares. With one
 * configured workspace — which is what a client repo is today — the flag is
 * optional and the command is as short as it was before. With none or with
 * several, there is no answer to guess and it throws, naming the configured
 * wsids so the fix is in the message. A statement run against the wrong
 * workspace is the failure worth designing against here, and the only case
 * where a default cannot cause it is the case where there is exactly one.
 */

import { getWorkspace, listWsids, type WorkspaceConfigOptions } from "../lib/workspaces.ts";
import { tenantDb, type TenantHandles } from "../lib/tenantDb.ts";

/**
 * The wsid to act on: the explicit one, or the sole configured one.
 *
 * Throws naming the configured wsids when `explicit` is absent and the
 * configuration declares anything other than exactly one workspace.
 */
export function resolveWsid(explicit: string | undefined, opts: WorkspaceConfigOptions = {}): string {
	if (explicit !== undefined && explicit !== "") {
		return explicit;
	}
	const configured = listWsids(opts);
	const only = configured[0];
	if (configured.length === 1 && only !== undefined) {
		return only;
	}
	throw new Error(
		`No --wsid given, and the loaded databrill.config.json declares ${configured.length} workspaces, ` +
			`so there is no sole one to mean: ${configured.length === 0 ? "(none)" : configured.join(", ")}. ` +
			`Pass --wsid.`,
	);
}

/** What a command needs to act on one workspace. */
export interface WorkspaceTarget {
	readonly wsid: string;
	readonly schema: string;
	readonly handles: TenantHandles;
}

/**
 * Resolve a wsid through the registry and open its database.
 *
 * This is the two-line join `../lib/workspaces.ts` deliberately does not provide as
 * a `tenantDbForWsid()` — done here, in the layer that already depends on both
 * halves, rather than in the module whose whole dependency footprint is
 * `node:` builtins.
 */
export function openWorkspace(explicit: string | undefined, opts: WorkspaceConfigOptions = {}): WorkspaceTarget {
	const wsid = resolveWsid(explicit, opts);
	const { database } = getWorkspace(wsid, opts);
	const handles = tenantDb({ postgresUrl: database.postgresUrl, schema: database.schema });
	return { wsid, schema: database.schema, handles };
}
