import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadModule} from '../source-probes.mjs';
const {mp3Timing}=loadModule('services/mp3Timing.ts');
function tagged({version=3,mono=false,flags=1,encoder='LAME',id3=0}={}) {
  const rate=48000/(version===3?1:version===2?2:4),bitrate=version===3?64:40;
  const size=Math.floor((version===3?144000:72000)*bitrate/rate),prefix=id3?10+id3:0;
  const bytes=new Uint8Array(prefix+size*21),view=new DataView(bytes.buffer);
  if(id3){bytes.set([73,68,51,4,0,0]);for(let i=0;i<4;i++)bytes[6+i]=(id3>>(21-7*i))&127}
  bytes.set([255,224+(version<<3)+3,84,mono?192:0],prefix);
  const marker=prefix+4+(version===3?(mono?17:32):(mono?9:17));
  bytes.set(new TextEncoder().encode('Info'),marker);view.setUint32(marker+4,flags);
  let cursor=marker+8;
  for(const [flag,length] of [[1,4],[2,4],[4,100],[8,4]])if(flags&flag){if(flag===1)view.setUint32(cursor,20);cursor+=length}
  bytes.set(new TextEncoder().encode(encoder),cursor);
  const value=(576<<12)|832;bytes.set([value>>16,(value>>8)&255,value&255],cursor+21);
  return new Blob([bytes]);
}
test('tagged MP3 duration and priming match native gapless playback metadata',async()=>{
  const result=await mp3Timing(new Blob([await readFile('tests/fixtures/gapless-pulses.mp3')]));
  assert.equal(result.sampleRate,48000);assert.equal(result.delaySamples,1105);assert.equal(result.duration,6);
});
test('MP3 timing respects optional Xing fields, version/channel layouts and large ID3 tags',async()=>{
  for(const options of [{flags:15},{version:2,mono:true},{version:0,mono:true},{id3:128*1024}]){
    const blob=tagged(options),reads=[];
    const result=await mp3Timing({size:blob.size,slice(start,end){reads.push(end-start);return blob.slice(start,end)}});
    assert.equal(result.delaySamples,1105);assert.equal(result.paddingSamples,303);
    assert(reads.every(length=>length<=4096));
  }
});
test('unknown, truncated, malformed and non-MP3 headers never invent a delay',async()=>{
  assert.equal(await mp3Timing(tagged({encoder:'test'})),null);
  for(const bytes of [[],[255,251],[73,68,51,4,0,0,128,0,0,0],Array(100).fill(0)])assert.equal(await mp3Timing(new Blob([new Uint8Array(bytes)])),null);
  const blob=tagged(),truncated=blob.slice(0,50);assert.equal(await mp3Timing(truncated),null);
});
