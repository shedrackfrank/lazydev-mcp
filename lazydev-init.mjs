#!/usr/bin/env node
// lazydev-init.mjs - find installed agent CLIs, write lazydev.harnesses.json, and optionally run one
// tiny real task to verify a single harness. Detection only; it never guesses flags that are not in
// lazydev.harnesses.sample.json.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveOpencodeBin } from './lazydev-bin.mjs';
import { DEFAULT_HARNESSES_FILE, OPENCODE, readHarnessConfig, validateHarnessConfig } from './lazydev-harnesses.mjs';
import { exec } from './lazydev-poc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'lazydev-poc.mjs');

// Detected agent ids. Sample entries are looked up by id first ("codex"), then by this alias
// ("claude" -> "example-claude-code"), then as "example-<id>". A tool with no sample entry is
// reported but never added to the config: inventing flags is exactly what this script refuses to do.
export const AGENT_SAMPLE = {
  claude: 'example-claude-code',
};
export const AGENT_IDS = ['claude', 'codex', 'gemini', 'agy'];

const unverifiedNote = (id) => `Flags are unverified guesses for ${id}: check them against \`${id} --help\` before relying on them.`;
const verifiedNote = (id) => `Verified with one tiny task by lazydev-init --self-test; check flags against \`${id} --help\` for anything more complex.`;

const USAGE = `Usage: node lazydev-init.mjs [options]
  --repo <dir>       git repository used by --self-test and --lead (default: current folder)
  --print            print the harness config instead of writing it
  --force            overwrite an existing lazydev.harnesses.json
  --self-test <id>   run one tiny real task with that harness; on success set "verified": true
  --lead <name>      print the MCP config for a lead agent ("opencode" is the verified layout)
  --help             show this text

Without --self-test nothing is executed: the script only looks for CLIs and runs "<program> --version".`;

const quote = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));

function isExecutable(fs, file) {
  if (!fs.existsSync(file)) return false;
  if (typeof fs.statSync !== 'function') return true;
  try {
    const st = fs.statSync(file);
    if (!st || typeof st.mode !== 'number') return true;
    return (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// Pure: extra install locations to try after PATH, for installers that do not update the current
// terminal. Antigravity on Windows installs here and does not add itself to PATH.
function fallbackExecutables(id, env, platform, P) {
  if (platform !== 'win32' || id !== 'agy') return [];
  const base = env.LOCALAPPDATA ?? env.LocalAppData;
  return base ? [P.join(base, 'agy', 'bin', 'agy.exe')] : [];
}

// Pure: env, platform and fs are injected. On Windows only a real .exe is usable (Lazy Dev spawns
// without a shell); a .cmd/.bat/.ps1 is reported as a shim. On POSIX the file must be executable.
export function findExecutable(id, env = process.env, platform = process.platform, fs = nodeFs) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  let shim = null;
  for (const dir of dirs) {
    if (platform === 'win32') {
      const exe = P.join(dir, `${id}.exe`);
      if (fs.existsSync(exe)) return { path: exe, shim: false };
      if (!shim) {
        for (const ext of ['.cmd', '.bat', '.ps1']) {
          const cand = P.join(dir, id + ext);
          if (fs.existsSync(cand)) { shim = cand; break; }
        }
      }
    } else if (isExecutable(fs, P.join(dir, id))) {
      return { path: P.join(dir, id), shim: false };
    }
  }
  // PATH had no real executable (only a shim, if anything): try the known install location.
  for (const cand of fallbackExecutables(id, env, platform, P)) {
    if (fs.existsSync(cand)) return { path: cand, shim: false };
  }
  return shim ? { path: shim, shim: true } : null;
}

const placeholderFor = (id) => `<path-to-${id}-executable>`;

// Pure: fill "<path-to-<id>-executable>" and a bare argv[0] with the detected executable.
function fillPaths(list, id, exe) {
  if (!Array.isArray(list)) return list;
  const ph = placeholderFor(id);
  return list.map((arg, i) => {
    let value = typeof arg === 'string' ? arg.split(ph).join(exe ?? ph) : arg;
    if (i === 0 && value === id && exe) value = exe;
    return value;
  });
}

function sampleKeyFor(id, sample) {
  if (sample[id]) return id;
  const alias = AGENT_SAMPLE[id];
  if (alias && sample[alias]) return alias;
  if (sample[`example-${id}`]) return `example-${id}`;
  return null;
}

// Pure: build the config from what was detected. Entries are copied from the sample file, the
// executable path is filled in, and "verified" stays false until --self-test succeeds. Every
// detected id that is not added is returned in "skipped" with a reason, so nothing is silent.
export function buildHarnessConfig({ detected = [], sample = {}, paths = {} } = {}) {
  const config = {};
  const skipped = [];
  for (const id of detected) {
    if (id === OPENCODE) {
      config.opencode = { ...(sample.opencode ?? { type: 'opencode' }) };
      continue;
    }
    const sampleId = sampleKeyFor(id, sample);
    if (!sampleId) {
      const looked = [id, ...(AGENT_SAMPLE[id] ? [AGENT_SAMPLE[id]] : []), `example-${id}`];
      skipped.push({ id, reason: `no entry in lazydev.harnesses.sample.json (looked for ${looked.map((c) => `"${c}"`).join(', ')}); not added, because flags are never invented` });
      continue;
    }
    const exe = paths[id];
    const entry = { ...sample[sampleId] };
    if ('argv' in entry) entry.argv = fillPaths(entry.argv, id, exe);
    if ('version_argv' in entry) entry.version_argv = fillPaths(entry.version_argv, id, exe);
    const leftover = [...(entry.argv ?? []), ...(entry.version_argv ?? [])]
      .find((arg) => typeof arg === 'string' && /[<>]/.test(arg));
    if (leftover) {
      skipped.push({ id, reason: `the sample flags still need ${leftover} and no executable path was detected; not added` });
      continue;
    }
    config[id] = { ...entry, verified: false, note: unverifiedNote(id) };
  }
  return { config, skipped };
}

// Pure: never overwrite an existing file unless --force was passed.
export function canWriteFile({ exists, force }) {
  return !exists || force === true;
}

// Pure: the MCP snippet for the verified OpenCode layout, or generic fields for any other lead.
export function mcpConfigSnippet({ lead, repo, scriptDir }) {
  const server = path.join(scriptDir, 'mcp-server.mjs');
  if (lead !== OPENCODE) {
    return [
      `config format not verified for ${lead}; see its documentation`,
      '',
      'Generic fields to translate:',
      '  command: node',
      `  args: ${JSON.stringify([server])}`,
      '  environment:',
      `    LAZYDEV_REPO=${repo}`,
      `    LAZYDEV_OUT=${repo}.lazydev`,
      '    LAZYDEV_MAX_PARALLEL=3',
    ].join('\n');
  }
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      servers: {
        lazydev: {
          type: 'local',
          command: ['node', server],
          environment: {
            LAZYDEV_REPO: repo,
            LAZYDEV_OUT: `${repo}.lazydev`,
            LAZYDEV_MAX_PARALLEL: '3',
          },
          disabled: false,
          codemode: false,
        },
      },
    },
  }, null, 2);
}

