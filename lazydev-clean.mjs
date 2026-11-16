#!/usr/bin/env node
// lazydev-clean.mjs - remove LazyDev worktrees and branches after runs.
// Dry run by default; pass --yes to actually remove anything. Only touches lazydev/ branches and
// worktrees under <out>/workspaces, never the repo's current branch or working tree.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createOutputCollector, GIT_MAX_OUTPUT_BYTES } from './lazydev-poc.mjs';

const DAY_MS = 86_400_000;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,60}$/;

const USAGE = `Usage: node lazydev-clean.mjs --repo <dir> [options]
  --repo <dir>             git repository the runs worked on (default: current folder)
  --out <dir>              LazyDev output folder (default: <repo>.lazydev next to the repo)
  --run <runId>            clean only this run
  --older-than-days <n>    clean runs whose run.json started_at is older than n days
  --merged-only            keep only runs whose branches are all merged into the current branch
  --include-logs           also delete <out>/runs/<runId> and <out>/inbox/<runId>.tasks.json
  --yes                    actually remove (without it this is a dry run)
  --help                   show this text

Only lazydev/ branches and worktrees under <out>/workspaces are touched.`;

const quote = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

function inside(root, p) {
  const win = process.platform === 'win32';
  const r = path.resolve(root);
  const q = path.resolve(p);
  const rel = path.relative(win ? r.toLowerCase() : r, win ? q.toLowerCase() : q);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists but not ours
}

// Never rejects. Resolves { code, stdout, stderr, truncated }. stdout and stderr are capped separately.
function exec(cmd, args, { maxBytes } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const out = createOutputCollector(maxBytes), err = createOutputCollector(maxBytes);
    const done = (r) => { if (settled) return; settled = true; resolve(r); };
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { done({ code: -1, stdout: '', stderr: e.message, truncated: false }); return; }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => done({ code: -1, stdout: out.toString(), stderr: e.message, truncated: out.truncated || err.truncated }));
    child.on('close', (code) => done({ code, stdout: out.toString(), stderr: err.toString(), truncated: out.truncated || err.truncated }));
  });
}
const git = (repo, ...args) => exec('git', ['-C', repo, ...args], { maxBytes: GIT_MAX_OUTPUT_BYTES });

// Which runs are eligible? Pure: no git, no file system, no clock unless `now` is omitted.
// A run whose state is "running" and whose pid is still alive is never selected.
export function selectRuns(runs, { runId = null, olderThanDays = null, mergedOnly = false, now = Date.now() } = {}) {
  if (runId !== null && !runs.some((r) => r.runId === runId)) return { selected: [], error: `unknown run id: ${runId}` };
  const cutoff = olderThanDays === null ? null : now - olderThanDays * DAY_MS;
  const selected = [];
  for (const r of runs) {
    if (r.state === 'running' && r.pidAlive) continue;
    if (runId !== null) {
      if (r.runId !== runId) continue;
    } else if (cutoff !== null) {
      if (typeof r.startedAt !== 'number' || r.startedAt >= cutoff) continue;
    } else if (r.state !== 'finished' && r.state !== 'error') continue;
    if (mergedOnly && r.merged !== true) continue;
    selected.push(r);
  }
  return { selected, error: null };
}

// Git prints worktree paths with forward slashes ("C:/Users/x/wt") while path.join builds
// backslashes ("C:\\Users\\x\\wt"). A Set of raw strings therefore counts the same folder twice.
// Normalize to one key per real folder: resolve the separators, and case-fold on Windows.
export function uniquePaths(paths, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Map();
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const resolved = P.resolve(p);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) seen.set(key, resolved);
  }
  return [...seen.values()];
}

const pathKey = (p, platform = process.platform) => {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const resolved = P.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);

async function listWorktrees(repo) {
  const r = await git(repo, 'worktree', 'list', '--porcelain');
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { flush(); cur = { path: unquote(line.slice('worktree '.length)), branch: null }; }
    else if (line.startsWith('branch refs/heads/') && cur) cur.branch = line.slice('branch refs/heads/'.length);
    else if (line === '') flush();
  }
  flush();
  return out;
}

function taskIdsFromInbox(out, runId) {
  const spec = readJson(path.join(out, 'inbox', `${runId}.tasks.json`));
  if (!Array.isArray(spec?.tasks)) return null;
  return spec.tasks.map((t) => t?.id).filter((id) => typeof id === 'string' && id);
}

