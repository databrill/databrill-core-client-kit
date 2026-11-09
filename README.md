# databrill-core-client-kit

The database-access layer and the two commands that every Databrill client repo would otherwise paste into its
own `src/db/` and `scripts/`: a tenant connection factory, a raw-SQL reader, an optional wsid lookup in
`databrill.config.json` (`src/lib/workspaces.ts`), and the `seedCatalog` and `query` commands.

One implementation, consumed by every client repo, instead of a copy per repo that drifts apart on correctness.

## Adding it to a client repo

This package ships as a **git submodule**, the same way `extern/databrill-core-mcp` already does. **The pinned
commit is the version** — there is no registry release and no version number anywhere in the package.

```bash
git submodule add https://github.com/databrill/databrill-core-client-kit.git extern/databrill-core-client-kit
git commit -m "chore: add databrill-core-client-kit"
```

To move to a later version, update the submodule and commit the new pointer:

```bash
git -C extern/databrill-core-client-kit fetch origin main
git -C extern/databrill-core-client-kit checkout <commit>
git add extern/databrill-core-client-kit && git commit -m "chore: bump client-kit"
```

Exclude `extern/` from your own `fmt`, `lint`, `test` and `exclude` lists, as you already do for the other
submodules.

## The import map lines you must carry

**A file imported by path out of `extern/<submodule>/src/` is resolved against YOUR import map, never against
this package's own `deno.json`.** So every bare specifier under `src/` is a line your `deno.json` has to carry:

```jsonc
{
	"imports": {
		"effect": "npm:effect@4.1.2",
		// Needed by everything in this package.
		"@databrill/core-pg-kysely": "npm:@jsr/databrill__core-pg-kysely@^0.1.19",
	},
}
```

Effect is a public dependency, on Effect 4. Use the same Effect version as the consuming application; an
application still on Effect 3 cannot import this package.
The `@databrill/core-pg-kysely` floor above is the lowest release that works, not a suggestion: this
package's `src/` yields the Effect and Result values that `query()`, `destroy()` and `createDb()` return,
and earlier releases return Promises. Inside the monorepo the same import resolves to local pg source.

This package uses one Postgres driver. `@databrill/core-pg-kysely`
opens the pool, and `src/lib/rawSql.ts` runs the statements the typed surface cannot express on that same pool,
through `$1` placeholders. You do not need `postgres`, `pg`, or a driver of your own.

- **`src/lib/workspaces.ts` uses the same Effect dependency**, Node builtins and shared config sources.
- The CLI's platform dependency is CLI-only. The commands take their parser from `effect/cli`, which is
  part of `effect`, and this package's `deno.json` declares `@effect/platform-node` for running them. A command
  run as `deno run -A extern/.../src/cli/query.ts` uses this package's manifest. A consumer importing a CLI
  module directly must also declare `@effect/platform-node`; importing the library does not require it.

## Bun and Node consumers

The package is developed under Deno and runs under Deno, Node and Bun: `src/` uses `node:` builtins and
`process`, never the `Deno` namespace, and a test enforces that. Bun and Node read no import map; they resolve
each bare specifier from the `node_modules` above the importing file, which is your repo's. So your
`package.json` carries the packages instead, and the ones the commands use as well, because a command run by path
under Bun or Node does not see this package's `deno.json`:

```jsonc
{
	"dependencies": {
		"effect": "4.1.2",
		"@databrill/core-pg-kysely": "npm:@jsr/databrill__core-pg-kysely@^0.1.19",
		// Only to run the commands, or to import a file under src/cli/.
		"@effect/platform-node": "4.1.2",
	},
}
```

`@databrill/core-pg-kysely` comes from JSR's npm registry, so add `@jsr:registry=https://npm.jsr.io` to your
`.npmrc`. It depends on `kysely` (`^0.29.8`) and `pg` (`^8.23.1`) itself, so neither needs a line of its own;
list them only if your own code imports them. Keep one copy of `effect`: a version your package manager can
share with `@databrill/core-pg-kysely`'s `4.1.2` pin. The `@effect/*` versions are the ones this package is
tested with; a newer patch release of each works.

`@databrill/core-pg-kysely` needs a `Temporal` global. Bun and Node 26 have one. Node 22 and 24 do not, so add
`temporal-polyfill` and load it before anything connects: `import "temporal-polyfill/global"` in your own
code, or `node --import temporal-polyfill/global` for a command. `--help` and `--check` open no connection and
work without it.

