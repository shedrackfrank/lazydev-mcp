#!/usr/bin/env node
// lazydev-poc.mjs - the Lazy Dev run worker. mcp-server.mjs starts it; it can also run by itself.
// Runs independent coding tasks in parallel through the OpenCode CLI, each in its own git worktree,
// then judges every result from git and the event log, not from the worker's own words.
//
// Per task: worktree + branch from HEAD (or from the dependency commit when depends_on is set) -> guardrail
// opencode.json -> `opencode run --auto --format json` (with a timeout) -> parse JSON Lines events -> compare
// changed files with allowed_paths and the frozen contract -> optional verify command -> audit shell/file tool
// use -> commit in-scope results on the task branch -> one JSON line.
//
// Honest limits:
//  * The worktree and the opencode.json deny rule are speed bumps, not a sandbox. In testing, a worker that was
//    blocked by the rule wrote outside the folder anyway through its shell tool. This script FLAGS that after the
//    fact; it cannot PREVENT it. Only run it on repos and prompts you trust.
//  * Tasks may depend on earlier tasks (depends_on): a dependent starts only after its dependencies are done,
//    from the first dependency's commit, with the others merged in.
//  * A timeout kills the opencode client process. Whether OpenCode's shared background service then stops the
//    session is unverified.
//  * Verify commands run without a shell, so use real executables (node, git, python), not npm or .cmd shims.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_HARNESSES_FILE, fillArgv, normalizeHarnessConfig, OPENCODE, readHarnessConfig, resolveDefaultHarness, validateTaskHarnesses } from './lazydev-harnesses.mjs';
import { resolveOpencodeBin } from './lazydev-bin.mjs';

const IS_WIN = process.platform === 'win32';
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free';
const GUARDRAIL = { $schema: 'https://opencode.ai/config.json', permission: { external_directory: { '*': 'deny' } } };
const active = new Set();
const log = (...a) => console.error('[lazydev]', ...a);
const round1 = (n) => Math.round(n * 10) / 10;
const words = (s, n) => { const w = s.trim().split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')} ...` : s.trim(); };
const lastWords = (s, n) => s.trim().split(/\s+/).filter(Boolean).slice(-n).join(' ');

let runMeta = null; // { file, data } once the run folder exists; lets fatal errors mark run.json
function writeRunJson(patch) {
  if (!runMeta) return;
  try { writeFileSync(runMeta.file, JSON.stringify({ ...runMeta.data, ...patch }, null, 2)); } catch { /* best effort */ }
}

// ---------- process helpers ----------

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // 16 MiB per stream
export const GIT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024; // 256 MiB: a patch must never be cut

// Read per call (not at module load) so a test can change LAZYDEV_MAX_OUTPUT_BYTES at any time.
export function maxOutputBytes() {
  const n = Number.parseInt(process.env.LAZYDEV_MAX_OUTPUT_BYTES ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT_BYTES;
}

// Collect one stream without ever growing past `limit` bytes. Extra bytes are dropped and the
// collector reports truncated: true. Bytes already collected are kept; the crossing chunk is cut
// so the total is exactly `limit`.
export function createOutputCollector(limit = maxOutputBytes()) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const room = limit - size;
      if (room <= 0) { truncated = true; return; }
      if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); size = limit; truncated = true; return; }
      chunks.push(chunk);
      size += chunk.length;
    },
    toString() { return Buffer.concat(chunks).toString('utf8'); },
    get truncated() { return truncated; },
    get length() { return size; },
  };
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL'); // whole process group (children are spawned detached)
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// Never rejects. Resolves { code, stdout, stderr, truncated, timedOut, spawnError }. Arguments go straight to the process (no shell).
// stdin (when given) is written to the process and closed, so a worker can read the brief from its standard input.
// stdout and stderr are capped separately; `truncated` is true when either stream hit its cap.
export function exec(cmd, args, { cwd, timeoutMs = 0, stdin = null, maxBytes } = {}) {
  return new Promise((resolve) => {
    const cap = maxBytes ?? maxOutputBytes();
    const out = createOutputCollector(cap), err = createOutputCollector(cap);
    let settled = false, timedOut = false, timer;
    const child = spawn(cmd, args, { cwd, windowsHide: true, detached: !IS_WIN, stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const finish = (r) => {
      if (settled) return;
      settled = true; clearTimeout(timer); active.delete(child);
      resolve({ stdout: out.toString(), stderr: err.toString(), truncated: out.truncated || err.truncated, timedOut, ...r });
    };
    active.add(child);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    if (stdin !== null) {
      child.stdin.on('error', () => { /* the worker may exit before reading its input */ });
      try { child.stdin.end(stdin); } catch { /* already gone */ }
    }
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (e) => { err.push(Buffer.from(e.message)); finish({ code: -1, spawnError: true }); });
    child.on('close', (code) => finish({ code }));
  });
}

const git = (cwd, ...args) => exec('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBytes: GIT_MAX_OUTPUT_BYTES });
let gitChain = Promise.resolve(); // serialise git commands that write (worktree add, add, commit)
const gitLocked = (cwd, ...args) => { const p = gitChain.then(() => git(cwd, ...args)); gitChain = p; return p; };

// ---------- path helpers ----------

const isWinAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

// --run-id: starts with a letter or digit; then letters, digits, dot, underscore, hyphen; 1..60 chars.
// Also used as a folder name, so "." and ".." are rejected by the first-character rule.
export function validRunId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(id);
}

// true if p (absolute, or relative to root) is root or inside it. Works for Windows-style roots on any OS.
export function inside(root, p) {
  const P = isWinAbs(root) ? path.win32 : path.posix;
  if (isWinAbs(p) !== isWinAbs(root) && (isWinAbs(p) || p.startsWith('/'))) return false;
  const rel = P.relative(P.resolve(root), P.resolve(root, p));
  return rel === '' || (rel.split(P.sep)[0] !== '..' && !P.isAbsolute(rel));
}

export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, IS_WIN ? 'i' : '');
}

