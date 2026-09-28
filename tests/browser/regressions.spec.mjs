import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { expression } from "../source-probes.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";

test("rejected malformed draft preserves the current source URL", async ({
  page,
}, info) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  const url = await page.locator("video").first().getAttribute("src");
  expect(await page.evaluate(async (url) => (await fetch(url)).ok, url)).toBe(
    true,
  );
  await page
    .locator('input[accept=".json"]')
    .setInputFiles("tests/fixtures/drafts/invalid-arrays.json");
  await expect(page.locator('[data-editor-status="LOAD ERROR"]')).toBeVisible();
  const fetchable = await page.evaluate(async (url) => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  }, url);
  await info.attach("observation", {
    body: JSON.stringify({ fetchable }),
    contentType: "application/json",
  });
  expect(fetchable).toBe(true);
});

test("one audible preview source per clip", async ({ page }, info) => {
  await page.addInitScript(() => {
    window.playedMedia = new Set();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.playedMedia.add(this);
      return play.apply(this, args);
    };
  });
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => [...window.playedMedia].filter((v) => !v.paused).length >= 1,
  );
  const sources = await page.evaluate(() =>
    [...window.playedMedia]
      .filter((v) => !v.paused && !v.muted && v.volume > 0)
      .map((v) => v.tagName),
  );
  await info.attach("sources", {
    body: JSON.stringify(sources),
    contentType: "application/json",
  });
  expect(sources).toHaveLength(1);
});

test("editor actions remain reachable at phone, tablet and laptop widths", async ({
  page,
}, info) => {
  await openEditor(page);
  const observations = [];
  for (const width of [320, 375, 390, 414, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    for (const name of [
      "Add visuals",
      "Add audio",
      "Export video",
      "Open project",
      "Save project",
    ]) {
      const box = await page
        .getByRole("button", { name, exact: true })
        .boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      observations.push({ width, name, box });
    }
    await page.locator(".timeline-heading").scrollIntoViewIfNeeded();
    const timelineBox = await page.locator(".timeline-heading").boundingBox();
    expect(timelineBox.y).toBeGreaterThanOrEqual(0);
    expect(timelineBox.y + timelineBox.height).toBeLessThanOrEqual(900);
  }
  await info.attach("responsive-actions", {
    body: JSON.stringify(observations),
    contentType: "application/json",
  });
});

test("mixed PCM ends at clip trim", async ({ context }, info) => {
  const page = await openProbe(context);
  const clip = await asset("bars-fractional-av.mp4", {
    trimStart: 0.105,
    duration: 0.103,
    trimEnd: 0.793,
  });
  const result = await page.evaluate(
    async ({ clip, mix, wav }) => {
      const { media } = window.testRuntime;
      const bytes = Uint8Array.from(atob(clip.base64), (c) => c.charCodeAt(0));
      clip.blobUrl = URL.createObjectURL(
        new Blob([bytes], { type: clip.mimeType }),
      );
      const scope = {
        ...media,
        mediaAssets: [clip],
        audioTracks: [],
        totalDuration: 1,
        getBlob: async (url) => (await fetch(url)).blob(),
        audioBufferToWav: new Function(wav)(),
      };
      const fn = new Function(...Object.keys(scope), mix)(
        ...Object.values(scope),
      );
      const out = await fn();
      const ctx = new OfflineAudioContext(1, 44100, 44100);
      const audio = await ctx.decodeAudioData(out.buffer);
      const pcm = audio.getChannelData(0);
      const rms = (a, b) =>
        Math.sqrt(
          pcm.slice(a * 44100, b * 44100).reduce((s, v) => s + v * v, 0) /
            Math.round((b - a) * 44100),
        );
      return { inside: rms(0.03, 0.07), after: rms(0.108, 0.12) };
    },
    {
      clip,
      mix: expression("App.tsx", "mixAudio"),
      wav: expression("App.tsx", "audioBufferToWav"),
    },
  );
  expect(result.inside).toBeGreaterThan(0.03);
  await info.attach("audio-windows", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(result.after).toBeLessThan(0.001);
});

test("fractional fps, rotation, PCM windows and corrupt formats use real probes", async ({
  context,
}) => {
  const page = await openProbe(context);
  const inputs = await Promise.all(
    [
      "bars-fractional-av.mp4",
      "rotated-av.mp4",
      "corrupt.mp4",
      "unsupported.bin",
      "tone-impulses.wav",
    ].map(async (name) => ({
      name,
      base64: (await readFile(`tests/fixtures/${name}`)).toString("base64"),
    })),
  );
  const results = await page.evaluate(async (inputs) => {
    const m = window.testRuntime.media;
    const results = [];
    for (const item of inputs) {
      const bytes = Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0));
      const input = new m.Input({
        source: new m.BlobSource(new Blob([bytes])),
        formats: m.ALL_FORMATS,
      });
      try {
        const vt = await input.getPrimaryVideoTrack();
        if (vt)
          results.push({
            name: item.name,
            fps: (await vt.computeFrameRateMetrics()).bestGuessFrameRate,
            rotation: vt.rotation,
            audio: (await input.getAudioTracks()).length,
          });
        else {
          const ctx = new OfflineAudioContext(1, 48000, 48000);
          const a = await ctx.decodeAudioData(bytes.buffer);
          const c = a.getChannelData(0);
          const rms = (start, end) =>
            Math.sqrt(
              c
                .slice(start * 48000, end * 48000)
                .reduce((s, v) => s + v * v, 0) /
                Math.round((end - start) * 48000),
            );
          results.push({
            name: item.name,
            silence: rms(0.01, 0.05),
            tone: rms(0.22, 0.38),
            impulse: c[4800],
          });
        }
      } catch (e) {
        results.push({ name: item.name, rejected: true });
      } finally {
        input.dispose();
      }
    }
    return results;
  }, inputs);
  expect(results[0].fps).toBeCloseTo(30000 / 1001, 3);
  expect(results[0].audio).toBe(1);
  expect(results[1].rotation).toBe(90);
  expect(results[2].rejected).toBe(true);
  expect(results[3].rejected).toBe(true);
  expect(results[4].silence).toBe(0);
  expect(results[4].tone).toBeCloseTo(Math.sqrt(0.02), 2);
  expect(results[4].impulse).toBeGreaterThan(0.79);
});

