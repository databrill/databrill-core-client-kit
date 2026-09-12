/**
 * The OPTIONAL workspace-registry layer: resolving a wsid to a database through
 * `databrill.config.json`.
 *
 * `./mod.ts` and everything it re-exports take explicit connection information
 * and know nothing about config files. This module is the other half, for repos
 * that want the registry convention, and it is imported directly rather than
 * through `mod.ts` so that a consumer which does not want it does not get it in
 * its import graph.
 *
 * ## Config discovery does not depend on where this file lives
 *
 * {@link resolveConfigPath} resolves from an explicit option, then
 * `DATABRILL_CONFIG`, then an upward search from a root directory that defaults
 * to `process.cwd()`. There is **no `import.meta.url` anywhere in this file**,
 * and that absence is the point. The client copies this code comes from derived
 * a repo root as `resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")`,
 * which is correct only while the module sits in the repo that owns the config.
 * The moment the same module is a git submodule under the consumer's `extern/`
 * — which is how this package ships — that expression names a directory inside
 * the submodule, finds no `databrill.config.json` there, and reports "no
 * workspace config loaded" for a repo whose config is sitting in its root. It
 * does not fail; it finds nothing, which is worse.
 *
 * `tests/unit/workspaces.test.ts` pins this with a case that copies this module
 * to a temp directory and asserts resolution still follows `rootDir`.
 *
 * ## Opening a connection for a wsid is TWO lines, on purpose
 *
 * ```ts
 * const { database } = yield* getWorkspace("123456789");
 * const { db, raw } = yield* tenantDb({ postgresUrl: database.postgresUrl, schema: database.schema });
 * ```
 *
 * There is deliberately no `tenantDbForWsid()` here. Database acquisition
 * belongs in the caller that already needs both halves. This module uses Node
 * builtins, Effect and shared config sources; its relocation test verifies the
 * same caller-relative discovery with those declared dependencies available.
 *
 * ## What stayed behind in the client repos
 *
 * `DEFAULT_SCHEMA` and `DEFAULT_WSID`. Those are one repo's identities, not a
 * property of the convention, so this package has no default wsid at all: every
 * caller says which workspace it means explicitly. {@link listWsids} is for
 * discovery and diagnostics, never for selecting a target.
 */

import { Effect } from "effect";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { type Config, loadConfig, type Workspace } from "./config.ts";
import { tryOrOperationError, tryPromiseOrOperationError } from "./effects.ts";

export type { Workspace };

/** The file an upward search looks for. */
const CONFIG_FILE_NAME = "databrill.config.json";

/** How to find `databrill.config.json`. Every field is optional; the defaults are the convention. */
export interface WorkspaceConfigOptions {
	/** An explicit path to the config file. Relative values resolve against `rootDir`. */
	readonly configPath?: string;

	/** Where discovery starts, and what relative paths resolve against. Defaults to `process.cwd()`. */
	readonly rootDir?: string;
}

/**
 * Where the config was found, and where the search started.
 *
 * `searchedFrom` is carried even on a hit so that a miss can say where it
 * looked: "no workspace config loaded" is the single least actionable thing this
 * layer can report, and the directory it searched from is the one fact that
 * turns it into a fixable message.
 */
export interface ConfigLocation {
	/** Absolute path to the config file, or `null` when nothing was found. */
	readonly path: string | null;

	/** Absolute path of the directory discovery started from. */
	readonly searchedFrom: string;
}

/** Does `path` name an existing regular file? */
function isFile(path: string): Effect.Effect<boolean, Error> {
	return tryPromiseOrOperationError(() => stat(path)).pipe(
		Effect.map((info) => info.isFile()),
		Effect.catchIf(
			(error) => "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"),
			() => Effect.succeed(false),
		),
	);
}

/**
 * Find `databrill.config.json`, without ever consulting this module's own
 * location.
 *
 * Resolution order, and each step's reason:
 *
 * 1. `opts.configPath` — an explicit answer wins; relative values resolve
 *    against `rootDir`, so a caller can pass a repo-relative path.
 * 2. `DATABRILL_CONFIG` — the environment variable the config loader itself
 *    reads, so honouring it here keeps one answer rather than two. An absolute
 *    value is taken as it stands; a relative one resolves against `rootDir`.
 * 3. An upward search from `rootDir`, which by default is `process.cwd()` — the
 *    consumer's repo when a CLI is run from it.
 *
 * Do not reorder these and do not add a fourth step derived from
 * `import.meta.url`; see the module docblock.
 */
