import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceIdentity, repositoryState } from '../../scripts/source-identity.mjs';
import { assertProductModules, inspectArtifacts } from '../../scripts/artifact-policy.mjs';
import { assertToolchainMetadata } from '../../scripts/toolchain-policy.mjs';
import { assessSmokeEvidence } from '../../scripts/qualification-policy.mjs';
const temporary=prefix=>mkdtempSync(path.join(tmpdir(),prefix));
test('F01/F03: assets, module declarations, generators and binary fixtures participate in identity',()=>{
  const root=temporary('clipbraid-inputs-');
  try{
    writeFileSync(path.join(root,'App.tsx'),'export const app=1;');
    for(const name of ['assets/icon.svg','scripts/api.d.mts','scripts/tool.cjs','scripts/generate.py','tests/fixtures/input.bin']){
      mkdirSync(path.dirname(path.join(root,name)),{recursive:true});writeFileSync(path.join(root,name),'first');
      const before=sourceIdentity(root).sha256;writeFileSync(path.join(root,name),'second');
      assert.notEqual(sourceIdentity(root).sha256,before,name);
    }
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('F04: private Markdown, data, external sources and unknown virtual modules cannot become product code',()=>{
  const root=process.cwd();
  for(const id of [`${root}/scratch-notes.md?raw`,`${root}/components/private-notes.md?raw`,`${root}/services/saved-project.json?raw`,`${root}/assets/user-photo.png?url`,`${root}/../outside.ts`,'\0private-journal'])
    assert.throws(()=>assertProductModules([id],root),/Non-product|Unapproved/);
});
test('F04: ignored implementation-shaped files are rejected even inside product directories',()=>{
  const root=temporary('clipbraid-ignored-source-');
  try{
    execFileSync('git',['init','-q',root]);writeFileSync(path.join(root,'.gitignore'),'*.local.ts\n');
    mkdirSync(path.join(root,'services'));writeFileSync(path.join(root,'services/debug.local.ts'),'export const privateContext="private";');
    assert.throws(()=>assertProductModules([path.join(root,'services/debug.local.ts')],root),/Non-product|ignored/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('F04: an artifact-root symlink is rejected before inventorying its contents',async()=>{
  const root=temporary('clipbraid-root-link-');
  try{
    mkdirSync(path.join(root,'real/assets'),{recursive:true});writeFileSync(path.join(root,'real/index.html'),'<!doctype html>');
    writeFileSync(path.join(root,'real/assets/index-12345678.js'),'console.log("public")');symlinkSync(path.join(root,'real'),path.join(root,'link'),'dir');
    await assert.rejects(inspectArtifacts(path.join(root,'link')),/symlink/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('F02/F03: required browser regressions have no undeclared native process dependency',async()=>{
  const {readFileSync}=await import('node:fs');
  for(const file of readdirSync('tests/browser').filter(file=>file.endsWith('.mjs')))
    assert.doesNotMatch(readFileSync(path.join('tests/browser',file),'utf8'),/node:child_process/,file);
});
test('F01/F03: Git and source-archive identities agree and a deleted cached file is not resurrected',()=>{
  const root=temporary('clipbraid-archive-parity-');
  try{
    writeFileSync(path.join(root,'App.tsx'),'export const app=1');writeFileSync(path.join(root,'README.md'),'Public description');
    mkdirSync(path.join(root,'assets'));writeFileSync(path.join(root,'assets/clipbraid.svg'),'<svg/>');
    execFileSync('git',['init','-q',root]);execFileSync('git',['add','.'],{cwd:root});
    const before=sourceIdentity(root);rmSync(path.join(root,'README.md'));const deleted=sourceIdentity(root);
    assert.notEqual(deleted.sha256,before.sha256);assert.equal(deleted.inputs.some(input=>input.path==='README.md'),false);
    rmSync(path.join(root,'.git'),{recursive:true,force:true});assert.equal(sourceIdentity(root).sha256,deleted.sha256);
    assert.deepEqual(repositoryState(root),{commit:null,dirty:null});
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('F03: runtime and lock metadata cannot diverge while a toolchain check remains green',()=>{
  const pkg={name:'example',version:'1.0.0',engines:{node:'22.23.3',npm:'11.11.1'},packageManager:'npm@11.11.1'};
  const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version,engines:{...pkg.engines}}}};
  const check=(p=pkg,l=lock)=>assertToolchainMetadata(p,l,'22.23.3','22.23.3\n','11.11.1','engine-strict=true\n');
  assert.doesNotThrow(()=>check());assert.throws(()=>check({...pkg,packageManager:'npm@10.0.0'}),/packageManager/);
  assert.throws(()=>check(pkg,{...lock,packages:{'':{...lock.packages[''],engines:{node:'20',npm:'11.11.1'}}}}),/runtime metadata/);
});
test('F01/F02: a harness ID or payload marker cannot substitute for job-bound decoded/delivery evidence',()=>{
  const jobId='00000000-0000-4000-8000-000000000000',buildId='a'.repeat(64)+':test';
  const value={jobId,buildId,sha256:'b'.repeat(64),bytes:2000,videoCodec:'avc',audioCodec:'aac',tone:.2,silence:0,
    job:{jobId,buildId,outcome:'download-started',cleanupComplete:true,input:{fingerprint:'c'.repeat(64)}}};
  assert.equal(assessSmokeEvidence(value),true);
  assert.equal(assessSmokeEvidence({...value,jobId:'run:test'}),false);
  assert.equal(assessSmokeEvidence({...value,job:{...value.job,outcome:'running'}}),false);
  assert.equal(assessSmokeEvidence({...value,tone:0}),false);
});
