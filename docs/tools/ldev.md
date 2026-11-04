# ldev

> Run the `ldev` lane manager CLI in the session working directory and report the worktree it hands back.

## Source

- Entry: `packages/coding-agent/src/tools/ldev.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ldev.md`
- Runner shared with `/ldev`: `packages/coding-agent/src/utils/ldev.ts`
- Slash command: `/ldev` in `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts`

## Input and availability

`args` is a string array of everything after `ldev` on a command line, e.g. `["issue", "start", "123"]` or `["exec", "--lease", "--", "pnpm", "test"]`. No shell is involved, so arguments are never quoted or joined. The tool is discoverable (`xd://ldev`), exec-approved, and registered only when `ldev` is on `PATH`. `ldev --help` and `ldev <command> --help` are the source of truth for commands and flags.

## Behavior

- Runs in the session working directory with a non-interactive environment and a one-hour deadline, so lane deploy and verify hooks can finish.
- `issue start` gets `--no-agent`, inserted before any `--`, unless the caller passed `--agent` or `--no-agent` before it. This keeps ldev's auto-spawn setting from launching a second agent in the worktree this session should continue in.
- The worktree comes from ldev's `LDEV_CD_FILE` handoff, the same contract as its shell wrapper, not from parsing its output. When present, the result ends with `worktree: <path>`. `issue resume` and an explicit `--agent` hand the worktree to another agent, so no path is reported for them.
- The tool never moves the session. To continue in the worktree, call `move` with that path as the only tool call of the next response.
- The result shows the effective command line, stdout, stderr, and `exit <code>`. A nonzero exit is a tool error. Exit codes: 0 success, 1 config/Git/hook/launch failure, 2 conflict with an existing branch/worktree/lane, 3 no binding found, 4 endpoint unresolved. A nonzero exit may follow partial success, so inspect `ldev lane list` before retrying.
- Captured stdout and stderr are each capped at 8 MiB, keeping the beginning and adding a truncation notice.
- On POSIX, ldev runs in its own process group. Cancellation or the deadline sends SIGTERM to the group, waits about a second, then sends SIGKILL and waits about another second before returning. Processes that left the group (for example via `setsid`) are not reached.

## Related surfaces

- `/ldev <ldev arguments>` runs the same runner from the TUI or ACP/RPC. When ldev hands back a worktree it moves the current session there directly, through the same path as `/move`. Print mode (`-p`) does not dispatch it.
- `move` relocates the session after an `ldev` tool call.
