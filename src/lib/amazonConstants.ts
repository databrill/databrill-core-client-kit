/**
 * The Amazon regions this platform recognizes. This tuple is the single source of truth for the
 * three codes: `AmazonRegion` below derives from it, and `amazonConstantsEffect.ts` builds
 * `AmazonRegionSchema` from the same tuple, so the union and the schema cannot drift apart.
 *
 * The schema lives in that sibling file rather than here because this file must keep zero import
 * statements: it is symlinked into `mcp-local/` and is meant to be symlinked into further packages
 * that add no dependencies of their own, so it must not pull `effect` in behind it.
 */
export const AMAZON_REGIONS = ["EU", "FE", "NA"] as const;

export type AmazonRegion = typeof AMAZON_REGIONS[number];

export interface AmazonRegionInfo {
	readonly baseUrlAdApi: string;
	readonly baseUrlSpApi: string;
	readonly awsRegion: string;
	readonly timeZoneDefault: string;
}

export interface AmazonMarketplaceInfo {
	readonly marketplaceId: string;
	readonly countryCode: string;
	readonly countryName: string;
	readonly timeZone: string;
	readonly defaultCurrencyCode: string;
	readonly defaultLanguageCode: string;
	readonly domainName: string;
	readonly region: AmazonRegion;
	readonly regionInfo: AmazonRegionInfo;
}

// Marketplace ID constants
export const MARKETPLACE_ID_AE = "A2VIGQ35RCS4UG";
export const MARKETPLACE_ID_AU = "A39IBJ37TRP1C6";
export const MARKETPLACE_ID_BE = "AMEN7PMS3EDWL";
export const MARKETPLACE_ID_BR = "A2Q3Y263D00KWC";
export const MARKETPLACE_ID_CA = "A2EUQ1WTGCTBG2";
export const MARKETPLACE_ID_DE = "A1PA6795UKMFR9";
export const MARKETPLACE_ID_ES = "A1RKKUPIHCS9HS";
export const MARKETPLACE_ID_FR = "A13V1IB3VIYZZH";
export const MARKETPLACE_ID_GB = "A1F83G8C2ARO7P";
export const MARKETPLACE_ID_IE = "A28R8C7NBKEWEA";
export const MARKETPLACE_ID_IT = "APJ6JRA9NG5V4";
export const MARKETPLACE_ID_JP = "A1VC38T7YXB528";
export const MARKETPLACE_ID_MX = "A1AM78C64UM0Y8";
export const MARKETPLACE_ID_NL = "A1805IZSGTT6HS";
export const MARKETPLACE_ID_PL = "A1C3SOZRARQ6R3";
export const MARKETPLACE_ID_SA = "A17E79C6D8DWNP";
export const MARKETPLACE_ID_SE = "A2NODRKZP88ZB9";
export const MARKETPLACE_ID_TR = "A33AVAJ2PDY3EV";
export const MARKETPLACE_ID_US = "ATVPDKIKX0DER";

export const regionInfoMap: { readonly [region in AmazonRegion]: AmazonRegionInfo } = {
	EU: {
		baseUrlAdApi: "https://advertising-api-eu.amazon.com",
		baseUrlSpApi: "https://sellingpartnerapi-eu.amazon.com",
		awsRegion: "EU-WEST-1",
		timeZoneDefault: "Europe/Paris",
	},
	NA: {
		baseUrlAdApi: "https://advertising-api.amazon.com",
		baseUrlSpApi: "https://sellingpartnerapi-na.amazon.com",
		awsRegion: "US-EAST-1",
		timeZoneDefault: "America/Los_Angeles",
	},
	FE: {
		baseUrlAdApi: "https://advertising-api-fe.amazon.com",
		baseUrlSpApi: "https://sellingpartnerapi-fe.amazon.com",
		awsRegion: "US-WEST-2",
		timeZoneDefault: "Australia/Sydney",
	},
};

