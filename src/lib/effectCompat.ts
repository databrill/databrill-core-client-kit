/**
 * Effect behaviour this repository depends on, behind one module: the log format, how Effect `Config` reads the
 * environment, the meaning of a cause's single failure, how Schema errors become text, a strict number parse, a
 * struct that refuses unknown keys, a half-open random range, seeded random generators and signed date distances.
 * Where the plain Effect call would behave differently, the helper says so.
 *
 * It imports `effect` and nothing else, so any package that depends on `effect` can use it as it stands. It builds
 * nothing at module level that a bundler must keep, so a browser bundle that imports one helper carries only that
 * helper.
 */

import {
	Cause,
	ConfigProvider,
	DateTime,
	Duration,
	Effect,
	Exit,
	type Fiber,
	Logger,
	Number as EffectNumber,
	Option,
	Random,
	Schema,
	SchemaGetter,
	SchemaIssue,
} from "effect";

// ============================================================================
// Running an effect
// ============================================================================

/**
 * Runs `effect` as a Promise with the repository's log format and environment config provider. Use it at every
 * boundary where server-side code leaves Effect, instead of `Effect.runPromise`.
 *
 * @param effect - The effect to run; it must need no services
 * @param options - `signal` interrupts the run when aborted
 * @returns The effect's value; rejects as `Effect.runPromise` does
 */
export function runEffectPromise<A, E>(
	effect: Effect.Effect<A, E>,
	options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> {
	return Effect.runPromise(withEnvConfigProvider(withLogfmtLogger(effect)), options);
}

/**
 * Runs `effect` as a Promise of its `Exit` with the repository's log format and environment config provider,
 * instead of `Effect.runPromiseExit`.
 *
 * @param effect - The effect to run; it must need no services
 * @param options - `signal` interrupts the run when aborted
 * @returns The effect's exit; never rejects
 */
export function runEffectPromiseExit<A, E>(
	effect: Effect.Effect<A, E>,
	options?: { readonly signal?: AbortSignal | undefined },
): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(withEnvConfigProvider(withLogfmtLogger(effect)), options);
}

/**
 * Runs a synchronous `effect` with the repository's log format and environment config provider, instead of
 * `Effect.runSync`.
 *
 * @param effect - The effect to run; it must need no services and must not suspend
 * @returns The effect's value; throws as `Effect.runSync` does
 */
export function runEffectSync<A, E>(effect: Effect.Effect<A, E>): A {
	return Effect.runSync(withEnvConfigProvider(withLogfmtLogger(effect)));
}

/**
 * Starts `effect` in a detached fiber with the repository's log format and environment config provider, instead of
 * `Effect.runFork`.
 *
 * @param effect - The effect to run; it must need no services
 * @returns The running fiber
 */
export function runEffectFork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
	return Effect.runFork(withEnvConfigProvider(withLogfmtLogger(effect)));
}

/**
 * Gives `effect` the logfmt logger, whose lines read `timestamp=… level=ERROR fiber=#0 message=…`, together with the
 * tracer logger. Effect's default logger prints another format; the production checks and the log searches of this
 * repository read the logfmt one. Every run boundary above goes through it, and so does any other runner
 * (`NodeRuntime.runMain`).
 *
 * @param effect - The effect to run with the logfmt logger
 * @returns The same effect, logging in logfmt
 */
export function withLogfmtLogger<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return Effect.provideService(effect, Logger.CurrentLoggers, new Set([Logger.consoleLogFmt, Logger.tracerLogger]));
}

/**
 * Runs `effect` with Effect `Config` reading the process environment one variable at a time: a variable that is set
 * to `""` is the value `""`, a variable that is not set is missing, and reading a variable the process may not read
 * fails on that variable alone, as a defect that names it. Effect's default provider copies the whole environment
 * at its first read, which a process allowed to read only some variables cannot do, and treats `""` as missing.
 * Every run boundary above goes through it, and so does any other runner (`NodeRuntime.runMain`). Path segments
 * join with `_`; a numeric value is parsed as written, so one with surrounding spaces fails.
 *
 * @param effect - The effect whose `Config` reads should come from the environment
 * @returns The same effect, reading `Config` from the environment
 */
export function withEnvConfigProvider<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return Effect.provideService(effect, ConfigProvider.ConfigProvider, makeEnvConfigProvider());
}

function makeEnvConfigProvider(): ConfigProvider.ConfigProvider {
	return ConfigProvider.make((path) =>
		Effect.sync(() => {
			const value = readEnvironmentVariable(path.join("_"));
			return value === undefined ? undefined : ConfigProvider.makeValue(value);
		})
	);
}

function readEnvironmentVariable(name: string): string | undefined {
	// `process.env` exists under Deno, Bun and Node; in a browser there is none, and nothing is set. It is read
	// through `Reflect` because not every workspace's type configuration declares `process`.
	const processValue: unknown = Reflect.get(globalThis, "process");
	if (typeof processValue !== "object" || processValue === null) {
		return undefined;
	}
	const env: unknown = Reflect.get(processValue, "env");
	if (typeof env !== "object" || env === null || !(name in env)) {
		return undefined;
	}
	const value: unknown = Reflect.get(env, name);
	return typeof value === "string" ? value : undefined;
}

