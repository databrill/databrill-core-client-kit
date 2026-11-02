import { CliError, Command } from "effect/cli";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";

/**
 * Parse `args` with `command`, run it with the CLI's platform services, and
 * return the exit code without exiting the caller.
 *
 * Effect's runner ends `--help` by failing with a `CliError.ShowHelp` that
 * carries no errors; that is a success here, exit code 0. A `ShowHelp` that
 * does carry parse errors stays a failure: the runner has already printed the
 * errors (stderr) and the usage (stdout).
 */
export function runCommand<Name extends string, Input, ContextInput>(
	command: Command.Command<Name, Input, ContextInput, Error>,
	args: readonly string[],
): Effect.Effect<number, Error | CliError.CliError> {
	// The client kit is pinned by Git commit and has no package version.
	return Command.runWith(command, { version: "unversioned" })(args).pipe(
		Effect.as(0),
		Effect.catchIf(isHelpRequest, () => Effect.succeed(0)),
		Effect.provide(NodeServices.layer),
	);
}

/**
 * The text `--help` prints for `command`, captured rather than printed, so a
 * command can put its own usage into an error message.
 */
export function renderHelp<Name extends string, Input, ContextInput>(
	command: Command.Command<Name, Input, ContextInput, Error>,
): Effect.Effect<string> {
	return Effect.suspend(() => {
		const lines: string[] = [];
		return runCommand(command, ["--help"]).pipe(
			Effect.provideService(Console.Console, capturingConsole(lines)),
			Effect.ignore,
			Effect.map(() => lines.join("\n")),
		);
	});
}

function isHelpRequest(error: Error | CliError.CliError): boolean {
	return CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0;
}

/** The process console, except that `log` appends to `lines` instead of printing. */
function capturingConsole(lines: string[]): Console.Console {
	const target = globalThis.console;
	return {
		assert: (condition: boolean, ...args: ReadonlyArray<unknown>) => target.assert(condition, ...args),
		clear: () => target.clear(),
		count: (label?: string) => target.count(label),
		countReset: (label?: string) => target.countReset(label),
		debug: (...args: ReadonlyArray<unknown>) => target.debug(...args),
		dir: (item: unknown, options?: unknown) => target.dir(item, options),
		dirxml: (...args: ReadonlyArray<unknown>) => target.dirxml(...args),
		error: (...args: ReadonlyArray<unknown>) => target.error(...args),
		group: (...args: ReadonlyArray<unknown>) => target.group(...args),
		groupCollapsed: (...args: ReadonlyArray<unknown>) => target.groupCollapsed(...args),
		groupEnd: () => target.groupEnd(),
		info: (...args: ReadonlyArray<unknown>) => target.info(...args),
		log: (...args: ReadonlyArray<unknown>) => {
			lines.push(args.map((value: unknown): string => String(value)).join(" "));
		},
		table: (tabularData: unknown, properties?: ReadonlyArray<string>) =>
			target.table(tabularData, properties === undefined ? undefined : [...properties]),
		time: (label?: string) => target.time(label),
		timeEnd: (label?: string) => target.timeEnd(label),
		timeLog: (label?: string, ...args: ReadonlyArray<unknown>) => target.timeLog(label, ...args),
		trace: (...args: ReadonlyArray<unknown>) => target.trace(...args),
		warn: (...args: ReadonlyArray<unknown>) => target.warn(...args),
	};
}
