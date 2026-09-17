/**
 * Opening a tenant database, and reusing the pool once it is open.
 *
 * This is the config-file-independent core of the kit: it takes explicit
 * connection information — a Postgres URL and a schema — and knows nothing about
 * `databrill.config.json`, wsids or any other config-file format. The layer
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
import { Cause, Effect, Either, Exit } from "effect";
import { tryOrOperationError } from "./effects.ts";
import { makeCompositeKey } from "./makeCompositeKey.ts";
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
 * Reusable handles indexed by connection URL and schema.
 * A plain Map supports both isolated operation scopes and caches retained across HMR.
 * Use acquireTenantDbCache for scoped ownership; module/global caches require explicit cleanup.
 */
export type TenantDbCache = Map<string, TenantHandles>;

/** Options common to every entry point that opens a tenant database. */
export interface TenantDbOptions {
	/**
	 * Where to look for an already-open handle, and where to record a new one.
	 * Defaults to {@link moduleTenantDbCache}.
	 */
	readonly cache?: TenantDbCache;
}

/** The default cache belongs to this module instance; callers manage its cleanup. */
const moduleCache: TenantDbCache = new Map<string, TenantHandles>();

/**
 * The default cache — one `Map` per module instance.
 *
 * Correct whenever the module is instantiated once: a CLI, a long-running
 * server started from a built bundle, a test run. Under a dev server that
 * re-executes server modules this map is replaced on every reload and the pools
 * it held are never destroyed; use {@link globalTenantDbCache} there.
 */
export function moduleTenantDbCache(): TenantDbCache {
	return moduleCache;
}

/** A fresh, unshared cache. Passing a new one per call disables reuse entirely. */
export function newTenantDbCache(): TenantDbCache {
	return new Map<string, TenantHandles>();
}

/**
 * A cache anchored on `globalThis` under a `Symbol.for` key, so it survives a
 * module being re-executed — which is what a Vite/HMR dev server does to every
 * server module on every edit.
 *
 * `Symbol.for` and not a string property: the registry is shared across module
 * instances by design, and a symbol key cannot collide with a consumer's own
 * global.
 */
export function globalTenantDbCache(name = "databrill.client-kit.tenantDb"): Either.Either<TenantDbCache, Error> {
	return tryOrOperationError(() => {
		const key = Symbol.for(name);
		const existing: unknown = Reflect.get(globalThis, key);
		if (existing instanceof Map) {
			return existing;
		}
		const created = new Map<string, TenantHandles>();
		Reflect.set(globalThis, key, created);
		return created;
	});
}

/**
 * Local hosts are exempt from the explicit TLS-mode requirement.
 * A Unix-socket connection string has no host and uses the empty string.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Fails unless `postgresUrl` says what it wants from TLS, for any host that is
 * not this machine. See this module's docblock for the whole argument.
 *
 * Exported because a consumer that builds its own `createDb()` call — rather
 * than going through {@link tenantDb} — needs the same check, and because a
 * check nobody can reach from outside is a check that gets reimplemented.
 */
export function assertExplicitSslMode(postgresUrl: string): Either.Either<void, Error> {
	return Either.gen(function* () {
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
		return yield* Either.left(
			new Error(
				`The connection string for ${host} has no sslmode. Add sslmode=require for a TLS connection ` +
					`(what a Supabase pooler URL carries), or sslmode=disable to connect in plaintext on purpose. ` +
					`It is not defaulted here: without it the driver connects in plaintext, and a database ` +
					`reached across the internet in plaintext is not something to arrive at by omission.`,
			),
		);
	});
}

/**
 * The memoisation key for a source.
 *
 * Component escaping keeps distinct URL/schema pairs distinct, including tabs.
 */
function sourceKey(source: TenantSource): string {
	return makeCompositeKey(source.postgresUrl, source.schema);
}

/**
 * Open (or reuse) a connection to one tenant database.
 *
 * ```ts
 * // Inside Effect.gen:
 * const { db, raw, destroy } = yield* tenantDb({ postgresUrl, schema: "w123456789" });
 * const rows = yield* raw.rows("SELECT * FROM amazon_listing_open");
 * yield* destroy();
 * ```
 *
 * `db` is read-only over every published table and view, `write` covers the
 * tables customers are meant to write, `raw` runs SQL the typed surface cannot
 * express, and all three share one pool.
 */
