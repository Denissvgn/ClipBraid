import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, loadDiagnostics } from "../source-probes.mjs";
const { exportStage, exportRecovery, copyableJobDetails, mediaRecovery } = loadModule("services/exportFeedback.ts", { "./diagnostics": loadDiagnostics() });
test("export stages describe actual processing and recovery does not permit unsafe retry", () => {
  assert.equal(exportStage({ phase: "rendering" }), "Rendering video and mixing audio");
  assert.equal(exportStage({ phase: "saving", cancellable: true }), "Preparing download");
  assert.equal(exportStage({ phase: "saving", cancellable: false }), "Waiting for file handoff");
  assert.equal(exportRecovery({ cleanupComplete: false }).retry, false);
  for (const category of ["asset", "size-limit", "unsupported"]) assert.equal(exportRecovery({ cleanupComplete: true, failure: { category } }).retry, false);
  assert.match(exportRecovery({ cleanupComplete: true, failure: { deliveryMayHaveStarted: true } }).message, /Check your downloads/);
  const confirmed=exportRecovery({cleanupComplete:true,failure:{category:"processing",deliveryMayHaveStarted:true},result:{delivery:"host-accepted",videoBytes:100}});
  assert.equal(confirmed.retry,false);assert.match(confirmed.message,/handoff was confirmed/);
  for (const category of ["denied", "cancelled", "transport", "unknown", "unsupported", "rejected", "size-limit"]) assert.ok(mediaRecovery(category).length > 30);
});
test("copyable job details omit raw messages, names and event payloads", () => {
  const report = copyableJobDetails({ jobId: "00000000-0000-4000-8000-000000000000", buildId: "build", phase: "failed", progress: 95, cleanupComplete: true,
    failure: { category: "unknown", assetId: "private-person" }, logs: ["secret"], error: "/home/user/private.mp4",
    events: [{ type: "failed", elapsedMs: 12, detail: { base64: "private media", name: "secret" } }] });
  assert.doesNotMatch(report, /secret|private|base64|home/);
  assert.equal(JSON.parse(report).category, "unknown");
});