/**
 * Two canonical marketplace lists exist and are intentionally distinct: this array is the
 * platform's supported set, while `amazonMarketplaceApiInfos` in
 * `libs/amazon/src/amazonConstants_marketplaces.ts` is a dump of observed seller
 * participation. They may legitimately differ in the supported-but-unobserved direction (a
 * marketplace supported here that no connected seller participates in yet); the
 * reverse direction is a defect, guarded by the test in
 * `libs/amazon/src/amazonConstants_marketplaces.test.ts`. That guard has to live under `libs/`
 * because it reads `amazonMarketplaceApiInfos`, and `shared/` must never import from `libs/`:
 * the dependency direction is `libs/` -> `shared/`, one way. `core-utils-shared` is a
 * published package (see its `deno.json` exports) that the frontend consumes as
 * `@databrill/core-utils-shared/…`, and the frontend's import map has no `@/libs/` mapping at
 * all — that alias is defined only in `services/deno.json`. So a `@/libs/…` import added here
 * does not merely bend a convention, it fails to resolve in the frontend build.
 */
export const marketplaceInfos: readonly AmazonMarketplaceInfo[] = [
	{
		countryCode: "AU",
		marketplaceId: MARKETPLACE_ID_AU,
		countryName: "Australia",
		timeZone: "Australia/Sydney",
		defaultCurrencyCode: "AUD",
		defaultLanguageCode: "en_AU",
		domainName: "www.amazon.com.au",
		region: "FE",
		regionInfo: regionInfoMap["FE"]!,
	},
	{
		countryCode: "AE",
		marketplaceId: MARKETPLACE_ID_AE,
		countryName: "United Arab Emirates",
		timeZone: "Asia/Dubai",
		defaultCurrencyCode: "AED",
		defaultLanguageCode: "ar_AE",
		domainName: "www.amazon.ae",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "BE",
		marketplaceId: MARKETPLACE_ID_BE,
		countryName: "Belgium",
		timeZone: "Europe/Brussels",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "fr_BE",
		domainName: "www.amazon.com.be",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "BR",
		marketplaceId: MARKETPLACE_ID_BR,
		countryName: "Brazil",
		timeZone: "America/Sao_Paulo",
		defaultCurrencyCode: "BRL",
		defaultLanguageCode: "pt_BR",
		domainName: "www.amazon.com.br",
		region: "NA",
		regionInfo: regionInfoMap["NA"]!,
	},
	{
		countryCode: "CA",
		marketplaceId: MARKETPLACE_ID_CA,
		countryName: "Canada",
		timeZone: "America/Los_Angeles",
		defaultCurrencyCode: "CAD",
		defaultLanguageCode: "en_CA",
		domainName: "www.amazon.ca",
		region: "NA",
		regionInfo: regionInfoMap["NA"]!,
	},
	{
		countryCode: "DE",
		marketplaceId: MARKETPLACE_ID_DE,
		countryName: "Germany",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "de_DE",
		domainName: "www.amazon.de",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "ES",
		marketplaceId: MARKETPLACE_ID_ES,
		countryName: "Spain",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "es_ES",
		domainName: "www.amazon.es",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "FR",
		marketplaceId: MARKETPLACE_ID_FR,
		countryName: "France",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "fr_FR",
		domainName: "www.amazon.fr",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "IE",
		marketplaceId: MARKETPLACE_ID_IE,
		countryName: "Ireland",
		timeZone: "Europe/London",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "en_IE",
		domainName: "www.amazon.ie",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "IT",
		marketplaceId: MARKETPLACE_ID_IT,
		countryName: "Italy",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "it_IT",
		domainName: "www.amazon.it",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "JP",
		marketplaceId: MARKETPLACE_ID_JP,
		countryName: "Japan",
		timeZone: "Asia/Tokyo",
		defaultCurrencyCode: "JPY",
		defaultLanguageCode: "ja_JP",
		domainName: "www.amazon.co.jp",
		region: "FE",
		regionInfo: regionInfoMap["FE"]!,
	},
	{
		countryCode: "MX",
		marketplaceId: MARKETPLACE_ID_MX,
		countryName: "Mexico",
		timeZone: "America/Los_Angeles",
		defaultCurrencyCode: "MXN",
		defaultLanguageCode: "es_MX",
		domainName: "www.amazon.com.mx",
		region: "NA",
		regionInfo: regionInfoMap["NA"]!,
	},
	{
		countryCode: "NL",
		marketplaceId: MARKETPLACE_ID_NL,
		countryName: "Netherlands",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "nl_NL",
		domainName: "www.amazon.nl",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "PL",
		marketplaceId: MARKETPLACE_ID_PL,
		countryName: "Poland",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "PLN",
		defaultLanguageCode: "pl_PL",
		domainName: "www.amazon.pl",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "SA",
		marketplaceId: MARKETPLACE_ID_SA,
		countryName: "Saudi Arabia",
		// Fixed UTC+03:00, no DST: Amazon publishes no per-marketplace timezone, so this is the
		// country's IANA zone, not an Amazon-stated value.
		timeZone: "Asia/Riyadh",
		defaultCurrencyCode: "SAR",
		// This is what Amazon's getMarketplaceParticipations actually returns for the SA
		// marketplace. Do not "correct" this to ar_SA.
		defaultLanguageCode: "en_AE",
		domainName: "www.amazon.sa",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "SE",
		marketplaceId: MARKETPLACE_ID_SE,
		countryName: "Sweden",
		timeZone: "Europe/Stockholm",
		defaultCurrencyCode: "SEK",
		defaultLanguageCode: "sv_SE",
		domainName: "www.amazon.se",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "TR",
		marketplaceId: MARKETPLACE_ID_TR,
		countryName: "Turkey",
		timeZone: "Europe/Istanbul",
		defaultCurrencyCode: "TRY",
		defaultLanguageCode: "tr_TR",
		domainName: "www.amazon.com.tr",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "GB",
		marketplaceId: MARKETPLACE_ID_GB,
		countryName: "United Kingdom",
		timeZone: "Europe/London",
		defaultCurrencyCode: "GBP",
		defaultLanguageCode: "en_GB",
		domainName: "www.amazon.co.uk",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "UK",
		marketplaceId: MARKETPLACE_ID_GB,
		countryName: "United Kingdom",
		timeZone: "Europe/London",
		defaultCurrencyCode: "GBP",
		defaultLanguageCode: "en_GB",
		domainName: "www.amazon.co.uk",
		region: "EU",
		regionInfo: regionInfoMap["EU"]!,
	},
	{
		countryCode: "US",
		marketplaceId: MARKETPLACE_ID_US,
		countryName: "United States",
		timeZone: "America/Los_Angeles",
		defaultCurrencyCode: "USD",
		defaultLanguageCode: "en_US",
		domainName: "www.amazon.com",
		region: "NA",
		regionInfo: regionInfoMap["NA"]!,
	},
];