export function tenantDb(source: TenantSource, options: TenantDbOptions = {}): Effect.Effect<TenantHandles, Error> {
	const cache = options.cache ?? moduleCache;
	return withTenantDbCacheLock(
		cache,
		Effect.gen(function* () {
			const key = sourceKey(source);
			const existing = yield* tryOrOperationError(() => cache.get(key));
			if (existing !== undefined) {
				return existing;
			}

			yield* assertExplicitSslMode(source.postgresUrl);

			// `createDb()` interprets the connection string's TLS options. The cache
			// lock keeps acquisition from returning a handle while teardown closes it.
			const handle = yield* createDb({ connectionString: source.postgresUrl, schema: source.schema });
			const handles: TenantHandles = { ...handle, raw: createRawReader(handle.pool) };
			const recorded = yield* Effect.exit(
				tryOrOperationError(() => cache.set(key, handles)),
			);
			if (Exit.isFailure(recorded)) {
				const closed = yield* Effect.exit(handle.destroy());
				return yield* Effect.failCause(
					Exit.isFailure(closed) ? Cause.sequential(recorded.cause, closed.cause) : recorded.cause,
				);
			}
			return handles;
		}),
	);
}

// Weak keys keep per-cache coordination from retaining a consumer's discarded cache.
const cacheLocks = new WeakMap<TenantDbCache, Effect.Semaphore>();

function withTenantDbCacheLock<A>(cache: TenantDbCache, work: Effect.Effect<A, Error>): Effect.Effect<A, Error> {
	return Effect.suspend(() => {
		let lock = cacheLocks.get(cache);
		if (lock === undefined) {
			lock = Effect.unsafeMakeSemaphore(1);
			cacheLocks.set(cache, lock);
		}
		return lock.withPermits(1)(Effect.uninterruptible(work));
	});
}

const pendingCleanup = new WeakMap<TenantDbCache, Map<string, Effect.Effect<void, Error>>>();

/** Concurrent callers observe one attempt; the next call after failure can retry. */
function shareCleanup(
	cache: TenantDbCache,
	key: string,
	work: Effect.Effect<void, Error>,
): Effect.Effect<void, Error> {
	return Effect.uninterruptible(Effect.gen(function* () {
		let pending = pendingCleanup.get(cache);
		if (pending === undefined) {
			pending = new Map();
			pendingCleanup.set(cache, pending);
		}
		const existing = pending.get(key);
		if (existing !== undefined) {
			return yield* existing;
		}

		const attempt = yield* Effect.cached(work);
		pending.set(key, attempt);
		return yield* attempt.pipe(Effect.ensuring(Effect.sync(() => pending.delete(key))));
	}));
}

/**
 * Destroy and forget the handle for one source, if it is open.
 *
 * Use this to close one workspace's handle while the rest of the cache stays
 * open: a long-running process that is finished with one workspace, or a caller
 * that has learned its connection string is wrong. `destroyAllTenantDbs` is the
 * shutdown path. If closing fails, the handle stays cached and the error is
 * returned, so the call can be retried.
 */
export function destroyTenantDb(
	source: TenantSource,
	cache: TenantDbCache = moduleCache,
): Effect.Effect<void, Error> {
	return shareCleanup(
		cache,
		makeCompositeKey("source", sourceKey(source)),
		withTenantDbCacheLock(
			cache,
			Effect.gen(function* () {
				const key = sourceKey(source);
				const handles = yield* tryOrOperationError(() => cache.get(key));
				if (handles !== undefined) {
					yield* handles.destroy();
					yield* tryOrOperationError(() => cache.delete(key));
				}
			}),
		),
	);
}

/**
 * Destroy every handle in `cache` and empty it.
 *
 * A CLI calls this before it exits; anything longer-lived calls it on shutdown.
 * Handles opened into a different cache are not touched — which is the whole
 * reason the cache is a parameter.
 */
export function destroyAllTenantDbs(cache: TenantDbCache = moduleCache): Effect.Effect<void, Error> {
	return shareCleanup(
		cache,
		"all",
		withTenantDbCacheLock(
			cache,
			Effect.gen(function* () {
				const open = yield* tryOrOperationError(() => [...cache.entries()]);
				let failures: Cause.Cause<Error> = Cause.empty;

				// Attempt every pool. Delete only successfully closed handles, so failed
				// teardown can be retried without losing the resource that needs closing.
				for (const [key, handles] of open) {
					const closed = yield* Effect.exit(Effect.gen(function* () {
						yield* handles.destroy();
						yield* tryOrOperationError(() => cache.delete(key));
					}));
					if (Exit.isFailure(closed)) {
						failures = Cause.sequential(failures, closed.cause);
					}
				}
				if (!Cause.isEmpty(failures)) {
					return yield* Effect.failCause(failures);
				}
			}),
		),
	);
}
