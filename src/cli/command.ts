import { runSafely } from "cmd-ts";
import type { Runner } from "cmd-ts/dist/cjs/runner.js";

/** Run without exiting the caller: help succeeds, and failures reach the entry point's error reporting. */
export async function runCommand<Args>(
	command: Runner<Args, Promise<number>>,
	args: readonly string[],
): Promise<number> {
	const result = await runSafely(command, [...args]);
	if (result._tag === "ok") {
		return result.value;
	}
	if (result.error.config.exitCode === 0) {
		console.log(result.error.config.message);
		return 0;
	}
	throw new Error(result.error.config.message);
}
