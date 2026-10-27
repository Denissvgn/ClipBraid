import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const { outputProfile, frameSegments } = loadModule("services/outputProfile.ts", { "./timeline": loadModule("services/timeline.ts") });
test("rational rates and global segment frame counts cover every output frame once", () => {
  for (const source of [24000 / 1001, 24, 30000 / 1001, 30, 60]) for (const duration of [1, 1.001, 4.2, 181.02]) {
    const profile = outputProfile("draft", "16:9", duration, [{ kind: "video", video: { fps: source, width: 160, height: 90 } }]);
    assert.ok(profile.duration >= duration - 1e-9);
    assert.ok(profile.duration - duration < 1 / profile.fps + 1e-9);
    const segments = frameSegments(profile);
    assert.equal(segments.reduce((sum, segment) => sum + segment.frameEnd - segment.frameStart, 0), profile.frames);
    assert.equal(segments[0].frameEnd, segments[1].frameStart);
    assert.equal(profile.width, 854); assert.equal(profile.height, 480);
    assert.equal(profile.fps, source > 30 ? 30 : source);
  }
});
