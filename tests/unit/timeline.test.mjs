import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";

const {
  activeIntervals,
  canvasFit,
  clampPlayhead,
  clampTransition,
  createOpacitySampler,
  frameCount,
  frameTimestamp,
  intervalEnd,
  intervalsOverlap,
  isIntervalActive,
  projectDuration,
  recalculateMediaStartTimes,
  sourceTimeAt,
  sourceWindow,
  timelineViewportDuration,
  trimmedDuration,
} = loadModule("services/timeline.ts");

const closeTo = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("video packet grid repairs cancellation noise without shifting fractional trims or interval ends",()=>{
  const clip={startTime:22.5,originalDuration:1,trimStart:0,trimEnd:0};
  const raw=sourceTimeAt(clip,551/24);
  assert(raw<11/24);
  assert.equal(sourceTimeAt(clip,551/24,12288),11/24);
  const trimmed={...clip,trimStart:.0334,trimEnd:.9326};
  assert.equal(sourceTimeAt(trimmed,22.5+1/30,15360),sourceTimeAt(trimmed,22.5+1/30));
  const justBeforeEnd={...clip,trimEnd:1-11/24};
  const selected=sourceTimeAt(justBeforeEnd,551/24,12288);
  assert(selected<11/24);
  assert.equal(sourceTimeAt(clip,551/24,NaN),raw);
});

test("timeline intervals are half-open and standalone audio defines the tail", () => {
  const first = { id: "first", startTime: 1, duration: 2 };
  const second = { id: "second", startTime: 3, duration: 1 };
  assert.equal(intervalEnd(first), 3);
  assert.equal(isIntervalActive(first, 0.999), false);
  assert.equal(isIntervalActive(first, 1), true);
  assert.equal(isIntervalActive(first, 2.999), true);
  assert.equal(isIntervalActive(first, 3), false);
  assert.equal(isIntervalActive({ startTime: 0, duration: 0 }, 0), false);
  assert.deepEqual(
    activeIntervals([first, second], 3).map((clip) => clip.id),
    ["second"],
  );
  assert.equal(intervalsOverlap(first, 0, 1), false);
  assert.equal(intervalsOverlap(first, 0, 1.001), true);
  assert.equal(intervalsOverlap(first, 1, 1), false);
  assert.equal(projectDuration([first], [{ startTime: 2, duration: 4 }]), 6);
  assert.equal(timelineViewportDuration([first], []), 10);
  assert.equal(
    timelineViewportDuration([], [{ startTime: 20, duration: 1 }]),
    21,
  );
});

