import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {assessSupportMatrix,SUPPORT_CASES} from '../../scripts/support-policy.mjs';
import {verifyEvidenceArtifacts} from '../../scripts/qualification-input.mjs';
const source='a'.repeat(64),buildId=source+':production';
function matrix(){return {schemaVersion:1,sourceInputsSha256:source,buildId,artifacts:[{id:'observation'}],targets:['desktop-chromium','android-flow'].map((kind,index)=>({
  id:`target-${index}`,kind,physical:true,headless:false,operatorId:'operator-01',observedAt:'2026-10-27T00:00:00.000Z',observedBuildId:buildId,
  device:{model:'synthetic test fixture',os:'test OS',browser:'Chromium',browserVersion:'1',webViewVersion:'1',flowVersion:'1'},
  cases:Object.fromEntries(SUPPORT_CASES.map(key=>[key,{status:'passed',behavior:'available',observation:'synthetic unit-test observation',artifacts:['observation']}])),
  envelope:{visualClips:23,audioTracks:1,durationSeconds:181.02,inputBytes:1000,profiles:['draft','standard']},
  measurements:{concurrentEncoders:1,cancelAckMs:100,cleanupMs:1000,steadyAvSkewMs:20,memoryScope:'Unavailable to this API; pressure behavior observed separately',peakMemoryBytes:null}
}))}}
test('physical support requires both real target classes and observed versioned behavior',()=>{
  assert.equal(assessSupportMatrix(matrix(),source).valid,true);
  const extra=matrix();extra.targets[0].device.serial='not-for-summary';extra.targets[0].envelope.path='not-for-summary';
  const summary=assessSupportMatrix(extra,source).qualifiedTargets[0];
  assert.equal(summary.device.serial,undefined);assert.equal(summary.envelope.path,undefined);assert.equal(summary.measurements.cleanupMs,1000);
  for(const mutate of [m=>m.targets.pop(),m=>{m.targets[0].physical=false},m=>{m.targets[0].headless=true},m=>{delete m.targets[1].device.flowVersion},
    m=>{m.targets[0].cases['microphone-deny'].status='unobserved'},m=>{m.targets[0].cases['local-import'].behavior='unsupported-with-fallback'},m=>{m.targets[0].observedBuildId='old'}]){
    const value=matrix();mutate(value);assert.equal(assessSupportMatrix(value,source).valid,false);
  }
});
test('reduced device limits require an explicit decision and timing targets remain fixed',()=>{
  const value=matrix();value.targets[1].envelope.visualClips=2;assert.equal(assessSupportMatrix(value,source).valid,false);
  value.targets[1].scopeDecision={approvedBy:'product-owner',recordedAt:'2026-10-27T00:00:00.000Z',reason:'Synthetic scope-decision test'};
  assert.equal(assessSupportMatrix(value,source).valid,true);
  value.targets[1].measurements.cleanupMs=5001;assert.equal(assessSupportMatrix(value,source).valid,false);
  value.targets[1].measurements.cleanupMs=1000;value.targets[1].measurements.steadyAvSkewMs=81;assert.equal(assessSupportMatrix(value,source).valid,false);
});
test('evidence hashing rejects changed files, duplicate paths and symlink escapes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'clipbraid-support-proof-'));
  try {
    await mkdir(path.join(root,'reports'));const bytes=Buffer.from('synthetic evidence');
    await writeFile(path.join(root,'reports/proof.bin'),bytes);
    const item={id:'proof',path:'reports/proof.bin',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    assert.deepEqual(await verifyEvidenceArtifacts([item],root),{files:1,bytes:bytes.length});
    await assert.rejects(verifyEvidenceArtifacts([{...item,sha256:'b'.repeat(64)}],root),/hash mismatch/);
    await assert.rejects(verifyEvidenceArtifacts([item,{...item,id:'second'}],root),/duplicate/);
    await symlink(path.join(root,'reports/proof.bin'),path.join(root,'reports/link.bin'));
    await assert.rejects(verifyEvidenceArtifacts([{...item,path:'reports/link.bin'}],root),/symlink/i);
    await assert.rejects(verifyEvidenceArtifacts([{...item,path:'README.md'}],root),/reports/);
  }finally{await rm(root,{recursive:true,force:true})}
});
