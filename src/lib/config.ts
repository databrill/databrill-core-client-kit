/**
 * Workspace registry. When `DATABRILL_CONFIG` points at a JSON file, the stdio
 * frontend routes each tool call's required `wsid` to one workspace-specific
 * credential. There is no unscoped single-credential mode.
 *
 * The file is a map of `wsid → workspace`. Each workspace carries its database
 * connection and a `merchantId → { name, countries }` map. Connection strings
 * use `${VAR}` placeholders expanded from the environment, so secrets stay in
 * `.env` and the config file itself is safe to commit.
 *
 *   {
 *     "version": 1,
 *     "workspaces": {
 *       "100000001": {
 *         "label": "Example Workspace A",
 *         "database": { "postgresUrl": "${WORKSPACE_A_POSTGRES_URL}", "schema": "w100000001" },
 *         "merchants": { "AEXAMPLE0000001": { "name": "Example Seller A", "countries": ["US", "CA"] } }
 *       }
 *     }
 *   }
 *
 * This file is canonical HERE and symlinked into `mcp-local/src/config.ts` and
 * `client-kit/src/lib/config.ts`. Both packages use this parser so a wsid
 * resolves to the same database in either package. Edit this one; there is no copy step. The symlinks are pinned by
 * `services/tests/unit/mcpSharedSourceSymlinks.test.ts` and
 * `client-kit/tests/unit/packageSymlinks.test.ts`.
 *
 * Consequences, both enforced by those packages' boundary scans, which read
 * THROUGH the symlinks:
 *
 *   - It imports `effect`, `node:` builtins and its sibling
 *     `./amazonConstants.ts`. Every third-party import here
 *     becomes a line every consumer of those packages must carry, and
 *     `client-kit` is consumed as a git submodule whose files resolve against
 *     the CONSUMER's import map.
 *   - It has to live in this directory specifically, beside
 *     `amazonConstants.ts`, because it reaches it relatively. Moving either one
 *     alone breaks the canonical copy, not just the links.
 */

import { Effect, Either } from "effect";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { countryCodeToMarketplaceInfo } from "./amazonConstants.ts";

export interface WorkspaceDatabase {
	readonly postgresUrl: string;
	readonly schema: string;
}

export const TFL_INVENTORY_FEATURE = "tflInventory";

/**
 * The SQL tools carry TWO flags, not one. `sql` enables the read tools
 * (`executeSql`, `listTables`, `describeTable`); `sqlWrite` enables `writeSql`
 * alone. A hosted server announces the read tools in every session but the
 * write tool only in a read-write one, which a single flag cannot express —
 * and expressing it outside the feature mechanism would mean filtering tools
 * by name, which is exactly what the declared access kind exists to avoid.
 */
export const SQL_FEATURE = "sql";
export const SQL_WRITE_FEATURE = "sqlWrite";

export type WorkspaceFeatures = Readonly<Record<string, boolean>>;

export interface Merchant {
	readonly name?: string;
	readonly countries: readonly string[];
}

export interface Workspace {
	readonly wsid: string;
	readonly label?: string;
	readonly database: WorkspaceDatabase;
	readonly merchants: Readonly<Record<string, Merchant>>;
	readonly features?: WorkspaceFeatures;
}

export interface Config {
	readonly workspaces: Readonly<Record<string, Workspace>>;
	/** country code (canonicalised) → wsids that sell there */
	readonly byCountry: ReadonlyMap<string, readonly string[]>;
	/** merchantId → its (single) wsid */
	readonly byMerchant: ReadonlyMap<string, string>;
}

/**
 * A credential-free view of a workspace: everything a directory listing may disclose, and nothing that
 * could open a connection. No `database` field — see `DirectoryWorkspace`.
 */
export interface DirectoryWorkspace {
	readonly wsid: string;
	readonly label?: string;
	readonly merchants?: Readonly<Record<string, Merchant>>;
	readonly features?: WorkspaceFeatures;
}

/**
 * The credential-free shape `registerTools`, `summarizeConfig` and `resolveWorkspace` need: enough to
 * enumerate, describe and select workspaces, with no `database` connection data anywhere in it.
 * `Config` satisfies this structurally (it has everything `WorkspaceDirectory` asks for, plus
 * `database` on each workspace), so every existing caller that constructs and passes a real `Config`
 * keeps compiling unchanged.
 *
 * The lookup maps are `ReadonlyMap` so `Config`'s `Map`-typed fields stay assignable.
 */
