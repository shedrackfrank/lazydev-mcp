// selftest.mjs - pure unit tests for the dependency gate. No git, no OpenCode, no network.
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildBrief, clipVerifyOutput, exec, findCycle, readyAndBlocked, validateTasks, validRunId } from './lazydev-poc.mjs';
import { mergeOrder } from './lazydev-integrate.mjs';
import { fillArgv, normalizeHarnessConfig, validateHarnessConfig } from './lazydev-harnesses.mjs';
import { selectRuns, uniquePaths } from './lazydev-clean.mjs';
import { resolveOpencodeBin } from './lazydev-bin.mjs';

const task = (id, depends_on) => ({ id, prompt: `do ${id}`, allowed_paths: ['x.js'], ...(depends_on ? { depends_on } : {}) });
const spec = (tasks) => ({ tasks });
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`ok ${name}`); }
  catch (e) { failed++; console.error(`not ok ${name}: ${e.message}`); }
};

// ---------- findCycle ----------

test('findCycle: none', () => {
  assert.equal(findCycle([task('a'), task('b', ['a'])]), null);
});

test('findCycle: self', () => {
  assert.deepEqual(findCycle([task('a', ['a'])]), ['a']);
});

test('findCycle: 2-cycle', () => {
  assert.deepEqual(findCycle([task('a', ['b']), task('b', ['a'])]), ['a', 'b']);
});

test('findCycle: 3-cycle', () => {
  assert.deepEqual(findCycle([task('a', ['b']), task('b', ['c']), task('c', ['a'])]), ['a', 'b', 'c']);
});

// ---------- validateTasks dependency errors ----------

test('validateTasks: accepts a valid dependency', () => {
  assert.deepEqual(validateTasks(spec([task('a'), task('b', ['a'])])), []);
});

test('validateTasks: rejects non-array depends_on', () => {
  const errs = validateTasks(spec([{ id: 'a', prompt: 'p', allowed_paths: ['a.js'], depends_on: 'b' }]));
  assert.ok(errs.some((e) => e.includes('"depends_on" must be an array')), errs.join('; '));
});

test('validateTasks: rejects unknown dependency', () => {
  const errs = validateTasks(spec([task('a', ['ghost'])]));
  assert.ok(errs.some((e) => e.includes('unknown task "ghost"')), errs.join('; '));
});

test('validateTasks: rejects self-dependency', () => {
  const errs = validateTasks(spec([task('a', ['a'])]));
  assert.ok(errs.some((e) => e.includes('cannot include itself')), errs.join('; '));
});

test('validateTasks: rejects a dependency cycle', () => {
  const errs = validateTasks(spec([task('a', ['b']), task('b', ['a'])]));
  assert.ok(errs.some((e) => e.includes('dependency cycle')), errs.join('; '));
});

// ---------- validateTasks verify ----------

test('validateTasks: accepts an argument-list verify', () => {
  assert.deepEqual(validateTasks(spec([{ ...task('a'), verify: ['node', 'test.js'] }])), []);
});

test('validateTasks: rejects one command-line string in verify', () => {
  const errs = validateTasks(spec([{ ...task('a'), verify: ['node test.js'] }]));
  assert.ok(errs.some((e) => e.includes('not one command-line string')), errs.join('; '));
});

test('validateTasks: rejects a non-array verify', () => {
  const errs = validateTasks(spec([{ ...task('a'), verify: 'node test.js' }]));
  assert.ok(errs.some((e) => e.includes('not one command-line string')), errs.join('; '));
});

test('validateTasks: accepts a single-element verify without spaces', () => {
  assert.deepEqual(validateTasks(spec([{ ...task('a'), verify: ['node'] }])), []);
});

// ---------- readyAndBlocked: diamond contract -> a, b -> c ----------

const diamond = [task('contract'), task('a', ['contract']), task('b', ['contract']), task('c', ['a', 'b'])];
const ready = (r) => r.ready;
const blocked = (r) => r.blocked;

test('readyAndBlocked diamond: contract is ready first', () => {
  const r = readyAndBlocked(diamond, {}, new Set());
  assert.deepEqual(ready(r), ['contract']);
  assert.deepEqual(blocked(r), []);
});