// ---------- detection ----------

async function describe(id, bin, { shim = false, error = null } = {}) {
  if (!bin) return { id, status: 'not found', path: '-', version: '-', note: error };
  if (shim) {
    return {
      id, status: 'shim (unusable)', path: bin, version: '-',
      note: `${id}: only a shim was found (${bin}); put the real ${id}.exe on PATH. Lazy Dev spawns without a shell and cannot use .cmd/.bat/.ps1.`,
    };
  }
  const r = await exec(bin, ['--version'], { timeoutMs: 5000 });
  const first = (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] ?? '';
  if (r.spawnError || r.code !== 0) return { id, status: 'error', path: bin, version: first || `exit ${r.code}`, note: null };
  return { id, status: 'found', path: bin, version: first || 'unknown', note: null };
}

async function detectAgents() {
  const rows = [];
  let ocPath = null, ocError = null;
  try { ocPath = resolveOpencodeBin(process.env, process.platform); } catch (e) { ocError = e.message; }
  rows.push(await describe(OPENCODE, ocPath, { error: ocError }));
  for (const id of AGENT_IDS) {
    const found = findExecutable(id, process.env, process.platform);
    rows.push(await describe(id, found?.path ?? null, { shim: found?.shim === true }));
  }
  return rows;
}

function printTable(rows) {
  const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const id = w('id'), status = w('status'), file = w('path');
  console.log(`${'id'.padEnd(id)}  ${'status'.padEnd(status)}  ${'path'.padEnd(file)}  version`);
  for (const r of rows) {
    console.log(`${r.id.padEnd(id)}  ${r.status.padEnd(status)}  ${r.path.padEnd(file)}  ${r.version}`);
  }
  for (const r of rows) {
    if (!r.note) continue;
    for (const line of String(r.note).split(/\r?\n/)) console.log(`  ${line}`);
  }
}

// ---------- self-test ----------