export interface WorkspaceDirectory {
	readonly workspaces: Readonly<Record<string, DirectoryWorkspace>>;
	/** country code (canonicalised) → wsids that sell there */
	readonly byCountry: ReadonlyMap<string, readonly string[]>;
	/** merchantId → its (single) wsid */
	readonly byMerchant: ReadonlyMap<string, string>;
}

/** UK is an alias for GB throughout Amazon's data; collapse it for matching. */
function canonCountry(code: string): string {
	const up = code.trim().toUpperCase();
	return up === "UK" ? "GB" : up;
}

/** Replace every `${VAR}` with `process.env.VAR`, collecting any that are unset. */
function expandEnv(raw: string): Either.Either<string, Error> {
	return Either.gen(function* () {
		const missing = new Set<string>();
		const out = yield* Either.try({
			try: () =>
				raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
					const val = process.env[name];
					if (val === undefined || val === "") {
						missing.add(name);
						return "";
					}
					return val;
				}),
			catch: (cause) => new Error("DATABRILL_CONFIG: cannot read environment", { cause }),
		});
		if (missing.size > 0) {
			return yield* Either.left(
				new Error(
					`DATABRILL_CONFIG references undefined environment variable(s): ${[...missing].join(", ")}`,
				),
			);
		}
		return out;
	});
}

function parseFeatures(raw: unknown, source: string): Either.Either<WorkspaceFeatures, Error> {
	return Either.gen(function* () {
		if (raw === undefined) {
			return {};
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return yield* invalidConfig(source, '"features" must be an object of boolean flags');
		}
		const features: Record<string, boolean> = {};
		for (const [name, enabled] of Object.entries(raw)) {
			if (typeof enabled !== "boolean") {
				return yield* invalidConfig(source, `feature "${name}" must be boolean`);
			}
			features[name] = enabled;
		}
		return features;
	});
}

export function workspaceHasFeature(workspace: DirectoryWorkspace, feature: string): boolean {
	return workspace.features?.[feature] === true;
}

/**
 * Load the workspace config from an explicit path or `DATABRILL_CONFIG`, returning
 * `null` when neither is set. Frontends that require routing must reject that null.
 * Fails on a malformed file so a bad config fails at startup rather than
 * mid-request.
 */
export function loadConfig(configPath?: string): Effect.Effect<Config | null, Error> {
	return Effect.gen(function* () {
		const path = yield* Effect.try({
			try: () => configPath ?? process.env["DATABRILL_CONFIG"],
			catch: (cause) => new Error("DATABRILL_CONFIG: cannot read environment", { cause }),
		});
		if (!path) {
			return null;
		}

		const abs = yield* Effect.try({
			try: () => isAbsolute(path) ? path : resolvePath(process.cwd(), path),
			catch: (cause) => new Error("DATABRILL_CONFIG: cannot resolve path", { cause }),
		});
		const text = yield* Effect.tryPromise({
			try: (signal) => readFile(abs, { encoding: "utf8", signal }),
			catch: (cause) => new Error(`DATABRILL_CONFIG: cannot read ${abs}`, { cause }),
		});

		const expanded = yield* expandEnv(text);
		const parsed: unknown = yield* Effect.try({
			try: () => JSON.parse(expanded),
			catch: (cause) => new Error(`DATABRILL_CONFIG: invalid JSON in ${abs}`, { cause }),
		});

		return yield* build(parsed, abs);
	});
}

