import { readFileSync, accessSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const pkg=JSON.parse(readFileSync('package.json'));
assert.equal(process.versions.node,pkg.engines.node,'Use the exact Node version in .node-version');
assert.equal(execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),pkg.engines.npm,'Use packageManager npm version');
assert.equal(readFileSync('.node-version','utf8').trim(),pkg.engines.node);
// Required gates do not skip missing media/browser prerequisites.
accessSync(chromium.executablePath());
for(const file of ['ffmpeg-core.js','ffmpeg-core.wasm'])accessSync(`node_modules/@ffmpeg/core/dist/umd/${file}`);
console.log(`Toolchain: Node ${process.versions.node}; npm ${pkg.engines.npm}; pinned Chromium and FFmpeg present.`);
