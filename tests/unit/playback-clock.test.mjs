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
  // The running audio context retains the elapsed time spent waiting for video.
  remove();step(.2);assert(Math.abs(clock.getTime()-10.4)<1e-9);
});

test('frame-constrained presentation cannot rewind or hold the audio transport',async()=>{
  const {clock,context,step}=setup();let frame={time:0,duration:1/30};
  clock.registerVideo('clip',{start:0,end:3,sourceStart:0,frame:()=>frame,reset:()=>{frame=null}});
  await clock.play();step(.2);
  assert(clock.getTime()<.04);
  assert.equal(clock.getAudioTime(),context.currentTime);
  for(let read=0;read<20;read++)clock.getTime();
  assert.equal(clock.getAudioTime(),.2);
  frame={time:.3,duration:1/30};assert(clock.getTime()>=.285);
  assert.equal(clock.getAudioTime(),.2,'A leading video frame cannot advance soundtrack time either.');
  step(.2);assert.equal(clock.getAudioTime(),.4);
  clock.dispose();
});

test('the audio transport preserves explicit pause, resume, seek and duration bounds',async()=>{
  const {clock,context,step}=setup();await clock.play();step(1);
  assert.equal(clock.getAudioTime(),1);clock.pause();context.currentTime+=5;
  assert.equal(clock.getAudioTime(),1);await clock.play();step(.25);
  assert.equal(clock.getAudioTime(),1.25);clock.seek(20);step(.5);
  assert.equal(clock.getAudioTime(),20.5);clock.setDuration(20);
  assert.equal(clock.getAudioTime(),20);assert.equal(clock.getSnapshot().playing,false);
  clock.dispose();
});

test('successful source exhaustion releases the final frame tail without jumping across the cut',async()=>{
  const {clock,step}=setup();clock.seek(9.9);
  let ended=false,nextFrame={time:0,duration:1/30};
  clock.registerVideo('first',{start:0,end:10,sourceStart:0,
    frame:()=>({time:9.9,duration:1/30}),ended:()=>ended,reset:()=>{ended=false}});
  clock.registerVideo('next',{start:10,end:20,sourceStart:0,frame:()=>nextFrame,reset:()=>{}});
  await clock.play();step(.05);
  const waiting=clock.getTime();assert(waiting>9.93&&waiting<9.95);
  ended=true;step(.02);
  const released=clock.getTime();assert(released>waiting&&released<10);
  assert(Math.abs(released-9.97)<1e-9,'Completion must retain the elapsed audio clock phase.');
  nextFrame={time:.05,duration:1/30};step(.1);
  assert(Math.abs(clock.getTime()-10.07)<1e-9);
  assert.equal(clock.getSnapshot().playing,true);
  clock.dispose();
});

test('an uncompleted final frame remains a real playback constraint',async()=>{
  const {clock,step}=setup();clock.seek(9.9);
  clock.registerVideo('waiting',{start:0,end:10,sourceStart:0,
    frame:()=>({time:9.9,duration:1/30}),ended:()=>false,reset:()=>{}});
  await clock.play();step(.2);const waiting=clock.getTime();
  step(.5);assert.equal(clock.getTime(),waiting);
  assert(waiting<10,'A stale frame must not be treated as successful source exhaustion.');
  clock.dispose();
});

test('a terminal source without a presented frame cannot bypass visual readiness',async()=>{
  const {clock,step}=setup();clock.seek(10);
  clock.registerVideo('unpresented',{start:10,end:20,sourceStart:0,
    frame:()=>null,ended:()=>true,reset:()=>{}});
  await clock.play();step(.2);assert.equal(clock.getTime(),10);
  step(.5);assert.equal(clock.getTime(),10);
  clock.dispose();
});

test('seeking resets exhausted-source coverage before requesting another frame',async()=>{
  const {clock,step}=setup();clock.seek(9.9);
  let frame={time:9.9,duration:1/30},ended=true,resets=0;
  clock.registerVideo('clip',{start:0,end:10,sourceStart:0,frame:()=>frame,ended:()=>ended,
    reset:()=>{frame=null;ended=false;resets++}});
  await clock.play();step(.1);
  clock.seek(5);assert.equal(resets,1);assert.equal(ended,false);assert.equal(frame,null);
  step(.2);assert.equal(clock.getTime(),5);
  frame={time:5,duration:1/30};step(.02);
  assert(clock.getTime()>5&&clock.getTime()<5.04);
  clock.dispose();
});

test('seventeen crossfaded clips finish before a longer soundtrack ends the project',async()=>{
  const {recalculateMediaStartTimes,projectDuration}=loadModule('services/timeline.ts');
  const clips=recalculateMediaStartTimes(Array.from({length:17},(_,index)=>({id:`clip-${index}`,duration:10})),.5);
  const audio=[{startTime:0,duration:165}];
  const visualEnd=clips.at(-1).startTime+clips.at(-1).duration;
  assert.equal(visualEnd,162);assert.equal(projectDuration(clips,audio),165);
  const {clock,context,step}=setup();clock.setDuration(projectDuration(clips,audio));
  const states=clips.map(clip=>({clip,frame:{time:0,duration:1/30},ended:false,startedAt:null}));
  for(const state of states)clock.registerVideo(state.clip.id,{
    start:state.clip.startTime,end:state.clip.startTime+state.clip.duration,sourceStart:0,
    frame:()=>state.frame,ended:()=>state.ended,
    reset:()=>{state.frame=null;state.ended=false;state.startedAt=null},
  });
  await clock.play();const visited=new Set();let audioOnly=false;
  for(let tick=0;tick<180*60&&clock.getSnapshot().playing;tick++){
    const timeline=clock.getTime();
    for(const state of states){
      const local=timeline-state.clip.startTime;
      if(local<0||local>=state.clip.duration)continue;
      visited.add(state.clip.id);
      state.startedAt??=context.currentTime-local;
      const nativeTime=context.currentTime-state.startedAt;
      // Native playback continues to EOF even while transport waits for a frame.
      // The final interval deliberately undercovers the declared clip duration.
      state.frame={time:Math.min(9.9,Math.floor(nativeTime*30)/30),duration:1/30};
      state.ended=nativeTime>=9.95;
    }
    if(timeline>visualEnd+.1&&timeline<165)audioOnly=true;
    step(1/60);
  }
  assert.equal(visited.size,17,'Every clip must become active before the project ends.');
  assert.equal(audioOnly,true,'The soundtrack tail must retain a running transport.');
  assert.equal(clock.getTime(),165);
  assert.equal(clock.getSnapshot().playing,false);
  assert.equal(clock.getSnapshot().error,null);
  clock.dispose();
});

test('normal frame cadence does not discard elapsed audio time at successive frame gates',async()=>{
  const {clock,context,step}=setup();let frame={time:0,duration:1/24};
  clock.registerVideo('clip',{start:0,end:20,sourceStart:0,frame:()=>frame,reset:()=>{frame=null}});
  await clock.play();
  for(let tick=0;tick<10*60;tick++){
    frame={time:Math.floor(context.currentTime*24)/24,duration:1/24};
    step(1/60);
  }
  assert(Math.abs(clock.getTime()-context.currentTime)<=1/24+.005,
    'Waiting for successive presented frames must not accumulate an audio-clock phase loss.');
  assert.equal(clock.getSnapshot().playing,true);assert.equal(clock.getSnapshot().error,null);
  clock.dispose();
});
