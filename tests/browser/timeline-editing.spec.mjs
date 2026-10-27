import {test,expect} from './harness.mjs';
import {readFile} from 'node:fs/promises';
import {asset,draft,openProbe} from './fixtures.mjs';
import {openEditor,loadDraft,saveDraft} from './helpers.mjs';

async function time(page,name,value){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill(String(value));await input.press('Enter')}
async function seek(page,value){await page.getByRole('slider',{name:'Playhead time',exact:true}).evaluate((input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}))},value)}
async function addAudio(page,names=['narration.wav']){const buffer=await readFile('tests/fixtures/tone-impulses.wav');await page.locator('input[accept="audio/*"]').setInputFiles(names.map(name=>({name,mimeType:'audio/wav',buffer})));await expect(page.locator('[data-audio-track]')).toHaveCount(names.length)}

test('photo duration, clip ordering and keyboard trims remain reversible source-preserving edits',async({page})=>{
  await openEditor(page);const photo=await asset('landscape-red.png'),video=await asset('bars-fractional-av.mp4',{id:'video',startTime:1});
  await loadDraft(page,draft([photo,video]));await page.getByRole('button',{name:'Edit landscape-red.png',exact:true}).click();
  await time(page,'Photo duration (seconds)',2);
  const field=page.getByRole('spinbutton',{name:'Photo duration (seconds)',exact:true});await field.fill('0');await field.press('Enter');await expect(page.getByRole('alert')).toContainText('Enter a time');await field.press('Escape');await expect(field).toHaveValue('2');
  await page.getByRole('button',{name:'Later',exact:true}).click();
  let saved=await saveDraft(page);expect(saved.mediaAssets.map(item=>item.id)).toEqual(['video',photo.id]);expect(saved.mediaAssets[1].startTime).toBe(1);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await page.getByRole('button',{name:'Undo',exact:true}).click();
  saved=await saveDraft(page);expect(saved.mediaAssets[0].duration).toBe(1);expect(saved.mediaAssets[1].startTime).toBe(1);
  await page.getByRole('button',{name:'Redo',exact:true}).click();await page.getByRole('button',{name:'Redo',exact:true}).click();
  await page.getByRole('button',{name:'Edit bars-fractional-av.mp4',exact:true}).click();
  await page.getByRole('slider',{name:/^Trim from start/}).press('ArrowRight');await page.getByRole('slider',{name:/^Trim from end/}).press('ArrowRight');
  saved=await saveDraft(page);expect(saved.mediaAssets[0].duration).toBeCloseTo(.9,8);expect(saved.mediaAssets[1].startTime).toBeCloseTo(.9,8);expect(saved.mediaAssets[1].duration).toBe(2);
  expect(saved.mediaAssets[1].base64).toBe(photo.base64);expect(saved.mediaAssets[0].base64).toBe(video.base64);
});