export function resolveConfigPath(opts: WorkspaceConfigOptions = {}): Effect.Effect<ConfigLocation, Error> {
	return Effect.gen(function* () {
		const rootDir = yield* tryOrOperationError(() => resolve(opts.rootDir ?? process.cwd()));

		if (opts.configPath !== undefined && opts.configPath !== "") {
			const path = isAbsolute(opts.configPath) ? opts.configPath : resolve(rootDir, opts.configPath);
			return { path, searchedFrom: rootDir };
		}

		const fromEnv = yield* tryOrOperationError(() => process.env["DATABRILL_CONFIG"]);
		if (fromEnv !== undefined && fromEnv !== "") {
			const path = isAbsolute(fromEnv) ? fromEnv : resolve(rootDir, fromEnv);
			return { path, searchedFrom: rootDir };
		}

		let directory = rootDir;
		for (;;) {
			const candidate = join(directory, CONFIG_FILE_NAME);
			if (yield* isFile(candidate)) {
				return { path: candidate, searchedFrom: rootDir };
			}
			const parent = dirname(directory);
			if (parent === directory) {
				return { path: null, searchedFrom: rootDir };
			}
			directory = parent;
		}
	});
}

/**
 * The config last loaded, with the path it came from.
 *
 * Keyed on the path rather than cached outright, so a caller that asks for a
 * different config in the same process gets that one instead of the first one it
 * happened to ask for. {@link resetWorkspaceConfig} is for the case a test — or
 * a long-lived process told to reload — needs the file read again.
 */
let cached: { readonly path: string; readonly config: Config } | null = null;

/**
 * Load (or reuse) the workspace config.
 *
 * Pass the resolved path directly to `loadConfig()` so concurrent reads never
 * need to change the process environment. The cache changes only on execution.
 */
export function workspaceConfig(opts: WorkspaceConfigOptions = {}): Effect.Effect<Config, Error> {
	return Effect.gen(function* () {
		const location = yield* resolveConfigPath(opts);
		if (location.path === null) {
			return yield* Effect.fail(
				new Error(
					`No ${CONFIG_FILE_NAME} found: searched ${location.searchedFrom} and every directory above it. ` +
						`Set DATABRILL_CONFIG, pass configPath, or run from a directory inside the repo that has one.`,
				),
			);
		}
		if (cached !== null && cached.path === location.path) {
			return cached.config;
		}

		const config = yield* loadConfig(location.path);
		if (config === null) {
			return yield* Effect.fail(
				new Error(`Could not load ${location.path}: the config loader read no configuration from it.`),
			);
		}
		cached = { path: location.path, config };
		return config;
	});
}

/** Forget the loaded config, so the next call reads the file again. */
export function resetWorkspaceConfig(): void {
	cached = null;
}

/**
 * Every configured wsid, ascending.
 *
 * Sorted rather than left in the config file's own key order: this list is read
 * by people, in the "configured: …" tail of a "no such workspace" message and
 * in `../cli/workspaceTarget.ts`'s refusal, and a stable order is what makes two
 * such messages comparable. Wsids are nine-digit integers of equal width, so
 * lexicographic and numeric order are the same thing here.
 */
export function listWsids(opts: WorkspaceConfigOptions = {}): Effect.Effect<readonly string[], Error> {
	return Effect.map(workspaceConfig(opts), (config) => Object.keys(config.workspaces).sort());
}

/** One configured workspace, by wsid. Fails naming the configured wsids when there is no such one. */
export function getWorkspace(wsid: string, opts: WorkspaceConfigOptions = {}): Effect.Effect<Workspace, Error> {
	return Effect.gen(function* () {
		const config = yield* workspaceConfig(opts);
		const workspace = config.workspaces[wsid];
		if (workspace === undefined) {
			const known = Object.keys(config.workspaces);
			return yield* Effect.fail(
				new Error(
					`No workspace ${wsid} in the loaded configuration. Configured: ${
						known.length === 0 ? "(none)" : known.join(", ")
					}.`,
				),
			);
		}
		return workspace;
	});
}

/** The merchant ids configured for a workspace. */
export function merchantIds(wsid: string, opts: WorkspaceConfigOptions = {}): Effect.Effect<readonly string[], Error> {
	return Effect.map(getWorkspace(wsid, opts), (workspace) => Object.keys(workspace.merchants));
}

/**
 * Every country any merchant of a workspace sells in, upper-cased, deduplicated
 * and sorted.
 *
 * Upper-casing is not cosmetic: a country code from here is compared against and
 * concatenated into things that are upper-case everywhere else — the
 * `amazon_sales_rank__{cc}` partition names, marketplace lookups, the
 * `country` column of `brand_config_amazon_attributes`. A config that writes
 * `"us"` would otherwise deduplicate to two entries against a config that writes
 * `"US"`, and match neither.
 */
export function countries(wsid: string, opts: WorkspaceConfigOptions = {}): Effect.Effect<readonly string[], Error> {
	return Effect.map(getWorkspace(wsid, opts), (workspace) => {
		const found = new Set<string>();
		for (const merchant of Object.values(workspace.merchants)) {
			for (const country of merchant.countries) {
				found.add(country.toUpperCase());
			}
		}
		return [...found].sort();
	});
}
