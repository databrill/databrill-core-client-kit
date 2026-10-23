/**
 * Rewrite a Supabase SESSION-pooler connection URI to the direct-connection or
 * transaction-pooler form. A pure function: the caller decides whether and when
 * to apply it.
 *
 * Supabase's session pooler (`aws-*-*.pooler.supabase.com:5432`) works over IPv4
 * from anywhere, so it is the form connection strings are usually stored in.
 * Two other targets reach the same database without forking the stored string:
 *
 * - `direct`: the real Postgres host `db.{ref}.supabase.co`, which Supabase
 *   serves over IPv6 only. The tenant suffix is stripped from the username
 *   (`postgres.{ref}` → `postgres`). Suits long transactions from a host that
 *   has IPv6.
 * - `transaction`: port 6543 on the same pooler host. A server connection is
 *   held only for the duration of a transaction, so an idle client connection
 *   no longer pins a pooled backend. Session state does not carry from one
 *   transaction to the next, and clients must not use named prepared
 *   statements.
 *
 * A URI that does not match the strict session-pooler shape (host
 * `*.pooler.supabase.com`, port 5432 or none, username `{base}.{20-char ref}`)
 * is returned unchanged, so self-hosted poolers, direct URIs and URIs already on
 * port 6543 pass through.
 *
 * This file is symlinked into the published client kit, which is why it imports
 * nothing: every import would be a line in each client's import map.
 */

export type SupabasePoolerRewriteMode = "direct" | "transaction";

export interface SupabasePoolerRewriteResult {
	readonly uri: string;
	/** True when the URI matched the session-pooler shape and was rewritten. */
	readonly rewritten: boolean;
}

const SESSION_POOLER_URI_PATTERN =
	/^(postgres(?:ql)?:\/\/)([^:@/]+)(:[^@]*)?@([a-z0-9-]+\.pooler\.supabase\.com)(?::(\d+))?(\/[^?]*)?(\?.*)?$/;

const TENANT_USERNAME_PATTERN = /^(.+)\.([a-z0-9]{20})$/;

export function rewriteSupabasePoolerUri(
	uri: string,
	mode: SupabasePoolerRewriteMode,
): SupabasePoolerRewriteResult {
	const match = SESSION_POOLER_URI_PATTERN.exec(uri);
	if (match === null) {
		return { uri, rewritten: false };
	}
	const [, scheme, username, passwordPart, poolerHost, port, path, query] = match;
	if (scheme === undefined || username === undefined || poolerHost === undefined) {
		return { uri, rewritten: false };
	}
	if (port !== undefined && port !== "5432") {
		// Already the transaction pooler (6543) or something exotic; leave it alone.
		return { uri, rewritten: false };
	}
	const usernameMatch = TENANT_USERNAME_PATTERN.exec(username);
	if (usernameMatch === null) {
		return { uri, rewritten: false };
	}
	const [, baseUsername, projectRef] = usernameMatch;
	if (baseUsername === undefined || projectRef === undefined) {
		return { uri, rewritten: false };
	}

	const password = passwordPart ?? "";
	const pathAndQuery = `${path ?? ""}${query ?? ""}`;

	if (mode === "direct") {
		return {
			uri: `${scheme}${baseUsername}${password}@db.${projectRef}.supabase.co:5432${pathAndQuery}`,
			rewritten: true,
		};
	}
	return {
		uri: `${scheme}${username}${password}@${poolerHost}:6543${pathAndQuery}`,
		rewritten: true,
	};
}
