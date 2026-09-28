import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { inspectArtifacts } from './artifact-policy.mjs';

const baseline = JSON.parse(await readFile('reports/build-artifacts.json', 'utf8'));
await inspectArtifacts(baseline.outputDir, baseline.files);
const note = 'style-contamination-check.md';
// Construct the class so this test source cannot seed Tailwind's own scan.
const probeClass = ['z', '-[', '987654', ']'].join('');
await writeFile(note, `Synthetic local note: ${probeClass}\n`, { flag: 'wx' });
try {
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(build.status, 0, build.error?.message ?? build.stderr);
  const after = JSON.parse(await readFile('reports/build-artifacts.json', 'utf8'));
  await writeFile('reports/style-isolation.json', JSON.stringify({
    baseline: baseline.files, contaminated: after.files, probeClass,
    equal: JSON.stringify(baseline.files) === JSON.stringify(after.files),
  }, null, 2) + '\n');
  assert.deepEqual(after.files, baseline.files, 'Local notes changed production bytes');
  console.log('Production output is byte-identical with synthetic local-note contamination.');
} finally {
  await unlink(note);
}