test("contain margins clear after a landscape-to-portrait cut", async ({
  context,
}, info) => {
  const page = await openProbe(context);
  const clips = [
    await asset("landscape-red.png", { duration: 0.2 }),
    await asset("portrait-blue.png", {
      id: "visual-2",
      startTime: 0.2,
      duration: 0.8,
    }),
  ];
  const result = await page.evaluate(
    async ({ clips, render, opacity, filter }) => {
      const m = window.testRuntime.media;
      for (const c of clips)
        c.blobUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(atob(c.base64), (b) => b.charCodeAt(0))], {
            type: c.mimeType,
          }),
        );
      const opacityAt = new Function(
        "createOpacitySampler",
        "mediaAssets",
        opacity,
      )(window.testRuntime.timeline.createOpacitySampler, clips);
      const scope = {
        ...m,
        mediaAssets: clips,
        targetWidth: 160,
        targetHeight: 90,
        videoBitrate: 1000000,
        fps: 30,
        frameDuration: 1 / 30,
        fitMode: "contain",
        opacityAt,
        applyCanvasFilter: new Function(filter)(),
        getBlob: async (url) => (await fetch(url)).blob(),
        addLog: () => {},
        segmentProgress: { current: [0, 0] },
        setExportProgress: () => {},
      };
      const fn = new Function(...Object.keys(scope), render)(
        ...Object.values(scope),
      );
      const bytes = await fn(0, 1, 0);
      const input = new m.Input({
        source: new m.BlobSource(new Blob([bytes])),
        formats: m.ALL_FORMATS,
      });
      const sink = new m.VideoSampleSink(await input.getPrimaryVideoTrack());
      const sample = await sink.getSample(0.3);
      const canvas = new OffscreenCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      sample.draw(ctx, 0, 0, 160, 90);
      sample.close();
      const result = {
        margin: [...ctx.getImageData(5, 45, 1, 1).data],
        center: [...ctx.getImageData(80, 45, 1, 1).data],
      };
      input.dispose();
      return result;
    },
    {
      clips,
      render: expression("App.tsx", "renderSegment"),
      opacity: expression("App.tsx", "opacityAt"),
      filter: expression("App.tsx", "applyCanvasFilter"),
    },
  );
  expect(result.center[2]).toBeGreaterThan(230);
  await info.attach("decoded-pixels", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(Math.max(...result.margin.slice(0, 3))).toBeLessThan(15);
});