// ============================================================================
// Causes
// ============================================================================

/**
 * The error of a failed exit whose cause is exactly one typed failure. A cause with several failures, a failure
 * with a defect or an interruption, a defect, an interruption, an empty cause and a success give `None`, even when
 * a failure is part of the cause.
 *
 * @param exit - The exit to inspect
 * @returns The failure when it is the whole cause
 */
export function failureOf<A, E>(exit: Exit.Exit<A, E>): Option.Option<E> {
	if (!Exit.isFailure(exit) || exit.cause.reasons.length !== 1) {
		return Option.none();
	}
	const [reason] = exit.cause.reasons;
	return reason !== undefined && Cause.isFailReason(reason) ? Option.some(reason.error) : Option.none();
}

/**
 * The value to reject a foreign Promise with when an effect fails, the same value `Effect.runPromise` rejects with:
 * the error itself when the cause holds a typed failure, else the first defect, else an interruption error.
 *
 * @param cause - The cause of the failure
 * @returns The rejection value
 */
export function causeToRejection<E>(cause: Cause.Cause<E>): unknown {
	return Cause.squash(cause);
}

/**
 * Every typed failure in `cause`, in order.
 *
 * @param cause - The cause to inspect
 * @returns The failures; empty when there are none
 */
export function causeFailures<E>(cause: Cause.Cause<E>): readonly E[] {
	return cause.reasons.flatMap((reason) => Cause.isFailReason(reason) ? [reason.error] : []);
}

/**
 * Every defect in `cause`, in order.
 *
 * @param cause - The cause to inspect
 * @returns The defects; empty when there are none
 */
export function causeDefects<E>(cause: Cause.Cause<E>): readonly unknown[] {
	return cause.reasons.flatMap((reason) => Cause.isDieReason(reason) ? [reason.defect] : []);
}

/**
 * Whether `cause` contains an interruption anywhere.
 *
 * @param cause - The cause to inspect
 * @returns True when an interruption is part of the cause
 */
export function causeHasInterrupts<E>(cause: Cause.Cause<E>): boolean {
	return Cause.hasInterrupts(cause);
}

/**
 * Whether `cause` contains nothing but interruptions. An empty cause counts as interrupted only; Effect's
 * `Cause.hasInterruptsOnly` says false for it, which is why this is not that function.
 *
 * @param cause - The cause to inspect
 * @returns True when every part of the cause is an interruption, or there is none
 */
export function causeIsInterruptedOnly<E>(cause: Cause.Cause<E>): boolean {
	return cause.reasons.every((reason) => Cause.isInterruptReason(reason));
}

/**
 * Whether `cause` holds no failure, defect or interruption.
 *
 * @param cause - The cause to inspect
 * @returns True for an empty cause
 */
export function causeIsEmpty<E>(cause: Cause.Cause<E>): boolean {
	return cause.reasons.length === 0;
}

/**
 * The first typed failure anywhere in `cause`. Unlike `failureOf`, a failure among other failures, defects or
 * interruptions counts.
 *
 * @param cause - The cause to inspect
 * @returns The first failure, or `None`
 */
export function causeFailureOption<E>(cause: Cause.Cause<E>): Option.Option<E> {
	return Cause.findErrorOption(cause);
}

/**
 * `left` followed by `right`, as one cause. Equal parts that appear in both are kept once.
 *
 * @param left - The cause that happened first
 * @param right - The cause that happened after it
 * @returns The combined cause
 */
export function combineCauses<E, E2>(left: Cause.Cause<E>, right: Cause.Cause<E2>): Cause.Cause<E | E2> {
	return Cause.combine(left, right);
}

/**
 * `cause` with its interruptions removed, keeping every failure and defect.
 *
 * @param cause - The cause to filter
 * @returns The cause without interruptions
 */
export function causeWithoutInterrupts<E>(cause: Cause.Cause<E>): Cause.Cause<E> {
	return Cause.fromReasons(cause.reasons.filter((reason) => !Cause.isInterruptReason(reason)));
}

/**
 * The text of `cause` for a log line, a stored error or a person: each error's stack, one after another, with each
 * error's `cause` chain.
 *
 * @param cause - The cause to render
 * @returns The rendered text
 */
export function formatCause<E>(cause: Cause.Cause<E>): string {
	return Cause.pretty(cause);
}

// ============================================================================
// Schema errors
// ============================================================================

/**
 * Whether `u` is the error a Schema decode fails with.
 *
 * @param u - Any value
 * @returns True for a Schema error
 */
export function isSchemaError(u: unknown): u is Schema.SchemaError {
	return Schema.isSchemaError(u);
}

