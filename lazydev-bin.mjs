// lazydev-bin.mjs - find the real OpenCode CLI executable.
// Pure: env, platform and fs are injected so this can be tested without touching the machine.
import * as nodeFs from 'node:fs';
import path from 'node:path';

const SHIM_RE = /\.(cmd|bat|ps1)$/i;

const versionParts = (name) => (String(name).match(/\d+/g) ?? []).map(Number);

// Newest first. "1.10.0" beats "1.9.9" (a plain string sort would get that wrong).
function compareVersionsDesc(a, b) {
  const A = versionParts(a), B = versionParts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x !== y) return y - x;
  }
  return String(b).localeCompare(String(a));
}

function executable(fs, file) {
  if (!fs.existsSync(file)) return false;
  if (typeof fs.statSync !== 'function') return true;
  try {
    const st = fs.statSync(file);
    if (!st || typeof st.mode !== 'number') return true;
    return (st.mode & 0o111) !== 0;
  } catch { return false; }
}

export function resolveOpencodeBin(env = process.env, platform = process.platform, fs = nodeFs) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const checked = [];

  const explicit = env.LAZYDEV_OPENCODE_BIN;
  if (explicit) {
    if (SHIM_RE.test(explicit)) {
      throw new Error(`LAZYDEV_OPENCODE_BIN points to a script shim (${explicit}); use the real executable (for example opencode-cli.exe), not a .cmd/.bat/.ps1 shim`);
    }
    return explicit;
  }

  if (platform === 'win32') {
    for (const root of [env.APPDATA, env.LOCALAPPDATA].filter(Boolean)) {
      const cliRoot = P.join(root, 'ai.opencode.desktop', 'cli');
      checked.push(cliRoot);
      let entries = [];
      try { entries = fs.readdirSync(cliRoot); } catch { entries = []; }
      const versions = entries.filter((name) => !/update/i.test(name)).sort(compareVersionsDesc);
      for (const name of versions) {
        const exe = P.join(cliRoot, name, 'opencode-cli.exe');
        checked.push(exe);
        if (fs.existsSync(exe)) return exe;
      }
    }
  } else {
    for (const dir of String(env.PATH ?? env.Path ?? '').split(':').filter(Boolean)) {
      const cand = P.join(dir, 'opencode');
      checked.push(cand);
      if (executable(fs, cand)) return cand;
    }
  }

  const places = checked.length
    ? checked.map((p) => `  - ${p}`).join('\n')
    : '  (nothing to search: APPDATA/LOCALAPPDATA are not set)';
  throw new Error(`opencode CLI not found. Looked in:\n${places}\nSet LAZYDEV_OPENCODE_BIN to the full path of the real executable (not a .cmd or .ps1 shim).`);
}
