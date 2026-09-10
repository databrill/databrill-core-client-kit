/**
 * Opening a tenant database, and reusing the pool once it is open.
 *
 * This is the dependency-free core of the kit: it takes explicit connection
 * information — a Postgres URL and a schema — and knows nothing about
 * `databrill.config.json`, wsids or any other registry convention. The layer
 * that resolves a wsid to a `{ postgresUrl, schema }` is `./workspaces.ts`, and
 * it is optional on purpose: a consumer that already knows its connection string
 * should not have to adopt a config-file format to open a connection.
 *
 * ## This sets no `search_path`, because the ROLE already carries one
 *
 * Nothing here sends a `search_path`, and that is not the same as there being
 * none. Two of the three ways to get one are genuinely unsafe under a
 * transaction-mode pooler: a connection-startup parameter is not forwarded by
 * every pooler, and a per-session `SET` does not survive a pool that hands each
 * transaction to whichever backend is free. Either failure is silent — the same
 * table names resolve against `public` and return the wrong rows, or none.
 *
 * The third way is the one Databrill provisions.
 * `services/libs/database/src/tenantRolesSql.ts` issues
 * `ALTER ROLE w{wsid}_{ro,rw,mcp_ro,mcp_rw} SET search_path = "w{wsid}"` for
 * every tenant login role. A role-level setting is applied by the SERVER at
 * session start, so every backend a pooler opens as that role has it. Binding the
 * schema to the role is what makes transaction-mode pooling safe.
 * `services/apps/mcp` runs entirely on it and passes no `searchPath`.
 *
 * So a caller connected with its own workspace's credentials is in the right
 * schema before this package does anything, and an unqualified `FROM
 * amazon_listing_open` is correct. `createDb()`'s Kysely `withSchema()` names
 * the schema in generated SQL on top of that, which is redundant and harmless;
 * `tbl(schema, name)` in `./rawSql.ts` is there for a statement that must name a
 * schema OTHER than the connection's own.
 *
 * If a query does land in `public`, the role is missing its `ALTER ROLE`. That is
 * a provisioning defect, and it surfaces on its own: the role holds no grant on
 * `public`, so the statement fails rather than reading the wrong rows. It is not
 * a query transformation problem; correct the role's provisioning.
 *
 * ## TLS requirements
 *
 * {@link tenantDb} requires an explicit `sslmode` for remote hosts and refuses
 * the connection before opening a pool when it is absent. Local hosts and Unix
 * sockets are exempt. Use `sslmode=require` for encryption or `sslmode=disable`
 * for plaintext. The connection string is the only place to select the mode.
 *
 * `createDb()` interprets the TLS options. `sslmode=verify-ca` requires an
 * explicit `ssl: { ca }` option, which this package's connection interface does
 * not accept; callers needing that option must use `createDb()` directly.
 * `sslmode=verify-full` verifies the certificate using the system trust store.
 */

import { createDb, type TenantDb } from "@databrill/core-pg-kysely";
import { createRawReader, type RawReader } from "./rawSql.ts";

/** Where a tenant database is and which schema holds its tables. */
export interface TenantSource {
	readonly postgresUrl: string;
	readonly schema: string;
}

/** A connected tenant database, plus the raw-SQL reader over the same pool. */
export interface TenantHandles extends TenantDb {
	readonly raw: RawReader;
}

/**
 * Where {@link tenantDb} keeps the handles it has already opened.
 *
 * Memoisation is a PARAMETER here, not a constant, because the right strategy is
 * a property of the consumer and this package does not know which consumer it is
 * in. Both real cases exist today: a CLI runs once and exits, so a plain
 * module-level map (or none at all) is right; a Vite dev server re-executes
 * server modules on every HMR update, so a module-level map is a fresh map every
 * edit and leaks a pool per keystroke — that one needs a store anchored on
 * `globalThis`. Picking either one inside the package makes the other consumer
 * wrong, so the package picks neither.
 *
 * A plain `Map<string, TenantHandles>` satisfies this interface structurally,
 * which is the point: "give me my own store" needs no factory from here.
 */
export interface TenantDbStore {
	get(key: string): TenantHandles | undefined;
	set(key: string, handles: TenantHandles): void;
	delete(key: string): void;
	values(): Iterable<TenantHandles>;
	clear(): void;
}

/** Options common to every entry point that opens a tenant database. */
export interface TenantDbOptions {
	/**
	 * Where to look for an already-open handle, and where to record a new one.
	 * Defaults to {@link moduleTenantDbStore}.
	 */
	readonly store?: TenantDbStore;
}

/** The process-wide default store: right for a CLI, wrong under HMR. */
const moduleStore: TenantDbStore = new Map<string, TenantHandles>();

/**
 * The default store — one `Map` per module instance.
 *
 * Correct whenever the module is instantiated once: a CLI, a long-running
 * server started from a built bundle, a test run. Under a dev server that
 * re-executes server modules this map is replaced on every reload and the pools
 * it held are never destroyed; use {@link globalTenantDbStore} there.
 */
export function moduleTenantDbStore(): TenantDbStore {
	return moduleStore;
}

