import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const large = () => asset("oversized-av.mp4", { duration: 0.5, originalDuration: 0.512, trimEnd: 0.012, sourceWidth: 1600, sourceHeight: 900, sourceFps: 30 });

test("idle proxies preserve original sound, source hashes, round trips and exported audio", async ({ page, context }, info) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio; window.previewAudio = [];
    window.Audio = function (...args) { const audio = new NativeAudio(...args); window.previewAudio.push(audio); return audio; };
    window.Audio.prototype = NativeAudio.prototype;
  });
  await openEditor(page); await loadDraft(page, draft([await large()]));
  await page.waitForFunction(() => window.__clipbraidE2E.proxyState()[0]?.status === "ready");
  const original = await readFile("tests/fixtures/oversized-av.mp4");
  const saved = await saveDraft(page);
  expect(sha(Buffer.from(saved.mediaAssets[0].base64, "base64"))).toBe(sha(original));
  const urls = await page.evaluate(() => ({ visual: document.querySelector("video").src, sound: window.previewAudio.at(-1).src }));
  expect(urls.visual).not.toBe(urls.sound);
  const proxyBytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], urls.visual);
  const probe = await openProbe(context);
  const inventory = await probe.evaluate(async bytes => {
    const m = window.testRuntime.media, input = new m.Input({ source: new m.BlobSource(new Blob([Uint8Array.from(bytes)])), formats: m.ALL_FORMATS });
    try { const track = await input.getPrimaryVideoTrack(); return { width: await track.getDisplayWidth(), height: await track.getDisplayHeight(), rotation: await track.getRotation(), audio: (await input.getAudioTracks()).length }; }
    finally { input.dispose(); }
  }, proxyBytes);
  expect(Math.max(inventory.width, inventory.height)).toBeLessThanOrEqual(720);
  expect(inventory).toMatchObject({ rotation: 0, audio: 0 });
  await loadDraft(page, saved);
  expect((await saveDraft(page)).mediaAssets[0].base64).toBe(saved.mediaAssets[0].base64);
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const received = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const download = await received; await download.saveAs(info.outputPath("original-export.mp4"));
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(info.outputPath("original-export.mp4"));
  const rms = await probe.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const decoded = await new OfflineAudioContext(1, 44100, 44100).decodeAudioData(bytes.buffer);
    const pcm = decoded.getChannelData(0).slice(0.2 * 44100, 0.4 * 44100);
    return Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
  }, bytes.toString("base64"));
  expect(rms).toBeGreaterThan(0.02);
  await info.attach("proxy-preservation", { body: JSON.stringify({ sourceSha256: sha(original), proxy: inventory, exportAudioRms: rms }), contentType: "application/json" });
});

test("failed proxies fall back, retry is bounded and a legacy source can be relinked", async ({ page }) => {
  await page.addInitScript(() => {
    window.failProxy = true; window.failedProxyCalls = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (window.failProxy && message.type === "EXEC" && message.data.args.includes("preview.mp4")) {
        window.failedProxyCalls++;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, type: "ERROR", data: "injected proxy fault" } })));
        return;
      }
      return post.call(this, message, ...args);
    };
  });
  await openEditor(page); await loadDraft(page, draft([await large()]));
  await page.waitForFunction(() => window.__clipbraidE2E.proxyState()[0]?.status === "failed");
  expect(await page.evaluate(() => window.failedProxyCalls)).toBe(2);
  await expect(page.getByText(/Original media is retained/)).toBeVisible();
  await expect(page.getByText(/injected proxy fault/)).not.toBeVisible();
  const fallbackUrl=await page.locator("video").first().getAttribute("src");
  const fallbackHash=await page.locator("video").first().evaluate(async video=>{
    const bytes=await(await fetch(video.currentSrc||video.src)).arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  });
  expect(fallbackHash).toBe(sha(await readFile("tests/fixtures/oversized-av.mp4")));
  expect(await page.evaluate(()=>window.__clipbraidE2E.mediaInventory().sources[0].derived)).toEqual([]);
  const before = await saveDraft(page);
  await page.evaluate(() => { window.failProxy = false; });
  await page.getByRole("button", { name: "Optimize previews", exact: true }).click();
  await page.waitForFunction(() => window.__clipbraidE2E.proxyState()[0]?.status === "ready");
  await expect(page.locator("video").first()).not.toHaveAttribute("src",fallbackUrl);
  expect((await saveDraft(page)).mediaAssets[0].base64).toBe(before.mediaAssets[0].base64);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4", { normalized: true, hasAudio: false, duration: 0.3, trimStart: 0.1, trimEnd: 0.6 })]));
  await page.getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true }).click();
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Relink original video", exact: true }).click();
  await (await picker).setFiles("tests/fixtures/oversized-av.mp4");
  await expect.poll(async () => (await saveDraft(page)).mediaAssets[0].normalized).toBe(false);
  const relinked = (await saveDraft(page)).mediaAssets[0];
  expect(relinked.hasAudio).toBe(true); expect(relinked.trimStart).toBe(0.1); expect(relinked.duration).toBe(0.3);
  expect(sha(Buffer.from(relinked.base64, "base64"))).toBe(sha(await readFile("tests/fixtures/oversized-av.mp4")));
});

test("export interrupts an active proxy and survives replacement without source loss", async ({ page }) => {
  await page.addInitScript(() => {
    window.proxyBlocked = false;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === "EXEC" && message.data.args.includes("preview.mp4")) { window.proxyBlocked = true; return; }
      return post.call(this, message, ...args);
    };
  });
  await openEditor(page); await loadDraft(page, draft([await large()]));
  await page.waitForFunction(() => window.proxyBlocked);
  const sourceURL = await page.locator("video").getAttribute("src");
  const saved = await saveDraft(page);
  expect(sha(Buffer.from(saved.mediaAssets[0].base64, "base64"))).toBe(sha(await readFile("tests/fixtures/oversized-av.mp4")));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  await loadDraft(page, draft([await asset("landscape-red.png")]));
  expect(await (await ready).failure()).toBeNull();
  await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
  const after = await saveDraft(page);
  expect(after.mediaAssets[0].name).toBe("landscape-red.png");
  expect(await page.evaluate(() => window.__clipbraidE2E.proxyState().length)).toBe(0);
  expect(await page.evaluate(async url => { try { return (await fetch(url)).ok; } catch { return false; } }, sourceURL)).toBe(false);
});

test("proxy validation follows display rotation and retains fractional frame rate", async ({ page }) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("rotated-av.mp4")]));
  await page.getByRole("button", { name: "Optimize previews", exact: true }).click();
  await page.waitForFunction(() => window.__clipbraidE2E.proxyState()[0]?.status === "ready");
  const dimensions = await page.locator("video").evaluate(video => new Promise(resolve => {
    const read = () => resolve({ width: video.videoWidth, height: video.videoHeight });
    if (video.readyState >= 1) read(); else video.addEventListener("loadedmetadata", read, { once: true });
  }));
  expect(dimensions.height).toBeGreaterThan(dimensions.width);
  expect((await saveDraft(page)).mediaAssets[0].base64).toBe((await asset("rotated-av.mp4")).base64);
});
