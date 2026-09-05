/**
 * Composite string keys for in-memory `Map` / `Set` lookups.
 *
 * WHY THIS EXISTS: joining key components with an ad-hoc separator is a silent
 * correctness bug waiting to happen. If a component can contain the separator, two
 * distinct tuples flatten to the same string and two report rows merge into one — a
 * wrong number on a page, with no error.
 *
 * The old answer was to join on NUL. That is now PROHIBITED (see
 * `docs/coding_standards.md`): a literal NUL byte makes git and `grep -r` classify
 * the file as binary and skip it SILENTLY, so code searches return incomplete
 * results with no warning.
 *
 * The separator is a TAB because a key must be something
 * you can reliably copy and paste while troubleshooting or writing a test. Exotic
 * control characters (unit separator and friends) do not survive a round trip
 * through a terminal, a diff, or a paste buffer, so they are not an option here
 * however clean they look in a spec. Tab does not occur in the fields we key on —
 * search terms, fee descriptions, group labels.
 *
 * Components are escaped anyway, so the result stays unambiguous even if a
 * component one day DOES contain a tab. That backstop costs nothing on the common
 * path (a component with no tab and no backslash is returned as-is, so ordinary
 * keys are a plain `a<TAB>b` join and paste back exactly as they appear).
 *
 * Use this for ephemeral keys only. A key that is persisted (stored in a column,
 * hashed into an id) must not change separators without a data migration.
 */

/** Tab, not NUL: NUL breaks git/grep binary detection. Chosen to be paste-safe. */
const KEY_SEPARATOR = "\t";

const ESCAPE = "\\";
const ESCAPED_ESCAPE = "\\\\";
const ESCAPED_SEPARATOR = "\\t";

/**
 * Join components into a single string key. Distinct component tuples always
 * produce distinct keys, whatever the components contain. Numbers are
 * stringified first, so `(1, x)` and `("1", x)` are deliberately the same key.
 */
export function makeCompositeKey(first: string | number, ...rest: readonly (string | number)[]): string {
	return [first, ...rest].map(escapeKeyPart).join(KEY_SEPARATOR);
}

function escapeKeyPart(part: string | number): string {
	const text = typeof part === "number" ? String(part) : part;
	if (!text.includes(ESCAPE) && !text.includes(KEY_SEPARATOR)) {
		return text;
	}
	return text.replaceAll(ESCAPE, ESCAPED_ESCAPE).replaceAll(KEY_SEPARATOR, ESCAPED_SEPARATOR);
}