test("sequencing clamps short transitions without mutating clip instances", () => {
  assert.equal(clampTransition(2, 0.05, 0.05), 0);
  assert.equal(clampTransition(2, 0.2, 0.3), 0.1);
  const input = [
    { id: "a", mediaId: "shared", duration: 0.05 },
    { id: "b", mediaId: "shared", duration: 0.2, transitionDuration: 0.5 },
    { id: "c", mediaId: "shared", duration: 0.3, transitionDuration: 0.5 },
  ];
  const output = recalculateMediaStartTimes(input, 0.5);
  assert.deepEqual(
    output.map((clip) => clip.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    output.map((clip) => clip.transitionDuration),
    [0, 0, 0.1],
  );
  closeTo(output[0].startTime, 0);
  closeTo(output[1].startTime, 0.05);
  closeTo(output[2].startTime, 0.15);
  assert.equal(input[0].startTime, undefined);
  assert.notEqual(output[0], input[0]);
  output[1].duration = 1;
  assert.equal(input[1].duration, 0.2);
  assert.equal(output[2].duration, 0.3);
});

test("trim windows and frame timestamps share exact source boundaries", () => {
  const clip = {
    startTime: 3,
    trimStart: 0.2,
    trimEnd: 0.3,
    originalDuration: 2,
  };
  assert.deepEqual(sourceWindow(clip), { start: 0.2, end: 1.7 });
  closeTo(trimmedDuration(clip), 1.5);
  closeTo(sourceTimeAt(clip, 3.5), 0.7);
  closeTo(sourceTimeAt(clip, 2), 0.2);
  closeTo(sourceTimeAt(clip, 99), 1.699);
  assert.equal(frameCount(0, 30), 0);
  assert.equal(frameCount(-1, 30), 0);
  assert.equal(frameCount(1, 0), 0);
  assert.equal(frameCount(0.0001, 30), 1);
  assert.equal(frameCount(1, 30), 30);
  closeTo(frameTimestamp(3, 30, 1), 1.1);
  closeTo(frameTimestamp(3, 30), 0.1);
});

test("canvas fit preserves aspect ratio and contain/cover bounds", () => {
  const contained = canvasFit(90, 160, 160, 90, "contain");
  closeTo(contained.x, 54.6875);
  closeTo(contained.y, 0);
  closeTo(contained.width, 50.625);
  closeTo(contained.height, 90);
  const covered = canvasFit(90, 160, 160, 90, "cover");
  closeTo(covered.x, 0);
  closeTo(covered.width, 160);
  assert.ok(covered.height >= 90);
  assert.ok(covered.y <= 0);
  for (const size of [0.001, 1, 90, 10000]) {
    for (const mode of ["contain", "cover"]) {
      const fit = canvasFit(size, size * 1.7, 160, 90, mode);
      closeTo(fit.width / fit.height, 1 / 1.7);
      if (mode === "contain") {
        assert.ok(fit.width <= 160 + 1e-9);
        assert.ok(fit.height <= 90 + 1e-9);
      } else {
        assert.ok(fit.width >= 160 - 1e-9);
        assert.ok(fit.height >= 90 - 1e-9);
      }
    }
  }
  assert.deepEqual(canvasFit(0, 10, 160, 90, "contain"), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
});

test("playhead clamping covers seek, restore and shortened projects", () => {
  assert.equal(clampPlayhead(-1, 5), 0);
  assert.equal(clampPlayhead(2, 5), 2);
  assert.equal(clampPlayhead(9, 5), 5);
  assert.equal(clampPlayhead(Number.POSITIVE_INFINITY, 5), 5);
  assert.equal(clampPlayhead(Number.NaN, 5), 0);
  assert.equal(clampPlayhead(1, 0), 0);
});

test("crossfade weights are continuous at actual overlap boundaries", () => {
  const media = [
    { id: "a", startTime: 0, duration: 1, transitionDuration: 0 },
    { id: "b", startTime: 0.5, duration: 1, transitionDuration: 0.5 },
  ];
  const sample = createOpacitySampler(media);
  for (const [time, expected] of [
    [0.25, [1, 0]],
    [0.49, [1, 0]],
    [0.5, [1, 0]],
    [0.75, [0.5, 0.5]],
    [0.999, [0.002, 0.998]],
    [1, [0, 1]],
    [1.25, [0, 1]],
  ]) {
    const weights = media.map((clip) => sample(clip, time));
    weights.forEach((weight, index) => closeTo(weight, expected[index]));
    closeTo(weights.reduce((sum, weight) => sum + weight, 0), 1);
  }
});

test("transition settings never fade a clip without actual overlap", () => {
  for (const media of [
    [
      { id: "a", startTime: 0, duration: 1, transitionDuration: 0 },
      { id: "b", startTime: 1, duration: 1, transitionDuration: 0.5 },
    ],
    [
      { id: "a", startTime: 0, duration: 1, transitionDuration: 0 },
      { id: "b", startTime: 2, duration: 1, transitionDuration: 0.5 },
    ],
    [{ id: "a", startTime: 0, duration: 1, transitionDuration: 0.5 }],
  ]) {
    const sample = createOpacitySampler(media);
    const incoming = media[media.length - 1];
    for (const time of [incoming.startTime, incoming.startTime + 0.25]) {
      closeTo(sample(incoming, time), 1);
    }
  }
});

test("short three-way overlaps stay normalized at dense frame boundaries", () => {
  const media = [
    { id: "a", startTime: 0, duration: 1 },
    { id: "b", startTime: 0.5, duration: 0.6, transitionDuration: 0.5 },
    { id: "c", startTime: 0.6, duration: 1, transitionDuration: 0.5 },
  ];
  const sample = createOpacitySampler(media);
  for (let frame = 0; frame <= 160; frame++) {
    const time = frame / 100;
    const weights = media.map((clip) => sample(clip, time));
    assert.ok(weights.every((weight) => weight >= 0 && weight <= 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    closeTo(total, weights.some((weight) => weight > 0) ? 1 : 0);
  }
});
