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
