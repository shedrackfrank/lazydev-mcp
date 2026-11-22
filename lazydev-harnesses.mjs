// lazydev-harnesses.mjs - optional worker-harness config, shared by the runner and the MCP server.
// Pure helpers (validateHarnessConfig, normalizeHarnessConfig, fillArgv) have no I/O, so they are easy to test.
import { existsSync, readFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { resolveOpencodeBin } from './lazydev-bin.mjs';

export const OPENCODE = 'opencode';
export const DEFAULT_HARNESSES_FILE = 'lazydev.harnesses.json';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SHIM_RE = /\.(cmd|bat|ps1)$/i;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
const reasonOf = (e) => String(e?.message ?? e).split('\n')[0].trim();

function isExecutable(fs, file) {
  if (!fs.existsSync(file)) return false;
  if (typeof fs.statSync !== 'function') return true;
  try {
    const st = fs.statSync(file);
    if (!st || typeof st.mode !== 'number') return true;
    return (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// Extra install locations to try after PATH, for installers that do not update the current terminal.
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

// A program is either a path (absolute or containing a separator) or a bare name looked up on PATH.
function programAvailability(program, { env, platform, fs }) {
  if (typeof program !== 'string' || !program.trim()) return { available: false, reason: 'empty program path' };
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32' && SHIM_RE.test(program)) {
    return { available: false, reason: `script shim is not usable: ${program}` };
  }
  if (P.isAbsolute(program) || /[\\/]/.test(program)) {
    const abs = P.isAbsolute(program) ? program : P.resolve(program);
    if (!fs.existsSync(abs)) return { available: false, reason: `executable not found: ${program}` };
    return { available: true, bin: abs };
  }
  const id = platform === 'win32' ? program.replace(/\.exe$/i, '') : program;
  const found = findExecutable(id, env, platform, fs);
  if (!found) return { available: false, reason: `executable not found on PATH: ${program}` };
  if (found.shim) return { available: false, reason: `only a script shim was found: ${found.path}` };
  return { available: true, bin: found.path };
}

// Whether a normalized harness entry can actually be started on this machine.
export function harnessAvailability(h, { env = process.env, platform = process.platform, fs = nodeFs } = {}) {
  if (!h || typeof h !== 'object') return { available: false, reason: 'missing harness entry' };
  if (h.type === 'opencode') {
    if (h.bin && h.bin !== OPENCODE) return programAvailability(h.bin, { env, platform, fs });
    try {
      const bin = resolveOpencodeBin(env, platform, fs);
      return { available: true, bin };
    } catch (e) {
      return { available: false, reason: reasonOf(e) };
    }
  }
  const program = Array.isArray(h.argv) ? h.argv[0] : null;
  if (!program) return { available: false, reason: 'no argv[0] configured' };
  return programAvailability(program, { env, platform, fs });
}

// Shared default: LAZYDEV_DEFAULT_HARNESS or config.default when set, else opencode when available,
// else the only available harness. Returns { id } or { error }.
export function resolveDefaultHarness(harnesses, { config = {}, env = process.env, platform = process.platform, fs = nodeFs } = {}) {
  const ids = [...harnesses.keys()];
  const requested = env.LAZYDEV_DEFAULT_HARNESS ?? config.default;
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const id = String(requested).trim();
    if (!harnesses.has(id)) {
      return { error: `default harness ${JSON.stringify(id)} is not configured (configured: ${ids.join(', ')})` };
    }
    const av = harnessAvailability(harnesses.get(id), { env, platform, fs });
    if (!av.available) {
      return { error: `default harness ${JSON.stringify(id)} is not available: ${av.reason ?? 'not found'}` };
    }
    return { id };
  }
  const oc = harnesses.get(OPENCODE);
  if (oc && harnessAvailability(oc, { env, platform, fs }).available) return { id: OPENCODE };
  const available = ids.filter((id) => harnessAvailability(harnesses.get(id), { env, platform, fs }).available);
  const hint = 'set "harness" on each task or set LAZYDEV_DEFAULT_HARNESS';
  if (available.length === 1) return { id: available[0] };
  if (available.length === 0) return { error: `no harness is available (configured: ${ids.join(', ')}); ${hint}` };
  return { error: `cannot choose a default harness (available: ${available.join(', ')}); ${hint}` };
}

// Errors for tasks that name a harness that cannot run here. Tasks without "harness" use the default.
export function validateTaskHarnesses(tasks, harnesses, { env = process.env, platform = process.platform, fs = nodeFs } = {}) {
  const errs = [];
  for (const t of tasks) {
    if (t?.harness === undefined) continue;
    const h = harnesses.get(t.harness);
    if (!h) { errs.push(`task ${t.id}: harness ${JSON.stringify(t.harness)} is not configured`); continue; }
    const av = harnessAvailability(h, { env, platform, fs });
    if (!av.available) errs.push(`task ${t.id}: harness ${JSON.stringify(t.harness)} is not available: ${av.reason ?? 'not found'}`);
  }
  return errs;
}

// Returns a list of human-readable problems; an empty list means the config is usable.
export function validateHarnessConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['harnesses config must be a JSON object like { "my-agent": { "type": "command", ... } }'];
  }
  const errs = [];
  if (config.default !== undefined) {
    if (typeof config.default !== 'string' || !config.default.trim()) errs.push('"default" must be a harness id string');
    else if (config.default !== OPENCODE && !Object.prototype.hasOwnProperty.call(config, config.default)) {
      errs.push(`"default" names unknown harness ${JSON.stringify(config.default)}`);
    }
  }
  for (const [id, h] of Object.entries(config)) {
    if (id === 'default') continue;
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
    if (id === OPENCODE || id === 'default') continue;
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
