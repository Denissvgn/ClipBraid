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

test("pre-cancelled host actions never invoke external pickers, capture or saving",async({context})=>{
  const page=await openProbe(context);
  const result=await page.evaluate(async()=>{
    const calls=[];window.Flow={media:{select:async()=>{calls.push("picker");return null}},
      microphone:{record:async()=>{calls.push("record");return null},cancel:async()=>true,stop:async()=>true},
      save:async()=>{calls.push("save");return true}};
    const controller=new AbortController();controller.abort();
    for(const action of [()=>window.testRuntime.platform.media.select({filter:"all",signal:controller.signal}),
      ()=>window.testRuntime.platform.microphone.record({durationMs:1000,signal:controller.signal}),
      ()=>window.testRuntime.platform.save({base64:"AQ==",mimeType:"video/mp4",name:"clip.mp4",signal:controller.signal})])
      try{await action()}catch{}
    return calls;
  });expect(result).toEqual([]);
});

for(const mode of ["throws","missing-event"])test(`native recorder ${mode} at stop fails boundedly and stops its tracks`,async({context})=>{
  const page=await openProbe(context);
  const result=await page.evaluate(async mode=>{
    const nativeTimer=window.setTimeout.bind(window),Native=MediaRecorder;
    window.setTimeout=(callback,delay,...args)=>nativeTimer(callback,delay===5000?20:delay,...args);
    const audio=new AudioContext(),oscillator=audio.createOscillator(),destination=audio.createMediaStreamDestination();
    oscillator.connect(destination);oscillator.start();
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>destination.stream});
    let started;const ready=new Promise(resolve=>{started=resolve});
    window.MediaRecorder=class extends Native{
      start(...args){super.start(...args);started()}
      stop(){if(mode==="throws")throw new Error("injected recorder stop failure");super.stop();this.onstop=null}
    };
    const cancel=new AbortController(),stop=new AbortController();
    const pending=window.testRuntime.platform.microphone.record({durationMs:1000,signal:cancel.signal,stopSignal:stop.signal});
    try{
      await ready;stop.abort();
      const category=await Promise.race([pending.then(()=>"success",error=>error.category),new Promise(resolve=>nativeTimer(()=>resolve("still-running"),500))]);
      return {category,ended:destination.stream.getTracks().every(track=>track.readyState==="ended")};
    }finally{cancel.abort();await pending.catch(()=>{});destination.stream.getTracks().forEach(track=>track.stop());oscillator.stop();await audio.close();window.setTimeout=nativeTimer}
  },mode);
  expect(result).toEqual({category:"transport",ended:true});
});

test("host receipts bind the invoked adapter and preserve project-download uncertainty",async({context})=>{
  const page=await openProbe(context);
  const result=await page.evaluate(async()=>{
    const adapter=window.testRuntime.platform;
    window.Flow={save:async()=>{delete window.Flow;return true}};
    const receipt=await adapter.save({base64:"AQ==",mimeType:"video/mp4",name:"clip.mp4"});
    const errors=[];
    for(const download of [async()=>{throw new Error("host connection lost")},async()=>({accepted:false,outcome:"host-accepted"})]){
      window.Flow={download};try{await adapter.download({base64:"AQ==",mimeType:"application/json",filename:"project.json"})}
      catch(error){errors.push({category:error.category,uncertain:error.deliveryMayHaveStarted})}
    }
    return {receipt,errors};
  });
  expect(result).toEqual({receipt:{outcome:"host-accepted"},errors:[{category:"transport",uncertain:true},{category:"unknown",uncertain:true}]});
});

test("a rejected host early stop cancels capture and reports the control failure",async({context})=>{
  const page=await openProbe(context);
  const result=await page.evaluate(async()=>{
    const adapter=window.testRuntime.platform,results=[];
    for(const mode of ["throws","rejects","missing"]){
      let cancels=0;window.Flow={microphone:{record:()=>new Promise(()=>{}),cancel:async()=>{cancels++;return true},
        stop:async()=>{if(mode==="throws")throw new Error("host stop failed");return mode==="rejects"?false:undefined}}};
      const cancel=new AbortController(),stop=new AbortController();
      const pending=adapter.microphone.record({durationMs:1000,signal:cancel.signal,stopSignal:stop.signal});
      stop.abort();
      const category=await Promise.race([pending.then(()=>"success",error=>error.category),new Promise(resolve=>setTimeout(()=>resolve("still-running"),500))]);
      cancel.abort();await pending.catch(()=>{});results.push({mode,category,cancels});
    }
    return results;
  });
  expect(result).toEqual([{mode:"throws",category:"transport",cancels:1},{mode:"rejects",category:"rejected",cancels:1},{mode:"missing",category:"unknown",cancels:1}]);
});
