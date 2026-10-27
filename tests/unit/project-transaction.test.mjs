import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";

const { MediaSourceStore } = loadModule("services/mediaSources.ts");
const { serializeProject, parseProject } = loadModule("services/project.ts");

// Deterministic URL ledger: before/after resource snapshots are the evidence
// that a transaction releases exactly what it owns, in either direction.
function fakeUrls() {
  const created = [];
  const revoked = [];
  return {
    created,
    revoked,
    api: {
      createObjectURL(blob) {
        const url = `blob:test-${created.length}`;
        created.push({ url, bytes: blob.size });
        return url;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  };
}

const bytesOf = (text) => new Blob([new TextEncoder().encode(text)]);
const media = (text) => ({ bytes: bytesOf(text), mimeType: "video/mp4" });

async function liveProject(store, text = "old-project") {
  const [asset] = await store.stage([media(text)]);
  store.pin(asset.sourceId);
  return asset;
}

test("a probe failure rolls back staged sources and leases without touching the live project", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const old = await liveProject(store);
  const before = store.snapshot();
  const createdBefore = urls.created.length;

  const tx = store.beginTransaction();
  const [a, b] = await tx.stage([media("new-a"), media("new-b")]);
  tx.acquire(a.sourceId, "import-probe");
  tx.acquire(b.sourceId, "import-probe");
  const stagedUrls = urls.created.slice(createdBefore).map((entry) => entry.url);
  assert.equal(stagedUrls.length, 2);
  assert.equal(store.snapshot().sources.length, 3);
  // Injected probe failure: nothing was committed, so everything staged by
  // this transaction is disposed and the old project keeps its bytes and URL.
  tx.rollback();

  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual([...urls.revoked].sort(), [...stagedUrls].sort());
  assert.ok(!urls.revoked.includes(store.urlFor(old.sourceId)));
  assert.equal(await store.bytesFor(old.sourceId).text(), "old-project");

  tx.rollback(); // idempotent, never throws
  assert.deepEqual(store.snapshot(), before);
  await assert.rejects(() => tx.stage([media("late")]), /already settled/);
  assert.throws(() => tx.commit(), /already settled/);
});

test("a commit-phase failure after pre-pinning restores pins and disposes only staged sources", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const old = await liveProject(store);
  const oldUrl = store.urlFor(old.sourceId);
  const before = store.snapshot();

  const tx = store.beginTransaction();
  const [asset] = await tx.stage([media("replacement")]);
  tx.pin(asset.sourceId);
  tx.pin(asset.sourceId); // one transaction pin, however often it is requested
  tx.pin(old.sourceId); // already live-owned: not this transaction's reference
  assert.equal(store.snapshot().sources.length, 2);
  // Injected commit failure: the new state never published.
  tx.rollback();

  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.urlFor(old.sourceId), oldUrl);
  assert.ok(!urls.revoked.includes(oldUrl));
  assert.equal(store.bytesFor(asset.sourceId), undefined);
  assert.ok(urls.revoked.length > 0); // the staged URL was reclaimed, not leaked
});

test("commit publishes staged sources and old resources release only after the state swap", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const old = await liveProject(store);
  const oldUrl = store.urlFor(old.sourceId);

  const tx = store.beginTransaction();
  const [asset] = await tx.stage([media("committed")]);
  const probe = tx.acquire(asset.sourceId, "load-probe");
  tx.pin(asset.sourceId);
  tx.commit(); // hands pins to the live project, releases the probe lease

  assert.equal(store.urlFor(asset.sourceId), probe.url);
  assert.equal(store.snapshot().sources.length, 2);
  assert.ok(!urls.revoked.includes(oldUrl)); // old project still usable here
  tx.rollback(); // committed work is never rolled back
  assert.equal(store.bytesFor(asset.sourceId) !== undefined, true);

  store.syncPins([asset.sourceId]); // the committed state swap releases the old source
  assert.deepEqual(urls.revoked, [oldUrl]);
  assert.equal(store.bytesFor(old.sourceId), undefined);
  assert.deepEqual(store.snapshot().pinned, [asset.sourceId]);
  assert.throws(() => tx.commit(), /already settled/);
});

test("independent transactions settle without revoking or leaking each other's sources", async () => {
  const store = new MediaSourceStore(fakeUrls().api);
  const a = store.beginTransaction();
  const b = store.beginTransaction();
  const [sourceA] = await a.stage([media("tx-a")]);
  const [sourceB] = await b.stage([media("tx-b")]);
  b.pin(sourceB.sourceId);
  b.commit();
  a.rollback();

  assert.equal(store.bytesFor(sourceA.sourceId), undefined);
  assert.equal(store.bytesFor(sourceB.sourceId) !== undefined, true);
  assert.deepEqual(store.snapshot().pinned, [sourceB.sourceId]);
  store.syncPins([sourceB.sourceId]);
  assert.equal(store.snapshot().sources.length, 1);
});

test("an injected staging read failure disposes the partial batch inside a transaction", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const tx = store.beginTransaction();
  const unreadable = {
    size: 3,
    arrayBuffer: async () => {
      throw new Error("injected read failure");
    },
  };
  await assert.rejects(
    () =>
      tx.stage([
        media("staged-before-failure"),
        { bytes: unreadable, mimeType: "video/mp4" },
      ]),
    /injected read failure/,
  );
  tx.rollback();
  assert.deepEqual(store.snapshot(), { sources: [], pinned: [] });
  assert.deepEqual(urls.created, []);
  assert.deepEqual(urls.revoked, []);
});

test("a leased save snapshot keeps identical bytes through mid-save project replacement", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const old = await liveProject(store, "snapshot-bytes");
  const oldUrl = store.urlFor(old.sourceId);
  const clip = {
    id: "clip",
    mediaId: "media",
    sourceId: old.sourceId,
    mimeType: "video/mp4",
    type: "video",
    name: "clip.mp4",
    duration: 1,
    originalDuration: 1,
    startTime: 0,
    trimStart: 0,
    trimEnd: 0,
    filter: "none",
    transitionDuration: 0,
    hasAudio: true,
    muted: false,
    normalized: false,
  };
  const snapshot = {
    mediaAssets: [clip],
    audioTracks: [],
    aspectRatio: "16:9",
    fitMode: "contain",
    transitionDuration: 0.5,
    currentTime: 0.5,
  };
  const leases = store.acquireAll([old.sourceId], "project-save");
  let replacements = 0;
  const text = await serializeProject(snapshot, async (sourceId) => {
    // The live project is replaced while the save is still reading bytes.
    store.syncPins([]);
    replacements += 1;
    const bytes = store.bytesFor(sourceId);
    assert.ok(bytes, "leased snapshot bytes must survive replacement");
    return Buffer.from(await bytes.arrayBuffer()).toString("base64");
  });
  assert.equal(replacements, 1);
  assert.equal(store.bytesFor(old.sourceId) !== undefined, true); // lease holds it
  assert.ok(!urls.revoked.includes(oldUrl));
  const parsed = parseProject(text);
  assert.equal(parsed.sources.length, 1);
  assert.equal(
    Buffer.from(parsed.sources[0].base64, "base64").toString(),
    "snapshot-bytes",
  );

  for (const lease of leases) lease.release();
  assert.deepEqual(urls.revoked, [oldUrl]); // released exactly when the job ends
  assert.deepEqual(store.snapshot(), { sources: [], pinned: [] });
});