function invalidConfig(source: string, message: string): Either.Either<never, Error> {
	return Either.left(new Error(`DATABRILL_CONFIG (${source}): ${message}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function build(parsed: unknown, source: string): Either.Either<Config, Error> {
	return Either.gen(function* () {
		if (!isRecord(parsed)) {
			return yield* invalidConfig(source, "root must be an object");
		}
		const rawWorkspaces = parsed["workspaces"];
		if (!isRecord(rawWorkspaces)) {
			return yield* invalidConfig(source, 'missing "workspaces" object');
		}

		const workspaces: Record<string, Workspace> = {};
		const byCountry = new Map<string, string[]>();
		const byMerchant = new Map<string, string>();

		for (const [wsid, ws] of Object.entries(rawWorkspaces)) {
			if (!isRecord(ws)) {
				return yield* invalidConfig(source, `workspace "${wsid}" must be an object`);
			}

			const db = isRecord(ws["database"]) ? ws["database"] : undefined;
			const postgresUrl = db?.["postgresUrl"];
			if (typeof postgresUrl !== "string" || !postgresUrl) {
				return yield* invalidConfig(source, `workspace "${wsid}" missing database.postgresUrl`);
			}
			const schema = typeof db?.["schema"] === "string" && db["schema"] ? db["schema"] : `w${wsid}`;

			const rawMerchants = ws["merchants"];
			if (!isRecord(rawMerchants)) {
				return yield* invalidConfig(source, `workspace "${wsid}" missing "merchants" object`);
			}

			const merchants: Record<string, Merchant> = {};
			for (const [merchantId, m] of Object.entries(rawMerchants)) {
				if (!isRecord(m)) {
					return yield* invalidConfig(source, `merchant "${merchantId}" must be an object`);
				}
				const countriesRaw = m["countries"];
				if (!Array.isArray(countriesRaw) || countriesRaw.length === 0) {
					return yield* invalidConfig(source, `merchant "${merchantId}" needs a non-empty "countries" array`);
				}
				const countries: string[] = [];
				for (const c of countriesRaw) {
					if (typeof c !== "string") {
						return yield* invalidConfig(source, `merchant "${merchantId}" has a non-string country`);
					}
					const canon = canonCountry(c);
					if (!(canon in countryCodeToMarketplaceInfo)) {
						return yield* invalidConfig(source, `merchant "${merchantId}" has unknown country "${c}"`);
					}
					countries.push(canon);
				}

				if (byMerchant.has(merchantId)) {
					return yield* invalidConfig(
						source,
						`merchantId "${merchantId}" appears in workspaces ${byMerchant.get(merchantId)} and ${wsid}`,
					);
				}
				byMerchant.set(merchantId, wsid);
				for (const c of countries) {
					const list = byCountry.get(c) ?? [];
					if (!list.includes(wsid)) {
						list.push(wsid);
					}
					byCountry.set(c, list);
				}

				merchants[merchantId] = {
					name: typeof m["name"] === "string" ? m["name"] : undefined,
					countries,
				};
			}

			workspaces[wsid] = {
				wsid,
				label: typeof ws["label"] === "string" ? ws["label"] : undefined,
				database: { postgresUrl, schema },
				merchants,
				features: yield* parseFeatures(ws["features"], source),
			};
		}

		if (Object.keys(workspaces).length === 0) {
			return yield* invalidConfig(source, '"workspaces" is empty');
		}

		return { workspaces, byCountry, byMerchant };
	});
}

/**
 * Resolve the explicit `wsid` a tool call targets. Missing, blank and unknown
 * values are refused; neither registry size nor `stores` selects a workspace.
 *
 * Generic over the workspace type so this one explicit-resolution rule serves both a file-loaded
 * `Config` (returning a `Workspace`, whose `database` the stdio frontend then reads) and a
 * credential-free `WorkspaceDirectory` (returning only the `wsid` its caller needs). A second
 * implementation of this rule would let one frontend refuse a `wsid` argument the other accepts,
 * or resolve one the other reports as unknown.
 */
export function resolveWorkspace<W extends DirectoryWorkspace>(
	config: { readonly workspaces: Readonly<Record<string, W>> },
	args: Record<string, unknown>,
): Either.Either<W, Error> {
	return Either.gen(function* () {
		const ids = Object.keys(config.workspaces);

		const wsidArg = typeof args["wsid"] === "string" ? args["wsid"].trim() : "";
		if (wsidArg === "") {
			return yield* Either.left(new Error(`Pass "wsid" explicitly (one of: ${ids.join(", ")}).`));
		}
		const workspace = config.workspaces[wsidArg];
		if (workspace === undefined) {
			return yield* Either.left(new Error(`Unknown wsid "${wsidArg}". Configured workspaces: ${ids.join(", ")}`));
		}
		return workspace;
	});
}

/** A JSON-friendly summary of the configured workspaces, for the listWorkspaces tool. */
export function summarizeConfig(config: WorkspaceDirectory): unknown {
	return {
		workspaces: Object.values(config.workspaces).map((w) => ({
			wsid: w.wsid,
			label: w.label,
			merchants: Object.entries(w.merchants ?? {}).map(([merchantId, m]) => ({
				merchantId,
				name: m.name,
				countries: m.countries,
			})),
		})),
	};
}
