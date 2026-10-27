import { test, expect } from "./harness.mjs";
import { expression } from "../source-probes.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
import { readFile } from "node:fs/promises";

test("preview and decoded mixes share track volumes and overlap headroom", async ({ context }, info) => {
  await context.addInitScript(() => {
    const NativeAudio = window.Audio; window.mixAudioElements = [];
    window.Audio = function (...args) { const audio = new NativeAudio(...args); window.mixAudioElements.push(audio); return audio; };
    window.Audio.prototype = NativeAudio.prototype;
  });
  const page = await openProbe(context);
  const result = await page.evaluate(async ({ mix, wav }) => {
    const runtime = window.testRuntime;
    const buffer = new AudioBuffer({ length: 48000, numberOfChannels: 1, sampleRate: 48000 });
    buffer.getChannelData(0).fill(0.75);
    const blob = new Blob([new Function(wav)()(buffer)], { type: "audio/wav" });
    const url = URL.createObjectURL(blob), host = document.createElement("div"); document.body.append(host);
    const root = runtime.createRoot(host);
    const observations = [];
    try {
      for (const secondGain of [1, 0.5, 0]) {
        const tracks = [1, secondGain].map((gain, index) => ({ id: `audio-${index}`, sourceId: `source-${index}`,
          mediaId: "tone", mimeType: "audio/wav", name: `Tone ${index}`, startTime: 0, duration: 1, gain }));
        root.render(runtime.React.createElement(runtime.AudioEngine, { audioTracks: tracks, mediaAssets: [], sourceUrl: () => url, currentTime: 0.2, isPlaying: false }));
        await new Promise(resolve => setTimeout(resolve, 60));
        const volumes = window.mixAudioElements.filter(audio => audio.getAttribute("src") !== null).map(audio => audio.volume);
        const scope = { ...runtime.media, ...runtime.timeline, ...runtime.audio, ...runtime.lifecycle, ...runtime.mixing,
          audioTracks: tracks, mediaAssets: [], totalDuration: 1, getBlob: async () => blob,
          audioBufferToWav: new Function(wav)() };
        const bytes = await new Function(...Object.keys(scope), mix)(...Object.values(scope))();
        const data = new DataView(bytes.buffer); let sum = 0, squares = 0, peak = 0, count = 0;
        for (let frame = 8820; frame < 35280; frame++) {
          const sample = data.getInt16(44 + frame * 4, true) / 32767;
          sum += sample; squares += sample * sample; peak = Math.max(peak, Math.abs(sample)); count++;
        }
        observations.push({ secondGain, volumes, mean: sum / count, rms: Math.sqrt(squares / count), peak });
      }
      return observations;
    } finally { root.unmount(); host.remove(); URL.revokeObjectURL(url); }
  }, { mix: expression("services/exportPipeline.ts", "mixAudio"), wav: expression("services/exportPipeline.ts", "audioBufferToWav") });
  await info.attach("mix-levels", { body: JSON.stringify(result), contentType: "application/json" });
  for (const [index, expected] of [[0, 0.75], [1, 0.5625], [2, 0.75]]) {
    expect(result[index].mean).toBeCloseTo(expected, 3);
    expect(result[index].rms).toBeCloseTo(expected, 3);
    expect(result[index].peak).toBeLessThanOrEqual(1);
  }
  expect(result.map(value => value.volumes)).toEqual([[0.5, 0.5], [0.5, 0.25], [1]]);
});

test("overload is explicit and lower volume survives save and local recovery before retry", async ({ page }) => {
  const frames = 8820, bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(44100 * 4, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write("data", 36); bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) bytes.writeFloatLE(1.5, 44 + i * 4);
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await page.locator('input[accept="audio/*"]').setInputFiles({ name: "overload.wav", mimeType: "audio/wav", buffer: bytes });
  await expect(page.locator('[data-audio-track]')).toHaveCount(1);
  await page.getByRole("button", { name: "draft", exact: true }).click();
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();
  await expect(page.locator(".export-message")).toContainText("exceeds full scale");
  await expect(page.locator(".export-message > p")).toContainText("audio mix");
  await expect(page.getByRole("button",{name:"Review audio levels",exact:true})).toBeVisible();
  expect(downloads).toBe(0);
  await page.getByRole("button", { name: "Review audio levels", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Volume for audio 1: overload.wav", exact: true })).toBeFocused();
  await page.getByRole("slider", { name: "Volume for audio 1: overload.wav", exact: true }).fill("50");
  const received = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  expect(await (await received).failure()).toBeNull();
  await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
  const saved = await saveDraft(page);
  expect(saved.schemaVersion).toBe(3); expect(saved.audioTracks[0].gain).toBe(0.5);
  await page.reload(); await page.getByRole("button", { name: "Start editing" }).click();
  await page.getByRole("button", { name: "Restore local revision", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Volume for audio 1: overload.wav", exact: true })).toHaveValue("50");
});

test("fractional adjacent audio intervals never sum at a shared cut sample", async ({ context }) => {
  const page = await openProbe(context);
  const peak = await page.evaluate(async ({ mix, wav }) => {
    const runtime = window.testRuntime;
    const buffer = new AudioBuffer({ length: 48000, numberOfChannels: 1, sampleRate: 48000 });
    buffer.getChannelData(0).fill(0.75);
    const blob = new Blob([new Function(wav)()(buffer)]);
    const scope = { ...runtime.media, ...runtime.timeline, ...runtime.audio, ...runtime.lifecycle, ...runtime.mixing,
      mediaAssets: [], audioTracks: [0, 0.1001].map(startTime => ({ sourceId: "pcm", name: "cut", startTime, duration: 0.1001 })),
      totalDuration: 0.25, getBlob: async () => blob, audioBufferToWav: new Function(wav)() };
    const bytes = await new Function(...Object.keys(scope), mix)(...Object.values(scope))();
    const data = new DataView(bytes.buffer); let peak = 0;
    for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(data.getInt16(i, true) / 32767));
    return peak;
  }, { mix: expression("services/exportPipeline.ts", "mixAudio"), wav: expression("services/exportPipeline.ts", "audioBufferToWav") });
  expect(peak).toBeLessThan(0.85);
});

test("configured overlapping gains survive real AAC encoding", async ({ page, context }, info) => {
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  const buffer = await readFile("tests/fixtures/tone-impulses.wav");
  await page.locator('input[accept="audio/*"]').setInputFiles([
    { name: "a.wav", mimeType: "audio/wav", buffer }, { name: "b.wav", mimeType: "audio/wav", buffer },
  ]);
  for (const name of ["Volume for audio 1: a.wav", "Volume for audio 2: b.wav"])
    await page.getByRole("slider", { name, exact: true }).fill("50");
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const download = await ready; await download.saveAs(info.outputPath("balanced-audio.mp4"));
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(info.outputPath("balanced-audio.mp4")), probe = await openProbe(context);
  const rms = await probe.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const decoded = await new OfflineAudioContext(1, 44100, 44100).decodeAudioData(bytes.buffer);
    const pcm = decoded.getChannelData(0).slice(0.24 * 44100, 0.36 * 44100);
    return Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
  }, bytes.toString("base64"));
  expect(Math.abs(rms - 0.1 / Math.sqrt(2))).toBeLessThan(0.01);
  await info.attach("encoded-mix-level", { body: JSON.stringify({ expectedRms: 0.1 / Math.sqrt(2), actualRms: rms }), contentType: "application/json" });
});
