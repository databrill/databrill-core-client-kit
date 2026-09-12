#!/usr/bin/env -S deno run -A
/**
 * `seedCatalog` — write a brand configuration from a JSON file into one
 * workspace.
 *
 * ```
 * deno run -A extern/databrill-core-client-kit/src/cli/seedCatalog.ts --brand acme --wsid 123456789
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

import { CliConfig, Command, HelpDoc, Options, ValidationError } from "@effect/cli";
import { Cause, Effect, Either, Exit } from "effect";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { operationError, tryOrOperationError, tryPromiseOrOperationError } from "../lib/effects.ts";
import { parseCatalog, seedCatalog } from "../lib/seedCatalog.ts";
import { acquireTenantDbCache } from "../lib/acquireTenantDbCache.ts";
import { runCommand } from "./runCommand.ts";
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
function assertSeedWsid(seedWsid: string | null, resolved: string, path: string): Either.Either<void, Error> {
	return Either.gen(function* () {
		if (seedWsid !== null && seedWsid !== resolved) {
			return yield* Either.left(
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
): Either.Either<string, Error> {
	return Either.gen(function* () {
		if (file !== undefined && file !== "") {
			return isAbsolute(file) ? file : resolve(rootDir, file);
		}
		if (brand === undefined || brand === "") {
			return yield* Either.left(
				new Error(
					`Pass --brand <slug> or --file <path>.\n\n${
						HelpDoc.toAnsiText(Command.getHelp(seedCatalogCommand(), CliConfig.defaultConfig))
					}`,
				),
			);
		}
		return join(rootDir, "brands", brand, "catalog.json");
	});
}

function seedCatalogCommand() {
	return Command.make("seedCatalog.ts", {
		brand: Options.text("brand").pipe(
			Options.withDefault(undefined),
			Options.withDescription("Read <root>/brands/<slug>/catalog.json."),
		),
		file: Options.text("file").pipe(
			Options.withDefault(undefined),
			Options.withDescription("Read this seed file; otherwise use --brand."),
		),
		wsid: Options.text("wsid").pipe(Options.withDescription("The workspace to write (required).")),
		root: Options.text("root").pipe(
			Options.withDefault(undefined),
			Options.withDescription("Where brands/ and databrill.config.json are looked for (default: cwd)."),
		),
		check: Options.boolean("check").pipe(Options.withDescription("Validate the seed and write nothing.")),
		dryRun: Options.boolean("dry-run").pipe(
			Options.withDescription("Same as --check: validate and write nothing."),
		),
	}, (flags): Effect.Effect<void, Error> =>
		Effect.gen(function* () {
			const cache = yield* acquireTenantDbCache();
			const wsid = yield* resolveWsid(flags.wsid);

			const rootDir = yield* tryOrOperationError(() => resolve(flags.root ?? process.cwd()));
			const path = yield* seedPath(flags.brand, flags.file, rootDir);
			const text = yield* tryPromiseOrOperationError(() => Deno.readTextFile(path));
			const raw: unknown = yield* Effect.try({
				try: () => JSON.parse(text),
				catch: (cause) => new Error(`${path} is not valid JSON: ${operationError(cause).message}`, { cause }),
			});
			const seed = yield* parseCatalog(raw, { source: path });

			if (flags.check || flags.dryRun) {
				// Resolved even in --check, because "which workspace would this have
				// written?" is half of what a reader wants confirmed before a real run.
				yield* assertSeedWsid(seed.wsid, wsid, path);
				yield* tryOrOperationError(() =>
					console.log(
						`${path} is valid: ${seed.properties.length} properties, ${seed.categories.length} categories, ` +
							`${seed.variants.length} variants, ${seed.families.length} families, ${seed.asins.length} ASINs, ` +
							`${seed.attributes.length} attributes. ` +
							`Nothing written (--check); a real run would write workspace ${wsid}.`,
					)
				);
				return;
			}

			yield* assertSeedWsid(seed.wsid, wsid, path);
			const { schema, handles } = yield* openWorkspace(wsid, { rootDir }, { cache });
			const written = yield* seedCatalog(handles.write, seed);
			yield* tryOrOperationError(() =>
				console.log(
					`Seeded workspace ${wsid} (schema ${schema}) from ${path}: ${written.properties} properties, ` +
						`${written.categories} categories, ${written.variants} variants, ${written.families} families, ` +
						`${written.asins} ASINs, ${written.attributes} attributes.`,
				)
			);
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
export function main(args: readonly string[]): Effect.Effect<number, Error | ValidationError.ValidationError> {
	return runCommand("seedCatalog.ts", seedCatalogCommand(), args);
}

if (import.meta.main) {
	const result = await Effect.runPromiseExit(main(Deno.args));
	if (Exit.isFailure(result)) {
		// Effect CLI already prints argument-validation errors.
		if (result.cause._tag === "Fail") {
			const error = result.cause.error;
			if (!ValidationError.isValidationError(error)) {
				console.error(error.message);
			}
		} else {
			console.error(Cause.pretty(result.cause));
		}
		Deno.exit(1);
	}
	Deno.exit(result.value);
}
