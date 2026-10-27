import test from 'node:test';
import assert from 'node:assert/strict';
import {assessReferenceRuns} from '../../scripts/reference-policy.mjs';
import {diagnosticOptions} from '../../scripts/diagnostic-policy.mjs';
const source='a'.repeat(64),input='b'.repeat(64),nativeInput='c'.repeat(64),received='d'.repeat(64),buildId=source+':production';
function runs(){return ['draft','standard','draft','draft'].map((quality,index)=>{
  const jobId=`00000000-0000-4000-8000-00000000000${index}`,inputSha256=index===3?nativeInput:input;
  const state={jobId,buildId,phase:'complete',active:false,cleanupComplete:true,input:{fingerprint:'e'.repeat(64)},result:{delivery:'download-started',videoBytes:2000},
    events:['verified','download-started'].map(type=>({type,jobId,buildId}))};
  return {variant:index===3?'native-audio':'original',result:{quality,status:'passed',inputSha256,sourceInputsSha256:source,buildId,state,received:{bytes:2000,sha256:received,failure:null},
      errors:[],integrityErrors:[],environment:{launchArgs:['--disable-gpu','--disable-accelerated-video-encode']}},
    inspection:{status:'passed',sourceInputsSha256:source,inputSha256,receivedSha256:received,clipCount:23,profile:{width:quality==='standard'?1280:854,height:quality==='standard'?720:480,fps:24,frames:200},
      pictures:[...Array.from({length:86},(_,frame)=>frame),99,100,101,199].map((frame,i)=>({frame,psnrDb:30,activeClips:[i%23]})),
      audio:{unmutedClips:index===3?23:0,comparisons:Array.from({length:25},(_,i)=>({time:i,kind:'content',correlation:.99,levelRatio:1,offsetMs:0}))}}};
})}
test('full reference requires both profiles, a same-input repeat and an unmuted variant',()=>{
  assert.equal(assessReferenceRuns(runs(),source).valid,true);
  for(const mutate of [r=>r.pop(),r=>{r[1].result.quality='draft'},r=>{r[2].result.inputSha256=nativeInput},r=>{r[3].inspection.audio.unmutedClips=0},r=>{r[2].result.state.jobId=r[0].result.state.jobId}]){
    const value=runs();mutate(value);assert.equal(assessReferenceRuns(value,source).valid,false);
  }
});
test('reference status cannot replace exact-source, received media and measured inspection evidence',()=>{
  for(const mutate of [r=>{r[0].result.sourceInputsSha256=nativeInput},r=>{r[0].result.received.sha256='invalid'},r=>{r[0].inspection.pictures[0].psnrDb=NaN},
    r=>{r[0].inspection.audio.comparisons[0].correlation=.5},r=>{r[0].inspection.audio.comparisons[0].levelRatio=.1},r=>{r[0].inspection.audio.comparisons[0].offsetMs=80},
    r=>{r[0].inspection.pictures=[]},r=>{r[0].inspection.pictures[1].frame=0},r=>{r[0].inspection.pictures.forEach(point=>{point.activeClips=[0]})},
    r=>{r[0].inspection.audio.comparisons[1].time=0},r=>{r[0].result.environment.launchArgs=[]}]){
    const value=runs();mutate(value);assert.equal(assessReferenceRuns(value,source).valid,false);
  }
});
test('diagnostic software mode is explicit and rejects malformed configuration',()=>{
  assert.equal(diagnosticOptions(['input.json','reports/test'],{CLIPBRAID_DIAGNOSTIC_SOFTWARE:'1'}).software,true);
  assert.equal(diagnosticOptions(['input.json','reports/test'],{}).software,false);
  assert.throws(()=>diagnosticOptions(['input.json','reports/test'],{CLIPBRAID_DIAGNOSTIC_SOFTWARE:'yes'}),/must be 0 or 1/);
});
