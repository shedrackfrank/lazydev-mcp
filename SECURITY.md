# Security policy

## Supported versions

Only the latest version on `main` (or the latest release) is supported. Please update before
reporting a problem.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do **not** open a public issue for a security problem.

Please include the Lazy Dev version, your OS, and steps to reproduce. A small tasks file and the
relevant `run.json` / `.result.json` help, but remove secrets and personal paths first.

## Scope

Workers and `verify` commands run as your user, and git worktrees are not a sandbox. This is by
design and documented in the [Safety model](README.md#safety-model): a worker can still write
anywhere the current user can, and Lazy Dev only detects and reports that after the fact. Only run
Lazy Dev on repositories and prompts you trust. Reports about those documented limits are not
vulnerabilities; reports about Lazy Dev bypassing its checks or writing outside its stated paths are.
