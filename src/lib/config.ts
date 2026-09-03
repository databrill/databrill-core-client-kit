/**
 * Multi-workspace config. Optional: when `DATABRILL_CONFIG` points at a JSON
 * file, the stdio frontend routes each tool call to one of several client
 * workspaces (each its own Postgres schema/DB). With no config, the server
 * falls back to a single `POSTGRES_URL` (the original single-client behaviour).
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
 * `client-kit/src/lib/config.ts`. It was authored in `mcp-local/` and moved when
 * `client-kit/` needed the same parser, because the invariant worth having is
 * that a wsid resolves to the same database in both — one file, not two that
 * agree today. Edit this one; there is no copy step. The symlinks are pinned by
 * `services/tests/unit/mcpSharedSourceSymlinks.test.ts` and
 * `client-kit/tests/unit/packageSymlinks.test.ts`.
 *
 * Consequences, both enforced by those packages' boundary scans, which read
 * THROUGH the symlinks:
 *
 *   - It must import nothing beyond `node:` builtins and its sibling
 *     `./amazonConstants.ts`. A `@databrill/*` or third-party import here
 *     becomes a line every consumer of those packages must carry, and
 *     `client-kit` is consumed as a git submodule whose files resolve against
 *     the CONSUMER's import map.
 *   - It has to live in this directory specifically, beside
 *     `amazonConstants.ts`, because it reaches it relatively. Moving either one
 *     alone breaks the canonical copy, not just the links.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { countryCodeToMarketplaceInfo, regionCountryCodes } from "./amazonConstants.ts";

export interface WorkspaceDatabase {
	readonly postgresUrl: string;
	readonly schema: string;
}

export const TFL_INVENTORY_FEATURE = "tflInventory";
const TFL_INVENTORY_ENV = "DATABRILL_TFL_INVENTORY_ENABLED";

/**
 * The SQL tools carry TWO flags, not one. `sql` gates the read tools
 * (`executeSql`, `listTables`, `describeTable`); `sqlWrite` gates `writeSql`
 * alone. A hosted server announces the read tools in every session but the
 * write tool only in a read-write one, which a single flag cannot express —
 * and expressing it outside the feature mechanism would mean filtering tools
 * by name, which is exactly what the declared access kind exists to avoid.
 */
export const SQL_FEATURE = "sql";
const SQL_ENV = "DATABRILL_SQL_ENABLED";
export const SQL_WRITE_FEATURE = "sqlWrite";
const SQL_WRITE_ENV = "DATABRILL_SQL_WRITE_ENABLED";

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

/** Just the lookup maps: what `stores` inference reads, with no workspace map involved. */
type WorkspaceLookups = Pick<WorkspaceDirectory, "byCountry" | "byMerchant">;

/** UK is an alias for GB throughout Amazon's data; collapse it for matching. */
function canonCountry(code: string): string {
	const up = code.trim().toUpperCase();
	return up === "UK" ? "GB" : up;
}

/** Replace every `${VAR}` with `process.env.VAR`, collecting any that are unset. */
function expandEnv(raw: string): string {
	const missing = new Set<string>();
	const out = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
		const val = process.env[name];
		if (val === undefined || val === "") {
			missing.add(name);
			return "";
		}
		return val;
	});
	if (missing.size > 0) {
		throw new Error(
			`DATABRILL_CONFIG references undefined environment variable(s): ${[...missing].join(", ")}`,
		);
	}
	return out;
}

function parseFeatures(raw: unknown, fail: (message: string) => never): WorkspaceFeatures {
	if (raw === undefined) {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		fail('"features" must be an object of boolean flags');
	}
	const features: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(raw)) {
		if (typeof enabled !== "boolean") {
			fail(`feature "${name}" must be boolean`);
		}
		features[name] = enabled;
	}
	return features;
}

function envFlag(name: string): boolean {
	return process.env[name]?.trim().toLowerCase() === "true";
}

/** Feature flags for single-POSTGRES_URL mode, where no workspace config exists. */
export function loadSingleWorkspaceFeatures(): WorkspaceFeatures {
	return {
		[TFL_INVENTORY_FEATURE]: envFlag(TFL_INVENTORY_ENV),
		[SQL_FEATURE]: envFlag(SQL_ENV),
		[SQL_WRITE_FEATURE]: envFlag(SQL_WRITE_ENV),
	};
}

export function workspaceHasFeature(workspace: DirectoryWorkspace, feature: string): boolean {
	return workspace.features?.[feature] === true;
}

/**
 * Load the workspace config from `DATABRILL_CONFIG`, or return `null` when the
 * variable is unset (single-workspace `POSTGRES_URL` mode). Throws on a malformed
 * file so a bad config fails loudly at startup rather than mid-request.
 */
