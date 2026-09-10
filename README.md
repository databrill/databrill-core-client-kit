# databrill-core-client-kit

The database-access layer and the two commands that every Databrill client repo would otherwise paste into its
own `src/db/` and `scripts/`: a tenant connection factory, a raw-SQL reader, an optional workspace registry over
`databrill.config.json`, and the `seedCatalog` and `query` commands.

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
		// Needed by everything in this package.
		"@databrill/core-pg-kysely": "npm:@jsr/databrill__core-pg-kysely@^0.1.7"
	}
}
```

That is the whole list — one line, because this package uses one Postgres driver. `@databrill/core-pg-kysely`
opens the pool, and `src/lib/rawSql.ts` runs the statements the typed surface cannot express on that same pool,
through `$1` placeholders. You do not need `postgres`, `pg`, or a driver of your own.

- **`src/lib/workspaces.ts` adds nothing.** It imports `node:fs`, `node:path`, `node:process` and its sibling
  `src/lib/config.ts`, which in turn imports only `node:fs`, `node:path` and `src/lib/amazonConstants.ts`, which imports
  nothing at all. The registry layer is free.
- **`cmd-ts` is NOT on the list**, although this package's own `deno.json` declares it. It is imported only by
  files under `src/cli/`, and a command is run as `deno run -A extern/.../src/cli/query.ts` — where the
  entry point is inside this package, so Deno discovers *this* package's `deno.json` and resolves against it.
  You need `cmd-ts` in your own map only if you import a file under `src/cli/` from your own code, which the
  library halves below exist to make unnecessary.

## The two task lines

Put these in your `deno.json` `tasks` instead of a script in your repo:

```jsonc
{
	"tasks": {
		"seedCatalog": "deno run -A extern/databrill-core-client-kit/src/cli/seedCatalog.ts",
		"query": "deno run -A extern/databrill-core-client-kit/src/cli/query.ts"
	}
}
```

```bash
deno run -A extern/databrill-core-client-kit/src/cli/seedCatalog.ts --brand acme --wsid 123456789
deno run -A extern/databrill-core-client-kit/src/cli/query.ts --wsid 123456789 "SELECT count(*) FROM amazon_listing_open"
```

Add `--env-file=.env` to either line if your connection string comes from a `.env`.

Both commands refuse an option they do not define rather than ignoring it. `--formta json` would otherwise run
with the default format, and a mistyped `--wsid` must never silently select another workspace.

### `query`

| flag | what it does |
| --- | --- |
| `--wsid <wsid>` | Which workspace to run against. Required. |
| `--file <path>` | A nonempty path takes precedence over the positional SQL statement; otherwise use the statement. |
| `--format table\|json` | `table` (default) for a terminal, `json` for a pipe. |
| `--root <dir>` | Where `databrill.config.json` is looked for. Defaults to the current directory. |

**There is no default wsid.** Every invocation must pass `--wsid`, even when the registry declares one
workspace. The registry maps that explicit id to a server-side credential; discovery never selects a target.
The registry entry is taken at its word: the command opens the pool and runs the statement. Pointing a wsid
at the wrong connection string is a configuration mistake, and it shows up as recognisably wrong data rather
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

| flag | what it does |
| --- | --- |
| `--brand <slug>` | Read `<root>/brands/<slug>/catalog.json`. |
| `--file <path>` | A nonempty path takes precedence over `--brand`; otherwise use the brand's `catalog.json`. |
| `--wsid <wsid>` | Which workspace to write. Required. |
| `--root <dir>` | Where `brands/` and `databrill.config.json` are looked for. Defaults to the current directory. |
| `--check` | Validate the seed and write nothing. `--dry-run` is the same flag, under the name the client-repo script used. |

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
		{ "category": "yarn", "description": "Yarn", "data": { "fibre": "wool" } }
	],
	"variants": [
		{ "msku": "YRN-01", "category": "yarn", "data": { "weight": "dk" } }
	],
	"families": [
		{ "family": "classics", "category": "yarn", "msku": "VIRTUAL-01", "label": "Classics", "description": null }
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

Everything not listed as required may be absent or `null`.

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
  must be declared in the *same* seed; rows already in the database do not count. So adding one ASIN to an
  existing variant means declaring that variant in the seed too. That is what buys the whole check before a
  transaction is opened, rather than a constraint violation raised part-way through one.
- **Every table is upserted on its primary key, and nothing is deleted.** Running the same seed twice is the
  same as running it once, and re-stating a row the database already has changes nothing about it. A row the
  seed no longer mentions stays, because deleting it would need to cascade into ASINs and families the seed
  knows nothing about.

A seed is validated in full before anything is written, and every problem is reported at once rather than the
first. `--check` does the validation and stops.

### Scoped attributes

`attributes` writes `brand_config_amazon_attributes` — unit costs, VAT rates, unsellable-return loss, the
brand-registry flag and inventory-planning inputs. One row is **one attribute value, for one scope node, over
one effective-dated interval**, and for a given attribute and date the value comes from the most specific scope
whose interval covers it: `SKU` → `ASIN` → `FAMILY` → `STORE` → `COUNTRY`.

| field | rule |
| --- | --- |
| `scope` | One of `SKU`, `ASIN`, `FAMILY`, `STORE`, `COUNTRY`. |
| `scopeId` | The msku, asin or family name for the first three. **Must be `""` (or absent) for `STORE` and `COUNTRY`**, which apply to everything in them. |
| `merchantId` | A specific merchant, or `""` (the default) meaning every merchant. |
| `country` | Two-letter marketplace code, **already upper case**. |
| `attribute` | The attribute name, **already upper case**. Open-ended: a new one needs no schema change. |
| `dateFirst` | `YYYY-MM-DD`, inclusive. Required. |
| `dateLast` | `YYYY-MM-DD`, **inclusive**. Absent or `null` means still in force. |
| `value` | A finite number. `UNIT_COGS` is a landed unit cost; `VAT_RATE` is a fraction such as `0.2`. |
| `currency` | Three-letter ISO code for a cost attribute; absent for a rate. |
| `source` | `ACTUAL`, `INFERRED` or `DEFAULT`. |
| `confidence` | `HIGH`, `MED` or `LOW`. |
| `notes` | Free text, optional. |

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

Both commands are a thin shell over a library function that takes already-parsed input, reads no file and prints
nothing. Import those when you build a seed or a statement some other way:

```ts
import {
	destroyAllTenantDbs,
	formatRows,
	parseCatalog,
	runQuery,
	seedCatalog,
	tenantDb,
} from "./extern/databrill-core-client-kit/src/mod.ts";

