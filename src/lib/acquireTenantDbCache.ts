import { Effect, type Scope } from "effect";
import { destroyAllTenantDbs, newTenantDbCache, type TenantDbCache } from "./tenantDb.ts";

/** Acquire a fresh cache and close its pools when the enclosing scope ends. */
export function acquireTenantDbCache(): Effect.Effect<TenantDbCache, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(newTenantDbCache),
		(cache) => Effect.orDie(destroyAllTenantDbs(cache)),
	);
}
