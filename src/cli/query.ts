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
 * - `--wsid <wsid>` — which workspace to run against. Optional when the
 *   configuration declares exactly one. **There is no built-in default**; see
 *   `./workspaceTarget.ts` for what replaced the client repos' `DEFAULT_WSID`
 *   and why.
 * - `--file <path>` — read the statement from a file instead of the argument.
 * - `--format table|json` — `table` (default) for a terminal, `json` for a pipe.
 * There is no `--qualify`. It was removed on 2026-09-03 along with the rewriter
 * behind it: a tenant login role carries `ALTER ROLE ... SET search_path`, so an
 * unqualified name already resolves in the workspace's own schema. See
 * `../lib/query.ts` for the whole account.
 * - `--root <dir>` — where `databrill.config.json` is looked for. Defaults to
 *   the current directory.
 * - `--help`.
 */

import { parseArgs } from "@std/cli/parse-args";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { formatResult, QUERY_FORMATS, type QueryFormat, runStatement } from "../lib/query.ts";
import { destroyAllTenantDbs } from "../lib/tenantDb.ts";
import { openWorkspace } from "./workspaceTarget.ts";

function usage(): string {
	return [
		'Usage: query.ts [--wsid <wsid>] [--format table|json] [--root <dir>] "<statement>"',
		"       query.ts [--wsid <wsid>] --file <path>",
		"",
		"  --wsid <wsid>   the workspace to query; optional when exactly one is configured",
		"  --file <path>   read the statement from a file instead of the argument",
		"  --format <fmt>  table (default) or json",
		"  --root <dir>    where databrill.config.json is looked for (default: cwd)",
		"  --help          this text",
	].join("\n");
}

/**
 * Refuse an option this command does not define, instead of ignoring it.
 *
 * `parseArgs` keeps an unrecognised flag in its result and no caller reads it,
 * so `--formta json` runs with the default format and `--wsdi 123456789` runs
 * against whichever workspace the fallback picked — both silently, both
 * reporting success. A wrong workspace is the failure this directory is built
 * to design against, so a mistyped option is a refusal here rather than a
 * result nobody can tell apart from the right one.
 *
 * Only `-`-prefixed arguments are checked: everything else is a positional,
 * which `query` uses for the statement itself.
 */
function refuseUnknownOption(usageText: string): (arg: string) => boolean {
	return (arg: string): boolean => {
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option ${arg}.\n\n${usageText}`);
		}
		return true;
	};
}

/**
 * The file `--file` names, resolved against `--root`, or `null` when the
 * statement is coming from the positional argument instead.
 *
 * Exported for `tests/unit/cli.test.ts`: a relative `--file` resolving against
 * `--root` rather than against this file's own location is the same property
 * `--brand` has in `./seedFamilies.ts`, and it is the one a submodule breaks.
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

/**
 * The command, as a function: parse `args`, do the work, return an exit code.
 *
 * Exported so `tests/unit/cli.test.ts` can run it in process. `--help`, an
 * empty statement and an unknown `--format` all return or throw before a
 * connection is opened, so those cases need no database.
 */
export async function main(args: readonly string[]): Promise<number> {
	const flags = parseArgs([...args], {
		string: ["wsid", "file", "format", "root"],
		boolean: ["help"],
		unknown: refuseUnknownOption(usage()),
	});
	if (flags.help) {
		console.log(usage());
		return 0;
	}

	const rootDir = resolve(flags.root ?? process.cwd());
	const positional = flags._.map((value: string | number): string => String(value)).join(" ").trim();
	const path = statementPath(flags.file, rootDir);
	const statement = path === null ? positional : await Deno.readTextFile(path);
	if (statement.trim() === "") {
		throw new Error(`No statement given.\n\n${usage()}`);
	}

	const format = readFormat(flags.format);
	const { handles } = openWorkspace(flags.wsid, { rootDir });
	try {
		// `runStatement` and not `runQuery`: this command does not know whether it
		// was handed a SELECT, and an UPDATE with no RETURNING has no rows to show
		// however many it changed. `formatResult` reports the driver's command tag
		// for that case rather than the `(0 rows)` that would be a lie.
		const result = await runStatement(handles.raw, statement);
		console.log(formatResult(result, format));
	} finally {
		await destroyAllTenantDbs();
	}
	return 0;
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