const { db, write, raw } = tenantDb({ postgresUrl, schema: "w123456789" });

await seedCatalog(write, parseCatalog(mySeedObject));
console.log(formatRows([...await runQuery(raw, "SELECT 1 AS one")], "table"));

await destroyAllTenantDbs();
```

`db` is read-only over every published table and view, `write` covers the tables customers are meant to write,
`raw` runs SQL the typed surface cannot express, and all three share one pool.

## TLS: your connection string must say what it wants

Remote database URLs must include an explicit `sslmode`. `tenantDb()` refuses a remote URL without one
before opening a pool. Local hosts (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.localhost`) and
Unix sockets are exempt. Use `sslmode=require` for encryption or `sslmode=disable` for plaintext.
There is no separate option to disable this check.

`createDb()` interprets the TLS options. Its case-sensitive mapping is:

- `disable`: no TLS.
- `allow`, `prefer`, `require`: encryption without certificate verification.
- `verify-full`: certificate and server-identity verification using the system trust store.
- `verify-ca`: requires an explicit `ssl: { ca }` option. The kit's connection interface accepts only
  `postgresUrl` and `schema`, so this mode fails through `tenantDb()`. Use `createDb()` directly when
  custom TLS options are needed; its explicit `ssl` option takes precedence over the URL's mode.

Unrecognized or empty mode values are rejected.

## `databrill.config.json`

`src/lib/workspaces.ts` is the **optional** layer that turns a wsid into a database. It is not re-exported from
`src/mod.ts`: if you already know your connection string you never need it, and if you do want it you import it
directly.

```ts
import { countries, getWorkspace, listWsids, merchantIds } from "./extern/databrill-core-client-kit/src/lib/workspaces.ts";
import { tenantDb } from "./extern/databrill-core-client-kit/src/mod.ts";

const { database } = getWorkspace("123456789");
const { db, raw } = tenantDb({ postgresUrl: database.postgresUrl, schema: database.schema });
```

The file is discovered in this order, and **nothing in it depends on where this package sits on disk**:

1. an explicit `configPath` option — relative values resolve against `rootDir`;
2. the `DATABRILL_CONFIG` environment variable — absolute values as they stand, relative ones against `rootDir`;
3. an upward search for `databrill.config.json` from `rootDir`, which defaults to `process.cwd()`.

That last default is what makes this work from a submodule. Discovery starting at the current directory finds
*your* repo's config; discovery starting at this module's own location would find a directory inside
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
			"merchants": { "A1B2C3D4E5F6G7": { "name": "Example US", "countries": ["US", "CA"] } }
		}
	}
}
```

`schema` defaults to `w<wsid>` when omitted. `${VAR}` in any value is expanded from the environment, so a
connection string can be kept out of the file.

## Licence and support

Internal Databrill tooling, published so client repos can consume it as a submodule. Issues and changes go
through the `databrill-core-fullstack-1` monorepo, which is where this package is developed.
