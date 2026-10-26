import { test, expect } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";
import { readFile } from "node:fs/promises";
test("the final selected frame keeps its valid source timestamp near a trim boundary",async({page},info)=>{
  await openEditor(page);await loadDraft(page,draft([await asset("rate-30.mp4",{id:"near-end",duration:.034,originalDuration:1,trimStart:.0334,trimEnd:.9326,sourceFps:30,hasAudio:false})]));
  await page.getByRole("button",{name:"draft",exact:true}).click();const ready=page.waitForEvent("download");
  await page.getByRole("button",{name:"Export video",exact:true}).click();expect(await(await ready).failure()).toBeNull();
  await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeEnabled();
  const requests=await page.evaluate(()=>window.__clipbraidE2E.exportState().diagnostics.filter(point=>point.operation==="decode-request"&&point.clipId==="near-end").sort((a,b)=>a.timelineTime-b.timelineTime));
  expect(requests).toHaveLength(2);expect(requests[1].sourceTime).toBeCloseTo(.0334+1/30,9);
  await info.attach("near-end-source-requests",{body:JSON.stringify(requests),contentType:"application/json"});
});
test("short projects end on their frame grid without a one-second black tail",async({page},info)=>{
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png",{duration:.25,originalDuration:.25})]));
  await expect(page.getByRole("slider",{name:"Playhead time",exact:true})).toHaveAttribute("max","0.25");
  await page.getByRole("button",{name:"draft",exact:true}).click();const ready=page.waitForEvent("download");
  await page.getByRole("button",{name:"Export video",exact:true}).click();const received=await ready,path=info.outputPath("short.mp4");
  await received.saveAs(path);expect(await received.failure()).toBeNull();
  const metadata=JSON.parse(execFileSync("ffprobe",["-v","error","-show_streams","-show_format","-of","json",path],{encoding:"utf8"}));
  const video=metadata.streams.find(stream=>stream.codec_type==="video");expect(Number(video.nb_frames)).toBe(8);
  expect(Number(metadata.format.duration)).toBeLessThan(.35);expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(.25);
  await info.attach("short-project-duration",{body:JSON.stringify(metadata),contentType:"application/json"});
});
test("preview and encoded output reveal a still-active clip after its short overlay ends",async({page},info)=>{
  await openEditor(page);await loadDraft(page,draft([
    await asset("landscape-red.png",{id:"background",duration:2,originalDuration:2}),
    await asset("portrait-blue.png",{id:"overlay",startTime:.25,duration:.5,originalDuration:.5,transitionDuration:.25}),
  ]));
  await page.getByRole("slider",{name:"Playhead time",exact:true}).evaluate(input=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"1");input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  await page.locator(".preview-frame img").first().evaluate(image=>image.decode());
  const screenshot=await page.locator(".preview-frame").screenshot();
  const preview=await page.evaluate(async encoded=>{
    const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),value=>value.charCodeAt(0))],{type:"image/png"}));
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext("2d");ctx.drawImage(bitmap,0,0);bitmap.close();
    return [...ctx.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data];
  },screenshot.toString("base64"));
  expect(preview[0]).toBeGreaterThan(220);expect(preview[1]).toBeLessThan(30);expect(preview[2]).toBeLessThan(30);
  await page.getByRole("button",{name:"draft",exact:true}).click();const ready=page.waitForEvent("download");
  await page.getByRole("button",{name:"Export video",exact:true}).click();const received=await ready,path=info.outputPath("overlay-return.mp4");
  await received.saveAs(path);expect(await received.failure()).toBeNull();
  const pixel=[...execFileSync("ffmpeg",["-v","error","-ss","1","-i",path,"-frames:v","1","-vf","format=rgb24,crop=1:1:427:240","-f","rawvideo","pipe:1"])];
  expect(pixel[0]).toBeGreaterThan(220);expect(pixel[1]).toBeLessThan(30);expect(pixel[2]).toBeLessThan(30);
  await info.attach("overlay-return-pixels",{body:JSON.stringify({preview,encoded:pixel}),contentType:"application/json"});
});
test("profile frame counts, rational rates and framing survive real encoding", async ({ page, context }, info) => {
  test.setTimeout(120_000); await openEditor(page);
  const evidence = [];
  for (const file of ["rate-23976.mp4", "rate-24.mp4", "rate-2997.mp4", "rate-30.mp4", "rate-60.mp4", "vfr.mp4", "sar-wide.mp4", "rotated-av.mp4", "portrait-blue.png"]) {
    await loadDraft(page, draft([await asset(file, { filter: file.endsWith(".png") ? "grayscale" : "none", hasAudio: false })]));
    await page.getByRole("button", { name: "draft", exact: true }).click();
    const ready = page.waitForEvent("download"); await page.getByRole("button", { name: "Export video", exact: true }).click();
    const received = await ready, path = info.outputPath(file + ".mp4"); await received.saveAs(path); expect(await received.failure()).toBeNull();
    await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
    const profile = await page.evaluate(() => window.__clipbraidE2E.exportState().phaseResults.find(result => result.profile)?.profile);
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
    const video = metadata.streams.find(stream => stream.codec_type === "video");
    expect(Number(video.nb_frames)).toBe(profile.frames);
    expect(Math.abs(Number(video.duration) - profile.duration)).toBeLessThan(1 / profile.fps);
    expect(video).toMatchObject({ width: 854, height: 480 });
    if (video.sample_aspect_ratio && video.sample_aspect_ratio !== "N/A") expect(video.sample_aspect_ratio).toBe("1:1");
    if (file === "rate-60.mp4") expect(profile.fps).toBe(30);
    if (["portrait-blue.png", "sar-wide.mp4", "rotated-av.mp4"].includes(file)) {
      const probe = await openProbe(context), bytes = await readFile(path);
      const pixel = await probe.evaluate(async base64 => {
        const m = window.testRuntime.media, input = new m.Input({ source: new m.BlobSource(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))])), formats: m.ALL_FORMATS });
        try { const sample = await new m.VideoSampleSink(await input.getPrimaryVideoTrack()).getSample(0.3), canvas = new OffscreenCanvas(854,480), ctx = canvas.getContext("2d"); sample.draw(ctx,0,0,854,480); const result = { center: [...ctx.getImageData(427,240,1,1).data], top: [...ctx.getImageData(427,30,1,1).data], left: [...ctx.getImageData(10,240,1,1).data], par: sample.pixelAspectRatio };sample.close();return result; } finally { input.dispose(); }
      }, bytes.toString("base64"));
      expect(pixel.par).toEqual({ num: 1, den: 1 });
      if (file === "portrait-blue.png") expect(Math.max(...pixel.center.slice(0,3)) - Math.min(...pixel.center.slice(0,3))).toBeLessThan(5);
      if (file === "sar-wide.mp4") expect(Math.max(...pixel.top.slice(0,3))).toBeLessThan(10);
      else expect(Math.max(...pixel.left.slice(0,3))).toBeLessThan(10);
      await probe.close();
    }
    evidence.push({ file, profile, stream: video, duration: metadata.format.duration });
  }
  await info.attach("fidelity-matrix", { body: JSON.stringify(evidence), contentType: "application/json" });
});
