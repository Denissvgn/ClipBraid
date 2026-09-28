import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { expression } from "../source-probes.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";

const uploadDraft = (page, value) =>
  page
    .locator('input[accept=".json"]')
    .setInputFiles({
      name: "draft.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });

test("draft rejection preserves live data and rolls back partially allocated URLs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.createdUrls = [];
    window.revokedUrls = [];
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (...args) {
      const url = create.apply(this, args);
      window.createdUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      window.revokedUrls.push(url);
      return revoke.call(this, url);
    };
  });
  await openEditor(page);
  const clip = await asset("bars-fractional-av.mp4");
  await loadDraft(page, draft([clip]));
  const before = await saveDraft(page);
  const url = await page.locator("video").first().getAttribute("src");
  for (const invalid of [
    { ...draft([clip]), mediaAssets: {} },
    { ...draft([clip]), schemaVersion: 9999 },
    draft([clip, { ...clip }]),
    draft([{ ...clip, trimStart: 3 }]),
    { ...draft([clip]), aspectRatio: "broken" },
    { ...draft([clip]), currentTime: "later" },
    draft([clip, { ...clip, id: "second", base64: "!not-base64!" }]),
  ]) {
    const count = await page.evaluate(() => window.createdUrls.length);
    await uploadDraft(page, invalid);
    await expect(
      page.locator('[data-editor-status="LOAD ERROR"]'),
    ).toBeVisible();
    const state = await page.evaluate(
      async ({ url, count }) => ({
        live: (await fetch(url)).ok,
        stagedRevoked: window.createdUrls
          .slice(count)
          .every((url) => window.revokedUrls.includes(url)),
      }),
      { url, count },
    );
    expect(state).toEqual({ live: true, stagedRevoked: true });
    expect(await saveDraft(page)).toEqual(before);
  }
});

test("restored playhead uses the new project duration and long-project size is honest", async ({
  page,
}) => {
  await openEditor(page);
  const clip = await asset("landscape-red.png", { duration: 20 });
  await loadDraft(page, { ...draft([clip]), currentTime: 12 });
  expect((await saveDraft(page)).currentTime).toBe(12);
  await loadDraft(page, {
    ...draft([{ ...clip, duration: 2 }]),
    currentTime: 99,
  });
  expect((await saveDraft(page)).currentTime).toBe(2);
  await loadDraft(page, draft([{ ...clip, duration: 3600 }]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  await expect(page.getByText(/MiB estimated/)).toContainText("311.8 MiB");
  await expect(page.getByText(/MB target/)).toHaveCount(0);
});

test("replacing a project with the same clip ID replaces its audio source and pauses playback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.createdAudio = [];
    window.Audio = function (...args) {
      const audio = new NativeAudio(...args);
      window.createdAudio.push(audio);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
  });
  await openEditor(page);
  const project = draft([await asset("bars-fractional-av.mp4")]);
  await loadDraft(page, project);
  const previous = await page.locator("video").getAttribute("src");
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page.waitForFunction(() => window.createdAudio.some((a) => !a.paused));
  await loadDraft(page, project);
  const current = await page.locator("video").getAttribute("src");
  expect(current).not.toBe(previous);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.createdAudio.map((a) => ({
          url: a.getAttribute("src"),
          paused: a.paused,
        })),
      ),
    )
    .toEqual([
      { url: "", paused: true },
      { url: current, paused: true },
    ]);
});

test("invalid visual and batched audio imports reject instead of inventing a duration", async ({
  page,
}) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("landscape-red.png")]));
  const before = await saveDraft(page);
  const corrupt = await readFile("tests/fixtures/corrupt.mp4");
  for (const file of [
    { name: "broken.mp4", mimeType: "video/mp4", buffer: corrupt },
    { name: "broken.png", mimeType: "image/png", buffer: corrupt },
  ]) {
    const picker = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Add visuals", exact: true })
      .click();
    await (await picker).setFiles(file);
    await expect(
      page.locator('[data-editor-status="IMPORT ERROR"]'),
    ).toBeVisible();
    expect(await saveDraft(page)).toEqual(before);
  }
  await page.locator('input[accept="audio/*"]').setInputFiles([
    {
      name: "good.wav",
      mimeType: "audio/wav",
      buffer: await readFile("tests/fixtures/tone-impulses.wav"),
    },
    { name: "broken.wav", mimeType: "audio/wav", buffer: corrupt },
  ]);
  await expect(
    page.locator('[data-editor-status="AUDIO ERROR"]'),
  ).toBeVisible();
  expect(await saveDraft(page)).toEqual(before);
});

