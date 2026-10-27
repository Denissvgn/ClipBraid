import test from 'node:test';
import assert from 'node:assert/strict';
import {assessUsability,WORKFLOW_STEPS} from '../../scripts/usability-policy.mjs';
import {SUPPORT_CASES} from '../../scripts/support-policy.mjs';
const source='a'.repeat(64),buildId=source+':production';
function support(){return {schemaVersion:1,sourceInputsSha256:source,buildId,artifacts:[{id:'observation'}],targets:['desktop-chromium','android-flow'].map((kind,index)=>({
  id:`target-${index}`,kind,physical:true,headless:false,operatorId:'operator-01',observedAt:'2026-10-27T00:00:00.000Z',observedBuildId:buildId,
  device:{model:'synthetic unit fixture',os:'test OS',browser:'Chromium',browserVersion:'1',webViewVersion:'1',flowVersion:'1'},
  cases:Object.fromEntries(SUPPORT_CASES.map(key=>[key,{status:'passed',behavior:'available',observation:'synthetic unit observation',artifacts:['observation']}])),
  envelope:{visualClips:23,audioTracks:1,durationSeconds:181.02,inputBytes:1000,profiles:['draft','standard']},
  measurements:{concurrentEncoders:1,cancelAckMs:100,cleanupMs:1000,steadyAvSkewMs:20,memoryScope:'not available',peakMemoryBytes:null}
}))}}
function study(){return {schemaVersion:1,sourceInputsSha256:source,buildId,anonymized:true,observedAt:'2026-10-27T00:00:00.000Z',
  artifacts:[{id:'snapshot'}],snapshots:[{kind:'mobile',artifactId:'snapshot'},{kind:'desktop',artifactId:'snapshot'}],issues:[],
  participants:Array.from({length:5},(_,index)=>({id:`P0${index+1}`,representative:true,synthetic:false,targetId:'target-0',screenWidth:1280,screenHeight:800,artifacts:['snapshot'],coached:false,
    steps:Object.fromEntries(WORKFLOW_STEPS.map(step=>[step,'passed'])),categoryUnderstanding:'correct',saveExportUnderstanding:'correct',recoveryUnderstanding:'correct',
    progressErrorUnderstanding:'correct',keyboardOperation:'passed',legacyOpen:'passed',legacyProjectRecognition:'recognized'}))}}
test('study qualification requires five distinct real people and qualified targets',()=>{
  assert.equal(assessUsability(study(),support(),source).valid,true);
  for(const mutate of [s=>s.participants.pop(),s=>{s.participants[1].id='P01'},s=>{s.participants[0].synthetic=true},s=>{s.participants[0].targetId='unqualified'},s=>{s.sourceInputsSha256='b'.repeat(64)}]){
    const value=study();mutate(value);assert.equal(assessUsability(value,support(),source).valid,false);
  }
  const unavailable=support();unavailable.targets=[];assert.equal(assessUsability(study(),unavailable,source).valid,false);
});
test('coaching and save/export confusion are counted and require disposition',()=>{
  const value=study();value.participants[4].coached=true;
  assert.equal(assessUsability(value,support(),source).valid,false);
  value.issues=[{participantIds:['P05'],severity:'minor',disposition:'accepted-minor',reason:'Synthetic test of four-of-five threshold'}];
  assert.equal(assessUsability(value,support(),source).valid,true);
  value.participants[3].saveExportUnderstanding='incorrect';value.issues[0].participantIds.push('P04');
  assert.equal(assessUsability(value,support(),source).completed,3);assert.equal(assessUsability(value,support(),source).valid,false);
  value.issues=[{participantIds:1}];assert.equal(assessUsability(value,support(),source).valid,false);
});
test('critical retests and final keyboard/legacy behavior cannot be waived by a completion score',()=>{
  const value=study();value.issues=[{participantIds:['P01'],severity:'critical',disposition:'fixed',retestPassed:false,retestArtifactId:'snapshot'}];
  assert.equal(assessUsability(value,support(),source).valid,false);
  value.issues[0].retestPassed=true;assert.equal(assessUsability(value,support(),source).valid,true);
  value.participants[0].keyboardOperation='failed';assert.equal(assessUsability(value,support(),source).valid,false);
  value.participants[0].keyboardOperation='passed';value.participants[0].legacyOpen='failed';assert.equal(assessUsability(value,support(),source).valid,false);
});
