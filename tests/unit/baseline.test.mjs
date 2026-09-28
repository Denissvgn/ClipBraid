import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { evaluate, loadModule } from "../source-probes.mjs";

test("fixture inventory byte identities are pinned", () => {
  const inventory = JSON.parse(readFileSync("tests/fixtures/manifest.json"));
  for (const [name, expected] of Object.entries(inventory)) {
    const bytes = readFileSync(`tests/fixtures/${name}`);
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      name,
    );
  }
});
test("timeline bounds overlaps and keeps repeated-source clip edits independent", () => {
  const clampTransition = evaluate("App.tsx", "clampTransition");
  const recalculate = evaluate("App.tsx", "recalculateMediaStartTimes", {
    transitionDuration: 0.5,
    clampTransition,
  });
  const input = [
    { id: "a", mediaId: "shared", duration: 1 },
    { id: "b", mediaId: "shared", duration: 0.2 },
  ];
  const out = recalculate(input);
  assert.equal(out[0].startTime, 0);
  assert.equal(out[1].startTime, 0.9);
  assert.equal(out[1].transitionDuration, 0.1);
  assert.equal(input[1].startTime, undefined);
  out[0].duration = 2;
  assert.equal(out[1].duration, 0.2);
});

const {
  createOpacitySampler,
  exportFrameRate,
  estimateExport,
  projectDuration,
} = loadModule("services/timeline.ts");
const { parseProject } = loadModule("services/project.ts");
test("preview/export transition weights change only during the actual overlap", () => {
  const a = { id: "a", startTime: 0, duration: 6 },
    b = { id: "b", startTime: 5, duration: 3, transitionDuration: 1 };
  const mediaAssets = [b, a];
  const sampleOpacity = createOpacitySampler(mediaAssets);
  for (const [t, expected] of [
    [4.5, [1, 0]],
    [5, [1, 0]],
    [5.5, [0.5, 0.5]],
    [6, [0, 1]],
  ]) {
    const opacity = evaluate("App.tsx", "opacityAt", {
      createOpacitySampler,
      mediaAssets,
    });
    const preview = evaluate(
      "components/MediaPreview.tsx",
      "calculateOpacity",
      { currentTime: t, sampleOpacity },
    );
    assert.deepEqual([opacity(a, t), opacity(b, t)], expected);
    assert.deepEqual([preview(a), preview(b)], expected);
  }
});
test("project parser rejects unsupported versions, duplicate IDs, malformed timing and settings", () => {
  const media = {
    id: "clip",
    name: "image",
    mediaId: "source",
    base64: "YQ==",
    mimeType: "image/png",
    type: "image",
    startTime: 0,
    duration: 2,
  };
  for (const value of [
    { schemaVersion: 9999, mediaAssets: [], audioTracks: [] },
    { mediaAssets: {} },
    { mediaAssets: [media, media] },
    { mediaAssets: [media], audioTracks: [media] },
    { mediaAssets: [{ ...media, startTime: -1 }] },
    { mediaAssets: [{ ...media, duration: null }] },
    {
      mediaAssets: [
        { ...media, type: "video", originalDuration: 2, trimStart: 3 },
      ],
    },
    { mediaAssets: [media], fitMode: "invalid" },
    { mediaAssets: [media], currentTime: "later" },
  ])
    assert.throws(() => parseProject(JSON.stringify(value)));
  for (const schemaVersion of [undefined, 1]) {
    const parsed = parseProject(
      JSON.stringify({ schemaVersion, mediaAssets: [media] }),
    );
    assert.equal(parsed.mediaAssets[0].originalDuration, 2);
    assert.equal(projectDuration(parsed.mediaAssets, parsed.audioTracks), 2);
    assert.equal(parsed.currentTime, 0);
  }
});
test("fractional source rates are retained within the stated export range", () => {
  for (const fps of [24000 / 1001, 30000 / 1001, 25, 30])
    assert.equal(exportFrameRate(fps), fps);
  assert.equal(exportFrameRate(60), 30);
  assert.equal(exportFrameRate(8), 12);
  assert.equal(exportFrameRate(NaN), 30);
});
test("displayed estimate includes the actual bitrate floor, audio and base64 overhead", () => {
  for (const quality of ["draft", "standard", "high"])
    for (const duration of [1, 60, 3600]) {
      const estimate = estimateExport(quality, duration);
      const minimum =
        ((estimate.videoBitrate + estimate.audioBitrate) * duration) /
        8 /
        1048576;
      assert.ok(estimate.estimatedMiB >= minimum);
      assert.ok(estimate.base64MiB >= (estimate.estimatedMiB * 4) / 3);
    }
  assert.ok(estimateExport("draft", 3600).estimatedMiB > 290);
});

test("three-way overlaps do not amplify source brightness", () => {
  const media = [
    { id: "a", startTime: 0, duration: 10 },
    { id: "b", startTime: 9.1, duration: 1, transitionDuration: 0.9 },
    { id: "c", startTime: 9.2, duration: 10, transitionDuration: 0.9 },
  ];
  const sample = createOpacitySampler(media);
  for (const time of [0, 9.15, 9.3, 9.6, 10, 10.05, 11]) {
    const weights = media.map((asset) => sample(asset, time));
    assert.ok(weights.every((value) => value >= 0 && value <= 1));
    assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
});
