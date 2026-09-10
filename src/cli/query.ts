#!/usr/bin/env -S deno run -A
/**
 * `query` — run one SQL statement against a workspace and print the result.
 *
 * ```
 * deno run -A extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT 1"
 * ```
 *
 * This file is the COMMAND: argument parsing, reading a statement from a file,
 * and printing. The statement itself is run and formatted by `../lib/query.ts`,
 * which takes a statement string and touches no filesystem.
 *
 * ## Flags
 *
 * - `--wsid <wsid>` — required; which workspace to run against.
 * - `--file <path>` — read the statement from a file instead of the argument.
 * - `--format table|json` — `table` (default) for a terminal, `json` for a pipe.
 * - `--root <dir>` — where `databrill.config.json` is looked for. Defaults to
 *   the current directory.
 * - `--help`.
 */

import { command, oneOf, option, optional, restPositionals, string } from "cmd-ts";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { formatResult, QUERY_FORMATS, type QueryFormat, runStatement } from "../lib/query.ts";
import { destroyAllTenantDbs } from "../lib/tenantDb.ts";
import { openWorkspace, resolveWsid } from "./workspaceTarget.ts";
import { runCommand } from "./command.ts";

/**
 * The file `--file` names, resolved against `--root`, or `null` when the
 * statement is coming from the positional argument instead.
 *
 * Exported for `tests/unit/cli.test.ts`: a relative `--file` resolving against
 * `--root` rather than against this file's own location is the same property
 * `--brand` has in `./seedCatalog.ts`, and it is the one a submodule breaks.
 */
export function statementPath(file: string | undefined, rootDir: string): string | null {
	if (file === undefined || file === "") {
		return null;
	}
	return isAbsolute(file) ? file : resolve(rootDir, file);
}

/** The format named by `--format`, or the default. Throws on anything else. */
export function readFormat(value: string | undefined): QueryFormat {
	if (value === undefined || value === "") {
		return "table";
	}
	const match = QUERY_FORMATS.find((format: QueryFormat): boolean => format === value);
	if (match === undefined) {
		throw new Error(`Unknown --format ${JSON.stringify(value)}: expected ${QUERY_FORMATS.join(" or ")}.`);
	}
	return match;
}

function queryCommand() {
	return command({
		name: "query.ts",
		description: "Run one SQL statement against a workspace and print the result.",
		examples: [
			{ description: "Print a query as JSON.", command: 'query.ts --wsid <wsid> --format json "SELECT 1"' },
			{ description: "Read SQL from a file.", command: "query.ts --wsid <wsid> --file report.sql" },
		],
		args: {
			wsid: option({ long: "wsid", type: string, description: "The workspace to query (required)." }),
			file: option({
				long: "file",
				type: optional(string),
				description: "Read SQL from this file; otherwise use the statement argument.",
			}),
			format: option({
				long: "format",
				type: { ...oneOf(QUERY_FORMATS), displayName: QUERY_FORMATS.join("|") },
				defaultValue: (): QueryFormat => "table",
				defaultValueIsSerializable: true,
				description: "Output format.",
			}),
			root: option({
				long: "root",
				type: optional(string),
				description: "Where databrill.config.json is looked for (default: cwd).",
			}),
			statement: restPositionals({
				type: string,
				displayName: "statement",
				description: "SQL statement (or use --file).",
			}),
		},
		async handler(flags): Promise<number> {
			const wsid = resolveWsid(flags.wsid);

			const rootDir = resolve(flags.root ?? process.cwd());
			const positional = flags.statement.join(" ").trim();
			const path = statementPath(flags.file, rootDir);
			const statement = path === null ? positional : await Deno.readTextFile(path);
			if (statement.trim() === "") {
				throw new Error(
					`No statement given.\n\n${queryCommand().printHelp({ nodes: [], visitedNodes: new Set() })}`,
				);
			}

			const { handles } = openWorkspace(wsid, { rootDir });
			try {
				// `runStatement` and not `runQuery`: this command does not know whether it
				// was handed a SELECT, and an UPDATE with no RETURNING has no rows to show
				// however many it changed. `formatResult` reports the driver's command tag
				// for that case rather than the `(0 rows)` that would be a lie.
				const result = await runStatement(handles.raw, statement);
				console.log(formatResult(result, flags.format));
			} finally {
				await destroyAllTenantDbs();
			}
			return 0;
		},
	});
}

/**
 * The command, as a function: parse `args`, do the work, return an exit code.
 *
 * Exported so `tests/unit/cli.test.ts` can run it in process. `--help`, an
 * empty statement and an unknown `--format` all return or throw before a
 * connection is opened, so those cases need no database.
 */
export async function main(args: readonly string[]): Promise<number> {
	return await runCommand(queryCommand(), args);
}

if (import.meta.main) {
	try {
		Deno.exit(await main(Deno.args));
	} catch (cause) {
		console.error(cause instanceof Error ? cause.message : String(cause));
		await destroyAllTenantDbs();
		Deno.exit(1);
	}
}
