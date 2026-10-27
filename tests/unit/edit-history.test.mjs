import test from 'node:test';
import assert from 'node:assert/strict';
import {loadModule} from '../source-probes.mjs';
const project=loadModule('services/project.ts');
const {EditHistory,emptyProject}=loadModule('services/editHistory.ts',{'./project':project});
const {MediaSourceStore}=loadModule('services/mediaSources.ts');
const store=()=>new MediaSourceStore({createObjectURL:()=>`blob:${Math.random()}`,revokeObjectURL(){}});
async function fixture(limit=50,bytes=256*1048576){
  const media=store(),[source]=await media.stage([{bytes:new Blob(['original']),mimeType:'image/png'}]);media.pin(source.sourceId);
  const clip={id:'clip',mediaId:'clip',sourceId:source.sourceId,mimeType:'image/png',name:'clip',type:'image',startTime:0,duration:1,originalDuration:1,trimStart:0,trimEnd:0,filter:'none',hasAudio:false,muted:false};
  const history=new EditHistory(media,limit,bytes);history.reset({...emptyProject(),mediaAssets:[clip]},true);media.syncPins([source.sourceId]);return {media,source,clip,history};
}
test('undo deletion revives the same immutable original and shares it across clip instances',async()=>{
  const {media,source,clip,history}=await fixture();
  history.update('Repeat clip',p=>({...p,mediaAssets:[clip,{...clip,id:'second',startTime:1}]}));
  history.update('Delete clips',p=>({...p,mediaAssets:[]}));media.syncPins([]);
  assert.equal(media.get(source.sourceId).bytes,source.bytes);assert.equal(media.snapshot().sources.length,1);assert.equal(media.snapshot().sources[0].disposed,true);
  assert.equal(history.undo(),true);media.syncPins([source.sourceId]);assert.equal(history.getSnapshot().project.mediaAssets.length,2);assert.equal(media.snapshot().sources[0].disposed,false);
  assert.equal(media.get(source.sourceId).sha256,source.sha256);assert.equal(media.snapshot().sources.length,1);
  history.redo();media.syncPins([]);history.dispose();assert.equal(media.snapshot().sources.length,0);
});
test('slider gestures produce one undo unit and new edits discard redo',async()=>{
  const {history}=await fixture();history.beginGroup();
  for(const gain of [.8,.5,.2])history.update('Volume',p=>({...p,mediaAssets:p.mediaAssets.map(c=>({...c,gain}))}));history.endGroup();
  history.undo();assert.equal(history.getSnapshot().project.mediaAssets[0].gain,undefined);assert.equal(history.getSnapshot().canUndo,false);
  history.redo();assert.equal(history.getSnapshot().project.mediaAssets[0].gain,.2);history.undo();
  history.update('Look',p=>({...p,mediaAssets:p.mediaAssets.map(c=>({...c,filter:'grayscale'}))}));assert.equal(history.getSnapshot().canRedo,false);
});
test('history bounds commands and retained source bytes without releasing live originals',async()=>{
  const {history,media,source}=await fixture(2,0);
  for(const value of ['cover','contain','cover'])history.update('Framing',p=>({...p,fitMode:value}));
  history.undo();history.undo();assert.equal(history.getSnapshot().canUndo,false);assert.equal(history.getSnapshot().limited,true);
  history.update('Delete',p=>({...p,mediaAssets:[]}));media.syncPins([]);
  assert.equal(history.getSnapshot().canUndo,false);assert.equal(media.get(source.sourceId),undefined);assert.equal(history.getSnapshot().retainedBytes,0);
});
test('saved/exported markers track content, ignore old workspaces and preserve intervening edits',async()=>{
  const {history}=await fixture(),saved=history.getSnapshot().project,epoch=history.generation;
  history.update('Framing',p=>({...p,fitMode:'cover'}));history.markSaved(saved,epoch);assert.equal(history.getSnapshot().dirty,true);
  history.undo();assert.equal(history.getSnapshot().dirty,false);history.markExported(saved,epoch);assert.equal(history.getSnapshot().exported,true);
  history.reset({...saved,fitMode:'cover'},true);history.markSaved(saved,epoch);history.markExported(saved,epoch);assert.equal(history.getSnapshot().dirty,false);assert.equal(history.getSnapshot().exported,false);
});
test('failed commands leave metadata/history unchanged and snapshots cannot mutate old edits',async()=>{
  const {history}=await fixture(),before=history.getSnapshot();
  assert.throws(()=>history.update('Bad',p=>({...p,mediaAssets:p.mediaAssets.map(c=>({...c,duration:-1}))})),/duration/);
  assert.equal(history.getSnapshot(),before);assert.throws(()=>{before.project.mediaAssets[0].name='changed'},TypeError);
  assert.equal(history.update('No change',p=>({...p})),false);assert.equal(history.getSnapshot().canUndo,false);
});
