import { Command, type ValidationError } from "@effect/cli";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";

/** Supply the CLI's platform services and argv prefix without exiting the caller. */
export function runCommand<Name extends string, Args>(
	name: Name,
	command: Command.Command<Name, never, Error, Args>,
	args: readonly string[],
): Effect.Effect<number, Error | ValidationError.ValidationError> {
	// The client kit is pinned by Git commit and has no package version.
	return Command.run(command, { name, version: "unversioned" })(["deno", name, ...args]).pipe(
		Effect.provide(NodeContext.layer),
		Effect.as(0),
	);
}
