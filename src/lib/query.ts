/**
 * Formatting rows and complete driver results from an ad-hoc SQL statement.
 *
 * These formatters take query results and a selected output format. They never
 * read a file, inspect `Deno.args`, or print. `../cli/query.ts` handles those
 * command concerns and executes statements through `RawReader` in `./rawSql.ts`.
 */

import type { TenantPoolResult } from "@databrill/core-pg-kysely";

/** How {@link formatRows} renders a result. */
export type QueryFormat = "table" | "json";

/** The two values {@link QueryFormat} may take, for a CLI validating a flag. */
export const QUERY_FORMATS: readonly QueryFormat[] = ["table", "json"];

/** A value as one display cell: `null` shown as such, everything else via JSON or its own text. */
function cell(value: unknown): string {
	if (value === null || value === undefined) {
		return "NULL";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	// Temporal values, and anything else with a meaningful `toString`, read far
	// better than their JSON encoding — `2026-09-03T00:00:00Z` rather than a
	// structural dump.
	if (typeof value === "object" && Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) {
		return String(value);
	}
	return JSON.stringify(value);
}

/**
 * Render rows for a terminal.
 *
 * `json` is `JSON.stringify` over the rows as they came back, for piping into
 * `jq`. `table` is a fixed-width column layout with the column names taken from
 * the first row — which is what the driver reports, so a statement returning no
 * rows has no columns to name and says so.
 */
export function formatRows(rows: readonly Record<string, unknown>[], format: QueryFormat): string {
	if (format === "json") {
		return JSON.stringify(rows, null, 2);
	}
	const first = rows[0];
	if (first === undefined) {
		return "(0 rows)";
	}
	const columns = Object.keys(first);
	const body = rows.map((row: Record<string, unknown>): readonly string[] =>
		columns.map((column: string): string => cell(row[column]))
	);
	// Widened by a loop rather than `Math.max(...body.map(…))`: a spread passes one
	// ARGUMENT per row, and a result of a few hundred thousand rows — which is a
	// plausible `--format table` run — overflows the stack instead of printing.
	const widths = columns.map((column: string, index: number): number => {
		let width = column.length;
		for (const cells of body) {
			width = Math.max(width, cells[index]?.length ?? 0);
		}
		return width;
	});
	const line = (cells: readonly string[]): string =>
		cells.map((text: string, index: number): string => text.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
	return [
		line(columns),
		widths.map((width: number): string => "-".repeat(width)).join("  "),
		...body.map(line),
		`(${rows.length} ${rows.length === 1 ? "row" : "rows"})`,
	].join("\n");
}

/**
 * Render a whole driver result for a terminal: the rows when there are rows to
 * show, and the driver's own command tag when there are not.
 *
 * `formatRows([], "table")` says `(0 rows)`, which is true of a `SELECT` that
 * matched nothing and FALSE of an `UPDATE` that changed five thousand — a write
 * with no `RETURNING` returns no rows whatever it did. Reporting `(0 rows)` for
 * it tells a reader the opposite of what happened, so a non-`SELECT` that
 * returned nothing is reported as `command rowCount` instead: `UPDATE 5000`,
 * `DELETE 3`, `CREATE INDEX 0`. That is `psql`'s own spelling, which is where a
 * reader already knows how to read it.
 *
 * `json` is left alone: it is for a pipe, and a consumer parsing it wants the
 * rows array whatever the statement was.
 */
export function formatResult(result: TenantPoolResult, format: QueryFormat): string {
	if (format === "json" || result.rows.length > 0 || result.command === "SELECT") {
		return formatRows(result.rows, format);
	}
	return `${result.command} ${result.rowCount ?? 0}`;
}
