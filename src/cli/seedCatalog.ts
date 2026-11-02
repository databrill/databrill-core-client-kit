#!/usr/bin/env -S deno run -A
/**
 * `seedCatalog` — write a brand configuration from a JSON file into one
 * workspace.
 *
 * ```
 * deno run -A extern/databrill-core-client-kit/src/cli/seedCatalog.ts --brand acme --wsid 123456789
 * bun extern/databrill-core-client-kit/src/cli/seedCatalog.ts --brand acme --wsid 123456789
 * ```
 *
 * This file is the COMMAND: argument parsing, reading
 * `brands/<slug>/catalog.json`, and printing what happened. All of the
 * validation and every write is in `../lib/seedCatalog.ts`, which takes an
 * already-parsed seed and touches no filesystem — so a repo that builds its
 * configuration some other way calls that directly and the
 * `brands/<slug>/catalog.json` layout stays a convention of this command.
 *
 * ## Flags
 *
 * - `--brand <slug>` — read `<root>/brands/<slug>/catalog.json`.
 * - `--file <path>` — read this file instead. One of `--brand` or `--file`.
 * - `--wsid <wsid>` — required; which workspace to write.
 * - `--root <dir>` — where `brands/` and `databrill.config.json` are looked
 *   for. Defaults to the current directory, which is the consumer's repo when
 *   the command is run from it.
 * - `--check` (or `--dry-run`) — parse and
 *   validate, write nothing, exit non-zero on a problem.
 * - `--help`.
 *
 * A seed carrying a top-level `"wsid"` must agree with the workspace this
 * invocation resolved, or nothing is written; see {@link assertSeedWsid}.
 *
 * The `--root` default is the reason this package can be a submodule at all:
 * discovery starts at the CURRENT DIRECTORY, never at this file's own location.
 * Deriving it from `import.meta.url` would name a directory inside
 * `extern/databrill-core-client-kit/`, find no `databrill.config.json` there,
 * and report that none is configured for a repo whose config is in its root.
 */

import { CliError, Command, Flag } from "effect/cli";
import { Effect, Exit, Option, Result } from "effect";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { failureOf, formatCause, runEffectPromiseExit } from "../lib/effectCompat.ts";
import { operationError, tryOrOperationError, tryPromiseOrOperationError } from "../lib/effects.ts";
import { parseCatalog, seedCatalog } from "../lib/seedCatalog.ts";
import { acquireTenantDbCache } from "../lib/acquireTenantDbCache.ts";
import { renderHelp, runCommand } from "./runCommand.ts";
import { openWorkspace, resolveWsid } from "./workspaceTarget.ts";

/**
 * Refuse to write when the seed names one workspace and this invocation
 * resolved another.
 *
 * The required `--wsid` selects the write target. If `catalog.json` also names
 * a workspace, the two ids must agree before any connection is opened. This
 * prevents a valid seed from overwriting another workspace's configuration.
 * A seed may omit `wsid`; the command still requires an explicit target.
 */
function assertSeedWsid(seedWsid: string | null, resolved: string, path: string): Result.Result<void, Error> {
	return Result.gen(function* () {
		if (seedWsid !== null && seedWsid !== resolved) {
			return yield* Result.fail(
				new Error(
					`${path} declares "wsid": ${JSON.stringify(seedWsid)}, but this run resolved workspace ` +
						`${resolved}. Pass --wsid ${seedWsid} to write the workspace the seed names, or correct ` +
						`the seed. Nothing was written.`,
				),
			);
		}
	});
}

/**
 * The seed file this invocation means, from `--file` or the `--brand`
 * convention.
 *
 * Exported for `tests/unit/cli.test.ts`. It is the whole of the `--root`
 * property: `brands/<slug>/catalog.json` is resolved against the directory the
 * command was pointed at, never against this file's own location — which is the
 * difference between a submodule that works and one that reports nothing.
 */
