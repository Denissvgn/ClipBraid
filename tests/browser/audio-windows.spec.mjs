import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { expression } from "../source-probes.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";

test("real decoded PCM excludes impulses on both resampled trim edges", async ({ context }, info) => {
  const page = await openProbe(context);
  const results = await page.evaluate(async ({ tone, mix, wav }) => {
    const { media, timeline, audio } = window.testRuntime;
    const blob = new Blob([Uint8Array.from(atob(tone), c => c.charCodeAt(0))]);
    const results = [];
    // The fixture has one impulse at exactly 0.1 s. None of these selections owns it.
    // The fourth case also exercises the project format's duration/trim tolerance.
    for (const [start, end, standalone, duration] of [
      [0.05, 0.1, false, 0.05],
      [0.100005, 0.15, false, 0.049995],
      [0, 0.1, true, 0.1],
      [0.05, 0.1, false, 0.055],
    ]) {
      const clip = { name: "edge impulse", type: "video", hasAudio: true,
        sourceId: "tone", originalDuration: 1, trimStart: start,
        trimEnd: 1 - end, duration, startTime: 0.037 };
      const scope = {
        ...media, ...timeline, ...audio, ...window.testRuntime.lifecycle,
        mediaAssets: standalone ? [] : [clip],
        audioTracks: standalone ? [clip] : [], totalDuration: 0.3,
        getBlob: async () => blob,
        audioBufferToWav: new Function(wav)(),
      };
      const bytes = await new Function(...Object.keys(scope), mix)(...Object.values(scope))();
      const buffer = await new OfflineAudioContext(1, 13230, 44100).decodeAudioData(bytes.buffer);
      const pcm = buffer.getChannelData(0);
      results.push({ start, end, standalone, max: Math.max(...pcm.map(Math.abs)) });
    }
    return results;
  }, { tone: (await readFile("tests/fixtures/tone-impulses.wav")).toString("base64"),
    mix: expression("services/exportPipeline.ts", "mixAudio"), wav: expression("services/exportPipeline.ts", "audioBufferToWav") });
  await info.attach("resampled-trim-edges", { body: JSON.stringify(results), contentType: "application/json" });
  for (const result of results) expect(result.max).toBe(0);
});

test("real decoded sample windows preserve stereo, timestamp gaps and exact timeline bounds", async ({ context }, info) => {
  const page = await openProbe(context);
  const results = await page.evaluate(async ({ mix, wav }) => {
    const { media, timeline, audio } = window.testRuntime;
    const encodeWav = new Function(wav)();
    const results = [];
    for (const sampleRate of [44100, 48000, 96000]) {
      const input = new AudioBuffer({ numberOfChannels: 2, sampleRate, length: sampleRate / 5 });
      for (let channel = 0; channel < 2; channel++) {
        const pcm = input.getChannelData(channel);
        pcm.fill(0.9);
        pcm.fill(channel ? -0.125 : 0.25, sampleRate * 0.05, sampleRate * 0.1);
      }
      const blob = new Blob([encodeWav(input)]);
      for (const shift of [-0.02, 0, 0.025]) {
        class ShiftedSink extends media.AudioBufferSink {
          async *buffers(start, end) {
            for await (const chunk of super.buffers(start - shift, end - shift))
              yield { ...chunk, timestamp: chunk.timestamp + shift };
          }
        }
        const scope = { ...media, ...timeline, ...audio, ...window.testRuntime.lifecycle, decodeAudioInWorker: async (blob, start, end, resources, ...args) =>
            (await window.testRuntime.lifecycle.decodeAudioInWorker(blob, start - shift, end - shift, resources, ...args))
              .map(chunk => ({ ...chunk, timestamp: chunk.timestamp + shift })),
          mediaAssets: [{ name: "stereo", type: "video", hasAudio: true,
            sourceId: "pcm", originalDuration: 1, trimStart: 0.05 + shift,
            trimEnd: 0.9 - shift, duration: 0.05, startTime: 0.037 }],
          audioTracks: [], totalDuration: 0.3, getBlob: async () => blob,
          audioBufferToWav: encodeWav };
        const wav = await new Function(...Object.keys(scope), mix)(...Object.values(scope))();
        const rendered = await new OfflineAudioContext(2, 13230, 44100).decodeAudioData(wav.buffer);
        const channels = [0, 1].map(channel => {
          const pcm = rendered.getChannelData(channel);
          const max = (a, b) => Math.max(0, ...pcm.slice(a, b).map(Math.abs));
          const mid = pcm.slice(Math.ceil(0.047 * 44100), Math.floor(0.077 * 44100));
          return { before: max(0, Math.floor(0.037 * 44100) - 1),
            after: max(Math.ceil(0.087 * 44100) + 1, pcm.length),
            mean: mid.reduce((sum, x) => sum + x, 0) / mid.length,
            peak: max(0, pcm.length) };
        });
        results.push({ sampleRate, shift, channels });
      }
    }
    return results;
  }, { mix: expression("services/exportPipeline.ts", "mixAudio"), wav: expression("services/exportPipeline.ts", "audioBufferToWav") });
  await info.attach("decoded-sample-windows", { body: JSON.stringify(results), contentType: "application/json" });
  for (const result of results) {
    for (const [channel, values] of result.channels.entries()) {
      expect(values.before).toBe(0);
      expect(values.after).toBe(0);
      expect(values.mean).toBeCloseTo(channel ? -0.125 : 0.25, 3);
      expect(values.peak).toBeLessThan(channel ? 0.16 : 0.31);
    }
  }
});

