import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPlaywright,assessSmokeEvidence} from '../../scripts/qualification-policy.mjs';
import {processSucceeded} from '../../scripts/qualification-policy.mjs';
import {createQualificationRun,archiveQualification} from '../../scripts/qualification-evidence.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const single={suites:[{specs:[{file:'isolation.spec.mjs',title:'only a favicon',tests:[{expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}]}]};
test('Q01: global errors and incomplete production coverage cannot qualify',()=>{
  assert.equal(assessPlaywright({...single,errors:[{message:'global teardown failed'}]}).valid,false);
  assert.equal(assessPlaywright(single,false,'production').valid,false);
});
test('Q01: smoke evidence must bind its source and finite measured media observations',()=>{
  const jobId='00000000-0000-4000-8000-000000000001',buildId='a'.repeat(64)+':test';
  const evidence={jobId,buildId,sha256:'b'.repeat(64),bytes:2000,videoCodec:'avc',audioCodec:'aac',tone:.2,silence:0,
    duration:1.001,width:854,height:480,fps:30000/1001,frames:[[180,180,180,255],[180,180,180,255]],
    job:{jobId,buildId,outcome:'download-started',cleanupComplete:true,input:{fingerprint:'c'.repeat(64)}}};
  assert.equal(assessSmokeEvidence(evidence,'a'.repeat(64)),true);
  assert.equal(assessSmokeEvidence(evidence,'d'.repeat(64)),false);
  assert.equal(assessSmokeEvidence({...evidence,tone:Infinity}),false);
  assert.equal(assessSmokeEvidence({...evidence,frames:[]}),false);
});

test('Q01: a process timeout remains failure even if termination exits zero',()=>{
  const result=spawnSync(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100)"],{timeout:1000,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.error?.code,'ETIMEDOUT');assert.equal(processSucceeded(result),false);
});

test('Q01: qualification snapshots survive canonical replacement and locks prevent overlap',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'clipbraid-qualification-archive-'));
  try{
    const first=await createQualificationRun(root);await assert.rejects(createQualificationRun(root),/already running/);
    const file='reports/example.json',bytes=Buffer.from('first run');await writeFile(path.join(root,file),bytes);
    const manifest={status:'passed',steps:[]};
    const result=await archiveQualification(manifest,first.archiveDirectory,[file],root);
    assert.equal(result.artifacts[0].sha256,createHash('sha256').update(bytes).digest('hex'));
    await first.release();await writeFile(path.join(root,file),'second run');
    assert.equal(await readFile(path.join(root,result.artifacts[0].archivePath),'utf8'),'first run');
    const second=await createQualificationRun(root);assert.notEqual(second.runId,first.runId);await second.release();
  }finally{await rm(root,{recursive:true,force:true})}
});

test('Q01: changed or absent received output cannot be archived as passed evidence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'clipbraid-qualification-output-'));
  try{
    const run=await createQualificationRun(root);await mkdir(path.join(root,'test-results'),{recursive:true});
    const hash='a'.repeat(64);await writeFile(path.join(root,'test-results/output.mp4'),'changed');
    await writeFile(path.join(root,'reports/browser-manifest.json'),JSON.stringify({jobs:[{bytes:7,sha256:hash}],artifacts:[{path:'test-results/output.mp4',bytes:7,sha256:hash}]}));
    await assert.rejects(archiveQualification({status:'passed',steps:[]},run.archiveDirectory,['reports/browser-manifest.json'],root),/evidence changed/);
    await run.release();
  }finally{await rm(root,{recursive:true,force:true})}
});
