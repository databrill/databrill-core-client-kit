/**
 * Seeding a workspace's brand configuration: the ontology layer, the product
 * families, and the per-ASIN configuration, from one parsed seed object.
 *
 * This is the LIBRARY half of the `seedCatalog` command. It takes a seed that
 * has already been parsed from somewhere — a `brands/<slug>/catalog.json` in
 * the consumer's repo, a spreadsheet export, a fixture built in a test — and
 * never reads a file, never looks at the process arguments and never prints
 * usage. The command that does those things is `./cli/seedCatalog.ts`, and the
 * `brands/<slug>/catalog.json` layout is a convention of that command alone.
 *
 * ## Order of writes, and why it is not an implementation detail
 *
 * Five of the six tables form a chain of foreign keys:
 *
 * ```
 * brand_config_ontology_metadata     (no references)
 * brand_config_ontology_category     (no references)
 * brand_config_ontology_variant      category -> ontology_category.category
 * brand_config_amazon_family         category -> ontology_category.category
 * brand_config_amazon_asin           msku     -> ontology_variant.msku
 *                                    family   -> amazon_family.family
 * brand_config_amazon_attributes     (none — see below)
 * ```
 *
 * {@link seedCatalog} writes them in exactly that order, in one transaction.
 * **Variants before ASINs: `brand_config_amazon_asin.msku` references them.**
 * Attributes are written last and have no ordering requirement at all: that
 * table has no foreign keys, because its scope columns are polymorphic —
 * `scopeId` holds a sku, an asin or a family name depending on `scope`, and one
 * column cannot reference three tables.
 *
 * The ontology tables must be seeded for the `brand_ontology_*` views to
 * return data. `brand_ontology_variant` reads straight off
 * `brand_config_ontology_variant`, and `brand_ontology_amazon_asin` filters to
 * ASINs that resolve to a variant or a family, so with no variants and no
 * categories the two views a reader actually queries return nothing at all
 * while every write reported success. Seeding all five is what makes the four
 * `brand_ontology_*` views populate.
 *
 * ## What is validated before anything is written
 *
 * {@link parseCatalog} is a pure function and does the whole check up
 * front, reporting every problem it found rather than the first. Two of its
 * rules exist because of a specific failure:
 *
 * - **An ASIN's `msku` must name a variant declared in the same seed.**
 *   `brand_config_amazon_asin.msku` is a foreign key onto
 *   `brand_config_ontology_variant.msku`, so an unknown one is a constraint
 *   violation raised in the middle of a transaction, naming a constraint rather
 *   than the row that caused it. Checking it here turns that into a message
 *   naming the ASIN, the msku, and the fact that no such variant is declared.
 * - **An ASIN may be an ISBN.** {@link ASIN_PATTERN} accepts `B0` followed by
 *   eight alphanumerics, OR a ten-character ISBN-10 (nine digits and a check
 *   character that may be `X`). Book listings carry the ISBN as the ASIN, and a
 *   pattern of `/^B0[A-Z0-9]{8}$/` rejects every one of them.
 * - **An unrecognised top-level key is refused**, not ignored — see
 *   {@link SEED_KEYS}.
 * - **A scoped attribute's `scopeId` must match its `scope`.** `SKU`, `ASIN` and
 *   `FAMILY` name a thing; `STORE` and `COUNTRY` apply to everything and carry
 *   `""`. The wrong way round writes a row that resolution can never select,
 *   which is a value silently not applied rather than an error. The same
 *   reasoning covers the upper-case checks on `country` and `attribute`: those
 *   two are primary-key columns, so a lower-case value is not a variant spelling
 *   of a row, it is a second row nothing will ever look up.
 *
 * ## `dataResolved`
 *
 * The two ontology tables carry both the authored property values (`data`) and
 * the inherited-and-resolved ones (`dataResolved`); nothing in the database
 * computes the second from the first. This seeder resolves a category as its own
 * `data`, since the schema gives a category no parent, and a variant as its
 * CATEGORY'S RESOLVED values with the variant's own `data` written over them.
 *
 * A seed may state `dataResolved` outright on either, and then that value is
 * used as it stands — and, for a category, is also what its variants inherit.
 * Inheriting the category's authored `data` instead would make the two escape
 * hatches disagree: a category stating `dataResolved` with an empty `data` would
 * hand its variants nothing, and write variant rows whose resolved values
 * contradict their own category's.
 *
 * ## A seed is the whole configuration, not a fragment
 *
 * Every category, variant and family a row references must be declared in the
 * SAME seed — {@link parseCatalog} refuses one that is not, rather than
 * letting it become a constraint violation raised mid-transaction. Rows already
 * in the database do not count, so a seed that adds one ASIN to an existing
 * variant has to declare that variant too. That is the cost of validating the
 * whole thing before opening a transaction, and it is not in tension with
 * nothing being deleted: writing is an upsert per row.
 *
 * ## A key the seed leaves out is a column the seed leaves alone
 *
 * The configuration tables are also written through the MCP: SKU mappings,
 * per-country family and label overrides. A seed file committed before those
 * edits does not mention them, and re-seeding from it must not erase them. So
 * every optional column follows one rule:
 *
 * - **key absent** — an existing row keeps its value; a new row gets the
 *   column's default (`NULL`, or `'BOTH'` for `appliesTo`);
 * - **`null`, or `""` for a text column** — the column is cleared;
 * - **a value** — the column is set to it.
 *
 * {@link parseCatalog} keeps the first two apart: an absent key is `undefined`
 * on the parsed row and an explicit one is `null`. The writer puts a column in
 * `ON CONFLICT … DO UPDATE SET` only for rows that state it, and since one
 * statement has one `SET` list, it writes each table in one insert per set of
 * stated columns — see {@link groupByStatedColumns}.
 *
 * The exception is the ontology `data` and `dataResolved`. `dataResolved` is
 * computed from `data` and from the category, so both are written on every
 * run, and an absent `data` is `{}`.
 */

