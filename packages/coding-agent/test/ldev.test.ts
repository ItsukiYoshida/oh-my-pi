import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ldev as LdevRunner } from "@oh-my-pi/pi-coding-agent/utils/ldev";

// A fake ldev that follows the real CLI's directory handoff: it writes the worktree to
// LDEV_CD_FILE whenever it would ask a wrapping shell to cd, and echoes its argv.
const FAKE_LDEV = `#!/bin/sh
echo "args: $*"
case "$1 $2" in
  "issue start"|"issue resume") printf '%s' "$FAKE_WORKTREE" > "$LDEV_CD_FILE" ;;
  "lane status") echo "no binding" >&2; exit 3 ;;
esac
`;

describe("ldev integration", () => {
	let dir: string;
	let previousPath: string | undefined;
	let ldev: typeof LdevRunner;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ldev-test-"));
		await fs.writeFile(path.join(dir, "ldev"), FAKE_LDEV, { mode: 0o755 });
		await fs.mkdir(path.join(dir, "issue-7"));
		previousPath = process.env.PATH;
		process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
		process.env.FAKE_WORKTREE = path.join(dir, "issue-7");
		// The runner snapshots the environment at import, so load it after PATH points at the fake.
		({ ldev } = await import("@oh-my-pi/pi-coding-agent/utils/ldev"));
	});

	afterAll(async () => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_WORKTREE;
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("starts an issue without launching another agent and hands back its worktree", async () => {
		const result = await ldev.run(dir, ["issue", "start", "7"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("args: issue start 7 --no-agent");
		expect(result.worktree).toBe(path.join(dir, "issue-7"));
	});

	it("keeps an explicit agent choice and does not claim the worktree for this session", async () => {
		const result = await ldev.run(dir, ["issue", "start", "7", "--agent", "omp"]);
		expect(result.stdout).toBe("args: issue start 7 --agent omp");
		expect(result.worktree).toBeUndefined();

		const resumed = await ldev.run(dir, ["issue", "resume", "7"]);
		expect(resumed.worktree).toBeUndefined();
	});

	it("reports ldev failures with their exit code and no worktree", async () => {
		const result = await ldev.run(dir, ["lane", "status"]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toBe("no binding");
		expect(result.worktree).toBeUndefined();
	});
});
