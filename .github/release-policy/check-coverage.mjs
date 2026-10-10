#!/usr/bin/env node
// Release-policy coverage check. Every tracked file that lives in a sensitive area
// (sensitive-areas.json) must be classified as gated by risk-classes.json; otherwise this exits 1.
// Runs in CI (verify job) and locally with `pnpm policy:check`. No dependencies.
// Usage: node .github/release-policy/check-coverage.mjs [path ...]   (default: every file in `git ls-files`)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');

// Identical to the matcher inlined in .github/workflows/risk-classify.yml; check-coverage.test.mjs asserts the two stay the same.
export const globToRegex = glob => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${pattern}$`);
};

export function loadPolicy(dir = here) {
  return JSON.parse(readFileSync(join(dir, 'risk-classes.json'), 'utf8'));
}
export function loadAreas(dir = here) {
  return JSON.parse(readFileSync(join(dir, 'sensitive-areas.json'), 'utf8'));
}

/** Gated classes whose globs match the path (empty means routine). */
export function gatedClasses(file, policy) {
  return policy.gated.filter(rule => rule.paths.some(glob => globToRegex(glob).test(file))).map(rule => rule.class);
}

/** Sensitive areas the path falls into (empty means not sensitive). */
export function areasOf(file, areas) {
  return areas.areas.filter(area =>
    area.include.some(re => new RegExp(re, 'i').test(file)) &&
    !(area.exclude ?? []).some(re => new RegExp(re, 'i').test(file)));
}

/** Files that are in a sensitive area but not gated. */
export function uncovered(files, policy, areas) {
  const out = [];
  for (const file of files) {
    const hit = areasOf(file, areas);
    if (hit.length === 0) continue;
    if (gatedClasses(file, policy).length === 0) out.push({ file, areas: hit.map(a => a.area) });
  }
  return out;
}

export function trackedFiles(cwd = repoRoot) {
  return execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
}

export function report(files, policy, areas) {
  const sensitive = files.filter(file => areasOf(file, areas).length > 0);
  const missing = uncovered(files, policy, areas);
  const perArea = new Map();
  for (const file of sensitive) for (const a of areasOf(file, areas)) perArea.set(a.area, (perArea.get(a.area) ?? 0) + 1);
  return { total: files.length, sensitive: sensitive.length, perArea, missing };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map(f => f.replace(/\\/g, '/')) : trackedFiles();
  const result = report(files, loadPolicy(), loadAreas());
  console.log(`Release-policy coverage: ${result.total} files checked, ${result.sensitive} in sensitive areas.`);
  for (const [area, count] of [...result.perArea].sort()) {
    const gap = result.missing.some(m => m.areas.includes(area));
    console.log(`  ${area}: ${count} file(s)${gap ? ', NOT all gated' : ', all gated'}`);
  }
  if (result.missing.length) {
    console.error('\nSensitive files that are NOT classified as gated (add a matching path to .github/release-policy/risk-classes.json in this PR):');
    for (const m of result.missing) console.error(`  ${m.file}  [${m.areas.join(', ')}]`);
    process.exit(1);
  }
  console.log('Every sensitive file is gated.');
}