/**
 * The country codes this platform recognizes: one per marketplace above, excluding the "UK"
 * alias, which exists only so a lookup by the Ads-API spelling resolves (see
 * `libs/amazon/src/adapi/adapiCountryCode.ts` — the canonical spelling is "GB").
 *
 * Kept as its own list rather than derived from `marketplaceInfos` with `as const`, because
 * making that array's literal types survive also narrows the maps built from it and breaks
 * every caller that indexes them by a plain `string`. The tests in `amazonConstants.test.ts`
 * fail if the two ever drift. Use {@link isAmazonCountryCode} to cross from `string`.
 */
export const AMAZON_COUNTRY_CODES = [
	"AE",
	"AU",
	"BE",
	"BR",
	"CA",
	"DE",
	"ES",
	"FR",
	"GB",
	"IE",
	"IT",
	"JP",
	"MX",
	"NL",
	"PL",
	"SA",
	"SE",
	"TR",
	"US",
] as const;

export type AmazonCountryCode = typeof AMAZON_COUNTRY_CODES[number];

const amazonCountryCodeSet: ReadonlySet<string> = new Set(AMAZON_COUNTRY_CODES);

/**
 * Narrow a country code of unknown provenance — a CLI argument, a database row, or the
 * `countryCode` off a marketplace lookup, all of which are plain `string`. Use it at the
 * boundary so an unrecognized code is a case you handle rather than a comparison that
 * silently comes out false.
 */
export function isAmazonCountryCode(value: string): value is AmazonCountryCode {
	return amazonCountryCodeSet.has(value);
}

export const countryCodeToMarketplaceInfo: {
	readonly [countryCode: string]: AmazonMarketplaceInfo;
} = Object
	.fromEntries(
		marketplaceInfos.map((
			country,
		) => [country.countryCode.toUpperCase(), country]),
	);

