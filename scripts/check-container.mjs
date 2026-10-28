import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { assertProductArtifact } from './artifact-policy.mjs';
import { checkDockerContext } from './docker-context.mjs';
import { sourceIdentity } from './source-identity.mjs';

const image = process.argv[2] ?? 'clipbraid:local';
if (process.argv.length > 3 || !/^[a-z0-9][a-z0-9._/:@-]*$/i.test(image)) throw new Error('Usage: node scripts/check-container.mjs [image:tag]');
checkDockerContext();
const source = sourceIdentity(), directory = mkdtempSync(join(tmpdir(), 'clipbraid-container-'));
const name = 'clipbraid-check-' + randomUUID();
const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { status: 'failed', sourceInputsSha256: source.sha256, image };
let created = false, attempted = false;
try {
  const imageInfo = JSON.parse(run(['image', 'inspect', image]))[0];
  result.imageId = imageInfo.Id;
  const platform = process.env.DOCKER_DEFAULT_PLATFORM || run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
  assert.match(platform, /^linux\/[a-z0-9_]+(?:\/[a-z0-9_.-]+)?$/, 'Select a canonical Linux Docker platform');
  const [system, architecture] = platform.split('/');
  result.requestedPlatform = platform;
  result.imagePlatform = `${imageInfo.Os}/${imageInfo.Architecture}`;
  assert.equal(imageInfo.Os, system, 'Image OS must match the selected platform');
  assert.equal(imageInfo.Architecture, architecture, 'Image architecture must match the selected platform');
  assert.equal(imageInfo.Config.User, '101:101', 'Image must default to its non-root user');
  attempted = true;
  run(['run', '--platform', platform, '--detach', '--name', name, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--publish', '127.0.0.1::8080', image]);
  created = true;
  const expires = performance.now() + 30000;
  let state;
  while (performance.now() < expires) {
    state = JSON.parse(run(['inspect', name]))[0];
    if (!state.State.Running) throw new Error('Container stopped: ' + run(['logs', name]));
    if (state.State.Health?.Status === 'healthy') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(state.State.Health?.Status, 'healthy', 'Image healthcheck did not pass');
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(state.HostConfig.CapDrop, ['ALL']);
  assert(state.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(run(['exec', name, 'id', '-u']), '101');
  assert.equal(run(['top', name, '-eo', 'pid,args']).split('\n').filter(line => line.includes('nginx: worker process')).length, 1);
  const binding = state.NetworkSettings.Ports['8080/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  const base = `http://127.0.0.1:${binding.HostPort}/`;
  run(['cp', name + ':/opt/clipbraid/build-artifacts.json', join(directory, 'build-artifacts.json')]);
  const manifest = JSON.parse(readFileSync(join(directory, 'build-artifacts.json')));
  assert.equal(manifest.source.inputsSha256, source.sha256, 'Image must match the current public source');
  assert.equal(manifest.buildId, source.sha256 + ':production');
  assert.equal(manifest.configuration.automation, false);
  assert.equal(manifest.configuration.publicDir, false);
  const request = path => fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
  for (const file of manifest.files) {
    const response = await request(file.path), bytes = Buffer.from(await response.arrayBuffer());
    assertProductArtifact(file.path, bytes);
    assert.equal(response.status, 200, file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha(bytes), file.sha256, file.path);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), file.path === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (file.path.endsWith('.js')) assert.match(response.headers.get('content-type'), /(?:application|text)\/javascript/);
    if (file.path.endsWith('.css')) assert.match(response.headers.get('content-type'), /text\/css/);
    if (file.path.endsWith('.woff2')) assert.match(response.headers.get('content-type'), /font\/woff2/);
  }
  const files = run(['exec', name, 'find', '/usr/share/clipbraid', '-type', 'f']).split('\n').map(path => path.replace('/usr/share/clipbraid/', '')).sort();
  assert.deepEqual(files, manifest.files.map(file => file.path).sort(), 'Web root must contain exactly the approved files');
  for (const path of ['/', '/?e2e=1']) {
    const response = await request(path);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), manifest.files.find(file => file.path === 'index.html').sha256);
  }
  const denied = ['/.git/config', '/.env', '/package.json', '/Dockerfile', '/compose.yaml', '/IMPLEMENTATION_BACKLOG.md',
    '/reports/build-artifacts.json', '/opt/clipbraid/build-artifacts.json', '/tests/probe.html', '/__fixtures__/reference.json', '/assets/missing.js', '/missing.wasm'];
  for (const path of denied) {
    const response = await request(path);
    assert.equal(response.status, 404, path); assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
  const health = await request('/healthz'); assert.equal(health.status, 200); assert.equal(await health.text(), 'ok\n');
  // The source target exports the real Docker-filtered context. This checks
  // literal exceptions and containment, rather than approximating Docker globs.
  const contextRoot = join(directory, 'context');
  run(['build', '--platform', platform, '--target', 'source', '--output', `type=local,dest=${contextRoot}`, '.']);
  const inventory = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name), stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), 'Context must not contain symlinks');
    return stat.isDirectory() ? inventory(file) : [relative(contextRoot, file).replaceAll('\\', '/')];
  });
  assert.deepEqual(inventory(contextRoot).sort(), source.inputs.map(input => input.path).sort(), 'Docker must receive exactly the public inputs');
  assert.equal(sourceIdentity(contextRoot).sha256, source.sha256, 'Docker context contents must match the public source');
  assert.equal(sourceIdentity().sha256, source.sha256, 'Source changed during container checks');
  Object.assign(result, { status: 'passed', files: manifest.files.length, deniedRoutes: denied.length, user: 101,
    health: 'healthy', readOnly: true, contextFiles: source.inputs.length, servedArtifacts: 'byte-identical', runtime: 'NGINX static hosting; browser media processing' });
} catch (error) {
  result.error = String(error); process.exitCode = 1;
  if (created) try { result.logs = run(['logs', name]).slice(-8000); } catch {}
} finally {
  if (attempted) try { run(['rm', '--force', name]); } catch (error) {
    if (!String(error.stderr ?? error).includes('No such container')) { result.status = 'failed'; result.cleanupError = String(error); process.exitCode = 1; }
  }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync('reports', { recursive: true }); writeFileSync('reports/container-smoke.json', JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result));