Node runs the `.ts` sources directly through its type stripping, which needs Node 22.18 or later.

## The two task lines

Under Deno, put these in your `deno.json` `tasks` instead of a script in your repo:

```jsonc
{
	"tasks": {
		"seedCatalog": "deno run -A extern/databrill-core-client-kit/src/cli/seedCatalog.ts",
		"query": "deno run -A extern/databrill-core-client-kit/src/cli/query.ts",
	},
}
```

```bash
deno run -A extern/databrill-core-client-kit/src/cli/seedCatalog.ts --brand acme --wsid 123456789
deno run -A extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT count(*) FROM amazon_listing_open"
```

Add `--env-file=.env` to either line if your connection string comes from a `.env`.

Under Bun, the same commands go in `package.json` `scripts`:

```bash
bun --env-file=.env extern/databrill-core-client-kit/src/cli/seedCatalog.ts --brand acme --wsid 123456789
bun --env-file=.env extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT 1"
```

Under Node:

```bash
node --env-file=.env --import temporal-polyfill/global extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT 1"
```

Both commands refuse an option they do not define rather than ignoring it. `--formta json` would otherwise run
with the default format, and a mistyped `--wsid` must never silently select another workspace.

### `query`

| flag                   | what it does                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `--wsid <wsid>`        | Which workspace to run against. Required.                                                        |
| `--file <path>`        | A nonempty path takes precedence over the positional SQL statement; otherwise use the statement. |
| `--format table\|json` | `table` (default) for a terminal, `json` for a pipe.                                             |
| `--root <dir>`         | Where `databrill.config.json` is looked for. Defaults to the current directory.                  |

**There is no default wsid.** Every invocation must pass `--wsid`, even when `databrill.config.json` declares one
workspace. `databrill.config.json` maps that explicit id to a connection string; discovery never selects a target.
The `databrill.config.json` entry is taken at its word: the command opens the pool and runs the statement. Pointing
a wsid at the wrong connection string is a configuration mistake, and it shows up as recognisably wrong data rather
than as an error.

**Table names need no schema prefix.** Your workspace's login role is
provisioned with `ALTER ROLE w{wsid}_ro SET search_path = "w{wsid}"`, which the server applies at session
start — so it survives a transaction-mode pooler, and `FROM amazon_listing_open` finds your table. If a
statement unexpectedly resolves against `public`, the role is missing that setting; that is a provisioning
defect to report, not something to work around in the statement.

Writes are printed as the driver's command tag rather than as rows, because an `UPDATE` with no `RETURNING`
has no rows to print however many it changed: `UPDATE 5000`, `DELETE 3`. Only a `SELECT` that matched nothing
says `(0 rows)`. `--format json` is unaffected — it is for a pipe, and always gives the rows array.

### `seedCatalog`

| flag             | what it does                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `--brand <slug>` | Read `<root>/brands/<slug>/catalog.json`.                                                                      |
| `--file <path>`  | A nonempty path takes precedence over `--brand`; otherwise use the brand's `catalog.json`.                     |
| `--wsid <wsid>`  | Which workspace to write. Required.                                                                            |
| `--root <dir>`   | Where `brands/` and `databrill.config.json` are looked for. Defaults to the current directory.                 |
| `--check`        | Validate the seed and write nothing. `--dry-run` is the same flag, under the name the client-repo script used. |

`brands/<slug>/catalog.json` is a convention of **the command**, not of the library — see "Calling the library
directly" below.

## The `catalog.json` contract

One JSON object with an optional `wsid` and six optional lists, one per table. The lists are given here in the
order they are written, which is foreign-key order: **variants before ASINs, because
`brand_config_amazon_asin.msku` is a foreign key onto `brand_config_ontology_variant.msku`.** `attributes` is
last and unordered — that table has no foreign keys at all.

**Any other top-level key is refused**, rather than ignored: a misspelt `categorys` would otherwise write no
categories and report every other count as expected, with nothing for you to notice.