/**
 * One entry per failing value of a Schema decode error: where it is and what is wrong with it, in Effect's wording.
 *
 * @param error - A Schema decode error
 * @returns The issues, in the formatter's order
 */
export function formatSchemaIssues(
	error: Schema.SchemaError,
): readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] {
	return SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
		path: (issue.path ?? []).map((part) => typeof part === "object" ? part.key : part),
		message: issue.message,
	}));
}

/**
 * A Schema decode error as one multi-line text, in Effect's wording.
 *
 * @param error - A Schema decode error
 * @returns The rendered text
 */
export function formatSchemaError(error: Schema.SchemaError): string {
	return SchemaIssue.makeFormatterDefault()(error.issue);
}

// ============================================================================
// Schemas
// ============================================================================

/**
 * A string that decodes to a number, failing on a blank string and on text that is not a number. `"NaN"`,
 * `"Infinity"` and `"-Infinity"` decode to those values; anything else goes through `Number()`. Effect's
 * `Schema.NumberFromString` decodes `""` to `0` and `"abc"` to `NaN`; this one refuses both.
 */
export const StrictNumberFromString: Schema.decodeTo<Schema.Number, Schema.String> = /* @__PURE__ */ Schema.String
	.pipe(
		/* @__PURE__ */ Schema.decodeTo(Schema.Number, {
			decode: /* @__PURE__ */ SchemaGetter.transformEffect<number, string>((input) =>
				Option.match(EffectNumber.parse(input), {
					onNone: () =>
						Effect.fail(
							new SchemaIssue.InvalidValue({
								message: `Unable to decode ${JSON.stringify(input)} into a number`,
							}, input),
						),
					onSome: (value) => Effect.succeed(value),
				})
			),
			encode: /* @__PURE__ */ SchemaGetter.transform<string, number>((value) => String(value)),
		}),
	);

/**
 * A `Schema.Struct` of `fields` that refuses an input with an own key it does not declare, checked on the input
 * before decoding. Only this level is checked: a nested Struct that must refuse extra keys is a `strictStruct`
 * itself. A non-object and an array are left to the Struct, which refuses them with its own message.
 *
 * @param fields - The Struct's fields
 * @returns The strict Struct; its encoded side is `unknown`
 */
export function strictStruct<Fields extends Schema.Struct.Fields>(
	fields: Fields,
): Schema.decodeTo<Schema.Struct<Fields>, Schema.Unknown> {
	const allowed = new Set<PropertyKey>(Reflect.ownKeys(fields));
	return Schema.Unknown.check(Schema.makeFilter((input: unknown) => checkOwnKeys(input, allowed))).pipe(
		Schema.decodeTo(Schema.Struct(fields)),
	);
}

function checkOwnKeys(input: unknown, allowed: ReadonlySet<PropertyKey>): true | string {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return true;
	}
	const unexpected = Reflect.ownKeys(input).filter((key) => !allowed.has(key));
	if (unexpected.length === 0) {
		return true;
	}
	return `unexpected key ${unexpected.map(String).join(", ")}; expected one of ${
		[...allowed].map(String).join(", ")
	}`;
}

// ============================================================================
// Random
// ============================================================================

/**
 * A random integer in `[min, max)`: `max` itself is never drawn. Effect's `Random.nextIntBetween` includes `max`
 * unless told otherwise.
 *
 * @param min - The smallest value that can be drawn
 * @param max - One more than the largest value that can be drawn
 * @returns The draw
 */
export function nextIntBetweenHalfOpen(min: number, max: number): Effect.Effect<number> {
	return Random.nextIntBetween(min, max, { halfOpen: true });
}

/**
 * A seeded random generator. It keeps its state: every effect given the same generator continues one sequence.
 *
 * @param seed - The seed
 * @returns The generator
 */
export function makeSeededRandom(seed: number | string): Random.Random {
	return Effect.runSync(Effect.service(Random.Random).pipe(Random.withSeed(seed)));
}

/**
 * Runs an effect with `random` as its random generator.
 *
 * @param random - A generator from `makeSeededRandom`
 * @returns A function that gives an effect that generator
 */
export function withSeededRandom(
	random: Random.Random,
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
	return (effect) => Effect.provideService(effect, Random.Random, random);
}

// ============================================================================
// DateTime
// ============================================================================

/**
 * The signed number of milliseconds from `self` to `other`: positive when `other` is later.
 *
 * @param self - The start
 * @param other - The end
 * @returns `other` minus `self`, in milliseconds
 */
export function calcDistanceMillis(self: DateTime.DateTime, other: DateTime.DateTime): number {
	return DateTime.toEpochMillis(other) - DateTime.toEpochMillis(self);
}

/**
 * The time between `self` and `other` whichever comes first, as a non-negative `Duration`.
 *
 * @param self - One instant
 * @param other - The other instant
 * @returns The absolute distance
 */
export function calcAbsoluteDistance(self: DateTime.DateTime, other: DateTime.DateTime): Duration.Duration {
	return Duration.millis(Math.abs(calcDistanceMillis(self, other)));
}
