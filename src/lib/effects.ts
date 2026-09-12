import { Effect, Either } from "effect";

/** Keep foreign errors intact, including their original causes. */
export function operationError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error("Client operation failed", { cause });
}

/** Run synchronous work, preserving foreign errors and their causes. */
export function tryOrOperationError<A>(fn: () => A): Either.Either<A, Error> {
	return Either.try({ try: fn, catch: operationError });
}

/** Run Promise work, preserving foreign errors and their causes. */
export function tryPromiseOrOperationError<A>(fn: () => Promise<A>): Effect.Effect<A, Error> {
	return Effect.tryPromise({ try: fn, catch: operationError });
}
