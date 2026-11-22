# Contributing

Thanks for helping improve Lazy Dev. Small, focused changes are easiest to review.

## Setup

Clone the repository and install the dependencies:

```sh
git clone https://github.com/shedrackfrank/lazydev-mcp.git lazydev
cd lazydev
npm install
```

Run the test suite with:

```sh
npm test
```

That runs `check` (syntax-checks every `.mjs` file), `selftest` (pure unit tests, no git, no
agent, no network), and `smoke` (starts the MCP server and exercises its tools against a
throwaway folder with no real worker). CI runs the same `npm test` on Windows and Ubuntu with
Node 22.

## Before opening a pull request

- `npm test` must pass.
- Add a selftest for every behavior change.
- Keep pull requests small and focused.
- Open an issue before adding a new dependency.

## Adding a harness

Add one entry to `lazydev.harnesses.sample.json`. Keep `"verified": false` until the flags come
from the tool's own `--help` and are proven in a real one-task run and a parallel run. Never guess
flags. In the pull request, say what you tested and on which OS and version.

## Reporting a bug

Include your OS, Node version (`node --version`), the harness and its version, the tasks file, and
the run's `run.json` and task `.result.json` files (from `<out>/runs/<runId>/`). Remove any secrets
or personal paths before posting.

## Security

Workers and verify commands run as your user, and worktrees are not a sandbox. See the
[Safety model](README.md#safety-model) in the README. Report security problems through a private
[GitHub security advisory](https://github.com/shedrackfrank/lazydev-mcp/security/advisories/new),
not a public issue.
