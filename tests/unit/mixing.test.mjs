import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModule } from "../source-probes.mjs";
const timeline = loadModule("services/timeline.ts");
const { mixPolicy, trackGain } = loadModule("services/mixing.ts", { "./timeline": timeline });
const project = loadModule("services/project.ts");
test("headroom counts half-open enabled overlaps and stays constant for the project", () => {
  const one = { startTime: 0, duration: 1 };
  assert.deepEqual(mixPolicy([], [one]), { maxOverlap: 1, gain: 1 });
  assert.deepEqual(mixPolicy([], [one, { startTime: 1, duration: 1 }]), { maxOverlap: 1, gain: 1 });
  assert.deepEqual(mixPolicy([], [one, { startTime: 0.5, duration: 1 }]), { maxOverlap: 2, gain: 0.5 });
  assert.equal(mixPolicy([{ ...one, type: "video", hasAudio: true, muted: true }], [{ ...one, gain: 0 }]).maxOverlap, 0);
  assert.equal(mixPolicy([{ ...one, type: "image", hasAudio: true }], []).maxOverlap, 0);
  assert.equal(trackGain({}), 1); assert.equal(trackGain({ gain: 0 }), 0);
  for (const gain of [-0.1, 1.1, NaN, Infinity]) assert.throws(() => trackGain({ gain }));
});
test("seeded overlap sweeps agree with the shared interval sampler", () => {
  let seed = 17;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 200; run++) {
    const lanes = Array.from({ length: 40 }, () => ({ startTime: Math.round(random() * 20) / 10,
      duration: Math.round(random() * 15) / 10, gain: random() < 0.2 ? 0 : 1 }));
    const audible = lanes.filter(lane => lane.gain > 0);
    const peak = Math.max(0, ...lanes.map(lane => timeline.activeIntervals(audible, lane.startTime).length));
    assert.equal(mixPolicy([], lanes).maxOverlap, peak);
  }
});
test("version 1 drafts migrate to version 2 and independent gains round-trip with original bytes", async () => {
  const legacy = JSON.parse(readFileSync("tests/fixtures/drafts/legacy-unversioned.migrated.json", "utf8"));
  assert.equal(legacy.schemaVersion, 1);
  const parsed = project.parseProject(JSON.stringify(legacy));
  parsed.mediaAssets[0].gain = 0.25; parsed.audioTracks[0].gain = 0;
  const payloads = new Map(parsed.sources.map(source => [source.sourceId, source.base64]));
  const saved = JSON.parse(await project.serializeProject(parsed, async id => payloads.get(id)));
  assert.equal(saved.schemaVersion, 2);
  const restored = project.parseProject(JSON.stringify(saved));
  assert.equal(restored.mediaAssets[0].gain, 0.25);
  assert.equal(restored.audioTracks[0].gain, 0);
  assert.equal(saved.mediaAssets[0].base64, legacy.mediaAssets[0].base64);
  for (const gain of [-1, 1.1, null, "0.5"])
    assert.throws(() => project.parseProject(JSON.stringify({ ...saved, mediaAssets: saved.mediaAssets.map((clip, index) => index ? clip : { ...clip, gain }) })));
});
