import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { FORGE_NON_INTERACTIVE_ENV, type ForgeCliResult, runForgeCli } from "./forge-cli";

/** Deploy and verify hooks run inside ldev, so the deadline covers a cloud deploy. */
const LDEV_TIMEOUT_MS = 60 * 60 * 1000;

export interface LdevResult extends ForgeCliResult {
	/** Directory ldev asked its caller to enter; absent when ldev launched an agent there itself. */
	worktree?: string;
}

/**
 * `issue start` honors the user's auto-spawn setting; inside omp that would start a second agent
 * in the worktree the current session is about to move into, so the integration opts out unless
 * the caller chose an agent explicitly.
 */
export function ldevArgs(args: readonly string[]): string[] {
	if (
		args[0] !== "issue" ||
		args[1] !== "start" ||
		args.some(arg => arg === "--no-agent" || arg === "--agent" || arg.startsWith("--agent="))
	) {
		return [...args];
	}
	return [...args, "--no-agent"];
}

export const ldev = {
	available(): boolean {
		return Boolean($which("ldev"));
	},

	/**
	 * Run ldev without a shell. The target directory comes from ldev's `LDEV_CD_FILE` handoff (the
	 * same contract its shell wrapper uses), not from parsing human-oriented output.
	 */
	async run(cwd: string, rawArgs: readonly string[], signal?: AbortSignal): Promise<LdevResult> {
		const args = ldevArgs(rawArgs);
		const cdFile = path.join(os.tmpdir(), `omp-ldev-cd-${crypto.randomUUID()}`);
		try {
			const result = await runForgeCli(
				{
					bin: "ldev",
					displayName: "ldev",
					installMessage: "ldev is not installed or not on PATH.",
					env: { ...FORGE_NON_INTERACTIVE_ENV, LDEV_CD_FILE: cdFile },
					timeoutMs: LDEV_TIMEOUT_MS,
				},
				cwd,
				args,
				signal,
				true,
			);
			const target = await fs.readFile(cdFile, "utf8").catch(() => "");
			// `issue resume` and explicit `--agent` hand the worktree to another agent, not this session.
			const launchedAgent =
				(args[0] === "issue" && args[1] === "resume") ||
				args.some(arg => arg === "--agent" || arg.startsWith("--agent="));
			return target && !launchedAgent ? { ...result, worktree: target } : result;
		} finally {
			await fs.rm(cdFile, { force: true });
		}
	},
};

/** Plain-text transcript of one ldev invocation for the operator or the model. */
export function formatLdevResult(args: readonly string[], result: LdevResult): string {
	const lines = [`$ ldev ${ldevArgs(args).join(" ")}`];
	if (result.stdout) lines.push(result.stdout);
	if (result.stderr) lines.push(result.stderr);
	lines.push(`exit ${result.exitCode}`);
	if (result.worktree) lines.push(`worktree: ${result.worktree}`);
	return lines.join("\n");
}