/**
 * Marketplace id -> its info. The UK entry is an alias of GB on the same marketplace id and is
 * filtered out, as it is for the two maps below, so this yields the platform-canonical "GB"
 * (see `libs/amazon/src/adapi/adapiCountryCode.ts` — "UK" belongs to the Ads API boundary
 * only). Without the filter `Object.fromEntries` let the later UK entry shadow GB, and every
 * country code derived from a marketplace id came out as "UK".
 */
export const marketplaceIdToMarketplaceInfo: {
	readonly [marketplaceId: string]: AmazonMarketplaceInfo;
} = Object
	.fromEntries(
		marketplaceInfos
			.filter((info) => info.countryCode !== "UK") // Avoid duplicate for UK/GB
			.map((country) => [country.marketplaceId, country]),
	);

/**
 * Maps sales channel names (lowercase) to marketplace IDs.
 * Sales channel values appear in order reports as e.g. "Amazon.com", "Amazon.de", "Amazon.co.uk".
 * Keys are lowercase for case-insensitive lookup.
 */
export const salesChannelToMarketplaceId: { readonly [salesChannel: string]: string } = Object.fromEntries(
	marketplaceInfos
		.filter((info) => info.countryCode !== "UK") // Avoid duplicate for UK/GB
		.map((info) => [info.domainName.replace("www.", "").toLowerCase(), info.marketplaceId]),
);

/**
 * Maps currency codes to marketplace IDs, but only for currencies unique to one marketplace.
 * Used as a fallback when sales channel is not recognized (e.g., "Non-Amazon").
 * Currencies like EUR are excluded because they're used in multiple marketplaces.
 */
export const currencyToMarketplaceId: { readonly [currency: string]: string } = (() => {
	// Group marketplaces by currency
	const currencyToInfos: { [currency: string]: AmazonMarketplaceInfo[] } = {};
	for (const info of marketplaceInfos) {
		if (info.countryCode === "UK") continue; // Skip UK duplicate
		const currency = info.defaultCurrencyCode;
		if (!currencyToInfos[currency]) {
			currencyToInfos[currency] = [];
		}
		currencyToInfos[currency].push(info);
	}
	// Only include currencies that map to exactly one marketplace
	const result: { [currency: string]: string } = {};
	for (const [currency, infos] of Object.entries(currencyToInfos)) {
		if (infos.length === 1) {
			result[currency] = infos[0]!.marketplaceId;
		}
	}
	return result;
})();

/**
 * The country codes of each region, derived from `marketplaceInfos` by deduplicating on
 * `marketplaceId` — the "UK" alias shares `MARKETPLACE_ID_GB` with the GB entry, which comes
 * first, so this carries "GB" and never "UK", the same way the marketplaceId-keyed maps above
 * do.
 *
 * Values stay `readonly string[]` rather than narrowing to {@link AmazonCountryCode}: the
 * reason `AMAZON_COUNTRY_CODES` is hand-maintained (see its comment above) applies here too —
 * making the literal types survive the derivation narrows the maps built from the same array
 * and breaks every caller that indexes them by a plain `string`.
 */
export const regionCountryCodes: { readonly [region in AmazonRegion]: readonly string[] } = (() => {
	// Every region initialized up front, so the mapped type is satisfied by construction rather
	// than by an assertion on a partially built object.
	const byRegion: { [region in AmazonRegion]: string[] } = { EU: [], FE: [], NA: [] };
	const seenMarketplaceIds = new Set<string>();
	for (const info of marketplaceInfos) {
		if (seenMarketplaceIds.has(info.marketplaceId)) {
			continue;
		}
		seenMarketplaceIds.add(info.marketplaceId);
		byRegion[info.region].push(info.countryCode);
	}
	return byRegion;
})();

/**
 * Derive a report's Amazon region from its marketplace IDs. All marketplace IDs of a
 * single report belong to the same region, so the first recognized ID determines the
 * result. Returns null when no ID is recognized (caller persists null rather than a
 * fabricated placeholder).
 */
export function getAmazonRegionFromMarketplaceIds(marketplaceIds: readonly string[]): AmazonRegion | null {
	for (const marketplaceId of marketplaceIds) {
		const info = marketplaceIdToMarketplaceInfo[marketplaceId];
		if (info) {
			return info.region;
		}
	}
	return null;
}