function branchesOf(runId, taskIds, branchSet, allRunIds) {
  const taskBranches = [];
  if (taskIds && taskIds.length) {
    for (const id of taskIds) {
      const b = `lazydev/${runId}-${id}`;
      if (branchSet.has(b)) taskBranches.push(b);
    }
  } else {
    // No task list on disk: fall back to a prefix scan, but never claim a branch owned by a longer run id.
    for (const b of branchSet) {
      if (!b.startsWith(`lazydev/${runId}-`)) continue;
      if ([...allRunIds].some((other) => other !== runId && other.length > runId.length && b.startsWith(`lazydev/${other}-`))) continue;
      taskBranches.push(b);
    }
  }
  return { taskBranches, hasStageBranch: branchSet.has(`lazydev/stage-${runId}`) };
}

async function allMerged(repo, branches) {
  for (const b of branches) {
    const r = await git(repo, 'merge-base', '--is-ancestor', b, 'HEAD');
    if (r.code !== 0) return false;
  }
  return true;
}

async function runGit(repo, args) {
  const full = ['-C', repo, ...args];
  console.log(`  + git ${full.map(quote).join(' ')}`);
  const r = await exec('git', full);
  if (r.code !== 0) console.log(`    ! failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return r.code === 0;
}

async function main() {
  let v;
  try {
    ({ values: v } = parseArgs({ options: {
      repo: { type: 'string', default: '.' },
      out: { type: 'string' },
      run: { type: 'string' },
      'older-than-days': { type: 'string' },
      'merged-only': { type: 'boolean', default: false },
      'include-logs': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    } }));
  } catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
  if (v.help) { console.log(USAGE); return; }

  const fail = (m) => { console.error(`[lazydev-clean] ERROR: ${m}`); process.exit(2); };
  if (v.run !== undefined && !RUN_ID_RE.test(v.run)) fail(`bad --run ${JSON.stringify(v.run)} (letters, digits, dot, underscore, hyphen; max 60)`);
  let olderThanDays = null;
  if (v['older-than-days'] !== undefined) {
    olderThanDays = Number(v['older-than-days']);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) fail('--older-than-days must be a number >= 0');
  }

  const top = await git(path.resolve(v.repo), 'rev-parse', '--show-toplevel');
  if (top.code !== 0) fail(`${v.repo} is not inside a git repository`);
  const repo = path.resolve(top.stdout.trim());
  const out = path.resolve(v.out ?? path.join(path.dirname(repo), `${path.basename(repo)}.lazydev`));
  const runsDir = path.join(out, 'runs');
  const workspacesDir = path.join(out, 'workspaces');

  const cb = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const currentBranch = cb.code === 0 ? cb.stdout.trim() : 'HEAD';
  const br = await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/lazydev/');
  const allBranches = br.code === 0 ? br.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const branchSet = new Set(allBranches);
  const allWorktrees = await listWorktrees(repo);

  const runIds = [];
  try { for (const d of readdirSync(runsDir, { withFileTypes: true })) if (d.isDirectory()) runIds.push(d.name); } catch { /* no runs */ }
  const allRunIds = new Set(runIds.filter((id) => RUN_ID_RE.test(id)));

  const now = Date.now();
  const runs = [];
  for (const runId of allRunIds) {
    const meta = readJson(path.join(runsDir, runId, 'run.json')) ?? {};
    const startedMs = Date.parse(meta.started_at);
    const startedAt = Number.isFinite(startedMs) ? startedMs : null;
    const pidAlive = meta.state === 'running' && Number.isInteger(meta.pid) && meta.pid > 0 && pidExists(meta.pid);
    const taskIds = Array.isArray(meta.task_ids) ? meta.task_ids : taskIdsFromInbox(out, runId);
    const { taskBranches, hasStageBranch } = branchesOf(runId, taskIds, branchSet, allRunIds);
    const stageBranch = `lazydev/stage-${runId}`;
    const stageWt = path.join(workspacesDir, `stage-${runId}`);
    const branches = [...taskBranches, ...(hasStageBranch ? [stageBranch] : [])];

    const stageWtKey = pathKey(stageWt);
    const taskWts = [];
    const stageWts = [];
    for (const w of allWorktrees) {
      if (!inside(workspacesDir, w.path)) continue;
      const isStage = pathKey(w.path) === stageWtKey || w.branch === stageBranch;
      if (isStage) { stageWts.push(w.path); continue; }
      const expected = (taskIds ?? []).map((id) => pathKey(path.join(workspacesDir, `${runId}-${id}`)));
      if ((w.branch && branches.includes(w.branch)) || expected.includes(pathKey(w.path))) {
        taskWts.push(w.path);
      }
    }
    for (const id of taskIds ?? []) {
      const p = path.join(workspacesDir, `${runId}-${id}`);
      if (existsSync(p)) taskWts.push(p);
    }
    if (existsSync(stageWt)) stageWts.push(stageWt);

    const uniqueTaskWts = uniquePaths(taskWts);
    const uniqueStageWts = uniquePaths(stageWts);

    runs.push({
      runId,
      state: meta.state ?? 'unknown',
      startedAt,
      pidAlive,
      merged: await allMerged(repo, branches),
      branches,
      taskBranches: taskBranches.length,
      hasStage: hasStageBranch || uniqueStageWts.length > 0,
      worktrees: [...uniqueTaskWts, ...uniqueStageWts],
      taskWorktrees: uniqueTaskWts.length,
      ageDays: startedAt === null ? null : Math.floor((now - startedAt) / DAY_MS),
    });
  }

  const { selected, error } = selectRuns(runs, { runId: v.run ?? null, olderThanDays, mergedOnly: v['merged-only'], now });
  if (error) fail(error);

  console.log(`repo: ${repo}`);
  console.log(`out:  ${out}`);
  console.log(v.yes ? 'REMOVING selected runs:' : 'DRY RUN: nothing is removed. Add --yes to apply.');
  if (!selected.length) { console.log('nothing selected'); return; }

  const width = Math.max(6, ...selected.map((r) => r.runId.length));
  console.log(`${'run id'.padEnd(width)}  age(d)  task worktrees  branches  stage  merged`);
  for (const r of selected) {
    console.log(`${r.runId.padEnd(width)}  ${(r.ageDays === null ? '?' : String(r.ageDays)).padStart(6)}  ${String(r.taskWorktrees).padStart(14)}  ${String(r.taskBranches).padStart(8)}  ${(r.hasStage ? 'yes' : 'no').padStart(5)}  ${r.merged ? 'yes' : 'no'}`);
  }
  const totalWt = selected.reduce((a, r) => a + r.taskWorktrees, 0);
  const totalBr = selected.reduce((a, r) => a + r.taskBranches, 0);
  const totalStage = selected.filter((r) => r.hasStage).length;
  console.log(`TOTAL: ${selected.length} run(s), ${totalWt} task worktree(s), ${totalBr} branch(es), ${totalStage} with staging`);

  if (!v.yes) return;

  let failures = 0;
  for (const r of selected) {
    console.log(`\n${r.runId}`);
    for (const wt of r.worktrees) {
      if (!inside(workspacesDir, wt)) { console.log(`  skip worktree outside ${workspacesDir}: ${wt}`); continue; }
      if (!(await runGit(repo, ['worktree', 'remove', '--force', wt]))) {
        failures++;
        if (existsSync(wt)) {
          console.log(`  removing the leftover folder: ${wt}`);
          try { rmSync(wt, { recursive: true, force: true }); } catch (e) { console.log(`    ! ${e.message}`); failures++; }
        }
      }
    }
    for (const b of r.branches) {
      if (!b.startsWith('lazydev/')) { console.log(`  skip non-lazydev branch: ${b}`); continue; }
      if (b === currentBranch) { console.log(`  skip the repo's current branch: ${b}`); continue; }
      if (!(await runGit(repo, ['branch', '-D', b]))) failures++;
    }
    if (!(await runGit(repo, ['worktree', 'prune']))) failures++;

    if (v['include-logs']) {
      const runDir = path.join(runsDir, r.runId);
      const inbox = path.join(out, 'inbox', `${r.runId}.tasks.json`);
      console.log(`  + rm -rf ${quote(runDir)}`);
      try { rmSync(runDir, { recursive: true, force: true }); } catch (e) { console.log(`    ! ${e.message}`); failures++; }
      console.log(`  + rm -f ${quote(inbox)}`);
      try { rmSync(inbox, { force: true }); } catch (e) { console.log(`    ! ${e.message}`); failures++; }
    }
  }
  if (failures) { console.log(`\n${failures} command(s) failed; the rest were attempted.`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
