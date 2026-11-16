// lazydev-harnesses.mjs - optional worker-harness config, shared by the runner and the MCP server.
// Pure helpers (validateHarnessConfig, normalizeHarnessConfig, fillArgv) have no I/O, so they are easy to test.
import { existsSync, readFileSync } from 'node:fs';

export const OPENCODE = 'opencode';
export const DEFAULT_HARNESSES_FILE = 'lazydev.harnesses.json';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

// Returns a list of human-readable problems; an empty list means the config is usable.
export function validateHarnessConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['harnesses config must be a JSON object like { "my-agent": { "type": "command", ... } }'];
  }
  const errs = [];
  for (const [id, h] of Object.entries(config)) {
    if (!ID_RE.test(id)) errs.push(`bad harness id ${JSON.stringify(id)} (lowercase letters, digits, dot, underscore, hyphen; max 40)`);
    if (h === null || typeof h !== 'object' || Array.isArray(h)) { errs.push(`harness ${id}: must be an object`); continue; }
    if (h.type !== 'opencode' && h.type !== 'command') errs.push(`harness ${id}: "type" must be "opencode" or "command"`);
    if (id === OPENCODE && h.type !== 'opencode') errs.push(`harness ${OPENCODE}: must keep "type": "opencode" (the built-in OpenCode harness)`);
    if (h.bin !== undefined && (typeof h.bin !== 'string' || !h.bin.trim())) errs.push(`harness ${id}: "bin" must be a non-empty string`);
    if (h.model !== undefined && typeof h.model !== 'string') errs.push(`harness ${id}: "model" must be a string`);
    if (h.note !== undefined && typeof h.note !== 'string') errs.push(`harness ${id}: "note" must be a string`);
    if (h.stdin !== undefined && typeof h.stdin !== 'boolean') errs.push(`harness ${id}: "stdin" must be true or false`);
    if (h.version_argv !== undefined && !(Array.isArray(h.version_argv) && h.version_argv.every((x) => typeof x === 'string'))) {
      errs.push(`harness ${id}: "version_argv" must be an array of strings`);
    }
    if (h.argv !== undefined && !isStringArray(h.argv)) errs.push(`harness ${id}: "argv" must be a non-empty array of strings (first item is the program)`);
    if (h.type === 'command' && !isStringArray(h.argv)) errs.push(`harness ${id}: "argv" is required for type "command"`);
    if (h.type === 'opencode' && h.argv !== undefined) errs.push(`harness ${id}: "argv" is only for type "command"`);
  }
  return errs;
}

// Build the harness map. "opencode" is always present; an explicit bin/model wins over the file's opencode entry.
export function normalizeHarnessConfig(config, { bin = null, model = null } = {}) {
  const out = new Map();
  const cfg = config ?? {};
  const oc = cfg[OPENCODE] ?? {};
  out.set(OPENCODE, {
    id: OPENCODE, type: 'opencode',
    bin: bin ?? oc.bin ?? OPENCODE,
    model: model ?? oc.model ?? null,
    version_argv: oc.version_argv ?? ['--version'],
  });
  for (const [id, h] of Object.entries(cfg)) {
    if (id === OPENCODE) continue;
    out.set(id, {
      id, type: h.type, bin: h.bin ?? null, model: h.model ?? null,
      argv: h.argv ?? null, stdin: h.stdin === true, version_argv: h.version_argv ?? null,
    });
  }
  return out;
}

// Replace {prompt}, {prompt_file} and {cwd} in one pass, so text substituted from a prompt is never expanded again.
export function fillArgv(argv, values) {
  return argv.map((a) => String(a).replace(/\{(prompt|prompt_file|cwd)\}/g, (m, k) => (values[k] === undefined ? m : String(values[k]))));
}

// Read the optional config file. A missing file is fine; a broken one is reported, never thrown.
export function readHarnessConfig(file) {
  if (!file || !existsSync(file)) return { config: {}, errors: [], file: null };
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { config: {}, errors: [`cannot parse ${file}: ${e.message}`], file }; }
  const errors = validateHarnessConfig(raw);
  return { config: errors.length ? {} : raw, errors, file };
}