test('readyAndBlocked diamond: a and b are ready after contract', () => {
  const r = readyAndBlocked(diamond, { contract: 'done' }, ['contract']);
  assert.deepEqual(ready(r), ['a', 'b']);
  assert.deepEqual(blocked(r), []);
});

test('readyAndBlocked diamond: c waits while b runs', () => {
  const r = readyAndBlocked(diamond, { contract: 'done', a: 'done', b: 'running' }, ['contract', 'a', 'b']);
  assert.deepEqual(ready(r), []);
  assert.deepEqual(blocked(r), []);
});

test('readyAndBlocked diamond: c is ready after a and b', () => {
  const r = readyAndBlocked(diamond, { contract: 'done', a: 'done', b: 'done' }, ['contract', 'a', 'b']);
  assert.deepEqual(ready(r), ['c']);
  assert.deepEqual(blocked(r), []);
});

test('readyAndBlocked diamond: nothing left when all are done', () => {
  const r = readyAndBlocked(diamond, { contract: 'done', a: 'done', b: 'done', c: 'done' }, ['contract', 'a', 'b', 'c']);
  assert.deepEqual(ready(r), []);
  assert.deepEqual(blocked(r), []);
});

test('readyAndBlocked: failed contract blocks a and b', () => {
  const r = readyAndBlocked(diamond, { contract: 'failed' }, ['contract']);
  assert.deepEqual(ready(r), []);
  assert.deepEqual(blocked(r), [
    { id: 'a', reason: 'dependency contract is failed' },
    { id: 'b', reason: 'dependency contract is failed' },
  ]);
});

test('readyAndBlocked: blocked a and b block c', () => {
  const r = readyAndBlocked(diamond, { contract: 'failed', a: 'blocked', b: 'blocked' }, ['contract', 'a', 'b']);
  assert.deepEqual(ready(r), []);
  assert.deepEqual(blocked(r), [{ id: 'c', reason: 'dependency a is blocked' }]);
});

test('readyAndBlocked: needs_review blocks a dependent', () => {
  const r = readyAndBlocked([task('contract'), task('backend', ['contract'])], { contract: 'needs_review' }, ['contract']);
  assert.deepEqual(ready(r), []);
  assert.deepEqual(blocked(r), [{ id: 'backend', reason: 'dependency contract is needs_review' }]);
});

// ---------- buildBrief ----------

const briefTask = (extra) => ({ id: 'a', prompt: 'do a', allowed_paths: ['a.js'], ...extra });
const VERIFY_RULE = 'The runner will run the verify command after you finish. Do not write your own tests, scratch scripts or temp files, and do not run your own checks beyond what the task asks; just make the files and stop.';

test('buildBrief: with verify, contains the no-own-tests rule', () => {
  const brief = buildBrief(briefTask({ verify: ['node', 'test.js'] }));
  assert.ok(brief.includes(VERIFY_RULE), brief);
});

test('buildBrief: without verify, does not contain the no-own-tests rule', () => {
  const brief = buildBrief(briefTask());
  assert.ok(!brief.includes(VERIFY_RULE), brief);
});

// ---------- clipVerifyOutput ----------

test('clipVerifyOutput: short output is unchanged', () => {
  const s = 'x'.repeat(700);
  assert.equal(clipVerifyOutput(s), s);
});

test('clipVerifyOutput: long output keeps the first 400 and last 250 chars', () => {
  const s = 'a'.repeat(400) + 'b'.repeat(1000) + 'c'.repeat(250);
  assert.equal(clipVerifyOutput(s), `${'a'.repeat(400)}\n...\n${'c'.repeat(250)}`);
});

// ---------- mergeOrder ----------

const order = (tasks, statuses) => mergeOrder(tasks, new Map(Object.entries(statuses)));

test('mergeOrder: diamond is contract, a, b, c', () => {
  const tasks = [task('contract'), task('a', ['contract']), task('b', ['contract']), task('c', ['a', 'b'])];
  assert.deepEqual(order(tasks, { contract: 'done', a: 'done', b: 'done', c: 'done' }), ['contract', 'a', 'b', 'c']);
});

test('mergeOrder: a done task with a skipped dependency is still merged, after the done ancestors', () => {
  const tasks = [task('contract'), task('a', ['contract']), task('b', ['a'])];
  assert.deepEqual(order(tasks, { contract: 'failed', a: 'done', b: 'done' }), ['a', 'b']);
});