test('narration move, source trims and gain survive undo, recovery and reopen with matching preview and AAC',async({page,context},info)=>{
  await page.addInitScript(()=>{const Native=window.Audio;window.editAudio=[];window.Audio=function(...args){const audio=new Native(...args);window.editAudio.push(audio);return audio};window.Audio.prototype=Native.prototype});
  await openEditor(page);await loadDraft(page,draft([await asset('landscape-red.png',{duration:1.5,originalDuration:1.5})]));
  await addAudio(page,['narration.wav','other.wav']);await page.getByRole('slider',{name:'Volume for audio 2: other.wav',exact:true}).fill('0');
  await page.getByRole('button',{name:'Edit audio 1',exact:true}).click();await page.getByRole('button',{name:'Close audio settings',exact:true}).click();await expect(page.getByRole('button',{name:'Edit audio 1',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Edit audio 1: narration.wav',exact:true}).click();await expect(page.getByRole('button',{name:'Close audio settings',exact:true})).toBeFocused();
  await time(page,'Audio start time (seconds)',.5);await time(page,'Audio trim from start (seconds)',.2);await time(page,'Audio trim from end (seconds)',.4);await page.getByRole('slider',{name:/^Audio volume/}).fill('50');
  let saved=await saveDraft(page);const selected=saved.audioTracks[0];expect(selected.startTime).toBe(.5);expect(selected.duration).toBeCloseTo(.4,8);expect(selected).toMatchObject({originalDuration:1,trimStart:.2,trimEnd:.4,gain:.5});
  const originalInventory=await page.evaluate(()=>window.__clipbraidE2E.mediaInventory().sources.map(item=>item.sha256).sort());expect(originalInventory).toHaveLength(2);
  for(let index=0;index<4;index++)await page.getByRole('button',{name:'Undo',exact:true}).click();
  const undone=(await saveDraft(page)).audioTracks[0];expect(undone).toMatchObject({startTime:0,duration:1,trimStart:0,trimEnd:0});expect(undone.gain).toBeUndefined();
  for(let index=0;index<4;index++)await page.getByRole('button',{name:'Redo',exact:true}).click();
  await seek(page,.65);await expect.poll(()=>page.evaluate(()=>window.editAudio.filter(audio=>audio.getAttribute('src')&&audio.volume>.0).map(audio=>({time:audio.currentTime,volume:audio.volume})))).toEqual([{time:.35,volume:.5}]);
  saved=await saveDraft(page);expect(saved.schemaVersion).toBe(3);expect(saved.audioTracks[0].base64).toBe((await readFile('tests/fixtures/tone-impulses.wav')).toString('base64'));
  await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Start editing',exact:true}).click();await page.getByRole('button',{name:'Restore local revision',exact:true}).click();await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
  expect(await saveDraft(page)).toEqual(saved);await loadDraft(page,saved);expect(await saveDraft(page)).toEqual(saved);
  expect(await page.evaluate(()=>window.__clipbraidE2E.mediaInventory().sources.map(item=>item.sha256).sort())).toEqual(originalInventory);
  await page.getByRole('button',{name:'draft',exact:true}).click();const ready=page.waitForEvent('download');await page.getByRole('button',{name:'Export video',exact:true}).click();const download=await ready;expect(await download.failure()).toBeNull();
  const path=info.outputPath('trimmed-narration.mp4');await download.saveAs(path);const bytes=await readFile(path),probe=await openProbe(context);
  const measured=await probe.evaluate(async base64=>{
    const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0)),pcm=await new OfflineAudioContext(1,44100,44100).decodeAudioData(bytes.buffer.slice(0));
    const rms=(from,to)=>{const values=pcm.getChannelData(0).slice(Math.round(from*pcm.sampleRate),Math.round(to*pcm.sampleRate));return Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length)};
    const runtime=window.testRuntime.media,input=new runtime.Input({source:new runtime.BlobSource(new Blob([bytes])),formats:runtime.ALL_FORMATS});
    try{return {duration:await input.computeDuration(),tone:rms(.54,.65),before:rms(.25,.4),after:rms(1.05,1.2)}}finally{input.dispose()}
  },bytes.toString('base64'));
  expect(measured.duration).toBeGreaterThanOrEqual(1.49);expect(measured.duration).toBeLessThan(1.54);expect(Math.abs(measured.tone-.1/Math.sqrt(2))).toBeLessThan(.012);expect(measured.before).toBeLessThan(.003);expect(measured.after).toBeLessThan(.003);
  await info.attach('narration-preview-export',{body:JSON.stringify({selected:saved.audioTracks[0],measured}),contentType:'application/json'});
});

