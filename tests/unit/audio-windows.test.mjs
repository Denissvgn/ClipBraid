import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";

const { audioChunkWindow } = loadModule("services/audio.ts");
const selection = {
  sourceStart: 0.05,
  sourceEnd: 0.1,
  timelineStart: 0.2,
  timelineEnd: 1,
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("audio windows intersect negative and positive timestamps without shifting source audio", () => {
  const negative = audioChunkWindow(-0.02, 150, 1000, selection);
  assert.equal(negative.first, 70);
  assert.equal(negative.end, 120);
  close(negative.when, 0.2);
  close(negative.duration, 0.05);
  const positive = audioChunkWindow(0.06, 100, 1000, selection);
  assert.equal(positive.first, 0);
  assert.equal(positive.end, 40);
  close(positive.when, 0.21);
  close(positive.duration, 0.04);
  assert.equal(audioChunkWindow(-1, 10, 1000, selection), null);
  assert.equal(audioChunkWindow(0.1, 100, 1000, selection), null);
});

test("audio windows select half-open sample timestamps at fractional trim boundaries", () => {
  const plan = audioChunkWindow(0, 9600, 48000, {
    ...selection,
    sourceStart: 0.050005,
    sourceEnd: 0.100005,
  });
  assert.equal(plan.first, 2401);
  assert.equal(plan.end, 4801);
  close(plan.when, 0.2 + 2401 / 48000 - 0.050005);
  close(plan.when + plan.duration, 0.25);
  assert.equal(
    audioChunkWindow(0, 100, 1000, {
      ...selection,
      sourceStart: 0.0501,
      sourceEnd: 0.0502,
    }),
    null,
  );
});

test("audio windows clip both output boundaries and retain deliberate timestamp gaps", () => {
  const left = audioChunkWindow(0, 1000, 1000, {
    ...selection,
    timelineStart: -0.02,
  });
  assert.equal(left.first, 70);
  close(left.when, 0);
  close(left.duration, 0.03);
  const right = audioChunkWindow(0, 1000, 1000, {
    ...selection,
    timelineEnd: 0.225,
  });
  assert.equal(right.end, 75);
  close(right.when + right.duration, 0.225);
  const gap = audioChunkWindow(0.08, 100, 1000, selection);
  close(gap.when, 0.23);
});

test("split chunks own every selected sample exactly once at multiple rates", () => {
  for (const sampleRate of [8000, 44100, 48000, 96000]) {
    for (const chunkSize of [127, 1024, 4096]) {
      const selected = [];
      let previousEnd;
      for (let first = 0; first < sampleRate; first += chunkSize) {
        const plan = audioChunkWindow(
          first / sampleRate,
          Math.min(chunkSize, sampleRate - first),
          sampleRate,
          selection,
        );
        if (!plan) continue;
        if (previousEnd !== undefined) close(plan.when, previousEnd);
        previousEnd = plan.when + plan.duration;
        for (let index = plan.first; index < plan.end; index++)
          selected.push(first + index);
      }
      const start = Math.ceil(0.05 * sampleRate);
      const end = Math.ceil(0.1 * sampleRate);
      assert.deepEqual(
        selected,
        Array.from({ length: end - start }, (_, index) => start + index),
      );
      close(previousEnd, 0.25);
    }
  }
});

test("long source timestamps do not discard frames through subtraction roundoff", () => {
  const timestamp = 86399;
  for (const sampleRate of [44100, 48000, 96000, 192000, 384000]) {
    for (let index = 1; index < 500; index++) {
      const first = index * 7;
      const end = first + 1000;
      const plan = audioChunkWindow(timestamp, sampleRate, sampleRate, {
        sourceStart: timestamp + first / sampleRate,
        sourceEnd: timestamp + end / sampleRate,
        timelineStart: 0,
        timelineEnd: 1,
      });
      assert.equal(plan.first, first);
      assert.equal(plan.end, end);
      close(plan.when, 0);
      close(plan.duration, 1000 / sampleRate);
    }
  }
});
