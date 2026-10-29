import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { checkDockerContext } from '../../scripts/docker-context.mjs';

for (const scenario of [
  { name: 'an explicit platform', image: 'arm64', requested: 'linux/amd64' },
  { name: 'the native daemon platform', image: 'amd64', requested: undefined },
]) test(`container checks reject an incompatible image for ${scenario.name} before launch`, () => {
  const root = mkdtempSync(join(tmpdir(), 'clipbraid-container-platform-'));
  try {
    for (const file of ['package.json', 'Dockerfile', 'scripts/check-container.mjs', 'scripts/docker-context.mjs',
      'scripts/source-identity.mjs', 'scripts/artifact-policy.mjs']) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(file));
    }
    writeFileSync(join(root, '.dockerignore'), '');
    checkDockerContext(root, true);
    const bin = join(root, 'reports/fake-bin'), calls = join(root, 'reports/docker-calls.jsonl');
    mkdirSync(bin, { recursive: true });
    const imageInfo = { Id: `sha256:${'a'.repeat(64)}`, Os: 'linux', Architecture: scenario.image, Config: { User: '101:101' } };
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') console.log(${JSON.stringify(JSON.stringify([imageInfo]))});
else if (args[0] === 'version') console.log('linux/arm64');
else { console.error('Unexpected Docker operation: ' + args[0]); process.exitCode = 2; }
`, { mode: 0o700 });
    const environment = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
    if (scenario.requested) environment.DOCKER_DEFAULT_PLATFORM = scenario.requested;
    else delete environment.DOCKER_DEFAULT_PLATFORM;
    const result = spawnSync(process.execPath, ['scripts/check-container.mjs', 'synthetic:local'], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(join(root, 'reports/container-smoke.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.match(report.error, /Image architecture must match the selected platform/);
    assert.equal(report.imagePlatform, `linux/${scenario.image}`);
    assert.equal(report.requestedPlatform, scenario.requested ?? 'linux/arm64');
    const operations = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(operations.map(args => args[0]), scenario.requested ? ['image'] : ['image', 'version']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