test('format 2 local revisions upgrade without activating unknown trims and older storage readers reject version 3',async({context})=>{
  const page=await openProbe(context);
  const result=await page.evaluate(async()=>{
    const {RecoveryStore,MediaSourceStore}=window.testRuntime,name='audio-migration-'+crypto.randomUUID();
    const media=new MediaSourceStore(),[source]=await media.stage([{bytes:new Blob(['immutable audio']),mimeType:'audio/wav'}]);media.pin(source.sourceId);
    const track={id:'voice',mediaId:'voice',sourceId:source.sourceId,mimeType:'audio/wav',name:'Voice',startTime:2,duration:1,originalDuration:3,trimStart:1,trimEnd:1};
    const snapshot={mediaAssets:[],audioTracks:[track],aspectRatio:'16:9',fitMode:'contain',transitionDuration:0,currentTime:2},ui={exportQuality:'draft',zoom:40,showSafeZones:false,isTheaterMode:false};
    const old=new RecoveryStore(name,2);await old.latest();await old.commit(snapshot,[source],ui);old.close();
    await new Promise((resolve,reject)=>{const open=indexedDB.open(name,2);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('revisions','readwrite'),store=tx.objectStore('revisions'),get=store.get(1);get.onsuccess=()=>store.put({...get.result,formatVersion:2});tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}});
    const next=new RecoveryStore(name),migrated=await next.latest();const legacy=migrated.record.snapshot.audioTracks[0];
    await next.commit({...snapshot,audioTracks:[{...track,originalDuration:1,trimStart:.2,trimEnd:.4,duration:.4}]},[source],ui);const current=await next.latest();next.close();
    const downlevel=new RecoveryStore(name,2);let rejected=false;try{await downlevel.latest()}catch{rejected=true}finally{downlevel.close();media.clear()}
    return {legacy,current:current.record.snapshot.audioTracks[0],format:current.record.formatVersion,rejected,source:migrated.sources[0].sha256===source.sha256};
  });
  expect(result.legacy).toMatchObject({startTime:2,duration:1});expect(result.legacy.trimStart).toBeUndefined();expect(result.current).toMatchObject({trimStart:.2,trimEnd:.4,duration:.4});expect(result.format).toBe(3);expect(result.rejected).toBe(true);expect(result.source).toBe(true);
});

test('audio keyboard, mouse and touch movement use one reversible gesture and cancel without edits',async({page},info)=>{
  await openEditor(page);await loadDraft(page,draft([await asset('landscape-red.png',{duration:4,originalDuration:4})]));await addAudio(page);
  const block=page.getByRole('button',{name:'Edit audio 1: narration.wav',exact:true});await block.focus();await block.press('ArrowRight');await block.press('Shift+ArrowRight');expect((await saveDraft(page)).audioTracks[0].startTime).toBe(1.1);
  await block.press('Home');await block.focus();await page.keyboard.down('ArrowRight');await page.keyboard.down('ArrowRight');await page.keyboard.down('ArrowRight');await page.keyboard.up('ArrowRight');expect((await saveDraft(page)).audioTracks[0].startTime).toBe(.3);
  await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await saveDraft(page)).audioTracks[0].startTime).toBe(0);await page.getByRole('button',{name:'Redo',exact:true}).click();
  await block.scrollIntoViewIfNeeded();let box=await block.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2,{steps:8});await page.mouse.up();expect((await saveDraft(page)).audioTracks[0].startTime).toBe(1.3);
  await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await saveDraft(page)).audioTracks[0].startTime).toBe(.3);
  await page.setViewportSize({width:390,height:844});const session=await page.context().newCDPSession(page);await session.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await block.scrollIntoViewIfNeeded();box=await block.boundingBox();
  const x=box.x+box.width/2,y=box.y+box.height/2;
  const touch=async(type,dx=0)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x:x+dx,y,id:1}]});
  await touch('touchStart');await touch('touchMove',40);await touch('touchEnd');expect((await saveDraft(page)).audioTracks[0].startTime).toBe(1.3);
  await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await saveDraft(page)).audioTracks[0].startTime).toBe(.3);
  await block.scrollIntoViewIfNeeded();box=await block.boundingBox();
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,id:2}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width/2+40,y:box.y+box.height/2,id:2}]});await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  expect((await saveDraft(page)).audioTracks[0].startTime).toBe(.3);await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await saveDraft(page)).audioTracks[0].startTime).toBe(0);
  await block.click();await expect(page.getByRole('spinbutton',{name:'Audio start time (seconds)',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('mobile-audio-settings.png'),fullPage:true});
});

test('an audio trim beyond actual source samples fails preflight with no omitted soundtrack',async({page})=>{
  const audio={id:'bad-window',mediaId:'audio',name:'out-of-range.wav',mimeType:'audio/wav',base64:(await readFile('tests/fixtures/tone-impulses.wav')).toString('base64'),startTime:0,duration:1.5,originalDuration:3,trimStart:1.5,trimEnd:0};
  await openEditor(page);await loadDraft(page,{...draft([await asset('landscape-red.png')],[audio]),schemaVersion:3});await page.getByRole('button',{name:'draft',exact:true}).click();let downloads=0;page.on('download',()=>downloads++);await page.getByRole('button',{name:'Export video',exact:true}).click();await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();await expect(page.locator('.export-message')).toContainText('Selected audio interval');expect(downloads).toBe(0);
});
