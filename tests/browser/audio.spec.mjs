import { test, expect } from "./harness.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";

test("short trim offsets and explicit small seeks synchronize both preview owners",async({page},info)=>{
  await page.addInitScript(()=>{
    window.previewSeeks=[];const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"currentTime");
    Object.defineProperty(HTMLMediaElement.prototype,"currentTime",{configurable:true,get:time.get,set(value){window.previewSeeks.push({kind:this.tagName,value});return time.set.call(this,value)}});
  });
  await openEditor(page);await loadDraft(page,draft([await asset("bars-fractional-av.mp4",{duration:.9,trimStart:.05,trimEnd:.05})]));
  await page.locator("video").first().evaluate(video=>video.readyState>=1?undefined:new Promise(resolve=>video.addEventListener("loadedmetadata",resolve,{once:true})));
  await page.evaluate(()=>{window.previewSeeks=[]});
  await page.getByRole("button",{name:"Play preview",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.previewSeeks.some(point=>point.kind==="AUDIO"&&Math.abs(point.value-.05)<1e-6))).toBe(true);
  await page.evaluate(()=>{window.previewSeeks=[]});
  await page.getByRole("slider",{name:"Playhead time",exact:true}).evaluate(input=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"0.02");input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  for(const kind of ["AUDIO","VIDEO"])await expect.poll(()=>page.evaluate(kind=>window.previewSeeks.some(point=>point.kind===kind&&Math.abs(point.value-.07)<1e-6),kind)).toBe(true);
  await page.getByRole("button",{name:"Pause preview",exact:true}).click();
  const requested=await page.getByRole("slider",{name:"Playhead time",exact:true}).evaluate(input=>{
    const value=Math.min(.8,Number(input.value)+.01);window.previewSeeks=[];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,String(value));input.dispatchEvent(new Event("input",{bubbles:true}));return value+.05;
  });
  for(const kind of ["AUDIO","VIDEO"])await expect.poll(()=>page.evaluate(({kind,requested})=>window.previewSeeks.some(point=>point.kind===kind&&Math.abs(point.value-requested)<1e-6),{kind,requested})).toBe(true);
  await info.attach("explicit-preview-seeks",{body:JSON.stringify(await page.evaluate(()=>window.previewSeeks)),contentType:"application/json"});
});

test("preview audio does not restart an exhausted source inside a longer declared interval",async({context})=>{
  const page=await openProbe(context),source=await asset("bars-fractional-av.mp4");
  const result=await page.evaluate(async source=>{
    const {React,createRoot,AudioEngine}=window.testRuntime,NativeAudio=window.Audio;let audio,calls=0;
    window.Audio=function(...args){audio=new NativeAudio(...args);const play=audio.play.bind(audio);audio.play=()=>{calls++;return play()};return audio};window.Audio.prototype=NativeAudio.prototype;
    const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(source.base64),c=>c.charCodeAt(0))],{type:source.mimeType}));
    const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
    const props={mediaAssets:[],audioTracks:[{id:"track",sourceId:"source",duration:2,startTime:0}],sourceUrl:()=>url,currentTime:0,isPlaying:false};
    const render=async changes=>{Object.assign(props,changes);root.render(React.createElement(AudioEngine,props));await new Promise(resolve=>setTimeout(resolve,50))};
    try{
      await render({});if(audio.readyState<1)await new Promise(resolve=>audio.addEventListener("loadedmetadata",resolve,{once:true}));
      await render({currentTime:1.2,isPlaying:true,seekRevision:1});return {calls,paused:audio.paused};
    }finally{root.unmount();host.remove();URL.revokeObjectURL(url);window.Audio=NativeAudio}
  },source);
  expect(result).toEqual({calls:0,paused:true});
});