import type { Json, TenantDb } from "@databrill/core-pg-kysely";
import { DateTime, Effect, Exit, Result } from "effect";
import { combineCauses } from "./effectCompat.ts";
import { tryOrOperationError, tryPromiseOrOperationError } from "./effects.ts";
import { makeCompositeKey } from "./makeCompositeKey.ts";

/**
 * A valid Amazon ASIN, or the ISBN a book listing uses in its place.
 *
 * `B0` plus eight alphanumerics is the modern ASIN. The second arm is an
 * ISBN-10: nine digits and a check character that is a digit or `X`. Books
 * listed on Amazon keep their ISBN as their ASIN, so a pattern that only
 * accepts the first arm rejects a real, sellable listing.
 */
export const ASIN_PATTERN = /^(B0[A-Z0-9]{8}|\d{9}[\dX])$/;

/** What an ontology property may be declared against. */
export const ONTOLOGY_APPLIES_TO = ["CATEGORY", "VARIANT", "BOTH"] as const;

/** One of {@link ONTOLOGY_APPLIES_TO}. */
export type OntologyAppliesTo = typeof ONTOLOGY_APPLIES_TO[number];

/**
 * A row of `brand_config_ontology_metadata`: one declared ontology property.
 *
 * In this and every row type below, an optional field left `undefined` means
 * the seed did not state it: an existing row keeps its value. `null` clears the
 * column. See the module docblock.
 */
export interface OntologyPropertySeed {
	readonly property: string;
	readonly valueType: string;
	/** `null` in the seed resets the column to its default, `BOTH`. */
	readonly appliesTo?: OntologyAppliesTo;
	readonly valuesAllowed?: Json | null;
	readonly description?: string | null;
}

/** A row of `brand_config_ontology_category`. */
export interface OntologyCategorySeed {
	readonly category: string;
	readonly description?: string | null;
	readonly data: Readonly<Record<string, Json>>;
	/** Stated outright, or resolved from {@link data}; see the module docblock. */
	readonly dataResolved: Readonly<Record<string, Json>> | null;
}

/** A row of `brand_config_ontology_variant`: one merchant SKU in a category. */
export interface OntologyVariantSeed {
	readonly msku: string;
	readonly category: string;
	readonly data: Readonly<Record<string, Json>>;
	/** Stated outright, or resolved from the category and {@link data}. */
	readonly dataResolved: Readonly<Record<string, Json>> | null;
}

/** A row of `brand_config_amazon_family`. */
export interface AmazonFamilySeed {
	readonly family: string;
	readonly category?: string | null;
	readonly msku?: string | null;
	readonly label?: string | null;
	readonly description?: string | null;
}

/**
 * What a scoped attribute may be attached to, most specific first.
 *
 * This is the order `brand_config_amazon_attributes` resolves in — for a given
 * attribute and date, the value comes from the most specific scope whose
 * interval covers that date. The order is stated in the table's own schema and
 * is why {@link AmazonAttributeSeed.scopeId} means different things per scope.
 */
export const ATTRIBUTE_SCOPES = ["SKU", "ASIN", "FAMILY", "STORE", "COUNTRY"] as const;

/** One of {@link ATTRIBUTE_SCOPES}. */
export type AttributeScope = typeof ATTRIBUTE_SCOPES[number];

/** The scopes whose `scopeId` names a thing. The other two carry `""`. */
const SCOPES_WITH_ID: readonly AttributeScope[] = ["SKU", "ASIN", "FAMILY"];

/** How a value was arrived at. `brand_config_amazon_attributes.source`. */
export const ATTRIBUTE_SOURCES = ["ACTUAL", "INFERRED", "DEFAULT"] as const;

/** How much the value is trusted. `brand_config_amazon_attributes.confidence`. */
export const ATTRIBUTE_CONFIDENCES = ["HIGH", "MED", "LOW"] as const;

/** `YYYY-MM-DD`, which is what both date columns are. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A row of `brand_config_amazon_attributes`: one attribute value, for one scope
 * node, over one effective-dated interval.
 *
 * The table is attribute-oriented on purpose, so a new attribute needs no schema
 * change — `attribute` is an open, upper-case name (`UNIT_COGS`, `VAT_RATE`,
 * `LEAD_TIME_DAYS`, …) and this seeder does not police the list.
 *
 * `dateLast` is INCLUSIVE, and `null` means the value is still in force.
 */
export interface AmazonAttributeSeed {
	/** A specific merchant, or `""` meaning every merchant in the workspace. */
	readonly merchantId: string;
	readonly scope: AttributeScope;
	/** The sku, asin or family name; `""` for the `STORE` and `COUNTRY` scopes. */
	readonly scopeId: string;
	/** Upper-case marketplace country code. */
	readonly country: string;
	/** Upper-case attribute name. */
	readonly attribute: string;
	/** Interval start, inclusive, `YYYY-MM-DD`. */
	readonly dateFirst: string;
	/** Interval end, INCLUSIVE. `null` means still in force. */
	readonly dateLast?: string | null;
	readonly value: number;
	/** ISO currency for a cost attribute; `null` for a rate. */
	readonly currency?: string | null;
	readonly source: string;
	readonly confidence: string;
	readonly notes?: string | null;
}

/** A row of `brand_config_amazon_asin`. */
export interface AmazonAsinSeed {
	readonly asin: string;
	readonly msku?: string | null;
	readonly family?: string | null;
	readonly countryToFamily?: Readonly<Record<string, Json>> | null;
	readonly labelInFamily?: string | null;
	readonly countryToLabelInFamily?: Readonly<Record<string, Json>> | null;
	readonly labelStandalone?: string | null;
	readonly description?: string | null;
}

