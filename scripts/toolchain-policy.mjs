import assert from 'node:assert/strict';
export function assertToolchainMetadata(pkg,lock,nodeVersion,nodePin,npmVersion,npmrc) {
  assert.equal(nodeVersion,pkg.engines.node,'Use the exact Node version in .node-version');
  assert.equal(nodePin.trim(),pkg.engines.node,'Node pin and engines must agree');
  assert.equal(npmVersion,pkg.engines.npm,'Use the supported npm version');
  assert.equal(pkg.packageManager,`npm@${pkg.engines.npm}`,'packageManager and npm engine must agree');
  assert.equal(lock.lockfileVersion,3,'Use the committed npm lockfile format');
  assert.equal(lock.name,pkg.name);assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].name,pkg.name);assert.equal(lock.packages[''].version,pkg.version);
  assert.deepEqual(lock.packages[''].engines,pkg.engines,'Lockfile runtime metadata must match package.json');
  assert.match(npmrc,/^engine-strict\s*=\s*true\s*$/m,'Required installs enforce the runtime pin');
}
