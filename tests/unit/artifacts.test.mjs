import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectArtifacts, assertProductModules } from '../../scripts/artifact-policy.mjs';

test('artifact allow-list rejects extra media, plausible hashed files, symlinks and internal text',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'clipbraid-artifacts-'));
  try{
    await mkdir(`${root}/assets`);
    await writeFile(`${root}/index.html`,'<!doctype html><script src="/assets/index-12345678.js"></script>');
    await writeFile(`${root}/assets/index-12345678.js`,'console.log("product");');
    const expected=await inspectArtifacts(root);
    for(const name of ['draft.json','clip.mp4','font.woff2','assets/rogue-12345678.js']){
      await writeFile(`${root}/${name}`,'unapproved');
      await assert.rejects(inspectArtifacts(root,expected),/Unapproved|inventory differs/);
      await rm(`${root}/${name}`);
    }
    await symlink(`${root}/index.html`,`${root}/assets/link-12345678.js`);
    await assert.rejects(inspectArtifacts(root,expected),/symlink rejected/);
    await rm(`${root}/assets/link-12345678.js`);
    await writeFile(`${root}/assets/index-12345678.js`,'window.__clipbraidE2E = {};');
    await assert.rejects(inspectArtifacts(root),/Internal\/test content/);
    await writeFile(`${root}/assets/index-12345678.js`,'console.log("unexpected edit");');
    await assert.rejects(inspectArtifacts(root,expected),/modified artifact/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('bundled fixture or journal imports cannot hide inside approved JavaScript',()=>{
  const root=process.cwd();
  assert.doesNotThrow(()=>assertProductModules([`${root}/App.tsx`,`${root}/services/ffmpegService.ts`],root));
  for(const id of ['tests/fixtures/oversized-av.mp4?raw','test-data/private.json','public/private.json','reports/output.json','JOURNAL.md?raw','docs/private.json','naming/scorecard.json','indexes/context.json','DESIGN.md?raw'])assert.throws(()=>assertProductModules([`${root}/${id}`],root),/Non-product module/);
});