test("corrupt images, missing video tracks and corrupt soundtracks prevent delivery", async ({
  page,
}) => {
  await openEditor(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  const image = await asset("landscape-red.png");
  const corrupt = (await readFile("tests/fixtures/corrupt.mp4")).toString(
    "base64",
  );
  const tone = (await readFile("tests/fixtures/tone-impulses.wav")).toString(
    "base64",
  );
  for (const project of [
    draft([{ ...image, base64: corrupt }]),
    draft([
      await asset("bars-fractional-av.mp4", { base64: tone, muted: true }),
    ]),
    draft(
      [image],
      [
        {
          id: "audio",
          mediaId: "audio",
          name: "broken.wav",
          mimeType: "audio/wav",
          base64: corrupt,
          startTime: 0,
          duration: 1,
        },
      ],
    ),
  ]) {
    await loadDraft(page, project);
    await page
      .getByRole("button", { name: "Export video", exact: true })
      .click();
    await expect(
      page.locator('[data-editor-status="EXPORT ERROR"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export video", exact: true }),
    ).toBeEnabled();
    expect(downloads).toBe(0);
  }
});

test("rejected and false save acknowledgements stay failed and permit a clean retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.saveMode = "reject";
    window.saveCalls = 0;
    window.Flow = {
      save: async () => {
        window.saveCalls++;
        if (window.saveMode === "reject")
          throw new Error("injected save rejection");
        return false;
      },
    };
  });
  await openEditor(page);
  await loadDraft(page, draft([await asset("landscape-red.png")]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  let downloads = 0;
  page.on("download", () => downloads++);
  for (const mode of ["reject", "false"]) {
    await page.evaluate((mode) => {
      window.saveMode = mode;
    }, mode);
    await page
      .getByRole("button", { name: "Export video", exact: true })
      .click();
    await expect(
      page.locator('[data-editor-status="EXPORT ERROR"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export video", exact: true }),
    ).toBeEnabled();
  }
  expect(await page.evaluate(() => window.saveCalls)).toBe(2);
  expect(downloads).toBe(0);
});

test("preview and encoded crossfades preserve brightness throughout the overlap", async ({
  page,
  context,
}) => {
  await openEditor(page);
  const clips = [
    await asset("landscape-red.png"),
    await asset("portrait-blue.png", {
      id: "second",
      startTime: 0.5,
      transitionDuration: 0.5,
    }),
  ];
  await loadDraft(page, {
    ...draft(clips),
    currentTime: 0.75,
    fitMode: "cover",
  });
  await page
    .locator(".preview-frame img")
    .evaluateAll((images) =>
      Promise.all(images.map((image) => image.decode())),
    );
  const shot = await page.locator(".preview-frame").screenshot();
  const preview = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return [
      ...ctx.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
      ).data,
    ];
  }, shot.toString("base64"));
  for (const channel of [0, 2]) expect(preview[channel]).toBeGreaterThan(120);
  expect(preview[1]).toBeLessThan(5);
  const probe = await openProbe(context);
  const pixels = await probe.evaluate(
    async ({ clips, render, filter }) => {
      const m = window.testRuntime.media,
        timeline = window.testRuntime.timeline;
      for (const clip of clips)
        clip.blobUrl = URL.createObjectURL(
          new Blob(
            [Uint8Array.from(atob(clip.base64), (c) => c.charCodeAt(0))],
            { type: clip.mimeType },
          ),
        );
      const opacityAt = timeline.createOpacitySampler(clips);
      const scope = {
        ...m,
        mediaAssets: clips,
        targetWidth: 160,
        targetHeight: 90,
        videoBitrate: 1000000,
        fps: 30,
        frameDuration: 1 / 30,
        fitMode: "cover",
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
      const bytes = await fn(0, 1.5, 0);
      const input = new m.Input({
        source: new m.BlobSource(new Blob([bytes])),
        formats: m.ALL_FORMATS,
      });
      try {
        const sink = new m.VideoSampleSink(await input.getPrimaryVideoTrack());
        const canvas = new OffscreenCanvas(160, 90),
          ctx = canvas.getContext("2d"),
          pixels = [];
        for (const time of [0.25, 0.75, 1.25]) {
          const sample = await sink.getSample(time);
          sample.draw(ctx, 0, 0, 160, 90);
          sample.close();
          pixels.push([...ctx.getImageData(80, 45, 1, 1).data]);
        }
        return pixels;
      } finally {
        input.dispose();
        clips.forEach((c) => URL.revokeObjectURL(c.blobUrl));
      }
    },
    {
      clips,
      render: expression("App.tsx", "renderSegment"),
      filter: expression("App.tsx", "applyCanvasFilter"),
    },
  );
  expect(pixels[0][0]).toBeGreaterThan(240);
  expect(pixels[0][2]).toBeLessThan(10);
  expect(pixels[2][2]).toBeGreaterThan(240);
  expect(pixels[2][0]).toBeLessThan(10);
  for (const channel of [0, 2])
    expect(Math.abs(pixels[1][channel] - preview[channel])).toBeLessThan(20);
  expect(pixels[1][0] + pixels[1][2]).toBeGreaterThan(240);
});

