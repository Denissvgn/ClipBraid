import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dockerIgnoreFor, assertContainerToolchain } from '../../scripts/docker-context.mjs';
import { sourceIdentity } from '../../scripts/source-identity.mjs';

test('container context uses sorted literal files without broad directory exceptions', () => {
  const text = dockerIgnoreFor(['components/Preview.tsx', 'App.tsx', 'App.tsx']);
  assert.deepEqual(text.split('\n').filter(line => line.startsWith('!')), ['!.dockerignore', '!App.tsx', '!components/Preview.tsx']);
  assert(text.includes('\n**\n')); assert(!text.includes('!components\n'));
  for (const path of ['../secret', '/secret', 'foo/*', 'foo/[name]', 'file\n!secret', ' foo', 'foo\\bar', 'foo//bar'])
    assert.throws(() => dockerIgnoreFor([path]), /literal Docker context path/);
});

test('Docker identity includes deployment settings while private and ignored inputs stay excluded', () => {
  const root = mkdtempSync('/tmp/clipbraid-docker-context-');
  try {
    execFileSync('git', ['init', '--quiet', root]);
    mkdirSync(root + '/docker'); mkdirSync(root + '/reports'); mkdirSync(root + '/components');
    writeFileSync(root + '/.gitignore', 'reports/\n*.private.json\ncomponents/ignored.tsx\n');
    writeFileSync(root + '/App.tsx', 'export const app = 1;');
    writeFileSync(root + '/Dockerfile', 'FROM scratch');writeFileSync(root + '/docker/nginx.conf', 'listen 8080;');
    writeFileSync(root + '/compose.yaml', 'services: {}');
    writeFileSync(root + '/reports/private.json', 'secret');writeFileSync(root + '/customer.private.json', 'secret');
    writeFileSync(root + '/components/ignored.tsx', 'secret');writeFileSync(root + '/.env', 'secret');
    const initial = sourceIdentity(root), context = dockerIgnoreFor(initial.inputs.map(input => input.path));
    for (const name of ['Dockerfile', 'docker/nginx.conf', 'compose.yaml']) assert(context.includes('!' + name + '\n'));
    assert.doesNotMatch(context, /reports|customer|ignored|\.env/);
    writeFileSync(root + '/docker/nginx.conf', 'listen 8081;'); assert.notEqual(sourceIdentity(root).sha256, initial.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('container Node/npm pins and immutable bases cannot diverge from project metadata', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8'), pkg = JSON.parse(readFileSync('package.json'));
  assertContainerToolchain(dockerfile, pkg);
  for (const text of [dockerfile.replace(pkg.engines.node + '-bookworm-slim', '22-bookworm-slim'),
    dockerfile.replace('npm@' + pkg.engines.npm, 'npm@latest'), dockerfile.replaceAll(/@sha256:[a-f0-9]{64}/g, '')])
    assert.throws(() => assertContainerToolchain(text, pkg), /pins must match/);
});
