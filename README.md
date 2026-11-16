# Lazy Dev

An MCP server where any lead agent delegates coding tasks to worker agents running in isolated git
worktrees. The lead agent gets evidence-based reports back, and a human approves the merge. Lazy Dev
is not a code generator: it starts workers, checks what actually changed in git and on disk, and
refuses to trust a worker's own summary.

## Status

This is a proof of concept. It works with OpenCode (the built-in harness) and with a generic command
harness, so any CLI agent that takes a prompt can be plugged in. It has been tested on Windows only,
and APIs, file layouts and messages may change.

## How it works

1. **`dispatch_tasks`** — the lead agent sends 1–12 tasks. Each task names the files it may touch
   (`allowed_paths`) and optionally a `verify` command and `depends_on` task ids. Lazy Dev creates
   one git worktree and one `lazydev/<runId>-<taskId>` branch per task, then starts a worker in
   each. Independent tasks run in parallel; a task with `depends_on` starts only after its
   dependencies commit.
2. **`wait_for_run`** — the lead agent polls until the run is finished.
3. **`get_task_report`** — read a task's report: status, changed files, whether `verify` passed,
   out-of-scope changes, and flags from the audit of the worker's shell and file tool calls.
4. **`request_integration`** — merge the run's done task branches into a staging branch
   (`lazydev/stage-<runId>`) in a separate worktree. Your branch and working tree are never touched,
   and nothing is pushed.
5. **Human accept** — a person reviews the staging worktree and merges it by hand if it is good.
6. **`lazydev-clean`** — after the review, remove that run's worktrees and `lazydev/` branches. It is
   a dry run unless you pass `--yes`.

Every task is judged from git and the event log, not from the worker's words: changed files are
compared with `allowed_paths`, Lazy Dev runs `verify` itself, and Lazy Dev makes the commits after
the checks pass.

## Install

Requirements: Node.js 22 or newer, git, and the OpenCode CLI (or another agent CLI configured as a
harness).

```sh
git clone https://github.com/shedrackfrank/lazydev-mcp.git lazydev
cd lazydev
npm install
node mcp-server.mjs   # start the server by hand
```

`LAZYDEV_REPO` is required. `LAZYDEV_OPENCODE_BIN` is optional: when it is not set, Lazy Dev looks
for the installed OpenCode CLI. On Windows it checks `%APPDATA%\ai.opencode.desktop\cli\*\opencode-cli.exe`
and the `%LOCALAPPDATA%` equivalents, newest version first, skipping folders with "update" in the
name. On other platforms it looks for `opencode` on `PATH`. It never uses a `.cmd` or `.ps1` shim.
If nothing is found, the error lists every place it looked and tells you to set
`LAZYDEV_OPENCODE_BIN`.

## Configuration

Copy `opencode.mcp.sample.json` to your OpenCode config (usually `opencode.json` in the project or
`~/.config/opencode/opencode.json`) and replace the placeholders:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lazydev": {
        "type": "local",
        "command": ["node", "<path-to-lazydev>/mcp-server.mjs"],
        "environment": {
          "LAZYDEV_REPO": "<path-to-your-repo>",
          "LAZYDEV_OUT": "<path-to-your-repo>.lazydev",
          "LAZYDEV_MODEL": "opencode/<provider-model>",
          "LAZYDEV_MAX_PARALLEL": "3"
        },
        "disabled": false,
        "codemode": false
      }
    }
  }
}
```

Keep `"codemode": false`: the five tools return JSON that the lead agent should read directly.

After changing the config, **restart OpenCode completely**. The background service keeps the old MCP
server process running until it is fully stopped, so a reload alone can leave you talking to the
previous version.

`LAZYDEV_REPO` is required; `LAZYDEV_OUT` defaults to `<repo>.lazydev` next to the repo;
`LAZYDEV_MAX_PARALLEL` is 1–4 (default 3); `LAZYDEV_HARNESSES` points at a harness config file.

## Tools

| Tool | Arguments |
| --- | --- |
| `list_harnesses` | none |
| `dispatch_tasks` | `tasks[]` (each: `id`, `prompt`, `allowed_paths[]`, optional `depends_on[]`, `verify[]`, `harness`), optional `model`, `timeout_s`, `max_parallel` |
| `wait_for_run` | `run_id`, optional `timeout_s` (1–50) |
| `get_task_report` | `run_id`, optional `task_id`, optional `detail` (`brief` or `full`) |
| `request_integration` | `run_id`, optional `verify[]` |

## Verify format

`verify` is an **argument list**, program first, run without a shell. There is no quoting layer, no
glob expansion and no shell built-ins.

Right:

```json
"verify": ["node", "-e", "const {slugify}=require('./slug.js');const a=require('node:assert');a.strictEqual(slugify('Hello World'),'hello-world');console.log('verify ok')"]
```

Wrong — one command-line string:

```json
"verify": ["node -e \"console.log('verify ok')\""]
```

The wrong form tries to run a program named `node -e "..."`, which does not exist. Split the command
into its arguments instead.

## Harness config

`lazydev.harnesses.sample.json` shows the format. Copy it to `lazydev.harnesses.json` next to
`mcp-server.mjs`; that file is git-ignored because it usually contains local paths. Three
placeholders are replaced in each `argv` item: `{prompt}` (the task prompt), `{prompt_file}` (a file
containing the prompt) and `{cwd}` (the task worktree).

```json
{
  "my-agent": {
    "type": "command",
    "argv": ["my-agent", "--prompt-file", "{prompt_file}"],
    "version_argv": ["--version"]
  }
}
```

The `example-claude-code`, `example-codex` and `example-gemini` entries in the sample are
**unverified guesses**. Check the flags against each CLI's `--help` before using them.

## Safety model

The worktree is a speed bump, not a sandbox. A worker that is blocked from writing outside its
worktree can still use its shell to write anywhere the current user can. Lazy Dev detects and flags
that after the fact, and it never commits out-of-scope files, but it cannot prevent it. Only run
Lazy Dev on repositories and prompts you trust. OS-level isolation is future work.

Branches are created only under `lazydev/`, worktrees only under `<out>/workspaces`, your current
branch and working tree are never touched, and nothing is pushed.

## Measured results

Single observations, not benchmarks:

- Small tasks were **slower** and used **more tokens** than doing the same work in one session; the
  overhead of a worktree, a fresh worker and verification dominates a one-file change.
- A five-module job with pre-written tests was about **1.7x faster** in one run.
- Cost savings are **not proven**. Do not assume this saves money.

## Known limits

- A worker can violate the frozen-file rule and write outside `allowed_paths`. This is detected and
  flagged, not prevented.
- The timeout kill path is untested on Windows.
- More than 4 parallel workers is untested.
- The `claude`, `codex` and `gemini` harness examples are unverified guesses.
- Linux and macOS are untested.

## Contributing

To add a harness, copy an entry from `lazydev.harnesses.sample.json`, set `type` to `"command"`, and
put the program first in `argv`. Use `{prompt}`, `{prompt_file}` or `{cwd}` where the prompt and
folder go, then check it with `list_harnesses` and one small task.

Run the tests with:

```sh
npm test
```

That runs `check` (syntax-check every `.mjs`), `selftest` (pure unit tests, no git, no agent) and
`smoke` (starts the MCP server and exercises the tools against a throwaway folder, with no real
worker).

## License

MIT. See `LICENSE`.
