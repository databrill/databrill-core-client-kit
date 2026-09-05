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
 * Every invocation names its workspace with `--wsid`. The registry is a
 * server-side map from that explicit id to a credential; the number of entries
 * in it never changes the request contract.
 */

import { getWorkspace, type WorkspaceConfigOptions } from "../lib/workspaces.ts";
import { tenantDb, type TenantHandles } from "../lib/tenantDb.ts";

/**
 * The explicit wsid to act on. Missing and blank values are always refused.
 */
export function resolveWsid(explicit: string | undefined): string {
	const wsid = explicit?.trim() ?? "";
	if (wsid !== "") {
		return wsid;
	}
	throw new Error("Pass --wsid <wsid>; every workspace operation must name its target explicitly.");
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
export function openWorkspace(
	explicit: string | undefined,
	opts: WorkspaceConfigOptions = {},
): WorkspaceTarget {
	const wsid = resolveWsid(explicit);
	const { database } = getWorkspace(wsid, opts);
	const handles = tenantDb({ postgresUrl: database.postgresUrl, schema: database.schema });
	return { wsid, schema: database.schema, handles };
}
