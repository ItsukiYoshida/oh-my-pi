Run the `ldev` lane manager CLI in the session working directory. Pass arguments as an array exactly as after `ldev` on a command line, e.g. `["lane", "list"]`, `["issue", "start", "123"]`, `["lane", "deploy"]`, `["url", "web"]`, `["exec", "--lease", "--", "pnpm", "test"]`. No shell is involved: never quote or join arguments.

`ldev --help` and `ldev <command> --help` are the source of truth for commands and flags. `issue start` gets `--no-agent` unless you pass `--agent` or `--no-agent`, so it does not launch a second agent.

When ldev hands back a worktree (for example after `issue start`), the result ends with `worktree: <path>`. Continue in that worktree by calling `move` with that path as the only tool call in your next response; this tool never moves the session itself.

Exit codes: 0 success, 1 config/Git/hook/launch failure, 2 conflict with an existing branch/worktree/lane, 3 no binding found, 4 endpoint unresolved. A nonzero exit may follow partial success; inspect `ldev lane list` before retrying.