test('mergeOrder: ties keep task order', () => {
  const tasks = [task('z'), task('a'), task('m')];
  assert.deepEqual(order(tasks, { z: 'done', a: 'done', m: 'done' }), ['z', 'a', 'm']);
});

// ---------- harnesses ----------

test('harnesses: a valid config with opencode and a command harness', () => {
  assert.deepEqual(validateHarnessConfig({
    opencode: { type: 'opencode', version_argv: ['--version'] },
    fake: { type: 'command', argv: ['node', 'fake-harness.mjs', 'out.txt'], stdin: false, version_argv: ['--version'] },
  }), []);
});

test('harnesses: rejects an unknown type and a command without argv', () => {
  const errs = validateHarnessConfig({ a: { type: 'nope' }, b: { type: 'command' } });
  assert.ok(errs.some((e) => e.includes('"type" must be "opencode" or "command"')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('"argv" is required')), errs.join('; '));
});

test('harnesses: rejects a config that is not an object', () => {
  assert.equal(validateHarnessConfig([]).length, 1);
});

test('harnesses: opencode is always present', () => {
  const map = normalizeHarnessConfig({}, { bin: 'oc.exe', model: 'p/m' });
  assert.equal(map.get('opencode').type, 'opencode');
  assert.equal(map.get('opencode').bin, 'oc.exe');
  assert.equal(map.get('opencode').model, 'p/m');
});

test('fillArgv: replaces prompt, prompt_file and cwd in one pass', () => {
  const values = { prompt: 'do {cwd} now', prompt_file: 'C:\\run\\a.prompt.txt', cwd: 'C:\\wt' };
  assert.deepEqual(fillArgv(['x', '--p', '{prompt}', '{prompt_file}', '{cwd}'], values),
    ['x', '--p', 'do {cwd} now', 'C:\\run\\a.prompt.txt', 'C:\\wt']);
});

test('validateTasks: rejects an unknown harness', () => {
  const errs = validateTasks({ tasks: [{ ...task('a'), harness: 'nope' }] }, { harnesses: ['opencode', 'fake'] });
  assert.ok(errs.some((e) => e.includes('unknown harness "nope"')), errs.join('; '));
});

test('validateTasks: accepts a configured harness', () => {
  assert.deepEqual(validateTasks({ tasks: [{ ...task('a'), harness: 'fake' }] }, { harnesses: ['opencode', 'fake'] }), []);
});

// ---------- selectRuns (lazydev-clean.mjs) ----------

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15);
const cleanRun = (id, state, daysAgo, merged = true, pidAlive = false) => ({
  runId: id, state, startedAt: daysAgo === null ? null : NOW - daysAgo * DAY, merged, pidAlive,
});

test('selectRuns: a running run with a live pid is never selected', () => {
  const runs = [cleanRun('live', 'running', 30, true, true), cleanRun('done', 'finished', 30)];
  assert.deepEqual(selectRuns(runs, { now: NOW }).selected.map((r) => r.runId), ['done']);
  assert.deepEqual(selectRuns(runs, { now: NOW, runId: 'live' }).selected, []);
});

test('selectRuns: default keeps finished and errored runs only', () => {
  const runs = [cleanRun('done', 'finished', 1), cleanRun('bad', 'error', 1), cleanRun('crashed', 'running', 1, true, false)];
  assert.deepEqual(selectRuns(runs, { now: NOW }).selected.map((r) => r.runId), ['done', 'bad']);
});

test('selectRuns: older-than-days keeps only older runs', () => {
  const runs = [cleanRun('old', 'finished', 10), cleanRun('new', 'finished', 1)];
  assert.deepEqual(selectRuns(runs, { now: NOW, olderThanDays: 7 }).selected.map((r) => r.runId), ['old']);
});

test('selectRuns: merged-only keeps only fully merged runs', () => {
  const runs = [cleanRun('merged', 'finished', 10, true), cleanRun('open', 'finished', 10, false)];
  assert.deepEqual(selectRuns(runs, { now: NOW, mergedOnly: true }).selected.map((r) => r.runId), ['merged']);
});

