#!/usr/bin/env -S deno run -A
/**
 * `seedFamilies` — write a brand configuration from a JSON file into one
 * workspace.
 *
 * ```
 * deno run -A extern/databrill-core-client-kit/src/cli/seedFamilies.ts --brand acme
 * ```
 *
 * This file is the COMMAND: argument parsing, reading
 * `brands/<slug>/families.json`, and printing what happened. All of the
 * validation and every write is in `../lib/seedFamilies.ts`, which takes an
 * already-parsed seed and touches no filesystem — so a repo that builds its
 * configuration some other way calls that directly and the
 * `brands/<slug>/families.json` layout stays a convention of this command.
 *
 * ## Flags
 *
 * - `--brand <slug>` — read `<root>/brands/<slug>/families.json`.
 * - `--file <path>` — read this file instead. One of `--brand` or `--file`.
 * - `--wsid <wsid>` — which workspace to write. Optional when the
 *   configuration declares exactly one; see `./workspaceTarget.ts` for why
 *   there is no default beyond that.
 * - `--root <dir>` — where `brands/` and `databrill.config.json` are looked
 *   for. Defaults to the current directory, which is the consumer's repo when
 *   the command is run from it.
 * - `--check` (or `--dry-run`, the name the client-repo script used) — parse and
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

import { parseArgs } from "@std/cli/parse-args";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { parseFamiliesSeed, seedFamilies, SeedValidationError } from "../lib/seedFamilies.ts";
import { destroyAllTenantDbs } from "../lib/tenantDb.ts";
import { openWorkspace, resolveWsid } from "./workspaceTarget.ts";

function usage(): string {
	return [
		"Usage: seedFamilies.ts (--brand <slug> | --file <path>) [--wsid <wsid>] [--root <dir>] [--check]",
		"",
		"  --brand <slug>  read <root>/brands/<slug>/families.json",
		"  --file <path>   read this seed file instead of the --brand convention",
		"  --wsid <wsid>   the workspace to write; optional when exactly one is configured",
		"  --root <dir>    where brands/ and databrill.config.json are looked for (default: cwd)",
		"  --check         validate the seed and write nothing (--dry-run is the same flag)",
		"  --help          this text",
	].join("\n");
}

/**
 * Refuse to write when the seed names one workspace and this invocation
 * resolved another.
 *
 * A `families.json` may carry a top-level `wsid`, and the client-repo script
 * this command replaces used that value AS the write target — it never had a
 * `--wsid` flag at all. This command resolves the target from `--wsid` or the
 * sole configured workspace instead, which is what makes the package
 * repo-agnostic; the cost is that the seed's own statement stops being what
 * decides. So it is checked rather than dropped: writing a brand's whole
 * configuration into the wrong workspace succeeds, upserts over ~200 rows of
 * somebody else's data, and reports every count as expected.
 *
 * A seed with no `wsid` is fine and says nothing, which is the in-memory case.
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
 * The seed file this invocation means, from `--file` or the `--brand`
 * convention.
 *
 * Exported for `tests/unit/cli.test.ts`. It is the whole of the `--root`
 * property: `brands/<slug>/families.json` is resolved against the directory the
 * command was pointed at, never against this file's own location — which is the
 * difference between a submodule that works and one that reports nothing.
 */
export function seedPath(brand: string | undefined, file: string | undefined, rootDir: string): string {
	if (file !== undefined && file !== "") {
		return isAbsolute(file) ? file : resolve(rootDir, file);
	}
	if (brand === undefined || brand === "") {
		throw new Error(`Pass --brand <slug> or --file <path>.\n\n${usage()}`);
	}
	return join(rootDir, "brands", brand, "families.json");
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
	const flags = parseArgs([...args], {
		string: ["brand", "file", "wsid", "root"],
		boolean: ["check", "help"],
		// `--dry-run` is what the client-repo script called this, and it is in
		// that repo's task docs and in a habit or two. Renaming it would fail
		// loudly — an unknown option is a refusal here — but failing loudly at
		// somebody who typed the documented flag is not an improvement.
		alias: { "dry-run": "check" },
		unknown: refuseUnknownOption(usage()),
	});
	if (flags.help) {
		console.log(usage());
		return 0;
	}

	const rootDir = resolve(flags.root ?? process.cwd());
	const path = seedPath(flags.brand, flags.file, rootDir);
	const text = await Deno.readTextFile(path);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (cause) {
		throw new Error(`${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	const seed = parseFamiliesSeed(raw, { source: path });

	if (flags.check) {
		// Resolved even in --check, because "which workspace would this have
		// written?" is half of what a reader wants confirmed before a real run.
		const wsid = resolveWsid(flags.wsid, { rootDir });
		assertSeedWsid(seed.wsid, wsid, path);
		console.log(
			`${path} is valid: ${seed.properties.length} properties, ${seed.categories.length} categories, ` +
				`${seed.variants.length} variants, ${seed.families.length} families, ${seed.asins.length} ASINs, ` +
				`${seed.attributes.length} attributes. ` +
				`Nothing written (--check); a real run would write workspace ${wsid}.`,
		);
		return 0;
	}

	assertSeedWsid(seed.wsid, resolveWsid(flags.wsid, { rootDir }), path);
	const { wsid, schema, handles } = openWorkspace(flags.wsid, { rootDir });
	try {
		const written = await seedFamilies(handles.write, seed);
		console.log(
			`Seeded workspace ${wsid} (schema ${schema}) from ${path}: ${written.properties} properties, ` +
				`${written.categories} categories, ${written.variants} variants, ${written.families} families, ` +
				`${written.asins} ASINs, ${written.attributes} attributes.`,
		);
	} finally {
		await destroyAllTenantDbs();
	}
	return 0;
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
