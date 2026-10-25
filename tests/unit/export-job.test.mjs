import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const { ExportJobs } = loadModule("services/exportJob.ts");
const input = () => ({ mediaAssets: [{ id: "clip", sourceId: "source", trimStart: 0, duration: 1 }],
  audioTracks: [], aspectRatio: "16:9", fitMode: "contain", exportQuality: "draft", totalDuration: 1 });
function store() {
  const blob = new Blob(["original"]);
  let active = 0;
  return { acquireAll: () => { active++; return [{ sourceId: "source", release: () => active-- }]; },
    bytesFor: () => blob, active: () => active, blob };
}
test("one job freezes inputs, owns leases and deduplicates rapid starts", async () => {
  const sources = store(); let finish, context, snapshot;
  const jobs = new ExportJobs(sources, async (value, ctx) => {
    snapshot = value; context = ctx;
    await new Promise(resolve => { finish = resolve; });
    return { videoBytes: 100, delivery: "adapter-accepted" };
  });
  const original = input();
  const pending = jobs.start(original);
  assert.equal(jobs.start(input()), pending);
  const id = jobs.getSnapshot().jobId;
  assert.ok(id);
  assert.equal(sources.active(), 1);
  original.mediaAssets[0].trimStart = 0.5;
  original.mediaAssets.length = 0;
  original.fitMode = "cover";
  assert.equal(snapshot.mediaAssets[0].trimStart, 0);
  assert.equal(snapshot.fitMode, "contain");
  assert.ok(Object.isFrozen(snapshot.mediaAssets[0]));
  assert.equal(await context.getBlob("source"), sources.blob);
  context.phase("rendering"); context.setExportProgress(40); context.addLog("frame");
  assert.equal(jobs.getSnapshot().jobId, id);
  finish(); await pending;
  assert.equal(jobs.getSnapshot().phase, "complete");
  assert.equal(sources.active(), 0);
  context.setExportProgress(5);
  assert.equal(jobs.getSnapshot().progress, 100);
});
test("failed jobs clean before retry and old callbacks cannot affect a newer job", async () => {
  const sources = store(); let old, nextFinish;
  let attempt = 0;
  const jobs = new ExportJobs(sources, async (_, ctx) => {
    if (++attempt === 1) { old = ctx; throw new Error("injected fault"); }
    await new Promise(resolve => { nextFinish = resolve; });
    return { videoBytes: 1, delivery: "adapter-accepted" };
  });
  await jobs.start(input());
  assert.equal(jobs.getSnapshot().phase, "failed");
  assert.equal(sources.active(), 0);
  const next = jobs.start(input()), id = jobs.getSnapshot().jobId;
  old.phase("saving"); old.setExportProgress(99); old.addLog("late old message");
  assert.equal(jobs.getSnapshot().jobId, id);
  assert.equal(jobs.getSnapshot().progress, 0);
  assert.equal(jobs.getSnapshot().phase, "preparing");
  assert.ok(!jobs.getSnapshot().logs.some(line => line.includes("late old")));
  nextFinish(); await next;
  assert.equal(sources.active(), 0);
});
test("source setup and invalid state transitions become recoverable failures", async () => {
  const sources = store();
  const jobs = new ExportJobs(sources, async (_, ctx) => {
    ctx.phase("saving"); ctx.phase("rendering");
    return { videoBytes: 1, delivery: "adapter-accepted" };
  });
  await jobs.start(input());
  assert.match(jobs.getSnapshot().error, /Invalid export phase/);
  assert.equal(sources.active(), 0);
  const missing = new ExportJobs({ ...sources, bytesFor: () => undefined }, async () => { throw new Error("must not run"); });
  await missing.start(input());
  assert.match(missing.getSnapshot().error, /Missing media source/);
  assert.equal(sources.active(), 0);
});