test("trimmed buffers exclude both boundaries and standalone tracks end at their duration", async ({
  context,
}) => {
  const page = await openProbe(context);
  const tone = (await readFile("tests/fixtures/tone-impulses.wav")).toString(
    "base64",
  );
  const result = await page.evaluate(
    async ({ mix, wav, tone }) => {
      const { media } = window.testRuntime;
      const buffer = new AudioBuffer({
        length: 44100,
        sampleRate: 44100,
        numberOfChannels: 1,
      });
      const data = buffer.getChannelData(0);
      data.fill(0.1);
      data.fill(0.5, 8820, 22050);
      data.fill(1, 22050);
      class Input {
        async getPrimaryAudioTrack() {
          return { canDecode: async () => true };
        }
        dispose() {}
      }
      class Sink {
        async *buffers() {
          yield { timestamp: 0, buffer };
        }
      }
      const scope = {
        ...media,
        Input,
        AudioBufferSink: Sink,
        mediaAssets: [
          {
            type: "video",
            hasAudio: true,
            muted: false,
            name: "trim",
            trimStart: 0.2,
            duration: 0.3,
            startTime: 0.4,
          },
        ],
        audioTracks: [],
        totalDuration: 1,
        getBlob: async () => new Blob(["fixture"]),
        audioBufferToWav: new Function(wav)(),
      };
      const invoke = () =>
        new Function(...Object.keys(scope), mix)(...Object.values(scope))();
      const decode = async (bytes) =>
        (
          await new OfflineAudioContext(1, 44100, 44100).decodeAudioData(
            bytes.buffer,
          )
        ).getChannelData(0);
      const pcm = await decode(await invoke());
      const mean = (pcm, a, b) =>
        pcm.slice(a * 44100, b * 44100).reduce((s, x) => s + Math.abs(x), 0) /
        Math.round((b - a) * 44100);
      scope.mediaAssets = [];
      scope.audioTracks = [{ name: "tone", startTime: 0.2, duration: 0.35 }];
      scope.getBlob = async () =>
        new Blob([Uint8Array.from(atob(tone), (c) => c.charCodeAt(0))]);
      const standalone = await decode(await invoke());
      return {
        before: mean(pcm, 0.35, 0.39),
        inside: mean(pcm, 0.45, 0.65),
        after: mean(pcm, 0.71, 0.8),
        tone: mean(standalone, 0.43, 0.53),
        tail: mean(standalone, 0.56, 0.59),
      };
    },
    {
      mix: expression("App.tsx", "mixAudio"),
      wav: expression("App.tsx", "audioBufferToWav"),
      tone,
    },
  );
  expect(result.before).toBe(0);
  expect(result.inside).toBeCloseTo(0.5, 3);
  expect(result.after).toBe(0);
  expect(result.tone).toBeGreaterThan(0.05);
  expect(result.tail).toBe(0);
});

test("playback controls receive pointer input on common laptop viewports with parallel tracks", async ({
  page,
}) => {
  await openEditor(page);
  const image = await asset("landscape-red.png", { duration: 10 });
  const tone = (await readFile("tests/fixtures/tone-impulses.wav")).toString(
    "base64",
  );
  const audio = Array.from({ length: 4 }, (_, index) => ({
    id: `audio-${index}`,
    name: `Track ${index + 1}`,
    mediaId: "tone",
    mimeType: "audio/wav",
    base64: tone,
    startTime: 0,
    duration: 1,
  }));
  await loadDraft(page, draft([image], audio));
  for (const [width, height] of [
    [1280, 720],
    [1366, 768],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await page
      .getByRole("button", { name: "Play preview", exact: true })
      .click({ timeout: 5000 });
    await page
      .getByRole("button", { name: "Pause preview", exact: true })
      .click({ timeout: 5000 });
  }
});