/**
 * A whole brand configuration, validated and ready to write.
 *
 * The five lists are in foreign-key order, which is also the order
 * {@link seedCatalog} writes them in.
 */
export interface Catalog {
	/**
	 * The workspace the seed says it is for, or `null` when it does not say.
	 *
	 * {@link seedCatalog} does not read it — it writes wherever the handle it
	 * was given points. It is here so a CALLER can check the two agree, which
	 * `../cli/seedCatalog.ts` does: a seed that names a workspace and a command
	 * that resolves a different one is the one mistake in this file with no
	 * symptom, because writing a brand's whole configuration into the wrong
	 * workspace succeeds.
	 */
	readonly wsid: string | null;
	readonly properties: readonly OntologyPropertySeed[];
	readonly categories: readonly OntologyCategorySeed[];
	readonly variants: readonly OntologyVariantSeed[];
	readonly families: readonly AmazonFamilySeed[];
	readonly asins: readonly AmazonAsinSeed[];
	/**
	 * Scoped attributes. Last, and outside the foreign-key chain: the table has
	 * NO foreign keys, because its scope columns are polymorphic — `scopeId`
	 * holds a sku, an asin or a family name depending on `scope`, and no one
	 * column can reference three tables.
	 */
	readonly attributes: readonly AmazonAttributeSeed[];
}

/**
 * Every key {@link parseCatalog} understands at the top level of a seed.
 *
 * An unknown one is refused rather than ignored, because ignoring one is
 * indistinguishable from a completely successful run: a misspelt `categorys`
 * writes no categories and reports every other count as expected, and there is
 * nothing for a reader to notice. See `README.md` § "catalog.json contract".
 */
const SEED_KEYS = ["wsid", "properties", "categories", "variants", "families", "asins", "attributes"] as const;

/**
 * Everything wrong with a seed, in one throw.
 *
 * One error carrying every problem rather than a throw at the first: a seed
 * file is edited by hand, and fixing one typo per run is the shape of a tool
 * nobody wants to use twice.
 */
export class SeedValidationError extends Error {
	/** One message per problem, in the order the seed declares the rows. */
	readonly problems: readonly string[];

	constructor(source: string, problems: readonly string[]) {
		super(
			`${source} is not a valid families seed (${problems.length} ${
				problems.length === 1 ? "problem" : "problems"
			}):\n  - ${problems.join("\n  - ")}`,
		);
		this.name = "SeedValidationError";
		this.problems = problems;
	}
}

/** How many rows {@link seedCatalog} wrote into each table. */
export interface SeedCatalogResult {
	readonly properties: number;
	readonly categories: number;
	readonly variants: number;
	readonly families: number;
	readonly asins: number;
	readonly attributes: number;
}

/** Options for {@link parseCatalog}. */
export interface ParseCatalogOptions {
	/**
	 * What to call the seed in error messages — a file path from a CLI, or
	 * whatever a caller building a seed in memory wants a reader to recognise.
	 */
	readonly source?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert an already-parsed JSON value to the `Json` type the column takes.
 *
 * `JSON.parse` gives back `unknown`, and the column type is a closed recursive
 * union; walking the value is how the two are connected without a type
 * assertion. Anything JSON cannot hold (an `undefined` inside an object, a
 * function) is reported rather than dropped.
 */
function toJson(value: unknown, path: string, problems: string[]): Json {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			problems.push(`${path}: ${String(value)} is not a value JSON can hold`);
			return null;
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown, index: number): Json => toJson(item, `${path}[${index}]`, problems));
	}
	if (isRecord(value)) {
		const out: Record<string, Json> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = toJson(item, `${path}.${key}`, problems);
		}
		return out;
	}
	problems.push(`${path}: ${typeof value} is not a value JSON can hold`);
	return null;
}

/** A JSON object, or `{}` when the field is absent. Anything else is a problem. */
function objectField(
	row: Record<string, unknown>,
	key: string,
	path: string,
	problems: string[],
): Record<string, Json> {
	const value = row[key];
	if (value === undefined || value === null) {
		return {};
	}
	if (!isRecord(value)) {
		problems.push(`${path}.${key}: expected an object of property values`);
		return {};
	}
	const out: Record<string, Json> = {};
	for (const [name, item] of Object.entries(value)) {
		out[name] = toJson(item, `${path}.${key}.${name}`, problems);
	}
	return out;
}

/**
 * A JSON object, `null` when the seed says `null`, or `undefined` when the key
 * is absent. `{}` is different from all three here.
 */
function nullableObjectField(
	row: Record<string, unknown>,
	key: string,
	path: string,
	problems: string[],
): Record<string, Json> | null | undefined {
	const value = row[key];
	if (value === undefined || value === null) {
		return value;
	}
	return objectField(row, key, path, problems);
}

/** A non-empty string, or a recorded problem and `""`. */
function requiredString(row: Record<string, unknown>, key: string, path: string, problems: string[]): string {
	const value = row[key];
	if (typeof value !== "string" || value.trim() === "") {
		problems.push(`${path}.${key}: expected a non-empty string`);
		return "";
	}
	return value;
}

/**
 * A string, `null` when the seed says `null`, or `undefined` when the key is
 * absent. An empty string is `null` too: a blank cell states the column and
 * leaves it empty, which is different from a column the seed does not mention.
 */
function optionalString(
	row: Record<string, unknown>,
	key: string,
	path: string,
	problems: string[],
): string | null | undefined {
	const value = row[key];
	if (value === undefined) {
		return undefined;
	}
	if (value === null || value === "") {
		return null;
	}
	if (typeof value !== "string") {
		problems.push(`${path}.${key}: expected a string`);
		return null;
	}
	return value;
}

