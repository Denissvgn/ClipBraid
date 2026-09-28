import { test, expect } from "./harness.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openEditor, loadDraft } from "./helpers.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";

test("one-second repeated-source real AVC encode, AAC mux and browser download", async ({
  page,
  context,
}, info) => {
  await openEditor(page);
  const a = await asset("bars-fractional-av.mp4", {
    duration: 0.5,
    trimEnd: 0.501,
    muted: true,
  });
  const b = {
    ...a,
    id: "visual-2",
    startTime: 0.5,
    trimStart: 0.5,
    trimEnd: 0.001,
  };
  const audio = {
    id: "tone",
    mediaId: "synthetic-tone",
    name: "tone-impulses.wav",
    mimeType: "audio/wav",
    base64: (await readFile("tests/fixtures/tone-impulses.wav")).toString(
      "base64",
    ),
    duration: 1,
    startTime: 0,
  };
  await loadDraft(page, draft([a, b], [audio]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const download = await ready;
  await download.saveAs(info.outputPath("smoke.mp4"));
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(info.outputPath("smoke.mp4"));
  expect(bytes.length).toBeGreaterThan(1000);
  const probe = await openProbe(context);
  const media = await probe.evaluate(async (base64) => {
    const m = window.testRuntime.media;
    const blob = new Blob(
      [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
      { type: "video/mp4" },
    );
    const input = new m.Input({
      source: new m.BlobSource(blob),
      formats: m.ALL_FORMATS,
    });
    const v = await input.getPrimaryVideoTrack(),
      a = await input.getPrimaryAudioTrack();
    if (!v || !a) throw new Error("Missing output stream");
    const sink = new m.VideoSampleSink(v);
    const frames = [];
    for (const t of [0.25, 0.75]) {
      const sample = await sink.getSample(t);
      if (!sample) throw new Error("Missing frame");
      const c = new OffscreenCanvas(854, 480);
      const x = c.getContext("2d");
      sample.draw(x, 0, 0, 854, 480);
      sample.close();
      frames.push([...x.getImageData(40, 100, 1, 1).data]);
    }
    const audioCtx = new OfflineAudioContext(1, 48000, 48000);
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const pcm = decoded.getChannelData(0);
    const rate = decoded.sampleRate;
    const rms = (s, e) =>
      Math.sqrt(
        pcm.slice(s * rate, e * rate).reduce((sum, n) => sum + n * n, 0) /
          Math.round((e - s) * rate),
      );
    const result = {
      duration: await input.computeDuration(),
      width: await v.getCodedWidth(),
      height: await v.getCodedHeight(),
      videoCodec: await v.getCodec(),
      audioCodec: await a.getCodec(),
      frames,
      silence: rms(0.02, 0.06),
      tone: rms(0.22, 0.38),
    };
    input.dispose();
    return result;
  }, bytes.toString("base64"));
  expect(media.duration).toBeGreaterThanOrEqual(0.99);
  expect(media.duration).toBeLessThan(1.1);
  expect(media).toMatchObject({
    width: 854,
    height: 480,
    videoCodec: "avc",
    audioCodec: "aac",
  });
  for (const pixel of media.frames) {
    expect(Math.min(...pixel.slice(0, 3))).toBeGreaterThan(150);
    expect(
      Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3)),
    ).toBeLessThan(25);
  }
  expect(media.silence).toBeLessThan(0.005);
  expect(media.tone).toBeGreaterThan(0.08);
  await info.attach("output-evidence", {
    body: JSON.stringify(
      {
        jobId: `${process.env.CLIPBRAID_RUN_ID ?? "manual"}:${info.testId}`,
        jobIdentitySource: "harness-run/test identity; not a production export-job identity",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...media,
        delivery:
          "download-initiated; test runner copied received bytes; no physical host/device claim",
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("corrupt visual prevents a successful download [known-broken asset failures]", async ({
  page,
}, info) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("corrupt.mp4", { muted: true })]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const outcome = Promise.race([
    page.waitForEvent("download").then(() => "download-initiated"),
    page
      .locator('[data-editor-status="EXPORT ERROR"]')
      .waitFor()
      .then(() => "explicit-error"),
  ]);
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const result = await outcome;
  await info.attach("corrupt-output", {
    body: JSON.stringify({ result }),
    contentType: "application/json",
  });
  test.fail(
    true,
    "failed media is omitted and a black video can be downloaded",
  );
  expect(result).toBe("explicit-error");
});
