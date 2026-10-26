import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, loadDelivery } from '../source-probes.mjs';
import { exportStatus, reportStatus } from '../../mcp-server/lib.js';
const lifecycle=loadModule('services/exportJob.ts');

function segmentValidator(config={},packets=[0,1/30,2/30]) {
  class Input {
    async getPrimaryVideoTrack(){return {
      getDecoderConfig:async()=>({codec:'avc1.42001f',codedWidth:854,codedHeight:480,...config}),
      computeDuration:async()=>.1,getFirstTimestamp:async()=>0,getTimeResolution:async()=>1e6,
    }}
    dispose(){}
  }
  class Sink {async *packets(){for(const [index,value] of packets.entries())yield typeof value==='number'?{timestamp:value,duration:1/30,type:index===0?'key':'delta'}:value}}
  const {validateSegments}=loadModule('services/encoderPlan.ts',{
    mediabunny:{Input,BlobSource:class{},ALL_FORMATS:[],EncodedPacketSink:Sink},'./exportJob':lifecycle,
    './outputProfile':{},'./renderWorker':{},
  });
  return ()=>validateSegments([new Uint8Array([1])],{width:854,height:480,fps:30},[{frameStart:0,frameEnd:3}],{resources:new lifecycle.ExportResources()});
}
test('E04/V08: segment validation checks codec, keyframes and the complete presentation grid',async()=>{
  await segmentValidator()();
  await segmentValidator({},[0,2/30,1/30])(); // Presentation order may differ from decode order.
  for(const packets of [[0,0,2/30],[0,.01,2/30],[0,1/30,4/30]])
    await assert.rejects(segmentValidator({},packets)(),/timestamp|grid|frame/i);
  await assert.rejects(segmentValidator({codec:'vp09.00.10.08'})(),/codec|AVC|incompatib/i);
  await assert.rejects(segmentValidator({},[{timestamp:0,duration:1/30,type:'delta'},1/30,2/30])(),/key|independent/i);
});

test('V07: an actual required audio stream cannot be bypassed with a stale hasAudio flag',async()=>{
  const video={canDecode:async()=>true,computeFrameRateMetrics:async()=>({bestGuessFrameRate:30,frameRateIsConstant:true}),
    hasHighDynamicRange:async()=>false,getColorSpace:async()=>({}),getFirstTimestamp:async()=>0,computeDuration:async()=>1,getCodec:async()=> 'avc'};
  class Input {computeDuration=async()=>1;getPrimaryVideoTrack=async()=>video;getPrimaryAudioTrack=async()=>({
    canDecode:async()=>false,getFirstTimestamp:async()=>0,computeDuration:async()=>1,getCodec:async()=> 'unsupported',
  });dispose(){}}
  class VideoSamples {async *samplesAtTimestamps(){for(let i=0;i<2;i++)yield {displayWidth:160,displayHeight:90,rotation:0,pixelAspectRatio:{num:1,den:1},close(){}}}}
  const {probeAsset}=loadModule('services/mediaProbe.ts',{
    mediabunny:{Input,BlobSource:class{},ALL_FORMATS:[],VideoSampleSink:VideoSamples},'@mediabunny/ac3':{registerAc3Decoder(){}},
    './timeline':loadModule('services/timeline.ts'),'./mixing':{trackGain:()=>1},
  });
  const clip={id:'clip',sourceId:'source',name:'source',type:'video',mimeType:'video/mp4',duration:1,originalDuration:1,trimStart:0,trimEnd:0,hasAudio:false,muted:false};
  await assert.rejects(probeAsset(clip,new Blob(['bytes'],{type:'video/mp4'})),/Unsupported audio codec/);
});

test('E05: conflicting host receipt fields cannot become successful delivery',async()=>{
  for(const response of [{accepted:false,outcome:'host-accepted'},{accepted:false,outcome:'download-started'},{accepted:true,outcome:'failed'}]){
    const {deliverVideo}=loadDelivery({Flow:{save:async()=>response},isHostedFlow:()=>true});
    await assert.rejects(deliverVideo({base64:'AQ==',mimeType:'video/mp4',name:'video.mp4'}),error=>['unknown','rejected'].includes(error.category));
  }
});

test('V07: observed audio metadata keeps immutable edits and source leases authoritative',async()=>{
  let closed=0;
  class Input {getAudioTracks=()=>new Promise(()=>{});dispose(){closed++}}
  const {sourceHasAudio,resolveSourceAudio}=loadModule('services/sourceAudio.ts',{mediabunny:{Input,BlobSource:class{},ALL_FORMATS:[]}});
  const controller=new AbortController(),pending=sourceHasAudio(new Blob(['data']),controller.signal);
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(closed,1);
  const clip=Object.freeze({id:'clip',sourceId:'source',type:'video',hasAudio:false,muted:true,gain:.25});
  const original={mediaAssets:[clip],audioTracks:[]};
  const checked=resolveSourceAudio(original,[{id:'clip',sourceId:'source',kind:'video',audio:{}}]);
  assert.equal(checked.mediaAssets[0].hasAudio,true);assert.equal(checked.mediaAssets[0].muted,true);assert.equal(checked.mediaAssets[0].gain,.25);
  assert.equal(clip.hasAudio,false);assert(Object.isFrozen(checked.mediaAssets[0]));
  assert.throws(()=>resolveSourceAudio(original,[]),/Missing source audio inventory/);
});

