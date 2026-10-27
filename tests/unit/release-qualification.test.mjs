import test from 'node:test';
import assert from 'node:assert/strict';
import {coreClosure,referenceChanges,assessRelease} from '../../scripts/release-policy.mjs';
import {readEvidence} from '../../scripts/qualification-input.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
function backlog(){return [...Array.from({length:54},(_,i)=>`### T${String(i+1).padStart(2,'0')} — Synthetic test card\n\n**Status:** Done · **Scope:** ${i<44?'CORE':'NEXT'}\n\n`),'### Q05 — Release\n\n**Status:** Planned · **Scope:** CORE\n'].join('')}
test('release closure rejects open, missing and duplicate CORE task records',()=>{
  assert.equal(coreClosure(backlog()).valid,true);
  assert.equal(coreClosure(backlog().replace('**Status:** Done','**Status:** Blocked')).valid,false);
  assert.equal(coreClosure(backlog().replace('### T01','### T02')).valid,false);
  assert.equal(coreClosure('').valid,false);
  assert.equal(coreClosure(backlog().replace('**Scope:** CORE','**Scope:** NEXT')).valid,false);
});
test('late media, build, brand and dependency changes require another reference run',()=>{
  const before=[{path:'services/timeline.ts',sha256:'a'.repeat(64)},{path:'README.md',sha256:'a'.repeat(64)},{path:'scripts/source-identity.mjs',sha256:'a'.repeat(64)},{path:'package-lock.json',sha256:'a'.repeat(64)},{path:'tsconfig.json',sha256:'a'.repeat(64)}];
  const docs=before.map(item=>({...item,sha256:item.path==='README.md'?'b'.repeat(64):item.sha256}));
  assert.equal(referenceChanges(before,docs).valid,true);
  for(const file of ['services/timeline.ts','package-lock.json','tsconfig.json'])assert.equal(referenceChanges(before,before.map(item=>({...item,sha256:item.path===file?'b'.repeat(64):item.sha256}))).valid,false);
  assert.equal(referenceChanges([],docs).valid,false);
});
test('a green technical status cannot replace full-reference, physical, user and CORE evidence',()=>{
  const result=assessRelease({candidate:{status:'passed'},reference:null,support:null,study:null,backlog:backlog(),source:{sha256:'a'.repeat(64),inputs:[]},lockfileSha256:'b'.repeat(64)});
  assert.equal(result.valid,false);
  assert(result.failures.some(message=>message.includes('Physical')));
  assert(result.failures.some(message=>message.includes('Representative-user')));
  assert(result.failures.some(message=>message.includes('reference')));
});
test('large generated reports use an explicit bounded limit without widening operator-record reads',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'clipbraid-generated-report-'));
  try{
    await mkdir(path.join(root,'reports'));await writeFile(path.join(root,'reports/result.json'),JSON.stringify({generated:'x'.repeat(4*1048576)}));
    await assert.rejects(readEvidence('reports/result.json',root),/at most/);
    assert.equal((await readEvidence('reports/result.json',root,64*1048576)).generated.length,4*1048576);
    await assert.rejects(readEvidence('reports/result.json',root,Infinity),/read limit/);
    await assert.rejects(readEvidence('reports/result.json',root,65*1048576),/read limit/);
  }finally{await rm(root,{recursive:true,force:true})}
});