/** A fresh, unshared store. Passing a new one per call disables reuse entirely. */
export function newTenantDbStore(): TenantDbStore {
	return new Map<string, TenantHandles>();
}

/**
 * A store anchored on `globalThis` under a `Symbol.for` key, so it survives a
 * module being re-executed — which is what a Vite/HMR dev server does to every
 * server module on every edit.
 *
 * `Symbol.for` and not a string property: the registry is shared across module
 * instances by design, and a symbol key cannot collide with a consumer's own
 * global.
 */
export function globalTenantDbStore(name = "databrill.client-kit.tenantDb"): TenantDbStore {
	const key = Symbol.for(name);
	const existing: unknown = Reflect.get(globalThis, key);
	if (existing instanceof Map) {
		return existing;
	}
	const created = new Map<string, TenantHandles>();
	Reflect.set(globalThis, key, created);
	return created;
}

/**
 * Local hosts are exempt from the explicit TLS-mode requirement.
 * A Unix-socket connection string has no host and uses the empty string.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Throws unless `postgresUrl` says what it wants from TLS, for any host that is
 * not this machine. See this module's docblock for the whole argument.
 *
 * Exported because a consumer that builds its own `createDb()` call — rather
 * than going through {@link tenantDb} — needs the same check, and because a
 * check nobody can reach from outside is a check that gets reimplemented.
 */
export function assertExplicitSslMode(postgresUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(postgresUrl);
	} catch {
		// Not a URL at all: a libpq key/value DSN, or a bare socket path. Neither
		// is something this can read, and `createDb()` passes both through
		// untouched, so there is nothing here to be sure about either way.
		return;
	}
	const host = parsed.hostname.toLowerCase();
	if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) {
		return;
	}
	if (parsed.searchParams.has("sslmode")) {
		return;
	}
	throw new Error(
		`The connection string for ${host} has no sslmode. Add sslmode=require for a TLS connection ` +
			`(what a Supabase pooler URL carries), or sslmode=disable to connect in plaintext on purpose. ` +
			`It is not defaulted here: without it the driver connects in plaintext, and a database ` +
			`reached across the internet in plaintext is not something to arrive at by omission.`,
	);
}

/**
 * The memoisation key for a source.
 *
 * `JSON.stringify` of the tuple rather than a hand-rolled join on a separator:
 * two different `{ postgresUrl, schema }` pairs must never produce one key, and
 * a separator only guarantees that if every component is escaped — which is
 * exactly what JSON encoding already does, in a form that is also readable in a
 * debugger.
 */
function sourceKey(source: TenantSource): string {
	return JSON.stringify([source.postgresUrl, source.schema]);
}

/**
 * Open (or reuse) a connection to one tenant database.
 *
 * ```ts
 * const { db, raw, destroy } = tenantDb({ postgresUrl, schema: "w123456789" });
 * const rows = await db.selectFrom("amazon_listing_open").selectAll().execute();
 * await destroy();
 * ```
 *
 * `db` is read-only over every published table and view, `write` covers the
 * tables customers are meant to write, `raw` runs SQL the typed surface cannot
 * express, and all three share one pool.
 */
export function tenantDb(source: TenantSource, options: TenantDbOptions = {}): TenantHandles {
	const store = options.store ?? moduleStore;
	const key = sourceKey(source);
	const existing = store.get(key);
	if (existing !== undefined) {
		return existing;
	}

	assertExplicitSslMode(source.postgresUrl);

	// `createDb()` interprets the connection string's TLS options.
	const handle = createDb({ connectionString: source.postgresUrl, schema: source.schema });
	const handles: TenantHandles = { ...handle, raw: createRawReader(handle.pool) };
	store.set(key, handles);
	return handles;
}

/**
 * Destroy and forget the handle for one source, if it is open.
 *
 * Registry-opened callers use this when the role-binding assertion fails: a
 * rejected credential must not leave a dead or unverified handle cached for a
 * later request.
 */
export async function destroyTenantDb(
	source: TenantSource,
	store: TenantDbStore = moduleStore,
): Promise<void> {
	const key = sourceKey(source);
	const handles = store.get(key);
	store.delete(key);
	if (handles !== undefined) {
		await handles.destroy();
	}
}

/**
 * Destroy every handle in `store` and empty it.
 *
 * A CLI calls this before it exits; anything longer-lived calls it on shutdown.
 * Handles opened into a different store are not touched — which is the whole
 * reason the store is a parameter.
 */
export async function destroyAllTenantDbs(store: TenantDbStore = moduleStore): Promise<void> {
	const open = [...store.values()];
	store.clear();
	// Sequentially, not `Promise.all`: teardown of a pool that is already failing
	// should not lose its error behind another pool's, and there are single
	// digits of these. Every handle is still destroyed when one throws — the
	// store was emptied first, so a pool skipped here is one nothing can reach to
	// destroy afterwards, and a CLI holding it open does not exit.
	const failures: unknown[] = [];
	for (const handles of open) {
		try {
			await handles.destroy();
		} catch (cause) {
			failures.push(cause);
		}
	}
	if (failures.length === 1) {
		throw failures[0];
	}
	if (failures.length > 1) {
		throw new AggregateError(failures, `${failures.length} tenant pools failed to close`);
	}
}