test("audio engine retries, rebinds and releases every playback lifecycle", async ({
  context,
}, info) => {
  await context.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.createdAudio = [];
    window.rejectAudioPlay = false;
    window.unhandledRejections = 0;
    window.Audio = function (...args) {
      const audio = new NativeAudio(...args);
      audio.releaseCount = 0;
      const load = audio.load;
      audio.load = function (...loadArgs) {
        audio.releaseCount++;
        return load.apply(audio, loadArgs);
      };
      window.createdAudio.push(audio);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.tagName === "AUDIO" && window.rejectAudioPlay)
        return Promise.reject(new Error("injected play rejection"));
      return play.apply(this, args);
    };
    window.addEventListener("unhandledrejection", (event) => {
      if (event.reason?.message === "injected play rejection")
        window.unhandledRejections++;
    });
  });
  const page = await openProbe(context);
  const clip = await asset("bars-fractional-av.mp4");
  const observations = await page.evaluate(async (clip) => {
    const { React, createRoot, AudioEngine } = window.testRuntime;
    const bytes = Uint8Array.from(atob(clip.base64), (c) => c.charCodeAt(0));
    const urls = [
      URL.createObjectURL(new Blob([bytes], { type: clip.mimeType })),
      URL.createObjectURL(new Blob([bytes], { type: clip.mimeType })),
    ];
    const media = {
      id: "clip",
      mediaId: "clip",
      sourceId: "source",
      mimeType: clip.mimeType,
      type: "video",
      name: "clip",
      duration: 1,
      originalDuration: 1,
      startTime: 0,
      trimStart: 0,
      trimEnd: 0,
      filter: "none",
      hasAudio: true,
      muted: false,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let mounted = true;
    let props = {
      audioTracks: [],
      mediaAssets: [media],
      sourceUrl: () => urls[0],
      currentTime: 0,
      isPlaying: false,
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const render = async (updates) => {
      props = { ...props, ...updates };
      root.render(React.createElement(AudioEngine, props));
      await settle();
    };
    const created = window.createdAudio;
    const last = () => created[created.length - 1];
    const audible = () =>
      created.filter((audio) => !audio.paused && !audio.muted && audio.volume > 0)
        .length;
    const result = {};
    try {
      await render({});
      window.rejectAudioPlay = true;
      await render({ isPlaying: true });
      result.rejected = {
        unhandled: window.unhandledRejections,
        audible: audible(),
      };
      window.rejectAudioPlay = false;
      await render({ isPlaying: false });
      await render({ isPlaying: true });
      result.played = audible();
      await render({ currentTime: 0.5 });
      result.seek = last().currentTime;
      const beforeMute = last();
      await render({ mediaAssets: [{ ...media, muted: true }] });
      result.mute = {
        paused: beforeMute.paused,
        releaseCount: beforeMute.releaseCount,
        src: beforeMute.getAttribute("src"),
        audible: audible(),
      };
      await render({ mediaAssets: [media] });
      result.unmuted = audible();
      const previous = last();
      await render({ sourceUrl: () => urls[1] });
      result.replacement = {
        previousPaused: previous.paused,
        currentIsNew: last() !== previous,
        currentUrl: last().src,
        expectedUrl: urls[1],
        audible: audible(),
      };
      await render({ mediaAssets: [] });
      result.deleted = {
        audible: audible(),
        allPaused: created.every((audio) => audio.paused),
      };
      await render({ mediaAssets: [media] });
      result.remounted = audible();
      const soundtrack = {
        id: "soundtrack",
        mediaId: "soundtrack",
        sourceId: "soundtrack-source",
        mimeType: "audio/wav",
        name: "soundtrack",
        startTime: 0,
        duration: 1,
      };
      await render({ audioTracks: [soundtrack] });
      result.layers = audible();
      await render({ mediaAssets: [{ ...media, muted: true }] });
      result.soundtrackOnly = audible();
      await render({ mediaAssets: [media] });
      result.restoredLayers = audible();
      root.unmount();
      mounted = false;
      await settle();
      result.teardown = {
        audible: audible(),
        allPaused: created.every((audio) => audio.paused),
        allDetached: created.every(
          (audio) => audio.getAttribute("src") === null,
        ),
      };
      result.created = created.length;
      return result;
    } finally {
      if (mounted) root.unmount();
      host.remove();
      urls.forEach((url) => URL.revokeObjectURL(url));
    }
  }, clip);
  await info.attach("audio-lifecycle", {
    body: JSON.stringify(observations),
    contentType: "application/json",
  });
  expect(observations.rejected).toEqual({ unhandled: 0, audible: 0 });
  expect(observations.played).toBe(1);
  expect(Math.abs(observations.seek - 0.5)).toBeLessThan(0.12);
  expect(observations.mute).toEqual({
    paused: true,
    releaseCount: 1,
    src: null,
    audible: 0,
  });
  expect(observations.unmuted).toBe(1);
  expect(observations.replacement).toEqual({
    previousPaused: true,
    currentIsNew: true,
    currentUrl: observations.replacement.expectedUrl,
    expectedUrl: observations.replacement.expectedUrl,
    audible: 1,
  });
  expect(observations.deleted).toEqual({ audible: 0, allPaused: true });
  expect(observations.remounted).toBe(1);
  expect(observations.layers).toBe(2);
  expect(observations.soundtrackOnly).toBe(1);
  expect(observations.restoredLayers).toBe(2);
  expect(observations.teardown).toEqual({
    audible: 0,
    allPaused: true,
    allDetached: true,
  });
});