export function loadConfig(): Config | null {
	const path = process.env["DATABRILL_CONFIG"];
	if (!path) return null;

	const abs = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
	let text: string;
	try {
		text = readFileSync(abs, "utf8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`DATABRILL_CONFIG: cannot read ${abs}: ${message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(expandEnv(text));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`DATABRILL_CONFIG: invalid JSON in ${abs}: ${message}`);
	}

	return build(parsed, abs);
}

function build(parsed: unknown, source: string): Config {
	const fail = (msg: string): never => {
		throw new Error(`DATABRILL_CONFIG (${source}): ${msg}`);
	};

	if (typeof parsed !== "object" || parsed === null) fail("root must be an object");
	const rawWorkspaces = (parsed as Record<string, unknown>)["workspaces"];
	if (typeof rawWorkspaces !== "object" || rawWorkspaces === null) {
		fail('missing "workspaces" object');
	}

	const workspaces: Record<string, Workspace> = {};
	const byCountry = new Map<string, string[]>();
	const byMerchant = new Map<string, string>();

	for (const [wsid, rawWs] of Object.entries(rawWorkspaces as Record<string, unknown>)) {
		if (typeof rawWs !== "object" || rawWs === null) fail(`workspace "${wsid}" must be an object`);
		const ws = rawWs as Record<string, unknown>;

		const db = ws["database"] as Record<string, unknown> | undefined;
		const postgresUrl = db?.["postgresUrl"];
		if (typeof postgresUrl !== "string" || !postgresUrl) {
			fail(`workspace "${wsid}" missing database.postgresUrl`);
		}
		const schema = typeof db?.["schema"] === "string" && db["schema"] ? db["schema"] : `w${wsid}`;

		const rawMerchants = ws["merchants"];
		if (typeof rawMerchants !== "object" || rawMerchants === null) {
			fail(`workspace "${wsid}" missing "merchants" object`);
		}

		const merchants: Record<string, Merchant> = {};
		for (const [merchantId, rawM] of Object.entries(rawMerchants as Record<string, unknown>)) {
			if (typeof rawM !== "object" || rawM === null) fail(`merchant "${merchantId}" must be an object`);
			const m = rawM as Record<string, unknown>;
			const countriesRaw = m["countries"];
			if (!Array.isArray(countriesRaw) || countriesRaw.length === 0) {
				fail(`merchant "${merchantId}" needs a non-empty "countries" array`);
			}
			const countries = (countriesRaw as unknown[]).map((c) => {
				if (typeof c !== "string") fail(`merchant "${merchantId}" has a non-string country`);
				const canon = canonCountry(c as string);
				if (!(canon in countryCodeToMarketplaceInfo)) {
					fail(`merchant "${merchantId}" has unknown country "${c}"`);
				}
				return canon;
			});

			if (byMerchant.has(merchantId)) {
				fail(`merchantId "${merchantId}" appears in workspaces ${byMerchant.get(merchantId)} and ${wsid}`);
			}
			byMerchant.set(merchantId, wsid);
			for (const c of countries) {
				const list = byCountry.get(c) ?? [];
				if (!list.includes(wsid)) list.push(wsid);
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
			database: { postgresUrl: postgresUrl as string, schema },
			merchants,
			features: parseFeatures(ws["features"], fail),
		};
	}

	if (Object.keys(workspaces).length === 0) fail('"workspaces" is empty');

	return { workspaces, byCountry, byMerchant };
}

/** Split a `stores` argument (string "US,DE" or array) into raw tokens. */
function tokenize(stores: unknown): string[] {
	if (typeof stores === "string") return stores.split(",");
	if (Array.isArray(stores)) return stores.map((s) => String(s));
	return [];
}

/** Which workspaces could a `stores` argument refer to? (country / merchant / region tokens) */
function candidateWsids(config: WorkspaceLookups, stores: unknown): Set<string> {
	const wsids = new Set<string>();
	for (const raw of tokenize(stores)) {
		const t = raw.trim();
		if (!t || t === "*") continue;

		// {merchantId}-{site} or a bare merchantId
		const dash = t.lastIndexOf("-");
		const merchant = dash > 0 ? t.slice(0, dash) : t;
		if (config.byMerchant.has(merchant)) {
			wsids.add(config.byMerchant.get(merchant)!);
			continue;
		}

		// country code
		const country = canonCountry(t);
		const forCountry = config.byCountry.get(country);
		if (forCountry) {
			for (const w of forCountry) wsids.add(w);
			continue;
		}

		// region (na / eu / fe) — expand to its countries
		const region = t.toUpperCase();
		if (region in regionCountryCodes) {
			for (const cc of regionCountryCodes[region as keyof typeof regionCountryCodes]) {
				for (const w of config.byCountry.get(canonCountry(cc)) ?? []) wsids.add(w);
			}
		}
	}
	return wsids;
}

/**
 * Resolve which workspace a tool call targets. Order: explicit `wsid` → the only
 * configured workspace → inference from the `stores` argument. Throws (listing the
 * options) when the call is ambiguous or names an unknown workspace, so the agent
 * can retry with an explicit `wsid`.
 *
 * Generic over the workspace type so this ONE inference rule serves both a file-loaded
 * `Config` (returning a `Workspace`, whose `database` the stdio frontend then reads) and a
 * credential-free `WorkspaceDirectory` (returning only the `wsid` its caller needs). A second
 * implementation of the order above would let the same `stores` argument pick different
 * workspaces in different frontends.
 */
export function resolveWorkspace<W extends DirectoryWorkspace>(
	config: WorkspaceLookups & { readonly workspaces: Readonly<Record<string, W>> },
	args: Record<string, unknown>,
): W {
	const ids = Object.keys(config.workspaces);

	const wsidArg = typeof args["wsid"] === "string" ? args["wsid"].trim() : "";
	if (wsidArg) {
		const ws = config.workspaces[wsidArg];
		if (!ws) throw new Error(`Unknown wsid "${wsidArg}". Configured workspaces: ${ids.join(", ")}`);
		return ws;
	}

	if (ids.length === 1) return config.workspaces[ids[0]!]!;

	const cands = [...candidateWsids(config, args["stores"])];
	if (cands.length === 1) return config.workspaces[cands[0]!]!;
	if (cands.length > 1) {
		throw new Error(
			`Ambiguous workspace: the stores match ${cands.join(", ")}. Pass "wsid" to choose one.`,
		);
	}
	throw new Error(`Cannot infer the workspace from the arguments. Pass "wsid" (one of: ${ids.join(", ")}).`);
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
