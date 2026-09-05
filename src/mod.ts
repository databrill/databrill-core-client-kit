/**
 * `databrill-core-client-kit` — the database-access layer every Databrill client
 * repo would otherwise paste into its own `src/db/`.
 *
 * A consumer imports this file by path out of its submodule checkout — the
 * specifier is `extern/databrill-core-client-kit/src/mod.ts` — and then:
 *
 * ```ts
 * const { db, raw } = tenantDb({ postgresUrl, schema: "w123456789" });
 * const listings = await db.selectFrom("amazon_listing_open").select(["sku", "asin"]).execute();
 * await destroyAllTenantDbs();
 * ```
 *
 * ## What is deliberately NOT re-exported here
 *
 * `./lib/workspaces.ts`. This module is the layer with zero knowledge of config
 * files: everything reachable from here takes explicit connection information,
 * and its whole dependency footprint is `@databrill/core-pg-kysely`.
 * `./lib/workspaces.ts` is the optional layer that resolves a wsid through
 * `databrill.config.json`; a consumer that wants the registry convention imports
 * that file directly, and a consumer that does not, does not pay for it.
 * Re-exporting it from here would collapse that split in the one way nothing
 * would report — by import graph, silently, for every consumer.
 *
 * ## Bare specifiers a consumer's import map must carry
 *
 * A file imported by path out of `extern/<submodule>/src/` resolves against the
 * CONSUMER's import map, not this package's `deno.json`, so every bare specifier
 * under `src/` is a line the consumer has to carry:
 *
 * - `@databrill/core-pg-kysely` — everything here
 *
 * That is the whole list, and it is one line because this package uses ONE
 * Postgres driver. `@databrill/core-pg-kysely` opens the pool; `./lib/rawSql.ts`
 * runs the statements the typed surface cannot express, on that same pool,
 * through `$1` placeholders. There was a second driver here — a `postgres.js`
 * handle in `./tenantSql.ts`, extracted verbatim from the client repos — and it
 * is gone: nothing called it, everything it was reached for is already served by
 * `./lib/rawSql.ts`, and a published package that makes every consumer resolve two
 * Postgres drivers to use one of them is not a package to ship. Removing the
 * `postgres` entry from this package's `deno.json` is what enforces it: the
 * boundary scan in `../tests/unit/boundaryScan.test.ts` derives the allowed bare
 * specifiers from that import map, so a new import of a second driver under
 * `src/` fails the unit suite rather than silently lengthening this list.
 *
 * `@std/cli` is declared in this package's `deno.json` but is NOT on that list:
 * nothing reachable from this file imports it. It is used only by the two
 * commands under `./cli/`, and a command is run as
 * `deno run -A extern/…/src/cli/query.ts`, where the entry point is inside this
 * package — so Deno discovers THIS package's `deno.json` and resolves against
 * it. A consumer pays for `@std/cli` only if it imports a file under `./cli/`
 * from its own code, which is what the library halves re-exported below exist to
 * make unnecessary.
 *
 * @module
 */

export {
	assertExplicitSslMode,
	destroyAllTenantDbs,
	destroyTenantDb,
	globalTenantDbStore,
	moduleTenantDbStore,
	newTenantDbStore,
	tenantDb,
} from "./lib/tenantDb.ts";
export type { TenantDbOptions, TenantDbStore, TenantHandles, TenantSource } from "./lib/tenantDb.ts";

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

export { formatResult, formatRows, QUERY_FORMATS, runQuery, runStatement } from "./lib/query.ts";
export type { QueryFormat } from "./lib/query.ts";

import type { TenantDb } from "@databrill/core-pg-kysely";

/**
 * The read-only Kysely surface of a tenant database: every published table and
 * view, with mutations and DDL as compile-time errors.
 *
 * These two aliases were a separate `types.ts` in the client repos. They are
 * here instead because two type aliases are not a module, and because the names
 * a caller writes down in its own signatures should come from the same import as
 * the function that returns them.
 */
export type ReadDb = TenantDb["db"];

/** The writable Kysely surface: the tables customers are intended to write. */
export type WriteDb = TenantDb["write"];
