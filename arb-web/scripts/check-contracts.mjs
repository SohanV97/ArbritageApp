#!/usr/bin/env node
/**
 * lib/contracts.ts is the only sanctioned type boundary between the engine and the browser.
 *
 * It must stay TYPE-ONLY. Type imports erase at build time, so a value export here would
 * compile happily and then pull server code — and transitively `node:crypto` — into the
 * client bundle. That is the kind of mistake that is invisible until the bundle breaks or,
 * worse, quietly ships. Cheaper to assert it than to remember it.
 */
import { readFileSync } from 'node:fs';

const FILE = 'lib/contracts.ts';
const src = readFileSync(FILE, 'utf8');

const offenders = [];
src.split('\n').forEach((line, i) => {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
  // Anything exported that is not a type or an interface is a runtime value.
  const m = t.match(/^export\s+(?!type\b|interface\b)(\w+)/);
  if (m) offenders.push(`${FILE}:${i + 1}  ${t.slice(0, 70)}`);
  // A value import would be bundled even if nothing re-exported it.
  if (/^import\s+(?!type\b)/.test(t)) offenders.push(`${FILE}:${i + 1}  value import: ${t.slice(0, 70)}`);
});

if (offenders.length) {
  console.error(`\n${FILE} must contain only types.\n`);
  for (const o of offenders) console.error('  ' + o);
  console.error('\nMove runtime values elsewhere; this file is imported by the browser.\n');
  process.exit(1);
}
console.log(`${FILE}: type-only boundary intact`);
