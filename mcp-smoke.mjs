#!/usr/bin/env node
// mcp-smoke.mjs - SDK client smoke test for mcp-server.mjs. No worker starts unless --run is passed.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'mcp-server.mjs');

// The server needs LAZYDEV_REPO. When it is not set (CI), use a throwaway folder so this smoke
// test never touches a real repository and never needs git or an agent.
const SMOKE_ROOT = path.join(os.tmpdir(), `lazydev-smoke-${process.pid}`);
const SMOKE_REPO = path.join(SMOKE_ROOT, 'repo');
const SMOKE_OUT = path.join(SMOKE_ROOT, 'out');
mkdirSync(SMOKE_REPO, { recursive: true });
if (!process.env.LAZYDEV_REPO) process.env.LAZYDEV_REPO = SMOKE_REPO;
if (!process.env.LAZYDEV_OUT) process.env.LAZYDEV_OUT = SMOKE_OUT;

// One fake command harness for this smoke run: a tiny node script, no agent and no network.
const SMOKE_HARNESSES = path.join(SMOKE_ROOT, 'harnesses.json');
const FAKE = path.join(HERE, 'fake-harness.mjs');
writeFileSync(SMOKE_HARNESSES, JSON.stringify({
  fake: {
    type: 'command',
    argv: [process.execPath, FAKE, 'smoke-out.txt'],
    version_argv: [FAKE, '--version'],
  },
}));
process.env.LAZYDEV_HARNESSES = SMOKE_HARNESSES;
delete process.env.LAZYDEV_DEFAULT_HARNESS;

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env } });
const client = new Client({ name: 'lazydev-smoke', version: '1.0.0' }, { capabilities: {} });
let failed = 0;
let lastText = '';

const test = async (name, fn) => {
  lastText = '';
  try { await fn(); console.log(`ok ${name}`); }
  catch (e) {
    failed++;
    console.error(`not ok ${name}: ${e.message}`);
    if (lastText) console.error(`  raw reply: ${lastText}`);
  }
};
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  lastText = text;
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { r, text, data };
};

await client.connect(transport);
try {
  await test('tools: exactly the 5 expected names', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ['dispatch_tasks', 'get_task_report', 'list_harnesses', 'request_integration', 'wait_for_run']);
  });

  await test('list_harnesses: returns a version and availability flags', async () => {
    const { data, text } = await call('list_harnesses');
    assert.ok(Array.isArray(data), text);
    assert.equal(data[0].id, 'opencode');
    assert.ok(typeof data[0].version === 'string' && data[0].version.trim(), text);
    for (const h of data) assert.equal(typeof h.available, 'boolean', text);
    const defaults = data.filter((h) => h.default);
    assert.equal(defaults.length, 1, text);
    assert.equal(defaults[0].available, true, text);
    const oc = data.find((h) => h.id === 'opencode');
    if (!oc.available) {
      assert.equal(oc.version, 'not installed', text);
      assert.ok(oc.reason, text);
    }
  });

  await test('list_harnesses: lists the configured fake command harness', async () => {
    const { r, data, text } = await call('list_harnesses');
    assert.ok(!r.isError && Array.isArray(data), text);
    const fake = data.find((h) => h.id === 'fake');
    assert.ok(fake, text);
    assert.equal(fake.type, 'command');
    assert.equal(fake.available, true, text);
    assert.equal(fake.version, 'fake-harness 1.0.0');
  });

  await test('dispatch_tasks: rejects bad task id', async () => {
    const { r, data, text } = await call('dispatch_tasks', {
      tasks: [{ id: 'Bad_ID', prompt: 'x', allowed_paths: ['x.txt'] }],
    });
    assert.ok(r.isError === true || data?.error, text);
  });

  await test('dispatch_tasks: rejects a dependency cycle', async () => {
    const { r, data, text } = await call('dispatch_tasks', {
      tasks: [
        { id: 'a', prompt: 'a', allowed_paths: ['a.txt'], depends_on: ['b'] },
        { id: 'b', prompt: 'b', allowed_paths: ['b.txt'], depends_on: ['a'] },
      ],
    });
    assert.ok(r.isError === true || data?.error, text);
  });

  await test('wait_for_run: unknown run_id returns an error', async () => {
    const { r, data, text } = await call('wait_for_run', { run_id: 'no-such-run', timeout_s: 1 });
    assert.ok(r.isError === true || data?.error, text);
  });

  await test('request_integration: unknown run_id returns an error', async () => {
    const { r, data, text } = await call('request_integration', { run_id: 'no-such-run' });
    assert.ok(r.isError === true || data?.error, text);
  });

  await test('get_task_report: omitting task_id lists every task', async () => {
    const out = path.resolve(process.env.LAZYDEV_OUT);
    const runId = 'smoke-alltasks';
    const dir = path.join(out, 'runs', runId);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ state: 'finished', task_ids: ['a', 'b'] }));
      writeFileSync(path.join(dir, 'a.result.json'), JSON.stringify({
        id: 'a', status: 'done', summary: 'ok', files_changed: ['a.txt'],
        violations: ['v1'], flags: ['f1'], verify: { ok: true, exit: 0 }, duration_s: 1.5,
      }));
      const { r, data, text } = await call('get_task_report', { run_id: runId, detail: 'full' });
      assert.ok(!r.isError && Array.isArray(data), text);
      assert.deepEqual(data.map((t) => t.id), ['a', 'b']);
      assert.equal(data[0].status, 'done');
      assert.equal(data[0].violations, 1);
      assert.equal(data[0].verify_ok, true);
      assert.equal(data[1].status, 'pending');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (process.argv.includes('--run')) {
    let runId = null;
    await test('dispatch_tasks: starts a tiny real task', async () => {
      const { r, data, text } = await call('dispatch_tasks', {
        tasks: [{ id: 'hello', prompt: 'Create hello.txt containing the word hello.', allowed_paths: ['hello.txt'] }],
        timeout_s: 120,
        max_parallel: 1,
      });
      assert.ok(!r.isError && data?.run_id, text);
      runId = data.run_id;
    });

    await test('get_task_report: pending or final right after dispatch', async () => {
      assert.ok(runId, 'no run_id');
      const { r, data, text } = await call('get_task_report', { run_id: runId, task_id: 'hello' });
      assert.ok(!r.isError && data && !data.error, text);
      assert.ok(['pending', 'done', 'failed', 'rejected', 'timeout', 'needs_review', 'blocked'].includes(data.status),
        `unexpected status: ${data.status}`);
    });

    await test('wait_for_run: finishes', async () => {
      assert.ok(runId, 'no run_id');
      let state = null;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const { data, text } = await call('wait_for_run', { run_id: runId, timeout_s: 20 });
        assert.ok(data && !data.error, text); // an error reply is a failure, not a retry
        state = data.state;
        if (state === 'finished' || state === 'error') break;
        assert.ok(state === 'starting' || state === 'running', `unexpected state: ${state}`);
      }
      assert.equal(state, 'finished');
    });

    await test('get_task_report: reads the task', async () => {
      const { r, data, text } = await call('get_task_report', { run_id: runId, task_id: 'hello', detail: 'full' });
      assert.ok(!r.isError && data?.id === 'hello', text);
    });
  }
} finally {
  try { await client.close(); } catch { /* already closed */ }
  try { rmSync(SMOKE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failed) process.exit(1);
