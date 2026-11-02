#!/usr/bin/env -S deno run -A
/**
 * `query` — run one SQL statement against a workspace and print the result.
 *
 * ```
 * deno run -A extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT 1"
 * bun extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT 1"
 * ```
 *
 * This file is the COMMAND: argument parsing, reading a statement from a file,
 * and printing. `RawReader` executes the statement, and `../lib/query.ts`
 * formats its result. Neither operation touches the filesystem.
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

import { Argument, CliError, Command, Flag } from "effect/cli";
import { Effect, Exit, Option, Result } from "effect";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { acquireTenantDbCache } from "../lib/acquireTenantDbCache.ts";
import { failureOf, formatCause, runEffectPromiseExit } from "../lib/effectCompat.ts";
import { tryOrOperationError, tryPromiseOrOperationError } from "../lib/effects.ts";
import { formatResult, QUERY_FORMATS, type QueryFormat } from "../lib/query.ts";
import { renderHelp, runCommand } from "./runCommand.ts";
import { openWorkspace, resolveWsid } from "./workspaceTarget.ts";

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

/** The format named by `--format`, or the default; an invalid value is a failed Result. */
export function readFormat(value: string | undefined): Result.Result<QueryFormat, Error> {
	return Result.gen(function* () {
		if (value === undefined || value === "") {
			return "table";
		}
		const match = QUERY_FORMATS.find((format: QueryFormat): boolean => format === value);
		if (match === undefined) {
			return yield* Result.fail(
				new Error(`Unknown --format ${JSON.stringify(value)}: expected ${QUERY_FORMATS.join(" or ")}.`),
			);
		}
		return match;
	});
}

function queryCommand() {
	return Command.make("query.ts", {
		wsid: Flag.String("wsid").pipe(Flag.withDescription("The workspace to query (required).")),
		file: Flag.String("file").pipe(
			Flag.withDefault(undefined),
			Flag.withDescription("Read SQL from this file; otherwise use the statement argument."),
		),
		format: Flag.Literals("format", QUERY_FORMATS).pipe(
			Flag.withDefault("table"),
			Flag.withDescription("Output format."),
		),
		root: Flag.String("root").pipe(
			Flag.withDefault(undefined),
			Flag.withDescription("Where databrill.config.json is looked for (default: cwd)."),
		),
		// Effect CLI refuses a token that starts with a dash as an unrecognized
		// flag before it can reach the statement. Use --file for SQL starting
		// with a dash.
		statement: Argument.String("statement").pipe(
			Argument.variadic(),
			Argument.withDescription("SQL statement (or use --file)."),
		),
	}, (flags): Effect.Effect<void, Error> =>
		Effect.gen(function* () {
			const cache = yield* acquireTenantDbCache();
			const wsid = yield* Effect.fromResult(resolveWsid(flags.wsid));

			const rootDir = yield* Effect.fromResult(tryOrOperationError(() => resolve(flags.root ?? process.cwd())));
			const positional = flags.statement.join(" ").trim();
			const path = statementPath(flags.file, rootDir);
			const statement = path === null
				? positional
				: yield* tryPromiseOrOperationError(() => readFile(path, "utf8"));
			if (statement.trim() === "") {
				const help = yield* renderHelp(queryCommand());
				return yield* Effect.fail(new Error(`No statement given.\n\n${help}`));
			}

			const { handles } = yield* openWorkspace(wsid, { rootDir }, { cache });
			// Keep the complete result: this command does not know whether it was
			// handed a SELECT, and an UPDATE with no RETURNING has no rows to show
			// however many it changed. `formatResult` reports the driver's command tag
			// for that case rather than the `(0 rows)` that would be a lie.
			const result = yield* handles.raw.result(statement);
			yield* Effect.fromResult(tryOrOperationError(() => console.log(formatResult(result, flags.format))));
			return;
		}).pipe(Effect.scoped)).pipe(
			Command.withDescription("Run one SQL statement against a workspace and print the result."),
		);
}

/**
 * The command, as a function: parse `args`, do the work, return an exit code.
 *
 * Exported so `tests/unit/cli.test.ts` can run it in process. `--help`, an
 * empty statement and an unknown `--format` all succeed or fail before a
 * connection is opened, so those cases need no database.
 */
export function main(args: readonly string[]): Effect.Effect<number, Error | CliError.CliError> {
	return runCommand(queryCommand(), args);
}

if (import.meta.main) {
	const result = await runEffectPromiseExit(main(process.argv.slice(2)));
	if (Exit.isFailure(result)) {
		// Effect CLI already prints argument-validation errors.
		const failure = failureOf(result);
		if (Option.isSome(failure)) {
			if (!CliError.isCliError(failure.value)) {
				console.error(failure.value.message);
			}
		} else {
			console.error(formatCause(result.cause));
		}
		process.exit(1);
	}
	process.exit(result.value);
}
