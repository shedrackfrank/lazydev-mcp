#!/usr/bin/env node
// mcp-server.mjs - stdio MCP server for lazydev-poc.mjs. stdout is the protocol; log with console.error only.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createOutputCollector, GIT_MAX_OUTPUT_BYTES, validateTasks, validRunId } from './lazydev-poc.mjs';
import { mergeOrder } from './lazydev-integrate.mjs';
import { DEFAULT_HARNESSES_FILE, harnessAvailability, normalizeHarnessConfig, OPENCODE, readHarnessConfig, resolveDefaultHarness, validateTaskHarnesses } from './lazydev-harnesses.mjs';
import { resolveOpencodeBin } from './lazydev-bin.mjs';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'lazydev-poc.mjs');

const REPO = process.env.LAZYDEV_REPO ? path.resolve(process.env.LAZYDEV_REPO) : null;
const BIN = process.env.LAZYDEV_OPENCODE_BIN || null;
const MODEL = process.env.LAZYDEV_MODEL || null;
const OUT = process.env.LAZYDEV_OUT
  ? path.resolve(process.env.LAZYDEV_OUT)
  : REPO && path.join(path.dirname(REPO), `${path.basename(REPO)}.lazydev`);
const envMax = Number.parseInt(process.env.LAZYDEV_MAX_PARALLEL ?? '3', 10);
const MAX_PARALLEL = envMax >= 1 && envMax <= 4 ? envMax : 3;

if (!REPO) { console.error('lazydev MCP: LAZYDEV_REPO is required'); process.exit(1); }

const HARNESSES_FILE = process.env.LAZYDEV_HARNESSES
  ? path.resolve(process.env.LAZYDEV_HARNESSES)
  : path.join(HERE, DEFAULT_HARNESSES_FILE);
const HARNESS_CONFIG = readHarnessConfig(HARNESSES_FILE);
const HARNESSES = normalizeHarnessConfig(HARNESS_CONFIG.config, { bin: BIN, model: MODEL });

// LAZYDEV_OPENCODE_BIN is optional: fall back to the installed OpenCode CLI when it is not set.
let ocBinCache;
const opencodeBin = () => {
  if (ocBinCache !== undefined) return ocBinCache;
  ocBinCache = BIN || HARNESS_CONFIG.config[OPENCODE]?.bin || resolveOpencodeBin(process.env, process.platform);
  return ocBinCache;
};

const LIMIT = 2000;
const clip = (v) => {
  if (typeof v === 'string') return v.length > LIMIT ? `${v.slice(0, LIMIT)}...` : v;
  if (Array.isArray(v)) return v.map(clip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
  return v;
};
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(clip(obj)) }] });
const err = (message, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify(clip({ error: message, ...extra })) }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const runDirOf = (runId) => path.join(OUT, 'runs', runId);
const tasksFileOf = (runId) => path.join(OUT, 'inbox', `${runId}.tasks.json`);
const taskIdsFrom = (file) => {
  const spec = readJson(file);
  return Array.isArray(spec?.tasks) ? spec.tasks.map((t) => t?.id).filter(Boolean) : [];
};
const resultFiles = (runDir) => {
  try { return readdirSync(runDir).filter((n) => n.endsWith('.result.json')); } catch { return []; }
};

// Spawn a process, never reject, and kill the whole tree on timeout.
// stdout and stderr are capped separately; `truncated` is true when either stream hit its cap.
const runProcess = (cmd, args, { cwd, timeoutMs = 0, maxBytes } = {}) => new Promise((resolve) => {
  const out = createOutputCollector(maxBytes), err = createOutputCollector(maxBytes);
  let settled = false, timedOut = false, timer;
  const child = spawn(cmd, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const killTree = () => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  };
  const finish = (r) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    resolve({ stdout: out.toString(), stderr: err.toString(), truncated: out.truncated || err.truncated, timedOut, ...r });
  };
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => err.push(d));
  if (timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
  child.on('error', (e) => { err.push(Buffer.from(e.message)); finish({ code: -1, spawnError: true }); });
  child.on('close', (code) => finish({ code }));
});

