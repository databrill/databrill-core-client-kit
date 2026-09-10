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

import { command, flag, option, optional, string } from "cmd-ts";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { parseCatalog, seedCatalog, SeedValidationError } from "../lib/seedCatalog.ts";
import { destroyAllTenantDbs } from "../lib/tenantDb.ts";
import { openWorkspace, resolveWsid } from "./workspaceTarget.ts";
import { runCommand } from "./command.ts";

/**
 * Refuse to write when the seed names one workspace and this invocation
 * resolved another.
 *
 * The required `--wsid` selects the write target. If `catalog.json` also names
 * a workspace, the two ids must agree before any connection is opened. This
 * prevents a valid seed from overwriting another workspace's configuration.
 * A seed may omit `wsid`; the command still requires an explicit target.
 */
function assertSeedWsid(seedWsid: string | null, resolved: string, path: string): void {
	if (seedWsid !== null && seedWsid !== resolved) {
		throw new Error(
			`${path} declares "wsid": ${JSON.stringify(seedWsid)}, but this run resolved workspace ` +
				`${resolved}. Pass --wsid ${seedWsid} to write the workspace the seed names, or correct ` +
				`the seed. Nothing was written.`,
		);
	}
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
export function seedPath(brand: string | undefined, file: string | undefined, rootDir: string): string {
	if (file !== undefined && file !== "") {
		return isAbsolute(file) ? file : resolve(rootDir, file);
	}
	if (brand === undefined || brand === "") {
		throw new Error(
			`Pass --brand <slug> or --file <path>.\n\n${
				seedCatalogCommand().printHelp({ nodes: [], visitedNodes: new Set() })
			}`,
		);
	}
	return join(rootDir, "brands", brand, "catalog.json");
}

function seedCatalogCommand() {
	return command({
		name: "seedCatalog.ts",
		description: "Write a brand configuration into a workspace. Pass --brand or --file.",
		examples: [
			{
				description: "Validate a seed without writing.",
				command: "seedCatalog.ts --wsid <wsid> --file catalog.json --check",
			},
		],
		args: {
			brand: option({
				long: "brand",
				type: optional(string),
				description: "Read <root>/brands/<slug>/catalog.json.",
			}),
			file: option({
				long: "file",
				type: optional(string),
				description: "Read this seed file; otherwise use --brand.",
			}),
			wsid: option({ long: "wsid", type: string, description: "The workspace to write (required)." }),
			root: option({
				long: "root",
				type: optional(string),
				description: "Where brands/ and databrill.config.json are looked for (default: cwd).",
			}),
			check: flag({ long: "check", description: "Validate the seed and write nothing." }),
			dryRun: flag({ long: "dry-run", description: "Same as --check: validate and write nothing." }),
		},
		async handler(flags): Promise<number> {
			const wsid = resolveWsid(flags.wsid);

			const rootDir = resolve(flags.root ?? process.cwd());
			const path = seedPath(flags.brand, flags.file, rootDir);
			const text = await Deno.readTextFile(path);
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch (cause) {
				throw new Error(`${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
			const seed = parseCatalog(raw, { source: path });

			if (flags.check || flags.dryRun) {
				// Resolved even in --check, because "which workspace would this have
				// written?" is half of what a reader wants confirmed before a real run.
				assertSeedWsid(seed.wsid, wsid, path);
				console.log(
					`${path} is valid: ${seed.properties.length} properties, ${seed.categories.length} categories, ` +
						`${seed.variants.length} variants, ${seed.families.length} families, ${seed.asins.length} ASINs, ` +
						`${seed.attributes.length} attributes. ` +
						`Nothing written (--check); a real run would write workspace ${wsid}.`,
				);
				return 0;
			}

			assertSeedWsid(seed.wsid, wsid, path);
			const { schema, handles } = openWorkspace(wsid, { rootDir });
			try {
				const written = await seedCatalog(handles.write, seed);
				console.log(
					`Seeded workspace ${wsid} (schema ${schema}) from ${path}: ${written.properties} properties, ` +
						`${written.categories} categories, ${written.variants} variants, ${written.families} families, ` +
						`${written.asins} ASINs, ${written.attributes} attributes.`,
				);
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
 * Exported so `tests/unit/cli.test.ts` can run it in process. Every path that
 * ends in an argument or validation error returns or throws before a connection
 * is opened, which is what lets those cases be covered with no database and no
 * `net` permission.
 */
export async function main(args: readonly string[]): Promise<number> {
	return await runCommand(seedCatalogCommand(), args);
}

if (import.meta.main) {
	try {
		Deno.exit(await main(Deno.args));
	} catch (cause) {
		// A validation failure is the expected way for this command to fail and
		// its message is the whole report, so it is printed as itself rather
		// than as a stack trace the reader has to look past.
		if (cause instanceof SeedValidationError) {
			console.error(cause.message);
		} else {
			console.error(cause instanceof Error ? cause.message : String(cause));
		}
		await destroyAllTenantDbs();
		Deno.exit(1);
	}
}