export function seedPath(
	brand: string | undefined,
	file: string | undefined,
	rootDir: string,
): Result.Result<string, Error> {
	return Result.gen(function* () {
		if (file !== undefined && file !== "") {
			return isAbsolute(file) ? file : resolve(rootDir, file);
		}
		if (brand === undefined || brand === "") {
			return yield* Result.fail(new Error("Pass --brand <slug> or --file <path>."));
		}
		return join(rootDir, "brands", brand, "catalog.json");
	});
}

function seedCatalogCommand() {
	return Command.make("seedCatalog.ts", {
		brand: Flag.String("brand").pipe(
			Flag.withDefault(undefined),
			Flag.withDescription("Read <root>/brands/<slug>/catalog.json."),
		),
		file: Flag.String("file").pipe(
			Flag.withDefault(undefined),
			Flag.withDescription("Read this seed file; otherwise use --brand."),
		),
		wsid: Flag.String("wsid").pipe(Flag.withDescription("The workspace to write (required).")),
		root: Flag.String("root").pipe(
			Flag.withDefault(undefined),
			Flag.withDescription("Where brands/ and databrill.config.json are looked for (default: cwd)."),
		),
		check: Flag.Boolean("check").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Validate the seed and write nothing."),
		),
		dryRun: Flag.Boolean("dry-run").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Same as --check: validate and write nothing."),
		),
	}, (flags): Effect.Effect<void, Error> =>
		Effect.gen(function* () {
			const cache = yield* acquireTenantDbCache();
			const wsid = yield* Effect.fromResult(resolveWsid(flags.wsid));

			const rootDir = yield* Effect.fromResult(tryOrOperationError(() => resolve(flags.root ?? process.cwd())));
			const path = yield* Effect.fromResult(seedPath(flags.brand, flags.file, rootDir)).pipe(
				Effect.catch((error) =>
					Effect.flatMap(
						renderHelp(seedCatalogCommand()),
						(help) => Effect.fail(new Error(`${error.message}\n\n${help}`, { cause: error })),
					)
				),
			);
			const text = yield* tryPromiseOrOperationError(() => readFile(path, "utf8"));
			const raw: unknown = yield* Effect.try({
				try: () => JSON.parse(text),
				catch: (cause) => new Error(`${path} is not valid JSON: ${operationError(cause).message}`, { cause }),
			});
			const seed = yield* Effect.fromResult(parseCatalog(raw, { source: path }));

			if (flags.check || flags.dryRun) {
				// Resolved even in --check, because "which workspace would this have
				// written?" is half of what a reader wants confirmed before a real run.
				yield* Effect.fromResult(assertSeedWsid(seed.wsid, wsid, path));
				yield* Effect.fromResult(tryOrOperationError(() =>
					console.log(
						`${path} is valid: ${seed.properties.length} properties, ${seed.categories.length} categories, ` +
							`${seed.variants.length} variants, ${seed.families.length} families, ${seed.asins.length} ASINs, ` +
							`${seed.attributes.length} attributes. ` +
							`Nothing written (--check); a real run would write workspace ${wsid}.`,
					)
				));
				return;
			}

			yield* Effect.fromResult(assertSeedWsid(seed.wsid, wsid, path));
			const { schema, handles } = yield* openWorkspace(wsid, { rootDir }, { cache });
			const written = yield* seedCatalog(handles.write, seed);
			yield* Effect.fromResult(tryOrOperationError(() =>
				console.log(
					`Seeded workspace ${wsid} (schema ${schema}) from ${path}: ${written.properties} properties, ` +
						`${written.categories} categories, ${written.variants} variants, ${written.families} families, ` +
						`${written.asins} ASINs, ${written.attributes} attributes.`,
				)
			));
			return;
		}).pipe(Effect.scoped)).pipe(
			Command.withDescription("Write a brand configuration into a workspace. Pass --brand or --file."),
		);
}

/**
 * The command, as a function: parse `args`, do the work, return an exit code.
 *
 * Exported so `tests/unit/cli.test.ts` can run it in process. Every path that
 * ends in an argument or validation error fails before a connection
 * is opened, which is what lets those cases be covered with no database and no
 * `net` permission.
 */
export function main(args: readonly string[]): Effect.Effect<number, Error | CliError.CliError> {
	return runCommand(seedCatalogCommand(), args);
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