/**
 * A required string that must already be upper case, or a recorded problem.
 *
 * Not upper-cased for the caller. `country` and `attribute` are both PRIMARY KEY
 * columns of `brand_config_amazon_attributes`, so `"us"` is not a variant
 * spelling of the `"US"` row — it is a different row, which every reader that
 * upper-cases (this package's own `countries()` included) will fail to find. A
 * silent normalisation would hide a seed that means one thing and says another;
 * a refusal names the value and the fix is one keystroke.
 */
function upperCaseField(
	row: Record<string, unknown>,
	key: string,
	path: string,
	problems: string[],
): string {
	const value = requiredString(row, key, path, problems);
	if (value !== "" && value !== value.toUpperCase()) {
		problems.push(`${path}.${key}: expected upper case, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * A member of a closed set of allowed values, or `null` and a recorded problem
 * naming all of them.
 *
 * `null` rather than a substituted default so a caller can SKIP the checks that
 * depend on this value. An unknown `scope` standing in as `SKU` would otherwise
 * go on to fail the `scopeId` rule too, and report two problems for one typo.
 */
function enumField(
	row: Record<string, unknown>,
	key: string,
	allowed: readonly string[],
	path: string,
	problems: string[],
): string | null {
	const value = row[key];
	if (typeof value === "string" && allowed.includes(value)) {
		return value;
	}
	problems.push(`${path}.${key}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
	return null;
}

/**
 * A `YYYY-MM-DD` date that is also a real one, or a recorded problem.
 *
 * The pattern alone accepts `2026-02-31`, which the `DATE` column rejects only
 * once the transaction is open — the round trip through `Date` is what turns
 * that into a problem reported beside every other one.
 */
function dateField(value: string, key: string, path: string, problems: string[]): void {
	if (!DATE_PATTERN.test(value)) {
		problems.push(`${path}.${key}: expected a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
		return;
	}
	if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
		problems.push(`${path}.${key}: ${JSON.stringify(value)} is not a real date`);
	}
}

/** The rows of one top-level list, each checked to be an object. */
function rowsOf(seed: Record<string, unknown>, key: string, problems: string[]): readonly Record<string, unknown>[] {
	const value = seed[key];
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		problems.push(`${key}: expected an array`);
		return [];
	}
	const rows: Record<string, unknown>[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const row: unknown = value[index];
		if (!isRecord(row)) {
			problems.push(`${key}[${index}]: expected an object`);
			continue;
		}
		rows.push(row);
	}
	return rows;
}

/** Record a problem for every key that appears more than once in a list. */
function reportDuplicates(key: string, values: readonly string[], problems: string[]): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (value === "") {
			continue;
		}
		if (seen.has(value)) {
			problems.push(`${key}: ${JSON.stringify(value)} is declared more than once`);
		}
		seen.add(value);
	}
}

/**
 * Check an already-parsed seed and return it in the shape {@link seedCatalog}
 * writes, or fail with a {@link SeedValidationError} listing everything wrong.
 *
 * Pure: no file is read, no connection is opened, and the same input always
 * gives the same answer — which is what lets the two rules that matter most (an
 * ASIN's `msku` naming a declared variant, and an ASIN that may be an ISBN) be
 * tested without a database.
 */
export function parseCatalog(value: unknown, options: ParseCatalogOptions = {}): Result.Result<Catalog, Error> {
	return Result.flatMap(
		tryOrOperationError(() => parseCatalogSub(value, options)),
		(result) => result instanceof SeedValidationError ? Result.fail(result) : Result.succeed(result),
	);
}

function parseCatalogSub(value: unknown, options: ParseCatalogOptions = {}): Catalog | SeedValidationError {
	const source = options.source ?? "the seed";
	const problems: string[] = [];

	if (!isRecord(value)) {
		return new SeedValidationError(source, ["expected a JSON object at the top level"]);
	}

	for (const key of Object.keys(value)) {
		if (!SEED_KEYS.some((allowed: string): boolean => allowed === key)) {
			problems.push(`${JSON.stringify(key)}: not a key of a families seed (known: ${SEED_KEYS.join(", ")})`);
		}
	}

	// Not `requiredString`: a seed built in memory by a caller that already knows
	// which handle it is writing through has nothing to name.
	const wsid = optionalString(value, "wsid", "seed", problems) ?? null;

	const properties: OntologyPropertySeed[] = [];
	for (const [index, row] of rowsOf(value, "properties", problems).entries()) {
		const path = `properties[${index}]`;
		const property = requiredString(row, "property", path, problems);
		const rawAppliesTo = row["appliesTo"];
		// The column is NOT NULL, so clearing it means its default.
		let appliesTo: OntologyAppliesTo | undefined = rawAppliesTo === null ? "BOTH" : undefined;
		if (rawAppliesTo !== undefined && rawAppliesTo !== null) {
			const match = ONTOLOGY_APPLIES_TO.find((allowed: OntologyAppliesTo): boolean => allowed === rawAppliesTo);
			if (match === undefined) {
				problems.push(
					`${path}.appliesTo: expected one of ${ONTOLOGY_APPLIES_TO.join(", ")}, got ${
						JSON.stringify(rawAppliesTo)
					}`,
				);
			} else {
				appliesTo = match;
			}
		}
		const rawValuesAllowed = row["valuesAllowed"];
		properties.push({
			property,
			valueType: requiredString(row, "valueType", path, problems),
			appliesTo,
			valuesAllowed: rawValuesAllowed === undefined || rawValuesAllowed === null
				? rawValuesAllowed
				: toJson(rawValuesAllowed, `${path}.valuesAllowed`, problems),
			description: optionalString(row, "description", path, problems),
		});
	}
	reportDuplicates(
		"properties",
		properties.map((row: OntologyPropertySeed): string => row.property),
		problems,
	);

	const categories: OntologyCategorySeed[] = [];
	for (const [index, row] of rowsOf(value, "categories", problems).entries()) {
		const path = `categories[${index}]`;
		categories.push({
			category: requiredString(row, "category", path, problems),
			description: optionalString(row, "description", path, problems),
			data: objectField(row, "data", path, problems),
			// Absent and null both mean "resolve it here"; see the module docblock.
			dataResolved: nullableObjectField(row, "dataResolved", path, problems) ?? null,
		});
	}
	reportDuplicates(
		"categories",
		categories.map((row: OntologyCategorySeed): string => row.category),
		problems,
	);
	const knownCategories = new Set(categories.map((row: OntologyCategorySeed): string => row.category));

	const variants: OntologyVariantSeed[] = [];
	for (const [index, row] of rowsOf(value, "variants", problems).entries()) {
		const path = `variants[${index}]`;
		const msku = requiredString(row, "msku", path, problems);
		const category = requiredString(row, "category", path, problems);
		if (category !== "" && !knownCategories.has(category)) {
			problems.push(
				`${path}: variant ${JSON.stringify(msku)} is in category ${JSON.stringify(category)}, ` +
					`which this seed does not declare (declared: ${describeKnown(knownCategories)})`,
			);
		}
		variants.push({
			msku,
			category,
			data: objectField(row, "data", path, problems),
			dataResolved: nullableObjectField(row, "dataResolved", path, problems) ?? null,
		});
	}
	reportDuplicates("variants", variants.map((row: OntologyVariantSeed): string => row.msku), problems);
	const knownVariants = new Set(variants.map((row: OntologyVariantSeed): string => row.msku));

	const families: AmazonFamilySeed[] = [];
	for (const [index, row] of rowsOf(value, "families", problems).entries()) {
		const path = `families[${index}]`;
		const family = requiredString(row, "family", path, problems);
		const category = optionalString(row, "category", path, problems);
		if (typeof category === "string" && !knownCategories.has(category)) {
			problems.push(
				`${path}: family ${JSON.stringify(family)} is in category ${JSON.stringify(category)}, ` +
					`which this seed does not declare (declared: ${describeKnown(knownCategories)})`,
			);
		}
		families.push({
			family,
			category,
			// `msku` here is deliberately NOT checked against the variants: the
			// column has no foreign key, because a family may name a conceptual
			// or virtual SKU that exists as no variant row. That is stated in the
			// table's own schema and is not an oversight to tighten.
			msku: optionalString(row, "msku", path, problems),
			label: optionalString(row, "label", path, problems),
			description: optionalString(row, "description", path, problems),
		});
	}
	reportDuplicates("families", families.map((row: AmazonFamilySeed): string => row.family), problems);
	const knownFamilies = new Set(families.map((row: AmazonFamilySeed): string => row.family));

	const asins: AmazonAsinSeed[] = [];
	for (const [index, row] of rowsOf(value, "asins", problems).entries()) {
		const path = `asins[${index}]`;
		const asin = requiredString(row, "asin", path, problems);
		if (asin !== "" && !ASIN_PATTERN.test(asin)) {
			problems.push(
				`${path}: ${JSON.stringify(asin)} is not an ASIN. Expected B0 followed by eight ` +
					`alphanumerics, or the ten-character ISBN a book listing uses as its ASIN.`,
			);
		}
		const msku = optionalString(row, "msku", path, problems);
		if (typeof msku === "string" && !knownVariants.has(msku)) {
			problems.push(
				`${path}: ASIN ${JSON.stringify(asin)} names msku ${JSON.stringify(msku)}, which this seed ` +
					`declares no variant for. brand_config_amazon_asin.msku is a foreign key onto ` +
					`brand_config_ontology_variant.msku, so add the variant or drop the msku ` +
					`(declared: ${describeKnown(knownVariants)})`,
			);
		}
		const family = optionalString(row, "family", path, problems);
		if (typeof family === "string" && !knownFamilies.has(family)) {
			problems.push(
				`${path}: ASIN ${JSON.stringify(asin)} is in family ${JSON.stringify(family)}, ` +
					`which this seed does not declare (declared: ${describeKnown(knownFamilies)})`,
			);
		}
		asins.push({
			asin,
			msku,
			family,
			countryToFamily: nullableObjectField(row, "countryToFamily", path, problems),
			labelInFamily: optionalString(row, "labelInFamily", path, problems),
			countryToLabelInFamily: nullableObjectField(row, "countryToLabelInFamily", path, problems),
			labelStandalone: optionalString(row, "labelStandalone", path, problems),
			description: optionalString(row, "description", path, problems),
		});
	}
	reportDuplicates("asins", asins.map((row: AmazonAsinSeed): string => row.asin), problems);

	const attributes: AmazonAttributeSeed[] = [];
	for (const [index, row] of rowsOf(value, "attributes", problems).entries()) {
		const path = `attributes[${index}]`;
		// `null` when the value is not one of the five; the scopeId rules below
		// depend on knowing which scope this is, so they are skipped rather than
		// run against a substituted one and reported as a second problem.
		const declaredScope = enumField(row, "scope", ATTRIBUTE_SCOPES, path, problems) as
			| AttributeScope
			| null;
		const scope: AttributeScope = declaredScope ?? "COUNTRY";
		// `merchantId` and `scopeId` are primary-key columns and NOT NULL, so the
		// absent case is the empty string rather than null — "" is a real value
		// here, meaning "every merchant" and "the whole scope" respectively.
		const merchantId = optionalString(row, "merchantId", path, problems) ?? "";
		const scopeId = optionalString(row, "scopeId", path, problems) ?? "";
		const wantsId = SCOPES_WITH_ID.includes(scope);
		if (declaredScope !== null && wantsId && scopeId === "") {
			problems.push(
				`${path}: scope ${scope} names a specific thing, so scopeId must be the ` +
					`${scope === "SKU" ? "msku" : scope.toLowerCase()} it applies to, not empty.`,
			);
		}
		if (declaredScope !== null && !wantsId && scopeId !== "") {
			problems.push(
				`${path}: scope ${scope} applies to everything in it, so scopeId must be "" — ` +
					`got ${JSON.stringify(scopeId)}, which resolution would never select.`,
			);
		}
		const country = upperCaseField(row, "country", path, problems);
		if (country !== "" && !/^[A-Z]{2}$/.test(country)) {
			problems.push(
				`${path}.country: expected a two-letter marketplace code, got ${JSON.stringify(country)}`,
			);
		}
		const attribute = upperCaseField(row, "attribute", path, problems);
		const dateFirst = requiredString(row, "dateFirst", path, problems);
		if (dateFirst !== "") {
			dateField(dateFirst, "dateFirst", path, problems);
		}
		const dateLast = optionalString(row, "dateLast", path, problems);
		if (typeof dateLast === "string") {
			dateField(dateLast, "dateLast", path, problems);
			// dateLast is INCLUSIVE, so equal dates are a one-day interval and fine.
			// An inverted pair covers no day at all: a row that can never resolve.
			if (dateFirst !== "" && dateLast < dateFirst) {
				problems.push(
					`${path}: dateLast ${dateLast} is before dateFirst ${dateFirst}, so this interval ` +
						`covers no date at all. dateLast is INCLUSIVE; null means still in force.`,
				);
			}
		}
		const rawValue = row["value"];
		if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
			problems.push(`${path}.value: expected a finite number, got ${JSON.stringify(rawValue)}`);
		}
		const currency = optionalString(row, "currency", path, problems);
		if (typeof currency === "string" && !/^[A-Z]{3}$/.test(currency)) {
			problems.push(
				`${path}.currency: expected a three-letter ISO currency, got ${JSON.stringify(currency)}. ` +
					`Leave it out for a rate attribute.`,
			);
		}
		attributes.push({
			merchantId,
			scope,
			scopeId,
			country,
			attribute,
			dateFirst,
			dateLast,
			value: typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : 0,
			currency,
			source: enumField(row, "source", ATTRIBUTE_SOURCES, path, problems) ?? "",
			confidence: enumField(row, "confidence", ATTRIBUTE_CONFIDENCES, path, problems) ?? "",
			notes: optionalString(row, "notes", path, problems),
		});
	}
	// The primary key is six columns, so the duplicate check needs a composite
	// key — and a hand-rolled join is what the root AGENTS.md forbids: any
	// component containing the separator would flatten two distinct rows into
	// one, and the seed would upsert twice into the same row reporting two.
	reportDuplicates(
		"attributes",
		attributes.map((row: AmazonAttributeSeed): string =>
			makeCompositeKey(
				row.merchantId,
				row.scope,
				row.scopeId,
				row.country,
				row.attribute,
				row.dateFirst,
			)
		),
		problems,
	);

	if (problems.length > 0) {
		return new SeedValidationError(source, problems);
	}
	return { wsid, properties, categories, variants, families, asins, attributes };
}

/** The declared keys of a set, or `(none)`, for the tail of a "no such thing" message. */
function describeKnown(known: ReadonlySet<string>): string {
	return known.size === 0 ? "(none)" : [...known].join(", ");
}

/**
 * A `jsonb` parameter.
 *
 * Serialised here rather than handed to the driver as an object, because `pg`
 * renders a JavaScript ARRAY as a PostgreSQL array literal — `{"a","b"}` — which
 * is not JSON and which the column rejects. A JSON string is unambiguous for
 * every shape a `jsonb` column can hold, and Postgres casts the text parameter
 * to `jsonb` from the column it is being written into.
 */
function jsonParam(value: Json): string {
	return JSON.stringify(value);
}

/** The category's RESOLVED values, which is what its variants inherit. */
function resolveCategoryData(category: OntologyCategorySeed): Readonly<Record<string, Json>> {
	return category.dataResolved ?? category.data;
}

/**
 * The variant's own values written over its category's RESOLVED ones; see the
 * module docblock.
 *
 * Inheriting the category's resolved values rather than its authored `data` is
 * what makes the two escape hatches agree. A seed that states `dataResolved` on
 * a category and leaves its `data` empty is saying the category resolves to
 * those values; inheriting `data` would hand its variants `{}` and write a
 * variant row whose resolved values contradict its own category's.
 */
function resolveVariantData(
	variant: OntologyVariantSeed,
	categoryData: Readonly<Record<string, Json>> | undefined,
): Record<string, Json> {
	if (variant.dataResolved !== null) {
		return { ...variant.dataResolved };
	}
	return { ...(categoryData ?? {}), ...variant.data };
}

/**
 * Write a validated seed into one tenant workspace, in foreign-key order and in
 * one transaction.
 *
 * ```ts
 * const handles = yield* tenantDb({ postgresUrl, schema: "w123456789" });
 * const seed = yield* parseCatalog(mySeedObject);
 * const written = yield* seedCatalog(handles.write, seed);
 * ```
 *
 * Takes the `write` surface rather than the whole handle: writing brand
 * configuration is all this does, and the narrower parameter is what lets a
 * caller pass a transaction it already owns.
 *
 * An optional key a seed row leaves out leaves that column alone on an existing
 * row, and `null` clears it; see the module docblock.
 *
 * Every table is upserted on its primary key, so running the same seed twice is
 * the same as running it once. Nothing is deleted — a row the seed no longer
 * mentions stays, because deleting it would cascade into ASINs and families the
 * seed knows nothing about, and `ON DELETE RESTRICT` would fail the whole
 * transaction rather than tell you which.
 */
export function seedCatalog(write: TenantDb["write"], seed: Catalog): Effect.Effect<SeedCatalogResult, Error> {
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const now = DateTime.formatIso(yield* DateTime.now);
			const categoryData = yield* Effect.fromResult(tryOrOperationError(() =>
				new Map<string, Readonly<Record<string, Json>>>(
					seed.categories.map((row: OntologyCategorySeed): [string, Readonly<Record<string, Json>>] => [
						row.category,
						resolveCategoryData(row),
					]),
				)
			));

			// Controlled transactions let interruption wait for the active statement,
			// then finish rollback before the caller starts closing the pool.
			const trx = yield* tryPromiseOrOperationError(() =>
				write.startTransaction().execute()
			);
			const result = yield* Effect.exit(restore(Effect.gen(function* () {
				// Every table below is written one insert per set of stated optional
				// columns, so `DO UPDATE SET` touches only what each row states. Kysely
				// leaves an `undefined` value out of both the column list (the column's
				// default applies on insert) and the `SET` list.
				for (const { states, rows } of groupByStatedColumns(seed.properties, PROPERTY_OPTIONAL)) {
					yield* Effect.uninterruptible(tryPromiseOrOperationError(() =>
						trx.insertInto("brand_config_ontology_metadata")
							.values(rows.map((row: OntologyPropertySeed) => ({
								property: row.property,
								valueType: row.valueType,
								appliesTo: row.appliesTo,
								valuesAllowed: jsonColumn(row.valuesAllowed),
								description: row.description,
								updatedAt: now,
							})))
							.onConflict((oc) =>
								oc.column("property").doUpdateSet((eb) => ({
									valueType: eb.ref("excluded.valueType"),
									appliesTo: states.has("appliesTo") ? eb.ref("excluded.appliesTo") : undefined,
									valuesAllowed: states.has("valuesAllowed")
										? eb.ref("excluded.valuesAllowed")
										: undefined,
									description: states.has("description") ? eb.ref("excluded.description") : undefined,
									updatedAt: now,
								}))
							)
							.execute()
					));
				}

				for (const { states, rows } of groupByStatedColumns(seed.categories, CATEGORY_OPTIONAL)) {
					yield* Effect.uninterruptible(tryPromiseOrOperationError(() =>
						trx.insertInto("brand_config_ontology_category")
							.values(rows.map((row: OntologyCategorySeed) => ({
								category: row.category,
								description: row.description,
								data: jsonParam(row.data),
								dataResolved: jsonParam(resolveCategoryData(row)),
								updatedAt: now,
							})))
							.onConflict((oc) =>
								oc.column("category").doUpdateSet((eb) => ({
									description: states.has("description") ? eb.ref("excluded.description") : undefined,
									data: eb.ref("excluded.data"),
									dataResolved: eb.ref("excluded.dataResolved"),
									updatedAt: now,
								}))
							)
							.execute()
					));
				}

				// Variants before ASINs: brand_config_amazon_asin.msku references them.
				if (seed.variants.length > 0) {
					yield* Effect.uninterruptible(tryPromiseOrOperationError(() =>
						trx.insertInto("brand_config_ontology_variant")
							.values(seed.variants.map((row: OntologyVariantSeed) => ({
								msku: row.msku,
								category: row.category,
								data: jsonParam(row.data),
								dataResolved: jsonParam(resolveVariantData(row, categoryData.get(row.category))),
								updatedAt: now,
							})))
							.onConflict((oc) =>
								oc.column("msku").doUpdateSet((eb) => ({
									category: eb.ref("excluded.category"),
									data: eb.ref("excluded.data"),
									dataResolved: eb.ref("excluded.dataResolved"),
									updatedAt: now,
								}))
							)
							.execute()
					));
				}

				for (const { states, rows } of groupByStatedColumns(seed.families, FAMILY_OPTIONAL)) {
					yield* Effect.uninterruptible(tryPromiseOrOperationError(() =>
						trx.insertInto("brand_config_amazon_family")
							.values(rows.map((row: AmazonFamilySeed) => ({
								family: row.family,
								category: row.category,
								msku: row.msku,
								label: row.label,
								description: row.description,
								updatedAt: now,
							})))
							.onConflict((oc) =>
								oc.column("family").doUpdateSet((eb) => ({
									category: states.has("category") ? eb.ref("excluded.category") : undefined,
									msku: states.has("msku") ? eb.ref("excluded.msku") : undefined,
									label: states.has("label") ? eb.ref("excluded.label") : undefined,
									description: states.has("description") ? eb.ref("excluded.description") : undefined,
									updatedAt: now,
								}))
							)
							.execute()
					));
				}

				for (const { states, rows } of groupByStatedColumns(seed.asins, ASIN_OPTIONAL)) {
					yield* Effect.uninterruptible(tryPromiseOrOperationError(() =>
						trx.insertInto("brand_config_amazon_asin")
							.values(rows.map((row: AmazonAsinSeed) => ({
								asin: row.asin,
								msku: row.msku,
								family: row.family,
								countryToFamily: jsonColumn(row.countryToFamily),
								labelInFamily: row.labelInFamily,
								countryToLabelInFamily: jsonColumn(row.countryToLabelInFamily),
								labelStandalone: row.labelStandalone,
								description: row.description,
								updatedAt: now,
							})))
							.onConflict((oc) =>
								oc.column("asin").doUpdateSet((eb) => ({
									msku: states.has("msku") ? eb.ref("excluded.msku") : undefined,
									family: states.has("family") ? eb.ref("excluded.family") : undefined,
									countryToFamily: states.has("countryToFamily")
										? eb.ref("excluded.countryToFamily")
										: undefined,
									labelInFamily: states.has("labelInFamily")
										? eb.ref("excluded.labelInFamily")
										: undefined,
									countryToLabelInFamily: states.has("countryToLabelInFamily")
										? eb.ref("excluded.countryToLabelInFamily")
										: undefined,
									labelStandalone: states.has("labelStandalone")
										? eb.ref("excluded.labelStandalone")
										: undefined,
									description: states.has("description") ? eb.ref("excluded.description") : undefined,
									updatedAt: now,
								}))
							)
							.execute()
					));
				}

				for (const { states, rows } of groupByStatedColumns(seed.attributes, ATTRIBUTE_OPTIONAL)) {
					yield* Effect.uninterruptible(tryPromiseOrOperationError(() =>
						trx.insertInto("brand_config_amazon_attributes")
							.values(rows.map((row: AmazonAttributeSeed) => ({
								merchantId: row.merchantId,
								scope: row.scope,
								scopeId: row.scopeId,
								country: row.country,
								attribute: row.attribute,
								dateFirst: row.dateFirst,
								dateLast: row.dateLast,
								value: row.value,
								currency: row.currency,
								source: row.source,
								confidence: row.confidence,
								notes: row.notes,
								updatedAt: now,
							})))
							// All six primary-key columns, and every one of them matters: the
							// same attribute for the same scope over a DIFFERENT interval is a
							// different row, so `dateFirst` being part of the key is what lets a
							// price history accumulate instead of overwriting itself.
							.onConflict((oc) =>
								oc.columns(["merchantId", "scope", "scopeId", "country", "attribute", "dateFirst"])
									.doUpdateSet((eb) => ({
										dateLast: states.has("dateLast") ? eb.ref("excluded.dateLast") : undefined,
										value: eb.ref("excluded.value"),
										currency: states.has("currency") ? eb.ref("excluded.currency") : undefined,
										source: eb.ref("excluded.source"),
										confidence: eb.ref("excluded.confidence"),
										notes: states.has("notes") ? eb.ref("excluded.notes") : undefined,
										updatedAt: now,
									}))
							)
							.execute()
					));
				}

				return {
					properties: seed.properties.length,
					categories: seed.categories.length,
					variants: seed.variants.length,
					families: seed.families.length,
					asins: seed.asins.length,
					attributes: seed.attributes.length,
				};
			})));
			const finished = yield* Effect.exit(tryPromiseOrOperationError(() =>
				Exit.isSuccess(result) ? trx.commit().execute() : trx.rollback().execute()
			));

			if (Exit.isFailure(result)) {
				return yield* Effect.failCause(
					Exit.isFailure(finished) ? combineCauses(result.cause, finished.cause) : result.cause,
				);
			}
			if (Exit.isFailure(finished)) {
				if (!trx.isCommitted && !trx.isRolledBack) {
					const rollback = yield* Effect.exit(tryPromiseOrOperationError(() =>
						trx.rollback().execute()
					));
					if (Exit.isFailure(rollback)) {
						return yield* Effect.failCause(combineCauses(finished.cause, rollback.cause));
					}
				}
				return yield* Effect.failCause(finished.cause);
			}
			return result.value;
		})
	);
}

/**
 * The optional columns of each table, in the shape of its seed row. A column
 * listed here is written on conflict only by rows that state it.
 */
const PROPERTY_OPTIONAL = ["appliesTo", "valuesAllowed", "description"] as const;
const CATEGORY_OPTIONAL = ["description"] as const;
const FAMILY_OPTIONAL = ["category", "msku", "label", "description"] as const;
const ASIN_OPTIONAL = [
	"msku",
	"family",
	"countryToFamily",
	"labelInFamily",
	"countryToLabelInFamily",
	"labelStandalone",
	"description",
] as const;
const ATTRIBUTE_OPTIONAL = ["dateLast", "currency", "notes"] as const;

/** Rows that state the same optional columns, and which columns those are. */
interface StatedColumnsGroup<Row, Column extends keyof Row> {
	readonly states: ReadonlySet<Column>;
	readonly rows: readonly Row[];
}

/**
 * Split `rows` into groups whose members state exactly the same `optional`
 * columns, in first-seen order.
 *
 * One `INSERT … ON CONFLICT DO UPDATE SET` has one `SET` list for every row it
 * carries, so a row that leaves `msku` out cannot share a statement with a row
 * that sets it without one of them being written wrongly. A per-row formulation
 * such as `coalesce(excluded.msku, t.msku)` would make an explicit `null`
 * impossible to express. A seed has few distinct shapes, typically one per
 * table, so this costs a handful of statements rather than one per row.
 */
function groupByStatedColumns<Row, Column extends keyof Row>(
	rows: readonly Row[],
	optional: readonly Column[],
): readonly StatedColumnsGroup<Row, Column>[] {
	const groups = new Map<number, { readonly states: ReadonlySet<Column>; readonly rows: Row[] }>();
	for (const row of rows) {
		const stated = optional.filter((column: Column): boolean => row[column] !== undefined);
		const shape = optional.reduce(
			(bits: number, column: Column, index: number): number =>
				row[column] === undefined ? bits : bits | (1 << index),
			0,
		);
		const existing = groups.get(shape);
		if (existing === undefined) {
			groups.set(shape, { states: new Set(stated), rows: [row] });
		} else {
			existing.rows.push(row);
		}
	}
	return [...groups.values()];
}

/** A `jsonb` column value, keeping "not stated" (`undefined`) and "clear it" (`null`) apart. */
function jsonColumn(value: Json | null | undefined): string | null | undefined {
	return value === undefined || value === null ? value : jsonParam(value);
}