```json
{
	"wsid": "123456789",
	"properties": [
		{
			"property": "fibre",
			"valueType": "string",
			"appliesTo": "BOTH",
			"valuesAllowed": ["wool", "cotton"],
			"description": "What the item is made of"
		}
	],
	"categories": [
		{
			"category": "yarn",
			"description": "Yarn",
			"data": { "fibre": "wool" }
		}
	],
	"variants": [
		{ "msku": "YRN-01", "category": "yarn", "data": { "weight": "dk" } }
	],
	"families": [
		{
			"family": "classics",
			"category": "yarn",
			"msku": "VIRTUAL-01",
			"label": "Classics",
			"description": null
		}
	],
	"asins": [
		{
			"asin": "B0ABCDEFGH",
			"msku": "YRN-01",
			"family": "classics",
			"labelInFamily": "DK",
			"labelStandalone": null,
			"description": null,
			"countryToFamily": { "US": "classics" },
			"countryToLabelInFamily": { "US": "DK weight" }
		}
	],
	"attributes": [
		{
			"scope": "COUNTRY",
			"scopeId": "",
			"merchantId": "",
			"country": "US",
			"attribute": "VAT_RATE",
			"dateFirst": "2026-01-01",
			"dateLast": null,
			"value": 0.2,
			"currency": null,
			"source": "ACTUAL",
			"confidence": "HIGH",
			"notes": null
		}
	]
}
```

Field by field:

- **`properties`** → `brand_config_ontology_metadata`. `property` and `valueType` are required. `appliesTo` is
  `CATEGORY`, `VARIANT` or `BOTH` and defaults to `BOTH` — the column carries a check constraint on exactly
  those three. `valuesAllowed` is any JSON value, or absent.
- **`categories`** → `brand_config_ontology_category`. `category` is required; `data` is the authored property
  values and defaults to `{}`.
- **`variants`** → `brand_config_ontology_variant`. `msku` and `category` are required, and `category` must be
  one this seed declares.
- **`families`** → `brand_config_amazon_family`. `family` is required. `category`, when given, must be one this
  seed declares. **`msku` here is deliberately not checked against the variants** — that column has no foreign
  key, because a family may name a conceptual or virtual SKU that exists as no variant row.
- **`asins`** → `brand_config_amazon_asin`. `asin` is required and must match
  `^(B0[A-Z0-9]{8}|\d{9}[\dX])$` — a modern ASIN, **or the ISBN a book listing uses as its ASIN**. `msku`, when
  given, must name a variant this seed declares. `family`, when given, must name a family this seed declares.
- **`attributes`** → `brand_config_amazon_attributes`. One row is one attribute value, for one scope node, over
  one effective-dated interval. See the section below — it has more rules than the other five put together,
  because its primary key is six columns wide and none of its mistakes fail loudly on their own.

Everything not listed as required may be absent, `null` or a value, and **the three mean different things on a
row that already exists**:

- **absent**: the column keeps whatever the row holds. A new row gets the column's default (`NULL`, or `BOTH`
  for `appliesTo`).
- **`null`**, or `""` for a text field: the column is cleared. `appliesTo` cannot be empty, so `null` resets it
  to `BOTH`.
- **a value**: the column is set to it.

This is what lets a committed `catalog.json` be re-seeded safely. The SKU mappings and per-country family and
label overrides made through the MCP (an ASIN's `msku`, `countryToFamily`, `countryToLabelInFamily`, a family's
`msku`) are not in a seed file written before them, and a re-seed from that file leaves them as they are. To
remove one, say `null` for it.

The one exception is the ontology `data` and `dataResolved` on categories and variants. `dataResolved` is
computed from `data` and from the category, so both are written on every run, and an absent `data` is `{}`.

- **`wsid`**, when given, is the workspace the seed says it is for. It is **not** the write target — required
  `--wsid` is. The two are checked against each other and a disagreement writes nothing. Say it when the seed
  belongs to one workspace and you want that recorded in the file; leave it out and the command says nothing
  about it.

Three behaviours worth knowing before you run it:

- **`dataResolved` is computed, not required.** The two ontology tables carry the authored values (`data`) and
  the inherited-and-resolved ones (`dataResolved`), and nothing in the database derives the second from the
  first. A category resolves to its own `data`; a variant resolves to its **category's resolved values** with
  the variant's own `data` written over them. State `dataResolved` outright on either and that value is used as
  it stands — and on a category it is also what its variants inherit, so the two escape hatches agree.
- **A seed is the whole configuration, not a fragment.** Every category, variant and family a row references
  must be declared in the same seed; rows already in the database do not count. So adding one ASIN to an
  existing variant means declaring that variant in the seed too. That is what buys the whole check before a
  transaction is opened, rather than a constraint violation raised part-way through one.
- **Every table is upserted on its primary key, and nothing is deleted.** Running the same seed twice is the
  same as running it once. A row the seed restates gets the columns the seed states and keeps the rest, as
  above. A row the seed no longer mentions stays, because deleting it would need to cascade into ASINs and
  families the seed knows nothing about.

