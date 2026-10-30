import {test,expect} from './harness.mjs';
import {openEditor,loadDraft} from './helpers.mjs';
import {asset,draft} from './fixtures.mjs';
for(const kind of ['AUDIO','VIDEO'])test(`a rejected ${kind.toLowerCase()} start is visible and pauses the shared transport`,async({page})=>{
  await page.addInitScript(kind=>{const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){if(this.tagName===kind)return Promise.reject(new Error('injected playback rejection'));return play.apply(this,args)}},kind);
  await openEditor(page);await loadDraft(page,draft([await asset('sync-markers.mp4',{duration:3,originalDuration:3})]));
  await page.getByRole('button',{name:'Play preview',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(/playback|play|preview/i);
  await expect(page.getByRole('button',{name:'Play preview',exact:true})).toBeVisible();
  const time=Number(await page.getByRole('slider',{name:'Playhead time',exact:true}).inputValue());await page.waitForTimeout(200);
  expect(Number(await page.getByRole('slider',{name:'Playhead time',exact:true}).inputValue())).toBe(time);
});
test('audio-clock start failure is recoverable',async({page})=>{
  await page.addInitScript(()=>{const Native=window.AudioContext;window.rejectClock=true;window.AudioContext=class extends Native{resume(){return window.rejectClock?Promise.reject(new Error('injected clock permission')):super.resume()}}});
  await openEditor(page);await loadDraft(page,draft([await asset('landscape-red.png',{duration:4,originalDuration:4})]));
  await page.getByRole('button',{name:'Play preview',exact:true}).click();await expect(page.getByRole('alert')).toContainText('permission');
  await page.evaluate(()=>{window.rejectClock=false});await page.getByRole('button',{name:'Play preview',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause preview',exact:true})).toBeVisible();await page.getByRole('button',{name:'Pause preview',exact:true}).click();
});
test('hidden-page handling preserves pause until an explicit resume',async({page})=>{
  await openEditor(page);await loadDraft(page,draft([await asset('sync-markers.mp4',{duration:3,originalDuration:3})]));
  await page.getByRole('button',{name:'Play preview',exact:true}).click();await expect(page.getByRole('button',{name:'Pause preview',exact:true})).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
  await expect(page.getByText('Preview paused while the page was hidden. Press Play when you return.',{exact:true})).toBeVisible();
  const time=await page.getByRole('slider',{name:'Playhead time',exact:true}).inputValue();await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});await page.waitForTimeout(200);
  expect(await page.getByRole('slider',{name:'Playhead time',exact:true}).inputValue()).toBe(time);await expect(page.getByRole('button',{name:'Play preview',exact:true})).toBeVisible();
});
test('a missing required video frame visibly stops playback instead of running the clock ahead',async({page})=>{
  await page.addInitScript(()=>{HTMLVideoElement.prototype.requestVideoFrameCallback=()=>1;HTMLVideoElement.prototype.cancelVideoFrameCallback=()=>{}});
  await openEditor(page);await loadDraft(page,draft([await asset('sync-markers.mp4',{duration:3,originalDuration:3})]));
  await page.getByRole('button',{name:'Play preview',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Visual playback stalled');
  await expect(page.getByRole('button',{name:'Play preview',exact:true})).toBeVisible();
  expect(Number(await page.getByRole('slider',{name:'Playhead time',exact:true}).inputValue())).toBe(0);
});
test('only nearby native audio elements retain loaded sources',async({page})=>{
  await page.addInitScript(()=>{const Native=window.Audio;window.retainedAudio=[];window.Audio=function(...args){const audio=new Native(...args);window.retainedAudio.push(audio);return audio};window.Audio.prototype=Native.prototype});
  const clip=await asset('sync-markers.mp4',{duration:3,originalDuration:3,hasAudio:true});
  await openEditor(page);await loadDraft(page,draft(Array.from({length:20},(_,index)=>({...clip,id:'clip-'+index,startTime:3*index}))));
  await expect.poll(()=>page.evaluate(()=>window.retainedAudio.filter(audio=>audio.getAttribute('src')).length)).toBe(1);
  await page.getByRole('slider',{name:'Playhead time',exact:true}).evaluate(input=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'9');input.dispatchEvent(new Event('input',{bubbles:true}))});
  await expect.poll(()=>page.evaluate(()=>window.retainedAudio.filter(audio=>audio.getAttribute('src')).length)).toBe(2);
  expect(await page.evaluate(()=>window.retainedAudio[0].getAttribute('src'))).toBe(null);
});

function toneTrack(duration){
  const sampleRate=16000,frames=Math.round(sampleRate*duration),bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  for(let index=0;index<frames;index++)bytes.writeInt16LE(Math.round(.2*32767*Math.sin(2*Math.PI*440*index/sampleRate)),44+index*2);
  return {id:'soundtrack',mediaId:'soundtrack',name:'Continuous soundtrack',mimeType:'audio/wav',base64:bytes.toString('base64'),
    startTime:0,duration,originalDuration:duration,trimStart:0,trimEnd:0};
}

async function observeNativeSequence(page){
  await page.addInitScript(()=>{
    const NativeAudio=window.Audio,play=HTMLMediaElement.prototype.play;
    const observed=window.sequencePlayback={videos:[],audio:[],tail:[]};
    window.Audio=function(...args){const audio=new NativeAudio(...args);observed.audio.push(audio);return audio};
    window.Audio.prototype=NativeAudio.prototype;
    HTMLMediaElement.prototype.play=function(...args){
      if(this.tagName==='VIDEO'){
        if(!observed.videos.includes(this)){
          observed.videos.push(this);this.sequencePlayCalls=0;this.sequenceEndedEvents=0;
          this.addEventListener('ended',()=>{this.sequenceEndedEvents++});
        }
        this.sequencePlayCalls++;
      }
      return play.apply(this,args);
    };
    setInterval(()=>{
      const slider=document.querySelector('input[aria-label="Playhead time"]');
      const clock=window.__clipbraidE2E?.playbackClock(),time=clock?.time;
      const audio=observed.audio.find(element=>element.duration>=9.9);
      if(time>=9&&time<10&&audio)observed.tail.push({time,audioClockTime:clock.audioTime,
        uiTime:Number(slider?.value),audioTime:audio.currentTime,paused:audio.paused,ended:audio.ended});
    },50);
  });
}

async function shortPreviewClips(count){
  // A shorter native source models an accepted preview proxy while the
  // timeline retains its original duration, within the 100 ms proxy allowance.
  const clip=await asset('oversized-av.mp4',{duration:.58,originalDuration:.58,hasAudio:false,muted:true,
    sourceFps:30,sourceWidth:640,sourceHeight:360});
  return Array.from({length:count},(_,index)=>({...clip,id:`segment-${index+1}`,name:`segment ${index+1}`,
    startTime:index*.5,transitionDuration:index?.08:0}));
}

test('all seventeen clips traverse native EOF and retain soundtrack playback through the audio-only tail',async({page},info)=>{
  await observeNativeSequence(page);await openEditor(page);
  await loadDraft(page,{...draft(await shortPreviewClips(17),[toneTrack(10)]),transitionDuration:.08});
  const selected=page.getByRole('button',{name:'Edit segment 9',exact:true});await selected.click();
  await expect(selected).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Play preview',exact:true}).click();
  try{
    await expect.poll(()=>page.evaluate(()=>window.sequencePlayback.tail.some(sample=>!sample.paused&&!sample.ended&&Math.abs(sample.audioTime-sample.audioClockTime)<.2)),
      {timeout:25000,intervals:[50]}).toBe(true);
  }catch(error){
    const diagnostic=await page.evaluate(()=>({clock:window.__clipbraidE2E.playbackClock(),
      uiTime:Number(document.querySelector('input[aria-label="Playhead time"]').value),
      tail:window.sequencePlayback.tail.slice(-40),alert:document.querySelector('[role="alert"]')?.textContent,
      audio:window.sequencePlayback.audio.map(audio=>({time:audio.currentTime,duration:audio.duration,paused:audio.paused,ended:audio.ended,error:audio.error?.message})),
      videos:window.sequencePlayback.videos.map(video=>({time:video.currentTime,duration:video.duration,paused:video.paused,ended:video.ended,ready:video.readyState,plays:video.sequencePlayCalls,ends:video.sequenceEndedEvents,error:video.error?.message}))
    })).catch(captureError=>({captureError:String(captureError)}));
    console.log(JSON.stringify({nativeSequenceTailFailure:diagnostic}));
    await info.attach('native-sequence-tail-failure',{body:JSON.stringify(diagnostic),contentType:'application/json'});
    throw error;
  }
  await expect(page.getByRole('button',{name:'Play preview',exact:true})).toBeVisible({timeout:10000});
  await expect.poll(()=>page.evaluate(()=>window.sequencePlayback.audio.every(audio=>audio.paused))).toBe(true);
  const result=await page.evaluate(()=>({time:Number(document.querySelector('input[aria-label="Playhead time"]').value),
    videos:window.sequencePlayback.videos.map(video=>({playCalls:video.sequencePlayCalls,endedEvents:video.sequenceEndedEvents,error:video.error?.message??null})),
    tail:window.sequencePlayback.tail,audio:window.sequencePlayback.audio.map(audio=>({time:audio.currentTime,paused:audio.paused,error:audio.error?.message??null}))}));
  await info.attach('seventeen-clip-preview',{body:JSON.stringify(result),contentType:'application/json'});
  expect(result.videos).toHaveLength(17);
  expect(result.videos.every(video=>video.playCalls===1&&video.endedEvents===1&&video.error===null)).toBe(true);
  expect(result.time).toBe(10);
  expect(result.audio.every(audio=>audio.paused&&audio.error===null)).toBe(true);
  await expect(selected).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('seeking back into an exhausted mounted clip clears completion and traverses the next clip again',async({page},info)=>{
  await observeNativeSequence(page);await openEditor(page);
  await loadDraft(page,{...draft(await shortPreviewClips(2),[toneTrack(3)]),transitionDuration:.08});
  await page.getByRole('button',{name:'Play preview',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window.sequencePlayback.videos[0]?.sequenceEndedEvents===1)
    &&(window.sequencePlayback.videos[1]?.sequencePlayCalls>=1)),{intervals:[25]}).toBe(true);
  expect(await page.evaluate(()=>window.sequencePlayback.videos[0].isConnected)).toBe(true);
  const before=await page.evaluate(()=>({firstCalls:window.sequencePlayback.videos[0].sequencePlayCalls,
    secondEnded:window.sequencePlayback.videos[1].sequenceEndedEvents}));
  await page.getByRole('slider',{name:'Playhead time',exact:true}).evaluate(input=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'.2');input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await expect.poll(()=>page.evaluate(()=>window.sequencePlayback.videos[0].sequencePlayCalls),{intervals:[25]}).toBeGreaterThan(before.firstCalls);
  await expect.poll(()=>page.evaluate(()=>window.sequencePlayback.videos[0].sequenceEndedEvents),{intervals:[25]}).toBe(2);
  await expect.poll(()=>page.evaluate(()=>window.sequencePlayback.videos[1]?.sequencePlayCalls??0),{intervals:[25]}).toBe(2);
  await expect(page.getByRole('button',{name:'Play preview',exact:true})).toBeVisible({timeout:10000});
  const result=await page.evaluate(()=>({time:Number(document.querySelector('input[aria-label="Playhead time"]').value),
    videos:window.sequencePlayback.videos.map(video=>({playCalls:video.sequencePlayCalls,endedEvents:video.sequenceEndedEvents,error:video.error?.message??null}))}));
  await info.attach('replayed-native-source',{body:JSON.stringify({before,...result}),contentType:'application/json'});
  expect(result.time).toBe(3);expect(result.videos).toHaveLength(2);
  expect(result.videos.every(video=>video.playCalls===2&&video.error===null)).toBe(true);
  expect(result.videos[0].endedEvents).toBe(2);
  expect(result.videos[1].endedEvents).toBe(before.secondEnded+1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('delayed visual frame observations cannot rewind the soundtrack transport',async({page},info)=>{
  await observeNativeSequence(page);
  await page.addInitScript(()=>{
    const request=HTMLVideoElement.prototype.requestVideoFrameCallback;
    const cancel=HTMLVideoElement.prototype.cancelVideoFrameCallback;
    const pending=new WeakMap();
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){
      let timers=pending.get(this);if(!timers){timers=new Map();pending.set(this,timers)}
      const id=request.call(this,(now,metadata)=>{
        timers.set(id,setTimeout(()=>{timers.delete(id);callback(now,metadata)},500));
      });
      return id;
    };
    HTMLVideoElement.prototype.cancelVideoFrameCallback=function(id){
      const timers=pending.get(this);clearTimeout(timers?.get(id));timers?.delete(id);cancel.call(this,id);
    };
  });
  await openEditor(page);
  await loadDraft(page,draft([await asset('sync-markers.mp4',{duration:3,originalDuration:3,
    sourceFps:30,hasAudio:false,muted:true})],[toneTrack(3)]));
  await page.getByRole('button',{name:'Play preview',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__clipbraidE2E.playbackClock().audioTime),{intervals:[25]}).toBeGreaterThan(1.5);
  const result=await page.evaluate(()=>({clock:window.__clipbraidE2E.playbackClock(),
    audio:window.sequencePlayback.audio.find(audio=>audio.duration>=2.9)?.currentTime,
    playing:window.sequencePlayback.audio.some(audio=>!audio.paused)}));
  await info.attach('audio-transport-during-frame-delay',{body:JSON.stringify(result),contentType:'application/json'});
  expect(result.clock.audioTime-result.clock.time).toBeGreaterThan(.25);
  expect(result.playing).toBe(true);
  expect(Math.abs(result.audio-result.clock.audioTime)).toBeLessThan(.2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
