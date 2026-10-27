import test from 'node:test';
import assert from 'node:assert/strict';
import {loadModule} from '../source-probes.mjs';
const {PlaybackClock}=loadModule('services/playbackClock.ts');
function setup(){
  const context={currentTime:0,state:'suspended',onstatechange:null,resume:async()=>{context.state='running'},suspend:async()=>{context.state='suspended'},close:async()=>{context.state='closed'}};
  let frame,id=0,stamp=0;const canceled=[];
  const clock=new PlaybackClock({context:()=>context,frame:callback=>{frame=callback;return ++id},cancel:value=>{canceled.push(value);frame=null}});
  clock.setDuration(30);
  return {clock,context,canceled,step(seconds){context.currentTime+=seconds;stamp+=seconds*1000;const callback=frame;frame=null;callback?.(stamp)}};
}
test('audio time owns transport across pause, resume, seek and end',async()=>{
  const {clock,context,step}=setup();await clock.play();step(1);assert.equal(clock.getTime(),1);
  clock.pause();context.currentTime+=10;assert.equal(clock.getTime(),1);await clock.play();step(.5);assert.equal(clock.getTime(),1.5);
  clock.seek(20);step(.5);assert.equal(clock.getTime(),20.5);clock.setDuration(20);assert.equal(clock.getSnapshot().playing,false);assert.equal(clock.getTime(),20);
});
test('pause cancels a pending resume and a late resolution cannot restart it',async()=>{
  const {clock,context}=setup();let resolve;context.resume=()=>new Promise(done=>{resolve=done});
  const started=clock.play();assert.equal(clock.getSnapshot().preparing,true);clock.pause();await started;context.state='running';resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(clock.getSnapshot().playing,false);assert.equal(context.state,'suspended');
});
test('context failure and interruption are visible and stop transport',async()=>{
  const {clock,context,step}=setup();context.resume=async()=>{throw new Error('denied')};await clock.play();assert.match(clock.getSnapshot().error,/denied/);assert.equal(clock.getSnapshot().playing,false);
  context.resume=async()=>{context.state='running'};await clock.play();context.state='interrupted';step(.1);assert.match(clock.getSnapshot().error,/interrupted/);assert.equal(clock.getSnapshot().playing,false);
});
test('frame publication is bounded and disposal releases its context',async()=>{
  const {clock,context,step}=setup();await clock.play();let changes=0;clock.subscribe(()=>changes++);
  for(let i=0;i<60;i++)step(1/60);assert(changes<=11);clock.dispose();await Promise.resolve();assert.equal(context.state,'closed');assert.equal(clock.getSnapshot().playing,false);
});
test('delivered frames bound lag and correct accumulated native-video lead',async()=>{
  const {clock,step}=setup();let frame={time:0,duration:1/30};
  clock.registerVideo('clip',{start:0,end:3,sourceStart:0,frame:()=>frame,reset:()=>{frame=null}});
  await clock.play();step(.2);assert(clock.getTime()<.04);
  frame={time:.3,duration:1/30};assert(clock.getTime()>=.285);
  clock.seek(1);assert.equal(frame,null);step(.2);assert.equal(clock.getTime(),1);
  frame={time:1,duration:1/30};step(.02);assert(clock.getTime()>=1);assert(clock.getTime()<1.04);
});
test('a seek before a future clip remains audio paced and removing it releases the visual constraint',async()=>{
  const {clock,step}=setup();const remove=clock.registerVideo('future',{start:10,end:12,sourceStart:1,frame:()=>null,reset:()=>{}});
  await clock.play();step(1);assert.equal(clock.getTime(),1);clock.seek(10);step(.2);assert.equal(clock.getTime(),10);
  remove();step(.2);assert(Math.abs(clock.getTime()-10.2)<1e-9);
});
