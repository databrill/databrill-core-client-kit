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
 * Every invocation names its workspace with `--wsid`. `databrill.config.json`
 * maps that explicit id to a connection string; the number of entries in it
 * never changes the request contract.
 */

import { Effect, Either } from "effect";
import { tenantDb, type TenantDbOptions, type TenantHandles } from "../lib/tenantDb.ts";
import { getWorkspace, type WorkspaceConfigOptions } from "../lib/workspaces.ts";

/**
 * The explicit wsid to act on. Missing and blank values are always refused.
 */
export function resolveWsid(explicit: string | undefined): Either.Either<string, Error> {
	const wsid = explicit?.trim() ?? "";
	if (wsid !== "") {
		return Either.right(wsid);
	}
	return Either.left(new Error("Pass --wsid <wsid>; every workspace operation must name its target explicitly."));
}

/** What a command needs to act on one workspace. */
export interface WorkspaceTarget {
	readonly wsid: string;
	readonly schema: string;
	readonly handles: TenantHandles;
}

/**
 * Resolve a wsid through `databrill.config.json` and open its database.
 *
 * This is the two-line join `../lib/workspaces.ts` deliberately does not provide as
 * a `tenantDbForWsid()` — done here, in the layer that already depends on both
 * halves, rather than in the module whose whole dependency footprint is
 * `node:` builtins.
 */
export function openWorkspace(
	explicit: string | undefined,
	opts: WorkspaceConfigOptions = {},
	dbOptions: TenantDbOptions = {},
): Effect.Effect<WorkspaceTarget, Error> {
	return Effect.gen(function* () {
		const wsid = yield* resolveWsid(explicit);
		const { database } = yield* getWorkspace(wsid, opts);
		const handles = yield* tenantDb({ postgresUrl: database.postgresUrl, schema: database.schema }, dbOptions);
		return { wsid, schema: database.schema, handles };
	});
}
