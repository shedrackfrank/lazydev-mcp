#!/usr/bin/env node
// fake-harness.mjs - a tiny stand-in worker for tests: no network, no agent, no shell.
// Usage: node fake-harness.mjs <file> [text]   writes <file> with [text] and prints one line.
//        node fake-harness.mjs --version       prints a fake version line.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('fake-harness 1.0.0');
  process.exit(0);
}
const file = args[0];
if (file) writeFileSync(file, args[1] ?? 'hello from fake-harness\n');
console.log(`fake-harness wrote ${file ?? '(nothing)'}`);
