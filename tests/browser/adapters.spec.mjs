import {test,expect} from "./harness.mjs";
import {asset,draft,openProbe} from "./fixtures.mjs";
import {openEditor,loadDraft,saveDraft} from "./helpers.mjs";
test("picker cancellation removes temporary controls and invalid host media preserves the project",async({page})=>{
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));const before=await saveDraft(page);
  const ready=page.waitForEvent("filechooser");await page.getByRole("button",{name:"Add visuals",exact:true}).click();await(await ready).setFiles([]);
  await expect(page.locator('[data-platform-picker]')).toHaveCount(0);
  expect(await saveDraft(page)).toEqual(before);
  await page.evaluate(()=>{window.Flow={media:{select:async()=>({mimeType:"application/octet-stream",type:"image",name:"bad.bin",base64:"AQ=="})}}});
  await page.getByRole("button",{name:"Add visuals",exact:true}).click();
  await expect(page.locator('[data-media-category="unsupported"]')).toContainText("Action unavailable here.");
  await expect(page.locator('[data-media-category="unsupported"] details p')).not.toBeVisible();
  await page.evaluate(()=>{delete window.Flow});expect(await saveDraft(page)).toEqual(before);
});
async function syntheticMicrophone(page){
  await page.addInitScript(()=>{
    window.captureMode="normal";window.capturedTracks=[];
    const make=()=>{const context=new AudioContext(),oscillator=context.createOscillator(),destination=context.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();
      const track=destination.stream.getTracks()[0],stop=track.stop.bind(track);let ended=false;track.stop=()=>{if(ended)return;ended=true;stop();oscillator.stop();void context.close()};window.capturedTracks.push(track);return destination.stream};
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
      if(window.captureMode==="denied")throw new DOMException("Microphone denied","NotAllowedError");
      if(window.captureMode==="pending")return new Promise(resolve=>{window.resolveCapture=()=>resolve(make())});return make();
    }});
  });
}
test("native recorder stop uses actual media duration and cancel/denial/error stop every track",async({page})=>{
  await syntheticMicrophone(page);await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByText("Record voice-over",{exact:true}).click();await page.getByRole("button",{name:"Start recording",exact:true}).click();
  await expect(page.getByRole("button",{name:"Stop recording and keep audio",exact:true})).toBeVisible();await page.waitForTimeout(450);
  await page.getByRole("button",{name:"Stop recording and keep audio",exact:true}).click();await expect(page.locator('[data-audio-track]')).toHaveCount(1);
  const recorded=(await saveDraft(page)).audioTracks[0];expect(recorded.duration).toBeGreaterThan(.1);expect(recorded.duration).toBeLessThan(2);
  expect(await page.evaluate(()=>window.capturedTracks.every(track=>track.readyState==="ended"))).toBe(true);
  await page.getByRole("button",{name:"Start recording",exact:true}).click();await page.waitForTimeout(100);await page.getByRole("button",{name:"Cancel recording",exact:true}).click();
  await expect(page.locator('[data-editor-status="RECORD CANCELLED"]')).toBeVisible();await expect(page.locator('[data-audio-track]')).toHaveCount(1);
  await page.evaluate(()=>{window.captureMode="denied"});await page.getByRole("button",{name:"Start recording",exact:true}).click();await expect(page.locator('[data-media-category="denied"]')).toContainText("Access needed.");
  await page.evaluate(()=>{window.captureMode="normal";const Native=MediaRecorder;window.MediaRecorder=class extends Native{start(...args){super.start(...args);setTimeout(()=>this.dispatchEvent(new Event("error")),50)}}});
  await page.getByRole("button",{name:"Start recording",exact:true}).click();await expect(page.locator('[data-editor-status="RECORD ERROR"]')).toBeVisible();
  expect(await page.evaluate(()=>window.capturedTracks.every(track=>track.readyState==="ended"))).toBe(true);
});
test("late microphone permission after cancellation stops tracks without committing audio",async({page})=>{
  await syntheticMicrophone(page);await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.evaluate(()=>{window.captureMode="pending"});await page.getByText("Record voice-over",{exact:true}).click();await page.getByRole("button",{name:"Start recording",exact:true}).click();
  await page.getByRole("button",{name:"Cancel recording",exact:true}).click();await expect(page.locator('[data-editor-status="RECORD CANCELLED"]')).toBeVisible();
  await page.evaluate(()=>window.resolveCapture());await expect.poll(()=>page.evaluate(()=>window.capturedTracks.every(track=>track.readyState==="ended"))).toBe(true);
  await expect(page.locator('[data-audio-track]')).toHaveCount(0);
});
test("Flow rejects unsupported recording contracts and invalid download acknowledgements",async({context})=>{
  const page=await openProbe(context);
  const result=await page.evaluate(async()=>{
    const adapter=window.testRuntime.platform;window.Flow={microphone:{record:async()=>{throw new Error("must not call")}},download:async()=>({success:true})};
    const categories=[];try{await adapter.microphone.record({durationMs:1000})}catch(error){categories.push(error.category)}
    try{await adapter.download({base64:"AQ==",mimeType:"application/json",filename:"project.json"})}catch(error){categories.push(error.category)}
    return categories;
  });expect(result).toEqual(["unsupported","unknown"]);
});
test("Flow recording measures actual bytes and awaits a cancellation acknowledgement",async({context})=>{
  const page=await openProbe(context);
  const tone=(await import("node:fs/promises")).readFile;
  const base64=(await tone("tests/fixtures/tone-impulses.wav")).toString("base64");
  const result=await page.evaluate(async base64=>{
    const adapter=window.testRuntime.platform;let calls=0;
    window.Flow={microphone:{record:async()=>({base64,mimeType:"audio/wav",durationMs:9000}),cancel:async()=>{calls++;return true},stop:async()=>true}};
    const actual=await adapter.microphone.record({durationMs:2000});
    window.Flow.microphone.record=()=>new Promise(()=>{});
    const controller=new AbortController(),pending=adapter.microphone.record({durationMs:1000,signal:controller.signal});controller.abort();
    let category;try{await pending}catch(error){category=error.category}
    return {duration:actual.durationMs,calls,category};
  },base64);
  expect(result.duration).toBeCloseTo(1000,0);expect(result.calls).toBe(1);expect(result.category).toBe("cancelled");
});
for(const action of ["cancel","replace"])test(`recording ${action} during source staging cannot commit a late track`,async({page})=>{
  await syntheticMicrophone(page);
  await page.addInitScript(()=>{
    const digest=crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest=(...args)=>{
      if(window.holdRecordingHash&&new Uint8Array(args[1])[0]!==0x89){
        window.holdRecordingHash=false;return new Promise(resolve=>{window.releaseRecordingHash=()=>digest(...args).then(resolve)});
      }
      return digest(...args);
    };
  });
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByText("Record voice-over",{exact:true}).click();await page.getByRole("button",{name:"Start recording",exact:true}).click();
  await expect(page.getByRole("button",{name:"Stop recording and keep audio",exact:true})).toBeVisible();await page.waitForTimeout(200);
  await page.evaluate(()=>{window.holdRecordingHash=true});await page.getByRole("button",{name:"Stop recording and keep audio",exact:true}).click();
  await page.waitForFunction(()=>window.releaseRecordingHash);
  if(action==="cancel")await page.getByRole("button",{name:"Cancel recording",exact:true}).click();
  else await loadDraft(page,draft([await asset("portrait-blue.png",{name:"Replacement during recording"})]));
  await page.evaluate(()=>window.releaseRecordingHash());await page.evaluate(()=>window.__clipbraidE2E.projectWorkIdle());
  await expect(page.locator("[data-audio-track]")).toHaveCount(0);
  expect(await page.evaluate(()=>window.__clipbraidE2E.mediaInventory().sources.length)).toBe(1);
  if(action==="cancel")await expect(page.locator('[data-editor-status="RECORD CANCELLED"]')).toBeVisible();
  else await expect(page.getByRole("button",{name:"Edit Replacement during recording",exact:true})).toBeVisible();
});