test('selectRuns: an unknown run id is rejected', () => {
  const { selected, error } = selectRuns([cleanRun('done', 'finished', 1)], { runId: 'ghost', now: NOW });
  assert.equal(selected.length, 0);
  assert.ok(error && error.includes('unknown run id'), error);
});

// ---------- uniquePaths (lazydev-clean.mjs) ----------

test('uniquePaths: git forward slashes and path.join backslashes are one folder', () => {
  const got = uniquePaths(['C:/Users/u/wt/a', 'C:\\Users\\u\\wt\\a', 'C:/Users/u/wt/b'], 'win32');
  assert.equal(got.length, 2, JSON.stringify(got));
});

test('uniquePaths: Windows paths are case-insensitive', () => {
  assert.equal(uniquePaths(['C:/Users/U/wt/A', 'c:\\users\\u\\WT\\a'], 'win32').length, 1);
});

test('uniquePaths: POSIX paths are deduped exactly and stay case-sensitive', () => {
  assert.deepEqual(uniquePaths(['/x/a', '/x/a', '/x/b'], 'linux'), ['/x/a', '/x/b']);
  assert.equal(uniquePaths(['/x/A', '/x/a'], 'linux').length, 2);
});

// ---------- resolveOpencodeBin (lazydev-bin.mjs) ----------

const join32 = (...parts) => path.win32.join(...parts);
const CLI32 = join32('C:\\Users\\u\\AppData\\Roaming', 'ai.opencode.desktop', 'cli');

