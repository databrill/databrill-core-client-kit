/**
 * `databrill-core-client-kit` — the database-access layer every Databrill client
 * repo would otherwise paste into its own `src/db/`.
 *
 * A consumer imports this file by path out of its submodule checkout — the
 * specifier is `extern/databrill-core-client-kit/src/mod.ts` — and then:
 *
 * ```ts
 * const program = Effect.gen(function* () {
 * 	const cache = yield* acquireTenantDbCache();
 * 	const { raw } = yield* tenantDb({ postgresUrl, schema: "w123456789" }, { cache });
 * 	return yield* raw.rows("SELECT sku, asin FROM amazon_listing_open");
 * }).pipe(Effect.scoped);
 * ```
 *
 * ## What is deliberately NOT re-exported here
 *
 * `./lib/workspaces.ts`. This module is the layer with zero knowledge of config
 * files: everything reachable from here takes explicit connection information,
 * and its dependencies are `@databrill/core-pg-kysely` and Effect.
 * `./lib/workspaces.ts` is the optional layer that resolves a wsid through
 * `databrill.config.json`; a consumer that wants that lookup imports that file
 * directly, and a consumer that does not, does not pay for it.
 * Re-exporting it from here would collapse that split in the one way nothing
 * would report — by import graph, silently, for every consumer.
 *
 * ## Bare specifiers a consumer's import map must carry
 *
 * A file imported by path out of `extern/<submodule>/src/` resolves against the
 * CONSUMER's import map, not this package's `deno.json`, so every bare specifier
 * under `src/` is a line the consumer has to carry:
 *
 * - `@databrill/core-pg-kysely` — database handles
 * - `effect` — Effect 3.21.2
 *
 * These imports use one Effect version and one Postgres driver. `@databrill/core-pg-kysely` opens the pool; `./lib/rawSql.ts`
 * runs the statements the typed surface cannot express, on that same pool,
 * through `$1` placeholders. The boundary scan in
 * `../tests/unit/boundaryScan.test.ts` derives allowed dependencies from the
 * import map and prevents an undeclared driver from entering `src/`.
 *
 * `@effect/cli`, `@effect/platform` and `@effect/platform-node` are CLI-only
 * dependencies declared in this package's `deno.json`. Nothing reachable from
 * this file imports them. A command run as
 * `deno run -A extern/…/src/cli/query.ts` uses this package's manifest. A consumer
 * importing a file under `./cli/` directly must declare those dependencies in
 * its own import map; the library exports below do not require them.
 *
 * @module
 */

export {
	assertExplicitSslMode,
	destroyAllTenantDbs,
	destroyTenantDb,
	globalTenantDbCache,
	moduleTenantDbCache,
	newTenantDbCache,
	tenantDb,
} from "./lib/tenantDb.ts";
export type { TenantDbCache, TenantDbOptions, TenantHandles, TenantSource } from "./lib/tenantDb.ts";

export { createRawReader, tbl } from "./lib/rawSql.ts";
export type { RawReader } from "./lib/rawSql.ts";

// The library halves of the two commands. `./cli/seedCatalog.ts` and
// `./cli/query.ts` are the commands; these are what they call, and what a
// consumer calls when it has a seed or a statement of its own and wants nothing
// to do with `brands/<slug>/catalog.json` or with argument parsing. Neither
// adds a bare specifier to the list above.
export {
	ASIN_PATTERN,
	ONTOLOGY_APPLIES_TO,
	parseCatalog,
	seedCatalog,
	SeedValidationError,
} from "./lib/seedCatalog.ts";
export type {
	AmazonAsinSeed,
	AmazonFamilySeed,
	Catalog,
	OntologyAppliesTo,
	OntologyCategorySeed,
	OntologyPropertySeed,
	OntologyVariantSeed,
	ParseCatalogOptions,
	SeedCatalogResult,
} from "./lib/seedCatalog.ts";

export { formatResult, formatRows, QUERY_FORMATS } from "./lib/query.ts";
export type { QueryFormat } from "./lib/query.ts";

import type { TenantDb } from "@databrill/core-pg-kysely";

/**
 * The read-only Kysely surface of a tenant database: every published table and
 * view, with mutations and DDL as compile-time errors.
 *
 * Import database types from the same entry point as the functions returning them.
 */
export type ReadDb = TenantDb["db"];

/** The writable Kysely surface: the tables customers are intended to write. */
export type WriteDb = TenantDb["write"];

export { acquireTenantDbCache } from "./lib/acquireTenantDbCache.ts";
