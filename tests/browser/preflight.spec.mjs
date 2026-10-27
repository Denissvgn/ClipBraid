import { test, expect } from "./harness.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
import { readFile } from "node:fs/promises";
test("preflight identifies a failing asset and forbids omission or out-of-source edits", async ({ page }) => {
  await openEditor(page); let downloads = 0; page.on("download", () => downloads++);
  for (const bad of [await asset("corrupt.mp4", { id: "bad", name: "broken clip" }),
    await asset("bars-fractional-av.mp4", { id: "range", name: "outside source", duration: 2, originalDuration: 2 })]) {
    await loadDraft(page, draft([await asset("landscape-red.png"), bad]));
    await page.getByRole("button", { name: "Export video", exact: true }).click();
    await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();
    await expect(page.locator(".export-message")).toContainText(bad.name);
    expect(downloads).toBe(0);
  }
});
test("actual inventories permit muted and silent video and record source timing", async ({ page }, info) => {
  await openEditor(page);
  const silent = await asset("silent-video.mp4", { hasAudio: true, sourceFps: 24 });
  await loadDraft(page, draft([silent]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  expect(await (await ready).failure()).toBeNull();
  await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
  const inventory = await page.evaluate(() => window.__clipbraidE2E.exportState().phaseResults.find(result => result.phase === "preparing").assets);
  expect(inventory[0].video).toMatchObject({ width: 160, height: 90, fps: 24, firstTimestamp: 0 });
  expect(inventory[0].audio).toBeUndefined();
  await info.attach("asset-inventory", { body: JSON.stringify(inventory), contentType: "application/json" });
});

test("actual source audio presence corrects stale project flags and mix headroom",async({page,context})=>{
  await openEditor(page);const probe=await openProbe(context);
  for(const [file,flag,audible] of [["bars-fractional-av.mp4",false,true],["silent-video.mp4",true,false]]){
    const tracks=audible?[]:[{id:"soundtrack",mediaId:"tone",name:"tone.wav",mimeType:"audio/wav",
      base64:(await readFile("tests/fixtures/tone-impulses.wav")).toString("base64"),startTime:0,duration:1}];
    await loadDraft(page,draft([await asset(file,{hasAudio:flag})],tracks));
    expect((await saveDraft(page)).mediaAssets[0].hasAudio).toBe(audible);
    await page.getByRole("button",{name:"draft",exact:true}).click();
    const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();
    const stream=await(await ready).createReadStream(),parts=[];for await(const part of stream)parts.push(part);
    const rms=await probe.evaluate(async base64=>{
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const audio=await new OfflineAudioContext(1,44100,44100).decodeAudioData(bytes.buffer);
      const pcm=audio.getChannelData(0).slice(.24*44100,.36*44100);
      return Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length);
    },Buffer.concat(parts).toString("base64"));
    expect(rms).toBeGreaterThan(audible?.05:.12);
    await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeEnabled();
  }
});