const gitRun = (cwd, ...args) => runProcess('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs: 60_000, maxBytes: GIT_MAX_OUTPUT_BYTES });

const server = new McpServer({ name: 'lazydev', version: '1.0.0' });

const SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EINVAL', 'UNKNOWN']);

const versionOf = async (cmd, args) => {
  try {
    const r = await execFileP(cmd, args, { windowsHide: true, timeout: 15000 });
    return { version: (r.stdout || r.stderr || '').trim() || 'unknown' };
  } catch (e) {
    // A spawn failure (ENOENT, EACCES, ...) means the command was never started.
    if (SPAWN_ERRORS.has(e?.code)) return { version: 'not installed', error: String(e.message ?? e).trim() };
    return { version: String(e?.stdout || e?.stderr || '').trim() || 'unknown' };
  }
};

const harnessVersion = async (h, bin) => {
  if (h.type === 'opencode') return versionOf(bin ?? h.bin, h.version_argv ?? ['--version']);
  if (!h.version_argv || !h.argv?.length) return { version: 'unknown' };
  return versionOf(h.argv[0], h.version_argv);
};

server.registerTool('list_harnesses', { description: 'List coding harnesses with versions and availability. The default harness has "default": true; call this before dispatch_tasks.' }, async () => {
  if (HARNESS_CONFIG.errors.length) {
    return err('invalid harness config', { file: HARNESSES_FILE, messages: HARNESS_CONFIG.errors });
  }
  const defaultRes = resolveDefaultHarness(HARNESSES, { config: HARNESS_CONFIG.config });
  const defaultId = defaultRes.id ?? null;
  const out = [];
  for (const h of HARNESSES.values()) {
    const av = harnessAvailability(h);
    const entry = { id: h.id, type: h.type, model: h.model ?? null, available: av.available, default: h.id === defaultId };
    if (h.id === OPENCODE) entry.repo = REPO;
    if (!av.available) {
      entry.version = 'not installed';
      if (av.reason) entry.reason = av.reason;
      out.push(entry);
      continue;
    }
    const v = await harnessVersion(h, av.bin);
    entry.version = v.version;
    if (v.error) {
      entry.error = v.error;
      entry.available = false;
      if (!entry.reason) entry.reason = v.error;
    }
    out.push(entry);
  }
  return ok(out);
});

const taskSchema = z.object({
  id: z.string(),
  prompt: z.string().max(4000),
  allowed_paths: z.array(z.string()).min(1).max(20),
  depends_on: z.array(z.string()).optional(),
  verify: z.array(z.string()).optional(),
  harness: z.string().optional(),
});

server.registerTool('dispatch_tasks', {
  description: 'Start a LazyDev run of 1-12 coding tasks. allowed_paths entries are exact relative paths or globs (*, **, ?), e.g. ["src/**"]; folder entries are not supported. Tasks without "harness" use the default shown by list_harnesses, so call list_harnesses first. verify = argument list, program first, run without a shell, e.g. ["node","-e","<js>"]. Split only large independent pieces; merge small or dependent ones into one task. Prompts must state exact export forms and the examples the verify will use.',
  inputSchema: {
    tasks: z.array(taskSchema).min(1).max(12),
    model: z.string().optional(),
    timeout_s: z.number().int().min(1).max(900).optional(),
    max_parallel: z.number().int().min(1).max(4).optional(),
  },
}, async (args) => {
  if (HARNESS_CONFIG.errors.length) {
    return err('invalid harness config', { file: HARNESSES_FILE, messages: HARNESS_CONFIG.errors });
  }
  const messages = validateTasks({ tasks: args.tasks }, { harnesses: [...HARNESSES.keys()] });
  if (messages.length) return err('invalid tasks', { messages });
  const harnessErrs = validateTaskHarnesses(args.tasks, HARNESSES);
  if (harnessErrs.length) return err('harness not available', { messages: harnessErrs });
  let defaultId = null;
  if (args.tasks.some((t) => t.harness === undefined)) {
    const defaultRes = resolveDefaultHarness(HARNESSES, { config: HARNESS_CONFIG.config });
    if (defaultRes.error) return err(defaultRes.error);
    defaultId = defaultRes.id;
  }
  const needsOpencode = args.tasks.some((t) => (t.harness ?? defaultId) === OPENCODE);
  let bin = null;
  if (needsOpencode) {
    try { bin = opencodeBin(); } catch (e) { return err(e.message); }
  }
  const model = args.model || MODEL;
  const timeout = args.timeout_s ?? 300;
  const parallel = args.max_parallel ?? MAX_PARALLEL;
  const runId = `r${Date.now()}${randomBytes(1).toString('hex')}`;
  const inbox = path.join(OUT, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const tasksFile = path.join(inbox, `${runId}.tasks.json`);
  const spec = { tasks: args.tasks };
  if (model) spec.model = model;
  writeFileSync(tasksFile, JSON.stringify(spec, null, 2));
  const cli = [RUNNER, tasksFile, '--repo', REPO, '--out', OUT, '--run-id', runId,
    '--max-parallel', String(parallel), '--timeout', String(timeout), ...(bin ? ['--bin', bin] : []), ...(model ? ['--model', model] : [])];
  const child = spawn(process.execPath, cli, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return ok({ run_id: runId, task_ids: args.tasks.map((t) => t.id) });
});

server.registerTool('wait_for_run', {
  description: 'Poll a run for finished and pending tasks; one call with timeout_s 50 is usually enough.',
  inputSchema: {
    run_id: z.string(),
    timeout_s: z.number().int().min(1).max(50).optional(),
  },
}, async (args) => {
  if (!validRunId(args.run_id)) return err(`bad run_id: ${args.run_id}`);
  const runId = args.run_id;
  const runDir = runDirOf(runId);
  const tasksFile = tasksFileOf(runId);
  const timeout = args.timeout_s ?? 20;
  const deadline = Date.now() + timeout * 1000;
  let taskIds = [];
  let starting = false;

  if (!existsSync(runDir)) {
    if (!existsSync(tasksFile)) return err(`unknown run_id: ${runId}`);
    starting = true;
    taskIds = taskIdsFrom(tasksFile);
    let writtenAt = Date.now();
    try { writtenAt = statSync(tasksFile).mtimeMs; } catch { /* keep now */ }
    const startDeadline = writtenAt + 30_000;
    while (!existsSync(runDir)) {
      const now = Date.now();
      if (now >= startDeadline) {
        return err(`runner did not start for ${runId}; run lazydev-poc.mjs by hand on ${tasksFile} to see the error`);
      }
      if (now >= deadline) return ok({ state: 'starting', done: [], pending: taskIds });
      await sleep(500);
    }
  }

  let meta = null;
  for (;;) {
    meta = readJson(path.join(runDir, 'run.json')) ?? meta;
    const state = meta?.state ?? 'running';
    if (state === 'finished' || state === 'error') break;
    if (Date.now() >= deadline) break;
    await sleep(500);
  }
  if (!meta && starting) return ok({ state: 'starting', done: [], pending: taskIds });
  if (!taskIds.length && Array.isArray(meta?.task_ids)) taskIds = meta.task_ids;
  const done = resultFiles(runDir)
    .map((n) => readJson(path.join(runDir, n)))
    .filter(Boolean)
    .map((r) => ({ id: r.id, status: r.status, duration_s: r.duration_s ?? 0 }));
  const doneIds = new Set(done.map((d) => d.id));
  const out = { state: meta?.state ?? 'running', done, pending: taskIds.filter((id) => !doneIds.has(id)) };
  if (typeof meta?.batch_s === 'number') out.batch_s = meta.batch_s;
  return ok(out);
});

server.registerTool('get_task_report', {
  description: "Read one task's report; omit task_id to list all tasks.",
  inputSchema: {
    run_id: z.string(),
    task_id: z.string().optional(),
    detail: z.enum(['brief', 'full']).optional(),
  },
}, async (args) => {
  if (!validRunId(args.run_id)) return err(`bad run_id: ${args.run_id}`);
  if (args.task_id !== undefined && !validRunId(args.task_id)) return err(`bad task_id: ${args.task_id}`);
  const runDir = runDirOf(args.run_id);
  const meta = readJson(path.join(runDir, 'run.json'));
  const tasksFile = tasksFileOf(args.run_id);
  const taskIds = Array.isArray(meta?.task_ids) ? meta.task_ids
    : (existsSync(tasksFile) ? taskIdsFrom(tasksFile) : null);
  if (!taskIds) return err(`unknown run_id: ${args.run_id}`);

  if (args.task_id === undefined) {
    return ok(taskIds.map((id) => {
      const r = readJson(path.join(runDir, `${id}.result.json`));
      if (!r) return { id, status: 'pending', summary: '', files_changed: [], violations: 0, flags: [], verify_ok: null, duration_s: null, why: '' };
      const item = {
        id: r.id ?? id, status: r.status, summary: String(r.summary ?? '').slice(0, 200),
        files_changed: r.files_changed ?? [], violations: (r.violations ?? []).length,
        flags: r.flags ?? [], verify_ok: r.verify ? r.verify.ok : null, duration_s: r.duration_s ?? null,
      };
      if (r.status !== 'done') item.why = String((r.reasons ?? [])[0] ?? '').slice(0, 200);
      return item;
    }));
  }

  if (!taskIds.includes(args.task_id)) return err(`unknown task_id ${args.task_id} in run ${args.run_id}`);
  const r = readJson(path.join(runDir, `${args.task_id}.result.json`));
  if (!r) return ok({ id: args.task_id, status: 'pending' });
  const report = {
    id: r.id, status: r.status, reasons: r.reasons ?? [], summary: r.summary ?? '',
    files_changed: r.files_changed ?? [], violations: r.violations ?? [], flags: r.flags ?? [],
    verify: r.verify ? { ok: r.verify.ok, exit: r.verify.exit } : null,
    branch: r.branch ?? null, commit: r.commit ?? null, base: r.base ?? null,
    duration_s: r.duration_s ?? null, tokens: r.tokens ?? null,
  };
  if (args.detail === 'full') {
    report.verify = r.verify ?? null;
    report.worktree = r.worktree ?? null;
    report.session_id = r.session_id ?? null;
  } else if (r.verify && r.verify.ok === false) {
    report.verify_output = String(r.verify.output ?? '').slice(0, 300);
  }
  return ok(report);
});

server.registerTool('request_integration', {
  description: "Merge a run's done task branches into a staging worktree for review.\nNever touches your branch or working tree and never pushes.",
  inputSchema: {
    run_id: z.string(),
    verify: z.array(z.string()).optional(),
  },
}, async (args) => {
  if (!validRunId(args.run_id)) return err(`bad run_id: ${args.run_id}`);
  const runId = args.run_id;
  if (args.verify !== undefined) {
    const messages = validateTasks({ tasks: [{ id: 'verify', prompt: 'verify', allowed_paths: ['src/app.js'], verify: args.verify }] });
    if (messages.length) return err('invalid verify', { messages });
  }

  const runDir = runDirOf(runId);
  if (!existsSync(runDir)) return err(`unknown run_id: ${runId}`);
  const spec = readJson(tasksFileOf(runId));
  if (!Array.isArray(spec?.tasks) || !spec.tasks.length) return err(`tasks file missing for run ${runId}`);
  const tasks = spec.tasks;
  const results = new Map(tasks.map((t) => [t.id, readJson(path.join(runDir, `${t.id}.result.json`))]));
  const statusById = new Map(tasks.map((t) => [t.id, results.get(t.id)?.status ?? 'pending']));
  const skipped = tasks.filter((t) => statusById.get(t.id) !== 'done').map((t) => ({ id: t.id, status: statusById.get(t.id) }));
  if (!tasks.some((t) => statusById.get(t.id) === 'done')) return err(`no done tasks in run ${runId}`, { skipped });

  const base = tasks
    .filter((t) => !(t.depends_on ?? []).length)
    .map((t) => results.get(t.id)?.base)
    .find(Boolean);
  if (!base) return err(`no base commit recorded for run ${runId}`);

  const stagingBranch = `lazydev/stage-${runId}`;
  const stagingWorktree = path.join(OUT, 'workspaces', `stage-${runId}`);
  const branchExists = await gitRun(REPO, 'rev-parse', '--verify', `refs/heads/${stagingBranch}`);
  if (branchExists.code === 0 || existsSync(stagingWorktree)) {
    return err(`staging branch ${stagingBranch} already exists; remove it first`, {
      commands: [
        `git worktree remove --force "${stagingWorktree}"`,
        `git branch -D ${stagingBranch}`,
      ],
    });
  }

  const add = await gitRun(REPO, 'worktree', 'add', '-b', stagingBranch, stagingWorktree, base);
  if (add.code !== 0) return err(`cannot create staging worktree: ${(add.stderr || add.stdout).trim().slice(-300)}`);

  const merged = [];
  let conflict = null;
  for (const id of mergeOrder(tasks, statusById)) {
    const taskBranch = results.get(id)?.branch;
    if (!taskBranch) continue;
    const m = await gitRun(stagingWorktree, '-c', 'user.name=LazyDev', '-c', 'user.email=lazydev@localhost', 'merge', '--no-ff', '--no-edit', taskBranch);
    if (m.code !== 0) {
      const files = (await gitRun(stagingWorktree, 'diff', '--name-only', '--diff-filter=U')).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean);
      await gitRun(stagingWorktree, 'merge', '--abort');
      conflict = { task: id, files };
      break;
    }
    merged.push(id);
  }

  let verify = null;
  if (args.verify && !conflict) {
    const r = await runProcess(args.verify[0], args.verify.slice(1), { cwd: stagingWorktree, timeoutMs: 120_000 });
    const raw = r.spawnError
      ? `verify could not start: program not found: ${String(args.verify[0]).slice(0, 60)}`
      : `${r.stdout}${r.stderr}`.trim();
    const output = raw.length <= 500 ? raw : `${raw.slice(0, 300)}\n...\n${raw.slice(-200)}`;
    verify = { ok: !r.spawnError && !r.timedOut && r.code === 0, exit: r.code, output };
  }

  return ok({
    staging_branch: stagingBranch,
    staging_worktree: stagingWorktree,
    base,
    merged,
    skipped,
    conflict,
    verify,
    accept: `git switch <your-branch> && git merge --no-ff ${stagingBranch}`,
    discard: `git worktree remove --force "${stagingWorktree}" && git branch -D ${stagingBranch}`,
  });
});

await server.connect(new StdioServerTransport());
