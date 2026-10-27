import { readFileSync, accessSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { assertToolchainMetadata } from './toolchain-policy.mjs';
const pkg=JSON.parse(readFileSync('package.json'));
const lock=JSON.parse(readFileSync('package-lock.json'));
const npm=execFileSync('npm',['--version'],{encoding:'utf8',timeout:5000,maxBuffer:16384}).trim();
assertToolchainMetadata(pkg,lock,process.versions.node,readFileSync('.node-version','utf8'),npm,readFileSync('.npmrc','utf8'));
assert.equal(execFileSync('npm',['config','get','engine-strict'],{encoding:'utf8',timeout:5000,maxBuffer:16384}).trim(),'true','Effective npm configuration must enforce engine-strict');
const versions={};
for(const name of ['@playwright/test','playwright-core','@ffmpeg/core','typescript','vite','@modelcontextprotocol/sdk','mediabunny','@mediabunny/ac3']){
  versions[name]=JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
  assert.equal(versions[name],lock.packages[`node_modules/${name}`].version,`${name} must match the frozen lockfile`);
}
// Required gates do not skip missing media/browser prerequisites.
accessSync(chromium.executablePath());
for(const file of ['ffmpeg-core.js','ffmpeg-core.wasm'])accessSync(`node_modules/@ffmpeg/core/dist/umd/${file}`);
mkdirSync('reports',{recursive:true});writeFileSync('reports/toolchain.json',JSON.stringify({node:process.versions.node,npm,versions,
  browser:JSON.parse(readFileSync('node_modules/playwright-core/browsers.json')).browsers.find(browser=>browser.name==='chromium'),
  nativeMediaCli:'not required; optional fixture generation/independent inspection only'},null,2)+'\n');
console.log(`Toolchain: Node ${process.versions.node}; npm ${pkg.engines.npm}; pinned Chromium and FFmpeg present.`);