A seed is validated in full before anything is written, and every problem is reported at once rather than the
first. `--check` does the validation and stops.

### Scoped attributes

`attributes` writes `brand_config_amazon_attributes` — unit costs, VAT rates, unsellable-return loss, the
brand-registry flag and inventory-planning inputs. One row is **one attribute value, for one scope node, over
one effective-dated interval**, and for a given attribute and date the value comes from the most specific scope
whose interval covers it: `SKU` → `ASIN` → `FAMILY` → `STORE` → `COUNTRY`.

| field        | rule                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`      | One of `SKU`, `ASIN`, `FAMILY`, `STORE`, `COUNTRY`. Required.                                                                                 |
| `scopeId`    | The msku, asin or family name for the first three. **Must be `""` (or absent) for `STORE` and `COUNTRY`**, which apply to everything in them. |
| `merchantId` | A specific merchant, or `""` (the default) meaning every merchant.                                                                            |
| `country`    | Two-letter marketplace code, **already upper case**. Required.                                                                                |
| `attribute`  | The attribute name, **already upper case**. Open-ended: a new one needs no schema change. Required.                                           |
| `dateFirst`  | `YYYY-MM-DD`, inclusive. Required.                                                                                                            |
| `dateLast`   | `YYYY-MM-DD`, **inclusive**. `null` means still in force; absent keeps an existing row's value, and a new row is in force.                    |
| `value`      | A finite number. `UNIT_COGS` is a landed unit cost; `VAT_RATE` is a fraction such as `0.2`. Required.                                         |
| `currency`   | Three-letter ISO code for a cost attribute; absent for a rate.                                                                                |
| `source`     | `ACTUAL`, `INFERRED` or `DEFAULT`. Required.                                                                                                  |
| `confidence` | `HIGH`, `MED` or `LOW`. Required.                                                                                                             |
| `notes`      | Free text, optional.                                                                                                                          |

Three of those are stricter than they look, and each is strict because the mistake it catches is otherwise
**silent** — the row is written, the command reports success, and the value simply never applies:

- **`scopeId` must match `scope`.** A `COUNTRY` row carrying a `scopeId`, or a `SKU` row without one, is a row
  resolution can never select.
- **`country` and `attribute` are not upper-cased for you.** Both are primary-key columns, so `"us"` is not a
  variant spelling of the `"US"` row — it is a different row that every reader which upper-cases will fail to
  find. Refusing it names the value; normalising it would hide a seed that means one thing and says another.
- **An inverted interval is refused.** `dateLast` before `dateFirst` covers no date at all.

**The primary key is all six of `merchantId`, `scope`, `scopeId`, `country`, `attribute`, `dateFirst`.** That
last one is what lets a value have a history: the same attribute for the same scope over a different interval is
a new row, not an overwrite. Two rows identical across all six are reported as a duplicate.

**All four `brand_ontology_*` views populate from a complete seed.** That is the point of seeding the ontology
layer: `brand_ontology_variant` reads straight off `brand_config_ontology_variant`, and
`brand_ontology_amazon_asin` filters to ASINs that resolve to a variant or a family, so a seed with only
families and ASINs succeeds, reports rows written, and leaves the views a reader actually queries empty.

## Calling the library directly

The commands use library operations that take already-parsed input, read no file and print nothing.
Use the catalog functions to seed data, and `raw.rows()` or `raw.result()` to execute SQL directly:

```ts
import { Effect } from "effect";
import {
	acquireTenantDbCache,
	formatRows,
	parseCatalog,
	seedCatalog,
	tenantDb,
} from "./extern/databrill-core-client-kit/src/mod.ts";

const program = Effect.gen(function* () {
	const cache = yield* acquireTenantDbCache();
	const { write, raw } = yield* tenantDb({ postgresUrl, schema: "w123456789" }, { cache });
	const seed = yield* Effect.fromResult(parseCatalog(mySeedObject));
	yield* seedCatalog(write, seed);
	return yield* raw.rows("SELECT 1 AS one");
}).pipe(Effect.scoped);

