import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const { exportStage, exportRecovery, copyableJobDetails, mediaRecovery } = loadModule("services/exportFeedback.ts");
test("export stages describe actual processing and recovery does not permit unsafe retry", () => {
  assert.equal(exportStage({ phase: "rendering" }), "Rendering video and mixing audio");
  assert.equal(exportStage({ phase: "saving" }), "Preparing download");
  assert.equal(exportRecovery({ cleanupComplete: false }).retry, false);
  for (const category of ["asset", "size-limit", "unsupported"]) assert.equal(exportRecovery({ cleanupComplete: true, failure: { category } }).retry, false);
  assert.match(exportRecovery({ cleanupComplete: true, failure: { deliveryMayHaveStarted: true } }).message, /Check your downloads/);
  for (const category of ["denied", "cancelled", "transport", "unknown", "unsupported", "rejected", "size-limit"]) assert.ok(mediaRecovery(category).length > 30);
});
test("copyable job details omit raw messages, names and event payloads", () => {
  const report = copyableJobDetails({ jobId: "job", buildId: "build", phase: "failed", progress: 95, cleanupComplete: true,
    failure: { category: "unknown", assetId: "private-person" }, logs: ["secret"], error: "/home/user/private.mp4",
    events: [{ type: "failed", elapsedMs: 12, detail: { base64: "private media", name: "secret" } }] });
  assert.doesNotMatch(report, /secret|private|base64|home/);
  assert.equal(JSON.parse(report).category, "unknown");
});