test("a short selected audio range survives actual AAC encoding with codec padding allowed", async ({ page, context }, info) => {
  await openEditor(page);
  const clip = await asset("bars-fractional-av.mp4", {
    id: "trim", trimStart: 0.05, trimEnd: 0.9, duration: 0.05, startTime: 0.25,
  });
  await loadDraft(page, draft([await asset("landscape-red.png"), clip]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const download = await ready;
  await download.saveAs(info.outputPath("trimmed-aac.mp4"));
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(info.outputPath("trimmed-aac.mp4"));
  const probe = await openProbe(context);
  const result = await probe.evaluate(async base64 => {
    const { media } = window.testRuntime;
    const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]);
    const input = new media.Input({ source: new media.BlobSource(blob), formats: media.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      const decoded = await new OfflineAudioContext(1, 44100, 44100).decodeAudioData(await blob.arrayBuffer());
      const pcm = decoded.getChannelData(0);
      const rate = decoded.sampleRate;
      const rms = (a, b) => {
        const values = pcm.slice(Math.ceil(a * rate), Math.floor(b * rate));
        return Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
      };
      // Permit two AAC-LC frames for codec priming/filter spread around the cut.
      const padding = 2 * 1024 / rate;
      return { codec: await track.getCodec(), firstTimestamp: await track.getFirstTimestamp(),
        padding, active: rms(0.26, 0.29), before: rms(0.05, 0.25 - padding),
        after: rms(0.3 + padding, 0.8) };
    } finally { input.dispose(); }
  }, bytes.toString("base64"));
  await info.attach("encoded-aac-window", { body: JSON.stringify(result), contentType: "application/json" });
  expect(result.codec).toBe("aac");
  expect(result.active).toBeGreaterThan(0.04);
  expect(result.before).toBeLessThan(0.002);
  expect(result.after).toBeLessThan(0.002);
});

test("audio rendering stays in bounded native batches and drains a cancelled batch", async ({ context }, info) => {
  const page = await openProbe(context);
  const result = await page.evaluate(async ({ mix, wav }) => {
    const { media, timeline, audio, lifecycle } = window.testRuntime;
    const encode = new Function(wav)();
    const buffer = new AudioBuffer({ length: 5 * 48000, numberOfChannels: 1, sampleRate: 48000 });
    buffer.getChannelData(0).fill(0.25);
    const blob = new Blob([encode(buffer)]);
    const NativeContext = window.OfflineAudioContext;
    const lengths = []; let active = 0, cancel = false, resources;
    window.OfflineAudioContext = function (...args) {
      lengths.push(args[1]); active++;
      const native = new NativeContext(...args), render = native.startRendering.bind(native);
      native.startRendering = () => render().then(value => {
        active--;
        if (cancel) resources.abort();
        return value;
      });
      return native;
    };
    const scope = { ...media, ...timeline, ...audio, ...lifecycle, mediaAssets: [],
      audioTracks: [{ sourceId: "tone", name: "tone", startTime: 0, duration: 5 }],
      totalDuration: 5, getBlob: async () => blob, audioBufferToWav: encode };
    const fn = new Function(...Object.keys(scope), mix)(...Object.values(scope));
    try {
      const bytes = await fn();
      const samples = new DataView(bytes.buffer);
      const means = [1.99, 2, 3.99, 4].map(time => {
        let sum = 0;
        for (let i = 0; i < 100; i++) sum += samples.getInt16(44 + (Math.floor(time * 44100) + i) * 4, true) / 32767;
        return sum / 100;
      });
      const beforeCancel = lengths.length;
      cancel = true; resources = new lifecycle.ExportResources();
      let error;
      try { await fn(resources.signal, resources); } catch (cause) { error = cause.name; }
      await resources.close();
      return { lengths, means, active, owners: resources.size, error, cancelBatches: lengths.length - beforeCancel };
    } finally { window.OfflineAudioContext = NativeContext; }
  }, { mix: expression("services/exportPipeline.ts", "mixAudio"), wav: expression("services/exportPipeline.ts", "audioBufferToWav") });
  expect(Math.max(...result.lengths)).toBeLessThanOrEqual(88200);
  for (const mean of result.means) expect(mean).toBeCloseTo(0.25, 2);
  expect(result).toMatchObject({ active: 0, owners: 0, error: "AbortError", cancelBatches: 1 });
  await info.attach("bounded-audio", { body: JSON.stringify(result), contentType: "application/json" });
});