test('E05: copying an old structured log cannot create a fresh running heartbeat',()=>{
  const now=Date.now(),jobId='00000000-0000-4000-8000-000000000001',buildId='a'.repeat(64)+':production';
  const event=at=>'EXPORT EVENT '+JSON.stringify({schemaVersion:1,type:'started',jobId,buildId,at:new Date(at).toISOString()});
  assert.equal(exportStatus(event(now-60000),{mtimeMs:now,nowMs:now}).verdict,'UNKNOWN');
  assert.equal(exportStatus(event(now-1000),{mtimeMs:now-60000,nowMs:now}).verdict,'RUNNING');
  assert.equal(exportStatus('EXPORT STARTED',{mtimeMs:now,nowMs:now}).verdict,'RUNNING');
});

test('E05: an unobserved external handoff is unknown rather than confirmed cancellation',async()=>{
  let leases=0;
  const store={acquireAll:()=>{leases++;return[{sourceId:'source',release(){leases--}}]},bytesFor:()=>new Blob(['original'])};
  const jobs=new lifecycle.ExportJobs(store,async(_,context)=>{
    context.phase('saving');context.beginDelivery();await context.resources.wait(new Promise(()=>{}));
    return {delivery:'host-accepted',videoBytes:1};
  },{},'a'.repeat(64)+':test');
  const pending=jobs.start({mediaAssets:[{id:'clip',sourceId:'source'}],audioTracks:[],aspectRatio:'16:9',fitMode:'contain',exportQuality:'draft',totalDuration:1});
  jobs.dispose();await pending;
  assert.equal(jobs.getSnapshot().phase,'failed');assert.equal(jobs.getSnapshot().failure.deliveryMayHaveStarted,true);
  assert.equal(jobs.getSnapshot().events.at(-1).type,'unknown');assert.equal(leases,0);
});

test('E05: a cleanup-complete unknown save report remains unknown in MCP',()=>{
  const report={schemaVersion:1,jobId:'00000000-0000-4000-8000-000000000001',buildId:'a'.repeat(64)+':test',
    phase:'failed',outcome:'unknown',cleanupComplete:true,updatedAt:new Date().toISOString()};
  assert.equal(reportStatus(report).verdict,'UNKNOWN');
  assert.equal(reportStatus({...report,cleanupComplete:false}).verdict,'FAILED');
});

test('E05: a confirmed receipt survives failure while releasing the mux owner',async()=>{
  const store={acquireAll:()=>[{sourceId:'source',release(){}}],bytesFor:()=>new Blob(['original'])};
  const jobs=new lifecycle.ExportJobs(store,async(_,context)=>{
    const release=context.resources.own(()=>{throw new Error('cleanup failed after receipt')});
    try{context.phase('saving');context.beginDelivery();context.event('host-accepted',{bytes:100});return {delivery:'host-accepted',videoBytes:100}}
    finally{await release()}
  });
  await jobs.start({mediaAssets:[{id:'clip',sourceId:'source'}],audioTracks:[],aspectRatio:'16:9',fitMode:'contain',exportQuality:'draft',totalDuration:1});
  assert.equal(jobs.getSnapshot().phase,'failed');assert.equal(jobs.getSnapshot().cleanupComplete,false);
  assert.deepEqual(jobs.getSnapshot().result,{delivery:'host-accepted',videoBytes:100});
  assert.equal(jobs.getSnapshot().failure.category,'cleanup');
  assert.equal(jobs.getSnapshot().events.at(-1).detail.category,'cleanup');
  const interrupted=new lifecycle.ExportJobs(store,async(_,context)=>{
    context.phase('saving');context.beginDelivery();context.event('host-accepted',{bytes:100});await context.resources.wait(new Promise(()=>{}));
    return {delivery:'host-accepted',videoBytes:100};
  });
  const pending=interrupted.start({mediaAssets:[{id:'clip',sourceId:'source'}],audioTracks:[],aspectRatio:'16:9',fitMode:'contain',exportQuality:'draft',totalDuration:1});
  interrupted.dispose();await pending;
  assert.equal(interrupted.getSnapshot().phase,'failed');assert.equal(interrupted.getSnapshot().result.delivery,'host-accepted');
  assert.equal(interrupted.getSnapshot().events.at(-1).type,'failed');
});
