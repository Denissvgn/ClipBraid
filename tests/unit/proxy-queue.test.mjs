import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const ownership = loadModule("services/mediaSources.ts");
const lifecycle = loadModule("services/exportJob.ts");
const { ProxyQueue, proxyKey } = loadModule("services/proxyQueue.ts", { "./exportJob": lifecycle });
function harness() {
  const revoked = []; let count = 0, failURL = false;
  const store = new ownership.MediaSourceStore({ createObjectURL: () => {
    if (failURL) throw new Error("URL allocation failed");
    return `blob:test-${count++}`;
  }, revokeObjectURL: url => revoked.push(url) });
  return { store, revoked, fail: value => { failURL = value; } };
}
const derived = key => ({ key, mimeType: "video/mp4", bytes: new Blob(["proxy"], { type: "video/mp4" }),
  metadata: { width: 720, height: 404, duration: 1, fps: 30, rotation: 0, hasAudio: false } });
async function source(store) {
  const [value] = await store.stage([{ bytes: new Blob(["original"], { type: "video/mp4" }), mimeType: "video/mp4" }]);
  store.pin(value.sourceId);
  return value;
}
const clip = value => ({ sourceId: value.sourceId, type: "video", name: "clip", sourceWidth: 1920 });

test("originals stay frozen and derived leases survive eviction and replacement", async () => {
  const { store, revoked } = harness(), original = await source(store);
  assert.ok(Object.isFrozen(original));
  assert.throws(() => { original.bytes = new Blob(["changed"]); }, TypeError);
  const key = proxyKey(original);
  store.attachDerived(original.sourceId, derived(key));
  const lease = store.acquireDerived(original.sourceId, key);
  store.dropDerived(original.sourceId, key);
  store.syncPins([]);
  assert.ok(!revoked.includes(lease.url));
  assert.equal(await store.bytesFor(original.sourceId).text(), "original");
  lease.release();
  assert.ok(revoked.includes(lease.url));
  assert.equal(store.snapshot().sources.length, 0);
});
test("failed URL allocation rolls back both original and derived reference counts", async () => {
  const h = harness();
  const [value] = await h.store.stage([{ bytes: new Blob(["original"]), mimeType: "video/mp4" }]);
  h.fail(true);
  assert.throws(() => h.store.pin(value.sourceId));
  assert.equal(h.store.snapshot().sources[0].refs, 0);
  assert.deepEqual(h.store.snapshot().pinned, []);
  h.fail(false); h.store.pin(value.sourceId);
  h.store.attachDerived(value.sourceId, derived("preview"));
  h.fail(true); assert.throws(() => h.store.acquireDerived(value.sourceId, "preview"));
  assert.equal(h.store.snapshot().sources[0].refs, 1);
});
test("the idle queue retries only twice, publishes valid media and preserves original bytes", async () => {
  const { store } = harness(), original = await source(store);
  let attempts = 0;
  const queue = new ProxyQueue(store, async (source, key) => {
    assert.equal(source.sha256, original.sha256);
    if (++attempts === 1) throw new Error("transient fault");
    return derived(key);
  }, 0);
  queue.sync([clip(original)], false); await queue.idle();
  assert.equal(attempts, 2); assert.equal(queue.getSnapshot()[0].status, "ready");
  assert.ok(queue.urlFor(original.sourceId));
  assert.equal(await store.bytesFor(original.sourceId).text(), "original");
  queue.dispose();
  const broken = new ProxyQueue(store, async () => { attempts++; throw new Error("permanent"); }, 0);
  attempts = 0; broken.sync([clip(original)], false); await broken.idle();
  assert.equal(attempts, 2); assert.equal(broken.getSnapshot()[0].status, "failed");
  broken.dispose();
});
test("export pause and deletion cancel an active proxy before releasing its original", async () => {
  const { store } = harness(), original = await source(store);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const queue = new ProxyQueue(store, async (_, __, resources) => {
    entered(); await resources.wait(new Promise(() => {})); return derived("unreachable");
  }, 0);
  queue.sync([clip(original)], false); await started;
  queue.sync([clip(original)], true);
  queue.sync([], true); store.syncPins([]); await queue.idle();
  assert.equal(store.snapshot().sources.length, 0);
  assert.equal(queue.getSnapshot().length, 0); queue.dispose();
});
test("a source retired before queue acquisition fails boundedly without wedging later work", async () => {
  const { store } = harness(), original = await source(store);
  const external = store.acquire(original.sourceId, "active-export");
  const queue = new ProxyQueue(store, async (_, key) => derived(key), 0);
  queue.sync([clip(original)], false); store.syncPins([]);
  await queue.idle();
  assert.equal(queue.getSnapshot()[0].status, "failed");
  assert.equal(queue.getSnapshot()[0].attempts, 2);
  external.release(); queue.dispose();
  assert.equal(store.snapshot().sources.length, 0);
});