console.log(formatRows(await Effect.runPromise(program), "table"));
```

`db` is read-only over every published table and view, `write` covers the tables customers are meant to write,
`raw` runs SQL the typed surface cannot express, and all three share one pool.

`destroyAllTenantDbs(cache)` destroys every handle in `cache` and empties it, for shutdown.
`destroyTenantDb(source, cache)` destroys and forgets only the handles opened with the same
`{ postgresUrl, schema }` as `source` (under either `pooler` mode, below) and leaves the rest of the cache open,
for a process that is finished with one workspace. Both use the module cache when `cache` is left out.

### Pool size

```ts
const { db } = yield* tenantDb(source, { pool: { max: 3, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 10_000 } });
```

A pool holds at most 5 connections (`DEFAULT_TENANT_POOL_MAX`) unless `pool.max` says otherwise. Every tenant
login role has a connection limit of 10, shared by every process that connects as it: your dev server, a command
run, the deployed app. `pg`'s own default of 10 would let one process take all of them and fail the next with
`too many connections for role`. `pool` also accepts `min`, `idleTimeoutMillis`, `connectionTimeoutMillis`,
`maxUses`, `maxLifetimeSeconds` and `allowExitOnIdle`, with `pg`'s defaults.

**The first open wins.** `pool` is read when a pool is opened. A later `tenantDb()` call for the same source in
the same cache gets the open handle whatever `pool` it passes, rather than a second pool that would double this
process's share of the role's limit. To change the settings, call `destroyTenantDb(source, cache)` first, or open
into another cache.

### Supabase's transaction pooler is the default

A connection string for Supabase's session pooler (host `*.pooler.supabase.com`, port 5432 or none, user
`<role>.<20-character project ref>`) is opened on port 6543 of the same host, the transaction pooler. In session
mode every open client connection pins a server connection for as long as it is open, so idle pools count against
the role's limit; in transaction mode a server connection is held only while a transaction runs. Any other URL is
opened exactly as written: a direct host, a local one, a self-hosted pooler, or one already on 6543. The query
string is kept, so the `sslmode` rule below applies unchanged.

Nothing in this package needs a session. Pass `pooler: "as-given"` when your own code does, which is when it uses:

- a session-level `SET` (`SET LOCAL` inside a transaction is fine);
- a temporary table across more than one transaction;
- `LISTEN` / `NOTIFY`;
- session-level advisory locks (`pg_advisory_lock`; the `_xact_` forms are fine);
- a cursor declared `WITH HOLD`;
- a named prepared statement.

```ts
const { raw } = yield* tenantDb(source, { pooler: "as-given" });
```

It is an option of the call, not of `databrill.config.json`, because whether a session is needed depends on what
the calling code does, not on where it runs. The two modes never share a handle: the URL actually opened is part
of the cache key.

Database acquisition, raw queries and teardown return lazy `Effect.Effect<A, Error>` programs.
Compose with `yield*` and execute at the application boundary. Synchronous validation (`tbl` and
`assertExplicitSslMode`) returns a `Result.Result` immediately; inside `Effect.gen` compose it with
`yield* Effect.fromResult(…)`, since Effect 4's `Effect.gen` does not accept a yielded `Result`.
`globalTenantDbCache` returns a `Result` and creates or finds its cache immediately;
`moduleTenantDbCache` and `newTenantDbCache` return caches directly.
Catalog validation with `parseCatalog` returns a `Result.Result<Catalog, Error>` immediately.
`seedCatalog` and CLI `main(args)` return lazy Effects; compose them with `yield*`.
CLI `main(args)` returns `Effect.Effect<number, Error | CliError.CliError>`: success or help returns 0,
application failures retain their original Error, and argument errors use `effect/cli`'s `CliError`.
`effect/cli` prints argument errors and the usage; executable entry points print application failures and exit
with 1.

Real Kysely builders still return Promises from `.execute()`;
wrap those native calls with `Effect.tryPromise` when composing them.

`formatRows` and `formatResult` return strings synchronously. Serialization failures propagate to
the caller.
The query CLI captures formatting and printing failures together in its Effect program.

`acquireTenantDbCache()` creates a fresh cache inside an Effect scope and registers its cleanup.
Finish the owning program with `.pipe(Effect.scoped)`: cleanup runs after success, failure or
interruption and completes before the program returns. Cleanup errors become defects and remain
in the Cause alongside work failures. Direct `destroyAllTenantDbs(cache)` calls retain typed
Error failures, attempt every pool and keep failed handles available for retry. Concurrent cleanup
calls share one attempt; cache access waits for active teardown. Module and global caches remain
available for applications that manage a longer lifetime explicitly.

```ts
const program = Effect.gen(function* () {
	const cache = yield* acquireTenantDbCache();
	const { raw } = yield* tenantDb({ postgresUrl, schema: "w123456789" }, { cache });
	return yield* raw.rows("SELECT 1 AS one");
}).pipe(Effect.scoped);