// A fake file system: dirs maps a directory to its entries, files is the set of existing files.
const fakeFs = ({ dirs = {}, files = [], modes = {} } = {}) => ({
  existsSync: (p) => Object.prototype.hasOwnProperty.call(dirs, p) || files.includes(p),
  readdirSync: (p) => {
    if (!Object.prototype.hasOwnProperty.call(dirs, p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return dirs[p];
  },
  statSync: (p) => ({ mode: modes[p] ?? 0o755 }),
});

test('resolveOpencodeBin: LAZYDEV_OPENCODE_BIN wins', () => {
  const fs = fakeFs({ dirs: { [CLI32]: ['1.0.0'] }, files: [join32(CLI32, '1.0.0', 'opencode-cli.exe')] });
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LAZYDEV_OPENCODE_BIN: 'D:\\tools\\oc.exe' };
  assert.equal(resolveOpencodeBin(env, 'win32', fs), 'D:\\tools\\oc.exe');
});

test('resolveOpencodeBin: the newest version folder wins', () => {
  const fs = fakeFs({
    dirs: { [CLI32]: ['1.9.9', '1.10.0', '1.2.0'] },
    files: ['1.9.9', '1.10.0', '1.2.0'].map((v) => join32(CLI32, v, 'opencode-cli.exe')),
  });
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.equal(resolveOpencodeBin(env, 'win32', fs), join32(CLI32, '1.10.0', 'opencode-cli.exe'));
});

test('resolveOpencodeBin: folders containing "update" are skipped', () => {
  const fs = fakeFs({
    dirs: { [CLI32]: ['update-9.9.9', '1.4.0'] },
    files: ['update-9.9.9', '1.4.0'].map((v) => join32(CLI32, v, 'opencode-cli.exe')),
  });
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.equal(resolveOpencodeBin(env, 'win32', fs), join32(CLI32, '1.4.0', 'opencode-cli.exe'));
});

test('resolveOpencodeBin: only an update folder means not found', () => {
  const fs = fakeFs({
    dirs: { [CLI32]: ['update-9.9.9'] },
    files: [join32(CLI32, 'update-9.9.9', 'opencode-cli.exe')],
  });
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.throws(() => resolveOpencodeBin(env, 'win32', fs), /opencode CLI not found/);
});

test('resolveOpencodeBin: not found names every place and the env variable', () => {
  const local = join32('C:\\Users\\u\\AppData\\Local', 'ai.opencode.desktop', 'cli');
  const fs = fakeFs({ dirs: { [CLI32]: [], [local]: [] } });
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  let message = '';
  try { resolveOpencodeBin(env, 'win32', fs); } catch (e) { message = e.message; }
  assert.ok(message.includes(CLI32), message);
  assert.ok(message.includes(local), message);
  assert.ok(message.includes('LAZYDEV_OPENCODE_BIN'), message);
});

test('resolveOpencodeBin: POSIX finds opencode on PATH', () => {
  const fs = fakeFs({ files: ['/opt/bin/opencode'], modes: { '/opt/bin/opencode': 0o755 } });
  assert.equal(resolveOpencodeBin({ PATH: '/usr/bin:/opt/bin' }, 'linux', fs), '/opt/bin/opencode');
});

test('resolveOpencodeBin: POSIX skips a non-executable opencode', () => {
  const fs = fakeFs({ files: ['/opt/bin/opencode'], modes: { '/opt/bin/opencode': 0o644 } });
  assert.throws(() => resolveOpencodeBin({ PATH: '/opt/bin' }, 'linux', fs), /opencode CLI not found/);
});

test('resolveOpencodeBin: a .cmd shim is rejected', () => {
  const fs = fakeFs();
  assert.throws(() => resolveOpencodeBin({ LAZYDEV_OPENCODE_BIN: 'C:\\tools\\opencode.cmd' }, 'win32', fs), /shim/);
});

// ---------- validRunId ----------

test('validRunId: accepts letters, digits, dot, underscore, hyphen', () => {
  assert.equal(validRunId('run_2026-11-12.a'), true);
  assert.equal(validRunId('ABC-xyz_1.2'), true);
});

test('validRunId: accepts ids that start with a letter or digit', () => {
  assert.equal(validRunId('a'), true);
  assert.equal(validRunId('r179475784080228'), true);
  assert.equal(validRunId('run-1_2.3'), true);
  assert.equal(validRunId('9start'), true);
});

test('validRunId: rejects "." and ".." and other non-alphanumeric starts', () => {
  assert.equal(validRunId('.'), false);
  assert.equal(validRunId('..'), false);
  assert.equal(validRunId('.x'), false);
  assert.equal(validRunId('-x'), false);
  assert.equal(validRunId('_x'), false);
});

test('validRunId: accepts 60 characters', () => {
  assert.equal(validRunId('x'.repeat(60)), true);
});

test('validRunId: rejects an empty id', () => {
  assert.equal(validRunId(''), false);
});

test('validRunId: rejects spaces, slashes and other characters', () => {
  assert.equal(validRunId('has space'), false);
  assert.equal(validRunId('a/b'), false);
  assert.equal(validRunId('a\\b'), false);
  assert.equal(validRunId('bad!'), false);
});

test('validRunId: rejects more than 60 characters', () => {
  assert.equal(validRunId('x'.repeat(61)), false);
});

// ---------- output cap (lazydev-poc.mjs exec) ----------

const testAsync = async (name, fn) => {
  try { await fn(); console.log(`ok ${name}`); }
  catch (e) { failed++; console.error(`not ok ${name}: ${e.message}`); }
};

// Set the env var for one call only; the helper reads it when it is called.
const withMaxOutput = async (value, fn) => {
  const prev = process.env.LAZYDEV_MAX_OUTPUT_BYTES;
  process.env.LAZYDEV_MAX_OUTPUT_BYTES = String(value);
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.LAZYDEV_MAX_OUTPUT_BYTES;
    else process.env.LAZYDEV_MAX_OUTPUT_BYTES = prev;
  }
};

await testAsync('exec: output past LAZYDEV_MAX_OUTPUT_BYTES is cut exactly and reported as truncated', () => withMaxOutput(1024, async () => {
  const r = await exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(1024*1024))"]);
  assert.equal(r.stdout.length, 1024);
  assert.equal(r.truncated, true);
}));

await testAsync('exec: a small output is not truncated', () => withMaxOutput(1024, async () => {
  const r = await exec(process.execPath, ['-e', "process.stdout.write('hi')"]);
  assert.equal(r.stdout, 'hi');
  assert.equal(r.truncated, false);
}));

await testAsync('exec: stderr is capped separately from stdout', () => withMaxOutput(16, async () => {
  const r = await exec(process.execPath, ['-e', "process.stderr.write('e'.repeat(100))"]);
  assert.equal(r.stderr.length, 16);
  assert.equal(r.stdout, '');
  assert.equal(r.truncated, true);
}));

if (failed) process.exit(1);