// Paths a shell command mentions that fall outside the worktree (heuristic: an audit signal, not a guarantee).
export function outsidePaths(cmd, wt) {
  const found = new Set();
  const cands = [
    ...(cmd.match(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|*?;,)]*/g) ?? []),
    ...(cmd.match(/\\\\[\w.$-]+\\[^\s"'`<>|*?;,)]*/g) ?? []),
  ];
  if (!isWinAbs(wt)) for (const m of cmd.matchAll(/(?:^|[\s"'=(])(\/[^\s"'`<>|;&)]+)/g)) cands.push(m[1]);
  for (const c of cands) if (!inside(wt, c)) found.add(c);
  if (/(^|[\s"'\\/])\.\.([\\/]|$)/.test(cmd)) found.add('.. (parent folder)');
  if (/(^|[\s"'=(])~[\\/]|\$HOME|\$env:(USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP)|%(USERPROFILE|APPDATA|LOCALAPPDATA|TEMP)%/i.test(cmd)) found.add('a home/env folder');
  return [...found];
}

// ---------- tasks ----------

export function findCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map(); // 1 = on the current path, 2 = finished
  const stack = [];
  let cycle = null;
  const visit = (id) => {
    if (cycle) return;
    if (color.get(id) === 1) { cycle = stack.slice(stack.indexOf(id)); return; }
    if (color.get(id) === 2) return;
    const t = byId.get(id);
    if (!t) return;
    color.set(id, 1);
    stack.push(id);
    for (const d of t.depends_on ?? []) visit(d);
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) if (!cycle) visit(t.id);
  return cycle;
}

const FINAL_STATUSES = new Set(['done', 'failed', 'rejected', 'timeout', 'needs_review', 'blocked']);

// A task not yet started is ready when every dependency is done, and blocked when any dependency has a final
// status other than done. Tasks whose dependencies are still running are neither.
export function readyAndBlocked(tasks, statusById, startedIds = []) {
  const started = startedIds instanceof Set ? startedIds : new Set(startedIds);
  const status = (id) => (typeof statusById?.get === 'function' ? statusById.get(id) : statusById?.[id]);
  const ready = [], blocked = [];
  for (const t of tasks) {
    if (started.has(t.id)) continue;
    const deps = t.depends_on ?? [];
    let bad = null, allDone = true;
    for (const d of deps) {
      const s = status(d);
      if (s === 'done') continue;
      allDone = false;
      if (FINAL_STATUSES.has(s)) { bad = { id: d, status: s }; break; }
    }
    if (bad) blocked.push({ id: t.id, reason: `dependency ${bad.id} is ${bad.status}` });
    else if (allDone) ready.push(t.id);
  }
  return { ready, blocked };
}

export function validateTasks(spec, { harnesses = [OPENCODE] } = {}) {
  const errs = [];
  if (!spec || !Array.isArray(spec.tasks) || spec.tasks.length === 0) return ['"tasks" must be a non-empty array'];
  const ids = new Set(spec.tasks.map((t) => t?.id));
  const allowed = harnesses instanceof Set ? harnesses : new Set(harnesses);
  const seen = new Set();
  for (const t of spec.tasks) {
    const id = t?.id;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id ?? '')) errs.push(`bad task id ${JSON.stringify(id)} (lowercase letters, digits, hyphens; max 40)`);
    if (seen.has(id)) errs.push(`duplicate task id: ${id}`);
    seen.add(id);
    if (typeof t.prompt !== 'string' || !t.prompt.trim()) errs.push(`${id}: "prompt" is required`);
    if (!Array.isArray(t.allowed_paths) || t.allowed_paths.length === 0) errs.push(`${id}: "allowed_paths" is required, e.g. ["src/**"]`);
    for (const p of Array.isArray(t.allowed_paths) ? t.allowed_paths : []) {
      if (typeof p !== 'string' || !p.trim() || isWinAbs(p) || p.startsWith('/') || p.split(/[\\/]/).includes('..')) {
        errs.push(`${id}: bad allowed path ${JSON.stringify(p)} (must be relative, no "..")`);
        continue;
      }
      const norm = p.replace(/\\/g, '/');
      if (norm.endsWith('/')) errs.push(`${id}: bad allowed path ${JSON.stringify(p)} (folder entries are not supported; use a glob such as "src/**" or exact file paths)`);
    }
    if (t.depends_on !== undefined) {
      if (!Array.isArray(t.depends_on)) errs.push(`${id}: "depends_on" must be an array of task ids`);
      else for (const d of t.depends_on) {
        if (typeof d !== 'string' || !ids.has(d)) errs.push(`${id}: depends_on references unknown task ${JSON.stringify(d)}`);
        else if (d === id) errs.push(`${id}: depends_on cannot include itself`);
      }
    }
    if (t.verify !== undefined) {
      const bad = !Array.isArray(t.verify) || !t.verify.length || !t.verify.every((x) => typeof x === 'string');
      const oneLine = !bad && t.verify.length === 1 && /\s/.test(t.verify[0]);
      if (bad || oneLine) errs.push(`task ${id}: verify must be an argument list like ["node","-e","<code>"], not one command-line string`);
    }
    if (t.harness !== undefined) {
      if (typeof t.harness !== 'string' || !t.harness.trim()) errs.push(`${id}: "harness" must be a harness id`);
      else if (!allowed.has(t.harness)) errs.push(`${id}: unknown harness ${JSON.stringify(t.harness)} (configured: ${[...allowed].join(', ')})`);
    }
  }
  const cycle = findCycle(spec.tasks);
  if (cycle) errs.push(`dependency cycle: ${cycle.join(' -> ')} -> ${cycle[0]}`);
  return errs;
}

export function buildBrief(t) {
  return [
    `Task: ${t.prompt.trim()}`,
    '',
    'Rules:',
    '- Work only inside the current directory. Do not read, write or run anything outside it.',
    `- You may only create or change files matching: ${t.allowed_paths.join(', ')}`,
    ...(t.frozen?.size ? [`- Read-only files from earlier tasks (do not modify): ${[...t.frozen].join(', ')}. They are already in your folder.`] : []),
    ...(t.verify ? ['- The runner will run the verify command after you finish. Do not write your own tests, scratch scripts or temp files, and do not run your own checks beyond what the task asks; just make the files and stop.'] : []),
    '- Do not run git commands that commit, branch, merge or push. The orchestrator handles git.',
    '- When finished, reply with a short summary (under 100 words) of what you did.',
  ].join('\n');
}

// ---------- reading OpenCode's JSON Lines output ----------

function auditTool(part, wt, flags) {
  const st = part.state ?? {};
  const input = st.input ?? {};
  const target = input.path ?? input.filePath ?? input.file_path;
  if (typeof target === 'string' && !inside(wt, target)) {
    flags.push(st.status === 'error'
      ? `blocked: ${part.tool} tried a path outside the worktree: ${target}`
      : `${part.tool} touched a path outside the worktree: ${target}`);
  }
  if (part.tool === 'shell' || part.tool === 'bash') {
    const cmd = String(input.command ?? '');
    for (const p of outsidePaths(cmd, wt)) flags.push(`shell command references ${p}: ${cmd.slice(0, 120)}`);
  }
}

export function parseEvents(text, wt) {
  const info = { session: null, summary: '', tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0 }, cost: 0,
    steps: 0, finished: false, bad_lines: 0, errors: [], flags: [], first_ts: null, last_ts: null };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { info.bad_lines++; continue; }
    info.session ??= ev.sessionID ?? null;
    if (typeof ev.timestamp === 'number') { info.first_ts ??= ev.timestamp; info.last_ts = ev.timestamp; }
    const part = ev.part ?? {};
    if (ev.type === 'text' && typeof part.text === 'string') info.summary = part.text;
    else if (ev.type === 'step_finish') {
      const k = part.tokens ?? {};
      info.tokens.input += k.input ?? 0; info.tokens.output += k.output ?? 0;
      info.tokens.reasoning += k.reasoning ?? 0; info.tokens.cache_read += k.cache?.read ?? 0;
      info.cost += part.cost ?? 0; info.steps++; info.finished = part.reason === 'stop';
    } else if (ev.type === 'tool_use') auditTool(part, wt, info.flags);
    else if (ev.type === 'error') info.errors.push(String(ev.error?.message ?? ev.message ?? JSON.stringify(ev)).slice(0, 200));
  }
  if (info.bad_lines) info.flags.push(`${info.bad_lines} output line(s) were not valid JSON`);
  info.flags = [...new Set(info.flags)];
  return info;
}

// ---------- git evidence ----------

async function changedFiles(wt, ignore) {
  const r = await git(wt, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const parts = r.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    files.push(parts[i].slice(3));
    if (/[RC]/.test(xy)) files.push(parts[++i]); // rename/copy: the old path changed too
  }
  return [...new Set(files)].filter((f) => f && !ignore.has(f)).sort();
}

export function clipVerifyOutput(text) {
  const s = String(text);
  if (s.length <= 700) return s;
  return `${s.slice(0, 400)}\n...\n${s.slice(-250)}`;
}

async function runVerify(t) {
  if (!t.verify) return null;
  const [cmd, ...args] = t.verify;
  const r = await exec(cmd, args, { cwd: t.wt, timeoutMs: 60_000 });
  if (r.spawnError) {
    return { ok: false, exit: r.code, timed_out: false, spawn_error: true, output: `verify could not start: program not found: ${String(t.verify[0]).slice(0, 60)}` };
  }
  return { ok: r.code === 0 && !r.timedOut, exit: r.code, timed_out: r.timedOut, truncated: r.truncated, output: clipVerifyOutput(`${r.stdout}${r.stderr}`.trim()) };
}

// ---------- one task ----------

async function runTask(t, ctx) {
  try { return await runTaskInner(t, ctx); }
  catch (e) { return { id: t.id, status: 'failed', reasons: [`internal error: ${e.message}`], branch: t.branch ?? null, worktree: t.wt ?? null, depends_on: [...(t.depends_on ?? [])], base: t.base ?? null }; }
}

async function runTaskInner(t, ctx) {
  const t0 = Date.now();
  const res = { id: t.id, status: 'failed', reasons: [], summary: '', files_changed: [], violations: [], flags: [], verify: null,
    commit: null, session_id: null, duration_s: 0, agent_s: null, tokens: null, cost: null, branch: t.branch ?? null, worktree: t.wt ?? null,
    guardrail: t.guardrail ?? null, depends_on: [...(t.depends_on ?? [])], base: t.base ?? null };
  if (t.setupError) { res.reasons.push(`worktree setup failed: ${t.setupError}`); return res; }

  const harness = ctx.harnesses.get(t.harness ?? ctx.defaultHarness) ?? ctx.harnesses.get(ctx.defaultHarness) ?? ctx.harnesses.get(OPENCODE);
  const isCommand = harness.type === 'command';
  const brief = buildBrief(t);
  let info = null;
  let run;
  log(`start   ${t.id}${isCommand ? ` (${harness.id})` : ''}`);
  if (isCommand) {
    const promptFile = path.join(ctx.runDir, `${t.id}.prompt.txt`);
    writeFileSync(promptFile, brief);
    const argv = fillArgv(harness.argv, { prompt: brief, prompt_file: promptFile, cwd: t.wt });
    run = await exec(argv[0], argv.slice(1), { cwd: t.wt, timeoutMs: ctx.timeoutMs, stdin: harness.stdin ? brief : null });
    writeFileSync(path.join(ctx.runDir, `${t.id}.stdout.txt`), run.stdout);
    if (run.stderr.trim()) writeFileSync(path.join(ctx.runDir, `${t.id}.stderr.txt`), run.stderr);
    res.summary = lastWords(run.stdout, 150);
    res.flags = [];
  } else {
    const args = ['run', '--auto', '--format', 'json', '-m', ctx.model,
      ...(ctx.standalone ? ['--standalone'] : []), ...(ctx.archived ? ['--archived'] : []), brief];
    run = await exec(ctx.bin, args, { cwd: t.wt, timeoutMs: ctx.timeoutMs });
    writeFileSync(path.join(ctx.runDir, `${t.id}.events.jsonl`), run.stdout);
    if (run.stderr.trim()) writeFileSync(path.join(ctx.runDir, `${t.id}.stderr.txt`), run.stderr);

    info = parseEvents(run.stdout, t.wt);
    res.summary = words(info.summary, 150);
    res.session_id = info.session;
    res.flags = info.flags;
    if (info.steps) { res.tokens = info.tokens; res.cost = info.cost; } // stays null when OpenCode reported nothing
    if (info.first_ts && info.last_ts) res.agent_s = round1((info.last_ts - info.first_ts) / 1000);
  }

  // 1. did the worker process finish cleanly? A command harness has no event stream to check.
  let ok = true;
  if (run.timedOut) { ok = false; res.status = 'timeout'; res.reasons.push(`timed out after ${ctx.timeoutMs / 1000}s`); }
  else if (run.spawnError) { ok = false; res.reasons.push(`could not start: ${run.stderr.trim()}`); }
  else if (run.code !== 0) { ok = false; res.reasons.push(`exit code ${run.code}: ${run.stderr.trim().slice(-200)}`); }
  else if (!isCommand && !info.finished) { ok = false; res.reasons.push('no completion event (no step_finish with reason "stop")'); }
  if (!ok && info?.errors.length) res.reasons.push(`harness error: ${info.errors[0]}`);

  // 2. what really changed (git is the source of truth)
  res.files_changed = await changedFiles(t.wt, t.ignore);
  const outOfScope = res.files_changed.filter((f) => !t.allowedRe.some((re) => re.test(f)));
  const frozenHits = res.files_changed.filter((f) => t.frozen?.has(f));
  res.violations = [...new Set([...outOfScope, ...frozenHits])];

  // 3. verify with the command defined beforehand, only when the diff is in scope
  if (ok && !res.violations.length) {
    res.verify = await runVerify(t);
    if (res.verify && !res.verify.ok) {
      ok = false;
      res.reasons.push(res.verify.spawn_error
        ? res.verify.output
        : `verify failed (exit ${res.verify.exit}): ${res.verify.output}`);
    }
  }

  // 4. verdict
  if (!ok) { if (res.status !== 'timeout') res.status = 'failed'; }
  else if (res.violations.length) {
    res.status = 'rejected';
    if (outOfScope.length) res.reasons.push(`changed files outside allowed_paths: ${outOfScope.join(', ')}`);
    if (frozenHits.length) res.reasons.push(`changed read-only files from earlier tasks: ${frozenHits.join(', ')}`);
  }
  else if (res.flags.length || !res.files_changed.length) {
    res.status = 'needs_review';
    if (!res.files_changed.length) res.reasons.push('worker finished but no files changed');
    if (res.flags.length) res.reasons.push(`${res.flags.length} audit flag(s), see "flags"`);
  } else res.status = 'done';

  // Output caps are recorded, never treated as a failure: res.reasons is the failure list.
  const truncationNotes = [];
  if (run.truncated) truncationNotes.push('worker output was truncated at the output cap');
  if (res.verify?.truncated) truncationNotes.push('verify output was truncated at the output cap');
  if (truncationNotes.length) {
    res.output_truncated = true;
    res.output_note = `${truncationNotes.join('; ')} (see LAZYDEV_MAX_OUTPUT_BYTES)`;
  }

  // The audit note is added after the verdict so it never turns a clean command-harness task into needs_review.
  if (isCommand) res.flags.push('shell-audit skipped: command harness output is not parsed');

  // 5. keep the evidence: patch for any change, commit only in-scope results
  if (res.files_changed.length) {
    await gitLocked(t.wt, 'add', '-A', '--', '.', ...t.excludeSpec);
    const patch = await git(t.wt, 'diff', '--cached', '--binary');
    if (patch.truncated) {
      // A cut patch is corrupt, so write nothing and fail the task instead of committing a mystery diff.
      res.status = 'failed';
      res.reasons.push(`patch output exceeded the git cap of ${GIT_MAX_OUTPUT_BYTES} bytes; the patch was not written`);
    } else {
      writeFileSync(path.join(ctx.runDir, `${t.id}.patch`), patch.stdout);
      if (ctx.commit && (res.status === 'done' || res.status === 'needs_review')) {
        const c = await gitLocked(t.wt, '-c', 'user.name=LazyDev', '-c', 'user.email=lazydev@localhost', 'commit', '-m', `lazydev: ${t.id}`);
        if (c.code === 0) res.commit = (await git(t.wt, 'rev-parse', '--short', 'HEAD')).stdout.trim();
        else res.reasons.push(`commit failed: ${(c.stderr || c.stdout).trim().slice(-200)}`);
      }
    }
  }
  res.duration_s = round1((Date.now() - t0) / 1000);
  log(`finish  ${t.id}  ${res.status}`);
  return res;
}

// Files produced by every task this task transitively depends on; they are present in its worktree and read-only.
function frozenFiles(t, stateById) {
  const out = new Set();
  for (const d of t.depends_on ?? []) {
    const entry = stateById.get(d);
    if (!entry) continue;
    for (const f of frozenFiles(entry.task, stateById)) out.add(f);
    for (const f of entry.res.files_changed ?? []) out.add(f);
  }
  return out;
}

// Create the task's worktree when the task starts. No deps: branch from HEAD. One dep: from that dep's commit.
// Several deps: from the first dep's commit, then merge the others in (abort and fail on conflict).
async function prepareWorktree(t, { repo, out, runId, head, stateById, defaultHarness }) {
  t.wt = path.join(out, 'workspaces', `${runId}-${t.id}`);
  t.branch = `lazydev/${runId}-${t.id}`;
  t.ignore = new Set();
  t.excludeSpec = [];
  t.allowedRe = t.allowed_paths.map(globToRegExp);

  const deps = t.depends_on ?? [];
  const commits = deps.map((d) => stateById.get(d)?.res?.commit);
  const missing = deps.find((d, i) => !commits[i]);
  if (missing) { t.setupError = `dependency ${missing} has no commit to branch from`; return; }
  const base = deps.length ? commits[0] : head;
  t.base = base.slice(0, 7);

  const add = await gitLocked(repo, 'worktree', 'add', '-b', t.branch, t.wt, base);
  if (add.code !== 0) { t.setupError = (add.stderr || add.stdout).trim(); return; }
  t.hasWorktree = true;

  for (let i = 1; i < deps.length; i++) {
    const m = await gitLocked(t.wt, '-c', 'user.name=LazyDev', '-c', 'user.email=lazydev@localhost', 'merge', '--no-ff', '--no-edit', commits[i]);
    if (m.code !== 0) {
      await gitLocked(t.wt, 'merge', '--abort');
      t.setupError = `cannot merge dependency ${deps[i]} (conflict?): ${(m.stderr || m.stdout).trim().slice(-300)}`;
      return;
    }
  }
  const shortHead = await git(t.wt, 'rev-parse', '--short', 'HEAD');
  if (shortHead.code === 0) t.base = shortHead.stdout.trim();

  if ((t.harness ?? defaultHarness) !== OPENCODE) { t.guardrail = 'n/a (command harness)'; return; }

  const cfg = path.join(t.wt, 'opencode.json');
  if (existsSync(cfg)) t.guardrail = 'none (repo has its own opencode.json, left untouched)';
  else {
    writeFileSync(cfg, JSON.stringify(GUARDRAIL, null, 2));
    t.guardrail = 'external_directory=deny (speed bump, not a sandbox)';
    t.ignore.add('opencode.json');
    t.excludeSpec = [':(exclude)opencode.json'];
  }
}

// ---------- main ----------

const USAGE = `Usage: node lazydev-poc.mjs <tasks.json> [--bin <opencode-cli>] [options]
  --bin <path>         OpenCode CLI executable (default: LAZYDEV_OPENCODE_BIN, then auto-discovery). Use the real .exe, not a .cmd/.ps1 shim.
  --repo <dir>         git repository to work on (default: current folder)
  --model <p/m>        model, e.g. ${DEFAULT_MODEL} (default: "model" in the tasks file, else that one)
  --timeout <sec>      per-task time limit (default 300)
  --max-parallel <n>   workers running at once (default 3)
  --out <dir>          where worktrees and logs go (default: <repo>.lazydev, next to the repo)
  --run-id <id>        use this run id instead of the timestamp (letters, digits, . _ -, max 60)
  --no-commit          leave results staged instead of committing them on the task branch (not allowed with depends_on)
  --standalone         pass --standalone to opencode (private server per run)
  --archived           pass --archived to opencode (keep scripted sessions out of the session list)

Tasks may set "depends_on": ["task-id", ...]. A dependent starts only after every dependency is done, from the
first dependency's commit, with the other dependency commits merged in. Files from dependencies are read-only.
Tasks may also set "harness": "<id>". A task without one uses the default: LAZYDEV_DEFAULT_HARNESS or
"default" in lazydev.harnesses.json when set, else "opencode" when it is available, else the only
available harness. Extra command harnesses come from lazydev.harnesses.json (next to this script) or
the file named by LAZYDEV_HARNESSES.`;

async function main() {
  let v, positionals;
  try {
    ({ values: v, positionals } = parseArgs({ allowPositionals: true, options: {
      repo: { type: 'string', default: '.' }, bin: { type: 'string' }, model: { type: 'string' },
      timeout: { type: 'string', default: '300' }, 'max-parallel': { type: 'string', default: '3' }, out: { type: 'string' },
      'run-id': { type: 'string' },
      'no-commit': { type: 'boolean', default: false }, standalone: { type: 'boolean', default: false },
      archived: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } } }));
  } catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
  if (v.help || positionals.length !== 1) { console.error(USAGE); process.exit(v.help ? 0 : 2); }
  const fail = (m) => {
    writeRunJson({ state: 'error', finished_at: new Date().toISOString(), message: String(m).slice(0, 300) });
    console.error(`[lazydev] ERROR: ${m}`);
    process.exit(2);
  };
  process.on('SIGINT', () => { for (const c of active) killTree(c); process.exit(130); });

  const harnessFile = process.env.LAZYDEV_HARNESSES
    ? path.resolve(process.env.LAZYDEV_HARNESSES)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), DEFAULT_HARNESSES_FILE);
  const harnessConfig = readHarnessConfig(harnessFile);
  if (harnessConfig.errors.length) fail(`invalid harness config (${harnessFile}):\n  - ${harnessConfig.errors.join('\n  - ')}`);

  let spec;
  try { spec = JSON.parse(readFileSync(positionals[0], 'utf8').replace(/^﻿/, '')); }
  catch (e) { fail(`cannot read tasks file: ${e.message}`); }

  const ocEntry = harnessConfig.config[OPENCODE] ?? {};
  const preliminaryBin = v.bin ?? process.env.LAZYDEV_OPENCODE_BIN ?? ocEntry.bin ?? null;
  const preliminary = normalizeHarnessConfig(harnessConfig.config, { bin: preliminaryBin });
  const errs = validateTasks(spec, { harnesses: [...preliminary.keys()] });
  if (errs.length) fail(`invalid tasks file:\n  - ${errs.join('\n  - ')}`);
  if (v['no-commit'] && spec.tasks.some((t) => t.depends_on?.length)) {
    fail('--no-commit cannot be used when a task has depends_on: dependents need their dependencies committed');
  }

  const harnessErrs = validateTaskHarnesses(spec.tasks, preliminary);
  if (harnessErrs.length) fail(`harness not available:\n  - ${harnessErrs.join('\n  - ')}`);
  let defaultHarness = null;
  if (spec.tasks.some((t) => t.harness === undefined)) {
    const defaultRes = resolveDefaultHarness(preliminary, { config: harnessConfig.config });
    if (defaultRes.error) fail(defaultRes.error);
    defaultHarness = defaultRes.id;
  }

  const needsOpencode = spec.tasks.some((t) => (t.harness ?? defaultHarness) === OPENCODE);
  let bin = null;
  let ver = { stdout: '', stderr: '', code: 0 };
  if (needsOpencode) {
    let binArg;
    try {
      binArg = v.bin ?? process.env.LAZYDEV_OPENCODE_BIN ?? ocEntry.bin ?? resolveOpencodeBin(process.env, process.platform);
    } catch (e) { fail(e.message); }
    if (/\.(cmd|bat|ps1)$/i.test(binArg)) fail('--bin must be the real executable (.exe), not a .cmd/.bat/.ps1 shim');
    // a path (not a bare command name) is made absolute now: workers run from inside their worktrees
    bin = /[\\/]/.test(binArg) ? path.resolve(binArg) : binArg;
    if (/[\\/]/.test(binArg) && !existsSync(bin)) fail(`--bin not found: ${bin}`);
    ver = await exec(bin, ['--version']);
    if (ver.spawnError || ver.code !== 0) fail(`cannot run "${bin} --version": ${ver.stderr.trim() || `exit ${ver.code}`}`);
  }

  const top = await git(path.resolve(v.repo), 'rev-parse', '--show-toplevel');
  if (top.code !== 0) fail(`${v.repo} is not inside a git repository`);
  const repo = path.resolve(top.stdout.trim());
  const headRes = await git(repo, 'rev-parse', '--verify', 'HEAD');
  if (headRes.code !== 0) fail('the repository has no commits yet (try: git commit --allow-empty -m init)');
  const head = headRes.stdout.trim();
  if ((await git(repo, 'status', '--porcelain')).stdout.trim()) log('warning: uncommitted changes in the main repo are NOT visible to workers (they branch from the last commit)');

  const timeoutMs = Number(v.timeout) * 1000;
  const maxPar = Number(v['max-parallel']);
  if (!(timeoutMs > 0) || !(maxPar >= 1)) fail('--timeout and --max-parallel must be positive numbers');
  const model = v.model ?? spec.model ?? ocEntry.model ?? DEFAULT_MODEL;
  const harnesses = normalizeHarnessConfig(harnessConfig.config, { bin, model });
  const runId = v['run-id'] ?? new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  if (!validRunId(runId)) fail(`bad --run-id ${JSON.stringify(runId)} (must start with a letter or digit, then letters, digits, dot, underscore, hyphen; max 60)`);
  const out = path.resolve(v.out ?? path.join(path.dirname(repo), `${path.basename(repo)}.lazydev`));
  const runDir = path.join(out, 'runs', runId);
  if (existsSync(runDir)) fail(`run folder already exists: ${runDir}`);
  mkdirSync(runDir, { recursive: true });
  const meta = { run_id: runId, state: 'running', started_at: new Date().toISOString(), task_ids: spec.tasks.map((t) => t.id), model, pid: process.pid };
  const metaFile = path.join(runDir, 'run.json');
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  runMeta = { file: metaFile, data: meta };
  mkdirSync(path.join(out, 'workspaces'), { recursive: true });
  log(`run ${runId} | harness: ${defaultHarness ?? 'per-task'}${ver.stdout.trim() ? ` (${ver.stdout.trim()})` : ''} | model: ${model} | base: ${head.slice(0, 7)} | ${spec.tasks.length} task(s), up to ${maxPar} at once`);

  // Contract gate: start tasks when their dependencies are done, block them when a dependency can never be done.
  const tasks = spec.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ctx = { bin, model, timeoutMs, runDir, harnesses, defaultHarness, standalone: v.standalone, archived: v.archived, commit: !v['no-commit'] };
  // Print the JSON line and persist the same object atomically (readers never see a half-written file).
  const emit = (res) => {
    const line = JSON.stringify(res);
    const file = path.join(runDir, `${res.id}.result.json`);
    writeFileSync(`${file}.tmp`, line);
    renameSync(`${file}.tmp`, file);
    console.log(line);
  };
  const statusById = new Map();
  const stateById = new Map();
  const startedIds = new Set();
  const results = [];
  const running = new Set();
  const tStart = Date.now();

  const runOne = async (t) => {
    try {
      t.frozen = frozenFiles(t, stateById);
      await prepareWorktree(t, { repo, out, runId, head, stateById, defaultHarness });
      return await runTask(t, ctx);
    } catch (e) {
      return { id: t.id, status: 'failed', reasons: [`internal error: ${e.message}`], branch: t.branch ?? null, worktree: t.wt ?? null,
        depends_on: [...(t.depends_on ?? [])], base: t.base ?? null };
    }
  };

  while (results.length < tasks.length) {
    const { ready, blocked } = readyAndBlocked(tasks, statusById, startedIds);
    let progressed = false;
    for (const b of blocked) {
      startedIds.add(b.id);
      statusById.set(b.id, 'blocked');
      const t = byId.get(b.id);
      const res = { id: b.id, status: 'blocked', reasons: [b.reason], summary: '', files_changed: [], violations: [], flags: [],
        verify: null, commit: null, session_id: null, duration_s: 0, agent_s: null, tokens: null, cost: null,
        branch: null, worktree: null, guardrail: null, depends_on: [...(t.depends_on ?? [])], base: null };
      results.push(res);
      emit(res);
      progressed = true;
    }
    for (const id of ready) {
      if (running.size >= maxPar) break;
      const t = byId.get(id);
      startedIds.add(id);
      statusById.set(id, 'running');
      const p = runOne(t).then((res) => {
        statusById.set(id, res.status);
        stateById.set(id, { task: t, res });
        results.push(res);
        emit(res);
      }).catch((e) => {
        statusById.set(id, 'failed');
        log(`internal error in ${id}: ${e.message}`);
      });
      running.add(p);
      p.finally(() => running.delete(p));
    }
    if (!running.size) {
      if (!progressed) fail('scheduler stalled: no task is ready and none is running (check depends_on)');
      continue;
    }
    await Promise.race([...running]);
  }

  const order = new Map(tasks.map((t, i) => [t.id, i]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));
  const batchS = round1((Date.now() - tStart) / 1000);
  const sumS = round1(results.reduce((a, r) => a + (r.duration_s ?? 0), 0));

  writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ run_id: runId, base: head, model, harness: ver.stdout.trim(), batch_s: batchS, results }, null, 2));
  log('---- summary ----');
  for (const r of results) {
    log(`${r.id.padEnd(14)} ${r.status.padEnd(13)} ${`${r.duration_s ?? '?'}s`.padEnd(8)} files=${r.files_changed?.length ?? '?'} verify=${r.verify ? (r.verify.ok ? 'ok' : 'FAIL') : '-'}${r.reasons?.length ? `  <- ${r.reasons.join('; ').replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  }
  log(`batch ${batchS}s; sum of task times ${sumS}s. Logs, raw events and patches: ${runDir}`);
  const made = tasks.filter((t) => t.hasWorktree);
  if (made.length) {
    log('Clean up when finished (per task):');
    for (const t of made) log(`  git -C "${repo}" worktree remove --force "${t.wt}" && git -C "${repo}" branch -D ${t.branch}`);
  }
  const exitCode = results.some((r) => ['failed', 'rejected', 'timeout', 'blocked'].includes(r.status)) ? 1 : 0;
  writeRunJson({ state: 'finished', finished_at: new Date().toISOString(), exit_code: exitCode, batch_s: batchS });
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => {
    console.error(e);
    writeRunJson({ state: 'error', finished_at: new Date().toISOString(), message: String(e?.message ?? e).slice(0, 300) });
    process.exit(2);
  });
}
