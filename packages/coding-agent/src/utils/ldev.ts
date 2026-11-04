import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, ptree } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { ToolAbortError } from "../tools/tool-errors";
import { FORGE_NON_INTERACTIVE_ENV } from "./forge-cli";

/** Deploy and verify hooks run inside ldev, so the deadline covers a cloud deploy. */
const LDEV_TIMEOUT_MS = 60 * 60 * 1000;

export interface LdevResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Directory ldev asked its caller to enter; absent when ldev launched an agent there itself. */
	worktree?: string;
}

/** Options precede `--`; everything after it belongs to the wrapped command (`ldev exec`). */
function ldevOptions(args: readonly string[]): readonly string[] {
	const end = args.indexOf("--");
	return end < 0 ? args : args.slice(0, end);
}

/**
 * `issue start` honors the user's auto-spawn setting; inside omp that would start a second agent
 * in the worktree the current session is about to move into, so the integration opts out unless
 * the caller chose an agent explicitly.
 */
export function ldevArgs(args: readonly string[]): string[] {
	const options = ldevOptions(args);
	if (
		args[0] !== "issue" ||
		args[1] !== "start" ||
		options.some(arg => arg === "--no-agent" || arg === "--agent" || arg.startsWith("--agent="))
	) {
		return [...args];
	}
	// Appended after a `--` terminator the flag would become a positional argument.
	return [...options, "--no-agent", ...args.slice(options.length)];
}

export const ldev = {
	available(): boolean {
		return Boolean($which("ldev"));
	},

	/**
	 * Run ldev without a shell. The target directory comes from ldev's `LDEV_CD_FILE` handoff (the
	 * same contract its shell wrapper uses), not from parsing human-oriented output. ldev runs in its
	 * own process group so cancelling also stops commands it started (`exec`, deploy hooks).
	 */
	async run(cwd: string, rawArgs: readonly string[], signal?: AbortSignal): Promise<LdevResult> {
		if (!$which("ldev")) throw new ToolError("ldev is not installed or not on PATH.");
		const args = ldevArgs(rawArgs);
		const cdFile = path.join(os.tmpdir(), `omp-ldev-cd-${crypto.randomUUID()}`);
		try {
			let result: ptree.ExecResult;
			try {
				result = await ptree.exec(["ldev", ...args], {
					cwd,
					env: { ...FORGE_NON_INTERACTIVE_ENV, LDEV_CD_FILE: cdFile },
					signal,
					timeout: LDEV_TIMEOUT_MS,
					allowNonZero: true,
					detached: true,
					subreaper: process.platform === "linux",
				});
			} catch (error) {
				if (signal?.aborted) throw new ToolAbortError();
				if (error instanceof ptree.TimeoutError) throw new ToolError(`ldev timed out: ldev ${args.join(" ")}`);
				throw error;
			}
			const target = await fs.readFile(cdFile, "utf8").catch(() => "");
			// `issue resume` and explicit `--agent` hand the worktree to another agent, not this session.
			const options = ldevOptions(args);
			const launchedAgent =
				(args[0] === "issue" && args[1] === "resume") ||
				options.some(arg => arg === "--agent" || arg.startsWith("--agent="));
			return {
				exitCode: result.exitCode ?? 1,
				stdout: result.stdout.trim(),
				stderr: result.stderr.trim(),
				...(target && !launchedAgent ? { worktree: target } : {}),
			};
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
