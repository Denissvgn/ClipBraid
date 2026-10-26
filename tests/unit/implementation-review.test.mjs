import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const { MediaSourceStore } = loadModule("services/mediaSources.ts");
const timeline = loadModule("services/timeline.ts");
const project = loadModule("services/project.ts");
const { ProjectWork } = loadModule("services/projectWork.ts");
const urls = () => ({createObjectURL:()=>`blob:${crypto.randomUUID()}`,revokeObjectURL:()=>{}});

for (const settlement of ["rollback", "commit"]) test(`D02: ${settlement} during hashing cannot leave a late staged source`, async()=>{
  const store=new MediaSourceStore(urls()),tx=store.beginTransaction();let finish;
  const pending=tx.stage([{bytes:{size:1,arrayBuffer:()=>new Promise(resolve=>{finish=resolve})},mimeType:"video/mp4"}]);
  tx[settlement]();finish(new Uint8Array([1]).buffer);
  await assert.rejects(pending,/settled/);assert.deepEqual(store.snapshot(),{sources:[],pinned:[]});
});
test("D02: clearing during hashing invalidates late sources while preserving an existing job lease",async()=>{
  const store=new MediaSourceStore(urls()),[old]=await store.stage([{bytes:new Blob(["old"]),mimeType:"video/mp4"}]);
  store.pin(old.sourceId);const lease=store.acquire(old.sourceId);let finish;
  const pending=store.stage([{bytes:{size:1,arrayBuffer:()=>new Promise(resolve=>{finish=resolve})},mimeType:"video/mp4"}]);
  store.clear();finish(new Uint8Array([2]).buffer);await assert.rejects(pending,/changed|cleared/);
  assert.equal(await store.bytesFor(old.sourceId).text(),"old");lease.release();assert.deepEqual(store.snapshot(),{sources:[],pinned:[]});
});
test("D02: a failed pin-set acquisition retains the old set without partial new pins",async()=>{
  let calls=0;const revoked=[],store=new MediaSourceStore({createObjectURL:()=>{if(++calls===3)throw new Error("URL capacity");return `blob:${calls}`},revokeObjectURL:url=>revoked.push(url)});
  const assets=await store.stage(["old","a","b"].map(text=>({bytes:new Blob([text]),mimeType:"video/mp4"})));
  store.pin(assets[0].sourceId);const before=store.snapshot();
  assert.throws(()=>store.syncPins(assets.slice(1).map(asset=>asset.sourceId)),/URL capacity/);
  assert.deepEqual(store.snapshot(),before);assert.deepEqual(revoked,["blob:2"]);
});
test("D03: the text entry point gates encoded bytes before parsing",()=>{
  const NativeBlob=globalThis.Blob;globalThis.Blob=class extends NativeBlob{get size(){return project.MAX_PROJECT_BYTES+1}};
  try{assert.throws(()=>project.parseProject("{not JSON"),/too large/)}finally{globalThis.Blob=NativeBlob}
});
test("D03: seeking to the end of an accepted long interval stays serializable",async()=>{
  const state=project.parseProject(JSON.stringify({mediaAssets:[{id:"image",name:"image",mimeType:"image/png",base64:"AQ==",type:"image",startTime:project.MAX_TIMELINE_SECONDS,duration:project.MAX_TIMELINE_SECONDS,originalDuration:1}]}));
  state.currentTime=timeline.projectDuration(state.mediaAssets,[]);
  const saved=await project.serializeProject(state,async()=>"AQ==");
  assert.equal(project.parseProject(saved).currentTime,2*project.MAX_TIMELINE_SECONDS);
});
test("D02/D04: repeated clip references encode their immutable source only once per save",async()=>{
  const clip={id:"one",name:"image",mimeType:"image/png",base64:"AQ==",type:"image",startTime:0,duration:1};
  const state=project.parseProject(JSON.stringify({mediaAssets:[clip,{...clip,id:"two",startTime:1}]}));let reads=0;
  const saved=JSON.parse(await project.serializeProject(state,async()=>{reads++;return "AQ=="}));
  assert.equal(reads,1);assert.equal(saved.mediaAssets[0].base64,saved.mediaAssets[1].base64);
});
test("D03/D04: oversized metadata fails before media encoding begins",async()=>{
  const state=project.parseProject(JSON.stringify({mediaAssets:[{id:"one",name:"image",mimeType:"image/png",base64:"AQ==",type:"image",startTime:0,duration:1}]}));
  let reads=0;const NativeBlob=globalThis.Blob;globalThis.Blob=class extends NativeBlob{get size(){return project.MAX_PROJECT_BYTES+1}};
  try{await assert.rejects(project.serializeProject(state,async()=>{reads++;return "AQ=="}),/too large/);assert.equal(reads,0)}finally{globalThis.Blob=NativeBlob}
});
test("V02: short projects and selected source windows do not acquire artificial duration",()=>{
  assert.equal(timeline.projectDuration([{startTime:0,duration:.25}],[]),.25);
  assert.equal(timeline.projectDuration([],[]),0);
  assert.equal(timeline.timelineViewportDuration([],[]),10);
  assert.equal(timeline.trimmedDuration({trimStart:0,trimEnd:0,originalDuration:.05}),.05);
});
test("V02: frame counts do not add a frame for floating-point addition noise",()=>{
  assert.equal(timeline.frameCount(.1+.2,30),9);
  assert.equal(timeline.frameCount(Number.MIN_VALUE,30),1);
  assert.equal(timeline.frameCount(0,30),0);
});
test("V02: valid source times near a selected end are not biased into the preceding frame",()=>{
  const clip={startTime:0,trimStart:.0334,trimEnd:.9326,originalDuration:1};
  assert.ok(Math.abs(timeline.sourceTimeAt(clip,1/30)-(.0334+1/30))<1e-12);
});
test("V02/V03: ending a short overlay reveals a still-active clip instead of black",()=>{
  const media=[{id:"background",startTime:0,duration:2},{id:"overlay",startTime:.25,duration:.5,transitionDuration:.25}];
  const opacity=timeline.createOpacitySampler(media);
  assert.equal(opacity(media[0],.1),1);assert.equal(opacity(media[1],.5),1);
  assert.equal(opacity(media[0],1),1);assert.equal(opacity(media[1],1),0);
});
test("D04: only the latest load may commit, while a failed load leaves workspace edits valid",()=>{
  const work=new ProjectWork(new MediaSourceStore(urls())),edit=work.beginEdit(),old=work.beginLoad(),latest=work.beginLoad();
  assert.equal(old.isCurrent(),false);assert.throws(()=>old.check(),{name:"AbortError"});assert.equal(edit.isCurrent(),true);
  latest.finish();assert.equal(edit.isCurrent(),true);edit.commit();edit.finish();old.finish();
});
test("D04: replacement cancels pending staging without revoking a retained export source",async()=>{
  const store=new MediaSourceStore(urls()),[old]=await store.stage([{bytes:new Blob(["old"]),mimeType:"image/png"}]);store.pin(old.sourceId);
  const lease=store.acquire(old.sourceId),manager=new ProjectWork(store),edit=manager.beginEdit();let finish;
  const pending=edit.tx.stage([{bytes:{size:1,arrayBuffer:()=>new Promise(resolve=>{finish=resolve})},mimeType:"image/png"}]);
  const load=manager.beginLoad(),[next]=await load.tx.stage([{bytes:new Blob(["new"]),mimeType:"image/png"}]);
  load.tx.pin(next.sourceId);load.commit();store.syncPins([next.sourceId]);
  assert.equal(edit.signal.aborted,true);assert.equal(edit.isCurrent(),false);
  finish(new Uint8Array([3]).buffer);await assert.rejects(pending,/settled/);edit.finish();load.finish();await manager.idle();
  assert.equal(await store.bytesFor(old.sourceId).text(),"old");lease.release();assert.equal(store.get(old.sourceId),undefined);
  assert.deepEqual(store.snapshot().pinned,[next.sourceId]);
});
test("D04: an explicit cancellation retains status ownership, unlike workspace invalidation",()=>{
  const manager=new ProjectWork(new MediaSourceStore(urls())),edit=manager.beginEdit();edit.cancel();
  assert.equal(edit.isCurrent(),true);assert.throws(()=>edit.check(),{name:"AbortError"});edit.finish();
  const next=manager.beginEdit();manager.invalidate();assert.equal(next.isCurrent(),false);next.finish();
});