console.log(formatRows(await Effect.runPromise(program), "table"));
```

CLI calls use separate caches and wait for their cleanup. Seeder interruption waits for the
active statement to finish, then rolls back before releasing its pool; this does not promise
server-side query cancellation. Both commands use `effect/cli` with Effect handlers, so failures and
interruption stay in the same Effect runtime. Generated help follows `effect/cli`'s layout, and `--version` reports
`unversioned`, because the client kit is pinned by Git commit. SQL positional tokens beginning with a
dash are refused as unknown options; use `--file` for SQL that starts with a dash.

## TLS: your connection string must say what it wants

Remote database URLs must include an explicit `sslmode`. `tenantDb()` refuses a remote URL without one
before opening a pool. Local hosts (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.localhost`) and
Unix sockets are exempt. Use `sslmode=require` for encryption or `sslmode=disable` for plaintext.
There is no separate option to disable this check.

`createDb()` interprets the TLS options. Its case-sensitive mapping is:

- `disable`: no TLS.
- `allow`, `prefer`, `require`: encryption without certificate verification.
- `verify-full`: certificate and server-identity verification using the system trust store.
- `verify-ca`: requires an explicit `ssl: { ca }` option. `tenantDb()` accepts no TLS options, so this mode
  fails through it. Use `createDb()` directly when
  custom TLS options are needed; its explicit `ssl` option takes precedence over the URL's mode.

Unrecognized or empty mode values are rejected.

## `databrill.config.json`

`src/lib/workspaces.ts` is the **optional** layer that turns a wsid into a database. It is not re-exported from
`src/mod.ts`: if you already know your connection string you never need it, and if you do want it you import it
directly.

```ts
import {
	countries,
	getWorkspace,
	listWsids,
	merchantIds,
} from "./extern/databrill-core-client-kit/src/lib/workspaces.ts";
import { tenantDb } from "./extern/databrill-core-client-kit/src/mod.ts";

// Inside Effect.gen:
const { database } = yield * getWorkspace("123456789");
const { db, raw } = yield * tenantDb({
	postgresUrl: database.postgresUrl,
	schema: database.schema,
});
```

Config discovery and loading return lazy `Effect.Effect<A, Error>` programs.
`getWorkspace`, `listWsids`, `merchantIds` and `countries` compose with `yield*`.
The shared `resolveWorkspace` returns a `Result.Result` synchronously;
`resetWorkspaceConfig` clears the cache synchronously and returns `void`.

The file is discovered in this order, and **nothing in it depends on where this package sits on disk**:

1. an explicit `configPath` option — relative values resolve against `rootDir`;
2. the `DATABRILL_CONFIG` environment variable — absolute values as they stand, relative ones against `rootDir`;
3. an upward search for `databrill.config.json` from `rootDir`, which defaults to `process.cwd()`.

That last default is what makes this work from a submodule. Discovery starting at the current directory finds
your repo's config; discovery starting at this module's own location would find a directory inside
`extern/databrill-core-client-kit/`, report that no workspace configuration is loaded, and never error.

The file's shape:

```json
{
	"workspaces": {
		"123456789": {
			"label": "Example",
			"database": {
				"postgresUrl": "postgres://user:pass@host:6543/postgres?sslmode=require",
				"schema": "w123456789"
			},
			"merchants": {
				"A1B2C3D4E5F6G7": {
					"name": "Example US",
					"countries": ["US", "CA"]
				}
			}
		}
	}
}
```

`schema` defaults to `w<wsid>` when omitted. `${VAR}` in any value is expanded from the environment, so a
connection string can be kept out of the file. A merchant's `countries` may say `UK`; it is stored as `GB`.

For a country code your users type, `canonicalCountryCode` in `src/lib/amazonConstants.ts` does the same
folding: it trims, upper-cases and turns `UK` into `GB`. Use it before comparing or storing a code. The
marketplace table keeps a `UK` entry for the Ads API's spelling, so an unfolded `UK` passes a lookup and then
matches nothing keyed on `GB`.

```ts
import { canonicalCountryCode } from "./extern/databrill-core-client-kit/src/lib/amazonConstants.ts";

canonicalCountryCode(" uk "); // "GB"
```

## Licence and support

Internal Databrill tooling, published so client repos can consume it as a submodule. Issues and changes go
through the `databrill-core-fullstack-1` monorepo, which is where this package is developed.