async function runSelfTest(id, repo, configPath) {
  const { config, errors } = readHarnessConfig(configPath);
  if (errors.length) {
    console.error(`[lazydev-init] ERROR: invalid harness config (${configPath}):\n  - ${errors.join('\n  - ')}`);
    process.exitCode = 2;
    return;
  }
  if (!config[id]) {
    console.error(`[lazydev-init] ERROR: no harness "${id}" in ${configPath}; run "node lazydev-init.mjs" first`);
    process.exitCode = 2;
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'lazydev-init-'));
  const outDir = path.join(tempRoot, 'out');
  const tasksFile = path.join(tempRoot, 'tasks.json');
  const runId = `init-${Date.now().toString(36)}`;
  writeFileSync(tasksFile, JSON.stringify({
    tasks: [{
      id: 'initcheck',
      harness: id,
      prompt: 'Create a file named lazydev-selftest.txt in the current folder containing the single word ok. Do not change any other file.',
      allowed_paths: ['lazydev-selftest.txt'],
      verify: ['node', '-e', "require('node:fs').accessSync('lazydev-selftest.txt');console.log('verify ok')"],
    }],
  }, null, 2));

  console.log(`\nself-test ${id}: one tiny task in ${repo} (run ${runId})`);
  const prevHarnesses = process.env.LAZYDEV_HARNESSES;
  process.env.LAZYDEV_HARNESSES = configPath;
  let r;
  try {
    r = await exec(process.execPath, [RUNNER, tasksFile, '--repo', repo, '--out', outDir,
      '--run-id', runId, '--timeout', '120', '--max-parallel', '1'], { timeoutMs: 180000 });
  } finally {
    if (prevHarnesses === undefined) delete process.env.LAZYDEV_HARNESSES;
    else process.env.LAZYDEV_HARNESSES = prevHarnesses;
  }

  let res = null;
  try { res = JSON.parse(readFileSync(path.join(outDir, 'runs', runId, 'initcheck.result.json'), 'utf8')); } catch { /* fall back to stdout */ }
  if (!res) {
    const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    try { res = JSON.parse(last); } catch { /* runner failed before writing a result */ }
  }

  // Best effort: remove the throwaway worktree registration and branch this run created.
  try { rmSync(tempRoot, { recursive: true, force: true }); }
  catch (e) { console.warn(`warning: could not remove the temp folder ${tempRoot}: ${e.message}`); }
  await exec('git', ['-C', repo, 'worktree', 'prune'], { timeoutMs: 30000 });
  const branch = `lazydev/${runId}-initcheck`;
  const branchExists = await exec('git', ['-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}`], { timeoutMs: 30000 });
  if (branchExists.code === 0) {
    const del = await exec('git', ['-C', repo, 'branch', '-D', branch], { timeoutMs: 30000 });
    if (del.code !== 0) console.warn(`warning: could not delete the throwaway branch ${branch}: ${(del.stderr || del.stdout).trim() || `exit ${del.code}`}`);
  }

  if (!res) {
    console.error(`self-test ${id}: no result (exit ${r.code})`);
    const why = (r.stderr || r.stdout).trim();
    if (why) for (const line of why.split(/\r?\n/).slice(-15)) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log(`status: ${res.status}`);
  console.log('reasons:');
  const reasons = Array.isArray(res.reasons) ? res.reasons : [];
  if (!reasons.length) console.log('  (none)');
  for (const reason of reasons) console.log(`  - ${reason}`);
  if (res.output_truncated) console.log('note: output was truncated (see output_note)');

  if (res.status !== 'done') {
    process.exitCode = 1;
    return;
  }
  const updated = { ...config, [id]: { ...config[id], verified: true, note: verifiedNote(id) } };
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`verified: true written to ${configPath}`);
}

// ---------- main ----------

async function main() {
  let v;
  try {
    ({ values: v } = parseArgs({ options: {
      repo: { type: 'string', default: '.' },
      print: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'self-test': { type: 'string' },
      lead: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    } }));
  } catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
  if (v.help) { console.log(USAGE); return; }

  const repo = path.resolve(v.repo);
  if (v.lead !== undefined) { console.log(mcpConfigSnippet({ lead: v.lead, repo, scriptDir: HERE })); return; }

  const configPath = process.env.LAZYDEV_HARNESSES
    ? path.resolve(process.env.LAZYDEV_HARNESSES)
    : path.join(HERE, DEFAULT_HARNESSES_FILE);

  console.log('Detected agents:');
  const rows = await detectAgents();
  printTable(rows);

  if (v['self-test'] !== undefined) {
    await runSelfTest(v['self-test'], repo, configPath);
    return;
  }

  const sampleFile = path.join(HERE, 'lazydev.harnesses.sample.json');
  let sample = {};
  try { sample = JSON.parse(readFileSync(sampleFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error(`[lazydev-init] ERROR: cannot read ${sampleFile}: ${e.message}`); process.exitCode = 2; return; }

  const paths = {};
  for (const r of rows) {
    if (r.path !== '-' && !r.status.startsWith('shim')) paths[r.id] = r.path;
  }
  const detected = Object.keys(paths);
  const { config, skipped } = buildHarnessConfig({ detected, sample, paths });
  const errors = validateHarnessConfig(config);
  if (errors.length) {
    console.error(`[lazydev-init] ERROR: generated config is invalid:\n  - ${errors.join('\n  - ')}`);
    process.exitCode = 2;
    return;
  }
  for (const s of skipped) console.log(`\n${s.id}: detected, but ${s.reason}.`);
  if (!Object.keys(config).length) console.log('\nwarning: nothing usable was detected; the config is empty.');

  if (v.print) { console.log(`\n${JSON.stringify(config, null, 2)}`); return; }

  const exists = existsSync(configPath);
  if (!canWriteFile({ exists, force: v.force })) {
    console.error(`\n[lazydev-init] ERROR: ${configPath} already exists; add --force to overwrite it, or use --print to see the new config.`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nwrote ${configPath}`);
  console.log('next: node lazydev-init.mjs --self-test <id> --repo ' + quote(repo));
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
