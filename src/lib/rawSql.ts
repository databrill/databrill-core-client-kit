/**
 * Raw SQL over the tenant pool, for the statements the typed Kysely surface
 * cannot express: a customer's own `SELECT`, an `EXPLAIN`, a `count(*)` over a
 * view the generated types do not carry.
 *
 * It runs on {@link TenantPool.query} — the narrow pool surface
 * `@databrill/core-pg-kysely` publishes — and not on a second Kysely instance
 * built over the same pool. A second Kysely is what the older client copies did,
 * and it is wrong twice: it does not compile against `@databrill/core-pg-kysely`
 * from 0.1.5 onwards (the package stopped publishing `pg`'s `Pool` type, so
 * there is nothing to hand a `PostgresDialect`), and even when it did compile it
 * built a whole query-builder stack whose only use was `sql.raw`.
 *
 * Reads only. Nothing here writes, and nothing here interpolates a value into
 * the statement text: values go through `$1`-style placeholders, which is what
 * the driver's parameter binding is for. The one thing this module does put into
 * statement text is an identifier, through {@link tbl}, which validates it.
 */

import type { TenantPool, TenantPoolResult } from "@databrill/core-pg-kysely";

/**
 * A plain Postgres identifier: what can appear inside double quotes without
 * needing an escape. Deliberately the same shape `createDb()` accepts for its
 * `schema` option, so a schema that opens a connection is a schema this can
 * qualify.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function assertPlainIdentifier(value: string, what: string): void {
	if (!PLAIN_IDENTIFIER.test(value)) {
		throw new Error(
			`Invalid ${what} name ${JSON.stringify(value)}: expected a plain Postgres identifier ` +
				`such as "public" or "w123456789".`,
		);
	}
}

/**
 * A schema-qualified, double-quoted table reference for use in raw statement
 * text: `tbl("w123456789", "amazon_listing_open")` gives
 * `"w123456789"."amazon_listing_open"`.
 *
 * Not needed for the connection's OWN schema — a tenant login role carries
 * `ALTER ROLE ... SET search_path`, so an unqualified name already resolves
 * there (see `tenantDb.ts`). This is for a statement that must name a DIFFERENT
 * schema, or one run on a connection whose role has no default. Both parts are
 * validated rather than escaped: an identifier that needs an escape is a mistake
 * here, not a case to support.
 */
export function tbl(schema: string, name: string): string {
	assertPlainIdentifier(schema, "schema");
	assertPlainIdentifier(name, "table");
	return `"${schema}"."${name}"`;
}

/** Read-only raw access to one tenant database. */
export interface RawReader {
	/** Every row, as plain objects keyed by column name. */
	rows(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;

	/** The first row, or `null` when the statement returned none. */
	first(text: string, values?: readonly unknown[]): Promise<Record<string, unknown> | null>;

	/** The whole driver result, for callers that need `command` or `rowCount`. */
	result(text: string, values?: readonly unknown[]): Promise<TenantPoolResult>;
}

/**
 * A {@link RawReader} over an already-connected tenant pool.
 *
 * The pool is borrowed, never owned: teardown belongs to whoever created it
 * (`TenantDb.destroy`, or `destroyAllTenantDbs()` in `tenantDb.ts`), which is
 * also why {@link TenantPool} publishes no `end()`.
 */
export function createRawReader(pool: TenantPool): RawReader {
	return {
		async rows(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
			const result = await pool.query(text, values);
			return result.rows;
		},

		async first(text: string, values?: readonly unknown[]): Promise<Record<string, unknown> | null> {
			const result = await pool.query(text, values);
			return result.rows[0] ?? null;
		},

		result(text: string, values?: readonly unknown[]): Promise<TenantPoolResult> {
			return pool.query(text, values);
		},
	};
}
