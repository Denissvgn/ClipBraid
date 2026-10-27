import test from 'node:test';
import assert from 'node:assert/strict';
import {loadModule} from '../source-probes.mjs';
const project=loadModule('services/project.ts');
const timing=loadModule('services/timeline.ts');
const editing=loadModule('services/editing.ts',{'./project':project});
const track={id:'voice',mediaId:'voice',sourceId:'source',mimeType:'audio/wav',name:'Voice',startTime:0,duration:1};
const snapshot={mediaAssets:[],audioTracks:[track],aspectRatio:'16:9',fitMode:'contain',transitionDuration:0,currentTime:0};
test('audio source windows preserve legacy defaults and apply exact source trims after moves',()=>{
  assert.deepEqual(timing.audioSourceWindow(track),{start:0,end:1});
  const trimmed=editing.moveAudio(editing.trimAudio(track,{trimStart:.2,trimEnd:.4}),.5);
  assert(Math.abs(trimmed.duration-.4)<1e-12);
  assert.deepEqual(timing.audioSourceWindow(trimmed),{start:.2,end:.6});
  assert(Math.abs(timing.audioSourceTimeAt(trimmed,.65)-.35)<1e-12);
  assert.equal(timing.isIntervalActive(trimmed,.5),true);assert.equal(timing.isIntervalActive(trimmed,.9),false);
  assert.equal(editing.moveAudio(trimmed,-2).startTime,0);assert.equal(editing.moveAudio(trimmed,1e8).startTime,86400);
  assert.equal(trimmed.sourceId,track.sourceId);assert.equal(editing.trimAudio(trimmed,{trimStart:0,trimEnd:0}).duration,1);
});
test('audio trim edits reject empty, invalid and unbounded source selections',()=>{
  for(const change of [{trimStart:1},{trimStart:-1},{trimEnd:Infinity},{trimStart:.999},{trimEnd:NaN}])assert.throws(()=>editing.trimAudio(track,change));
  for(const startTime of [NaN,Infinity])assert.throws(()=>editing.moveAudio(track,startTime));
  const clean=editing.trimAudio(track,{trimStart:.2,trimEnd:.4});
  const validate=audio=>project.validateProjectMetadata({...snapshot,audioTracks:[audio]});
  assert.deepEqual(validate(clean).audioTracks[0],clean);
  for(const bad of [{...clean,duration:.5},{...clean,originalDuration:Infinity},{...clean,trimStart:-1},{...clean,trimEnd:1}])assert.throws(()=>validate(bad));
});
test('format 3 audio trims and gains round-trip while versions 1/2 preserve their previously audible range',async()=>{
  const trimmed={...editing.trimAudio(track,{trimStart:.2,trimEnd:.4}),gain:.5};
  const json=await project.serializeProject({...snapshot,audioTracks:[trimmed]},async()=> 'b3JpZ2luYWw=');
  const saved=JSON.parse(json);assert.equal(saved.schemaVersion,3);assert.equal(saved.audioTracks[0].base64,'b3JpZ2luYWw=');
  const parsed=project.parseProject(json);assert.equal(parsed.audioTracks[0].trimStart,.2);assert.equal(parsed.audioTracks[0].trimEnd,.4);assert.equal(parsed.audioTracks[0].gain,.5);
  assert.equal(await project.serializeProject(parsed,async()=> 'b3JpZ2luYWw='),json);
  for(const schemaVersion of [undefined,1,2]){
    const old=project.parseProject(JSON.stringify({...saved,schemaVersion}));
    assert.equal(old.audioTracks[0].trimStart,undefined);
    assert.deepEqual(timing.audioSourceWindow(old.audioTracks[0]),{start:0,end:trimmed.duration});
  }
});
test('photo duration and clip ordering use the same transition bounds without changing source handles',()=>{
  const photo={id:'photo',mediaId:'photo',sourceId:'photo-source',mimeType:'image/png',name:'Photo',type:'image',startTime:0,duration:1,originalDuration:1,trimStart:0,trimEnd:0,filter:'none',hasAudio:false};
  const resized=editing.resizeImage(photo,2.5),second={...photo,id:'second',transitionDuration:.5};
  const sequence=timing.recalculateMediaStartTimes([resized,second],.5);
  assert.equal(sequence[0].sourceId,'photo-source');assert.equal(sequence[1].startTime,2);
  assert.equal(timing.projectDuration(sequence,[]),3);assert.equal(resized.originalDuration,2.5);
  for(const duration of [NaN,0,.01,86401])assert.throws(()=>editing.resizeImage(photo,duration));
  assert.throws(()=>editing.resizeImage({...photo,type:'video'},2));
});
