import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,mkdirSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sourceIdentity } from '../../scripts/source-identity.mjs';
import { diagnosticOptions,diagnosticBuild,verifyDiagnosticServer,diagnosticComplete,observerStopped,digest } from '../../scripts/diagnostic-policy.mjs';
const temporary=()=>mkdtempSync(path.join(tmpdir(),'clipbraid-diagnostic-policy-'));
test('E06: diagnostic arguments have bounded deadlines, local origins and private output paths',()=>{
  const root=temporary();
  try{
    assert.equal(diagnosticOptions(['input.json','reports/new'],{},root).timeoutMs,420000);
    for(const value of ['NaN','Infinity','0','1800001','1000.5'])assert.throws(()=>diagnosticOptions(['input.json','reports/new','draft','auto',value],{},root),/timeout/);
    assert.throws(()=>diagnosticOptions(['input.json','reports/new','draft','unknown'],{},root),/plan/);
    assert.throws(()=>diagnosticOptions(['input.json','components/evidence'],{},root),/evidence/);
    assert.throws(()=>diagnosticOptions(['input.json','reports/new'],{CLIPBRAID_DIAGNOSTIC_URL:'https://example.com/'},root),/loopback/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('E06: existing evidence and symlinked evidence directories cannot be overwritten',()=>{
  const root=temporary();
  try{
    mkdirSync(path.join(root,'reports/old'),{recursive:true});writeFileSync(path.join(root,'reports/old/result.json'),'old');
    assert.throws(()=>diagnosticOptions(['input.json','reports/old'],{},root),/already exists/);
    symlinkSync(path.join(root,'missing-target'),path.join(root,'reports/link'),'dir');
    assert.throws(()=>diagnosticOptions(['input.json','reports/link/new'],{},root),/symlink/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('E06: diagnostic build evidence must belong to the current source and product inventory',()=>{
  const root=temporary();
  try{
    writeFileSync(path.join(root,'App.tsx'),'export const app=1;');mkdirSync(path.join(root,'reports'));
    const identity=sourceIdentity(root),file=path.join(root,'reports/build-artifacts.json');
    const build={buildId:identity.sha256+':production',source:{inputsSha256:identity.sha256},
      configuration:{command:'build',mode:'production',automation:false,publicDir:false},
      files:['index.html','assets/index-12345678.js'].map(name=>({path:name,bytes:1,sha256:'a'.repeat(64)}))};
    const save=value=>writeFileSync(file,JSON.stringify(value));save(build);assert.equal(diagnosticBuild(root).identity.sha256,identity.sha256);
    save({...build,files:[...build.files,{path:'project.json',bytes:1,sha256:'a'.repeat(64)}]});assert.throws(()=>diagnosticBuild(root),/artifact/i);
    save(build);writeFileSync(path.join(root,'App.tsx'),'export const app=2;');assert.throws(()=>diagnosticBuild(root),/source/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('E06: every served build file must match exact bytes before input upload',async()=>{
  const body=Buffer.from('public bytes'),build={files:[{path:'index.html',bytes:body.length,sha256:digest(body)}]};
  const request=bytes=>({get:async()=>({status:()=>200,body:async()=>bytes})});
  assert.equal((await verifyDiagnosticServer(request(body),'http://127.0.0.1/',build)).length,1);
  await assert.rejects(verifyDiagnosticServer(request(Buffer.from('different')),'http://127.0.0.1/',build),/artifact mismatch/);
});
test('E06: completion requires received bytes, cleanup and events from the same job/build',()=>{
  const jobId='00000000-0000-4000-8000-000000000001',buildId='a'.repeat(64)+':production';
  const state={jobId,buildId,phase:'complete',active:false,cleanupComplete:true,input:{fingerprint:'c'.repeat(64)},result:{delivery:'download-started',videoBytes:100},
    events:['verified','download-started'].map(type=>({jobId,buildId,type}))};
  const received={bytes:100,sha256:'b'.repeat(64),failure:null};
  assert(diagnosticComplete(state,received,buildId));assert(!diagnosticComplete(state,null,buildId));
  assert(!diagnosticComplete({...state,cleanupComplete:false},received,buildId));
  assert(!diagnosticComplete(state,{...received,bytes:101},buildId));
  assert(!diagnosticComplete({...state,events:[...state.events,{jobId:'other',buildId,type:'verified'}]},received,buildId));
});

test('E05/E06: an explicitly stopped observer cannot leave a current running summary',()=>{
  const report={outcome:'running',cleanupComplete:false,warnings:[],endedAt:null};
  const historical=observerStopped(report);
  assert.equal(historical.outcome,'unknown');assert(historical.warnings.includes('previous-session-unobserved'));
  assert.equal(report.outcome,'running');assert.equal(historical.endedAt,null);
  const terminal={outcome:'download-started',cleanupComplete:true};assert.equal(observerStopped(terminal),terminal);
});
