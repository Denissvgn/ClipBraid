import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadModule } from "../source-probes.mjs";

const { MediaSourceStore, sourceChecksum } = loadModule(
  "services/mediaSources.ts",
);
const { parseProject, serializeProject } = loadModule("services/project.ts");

// Deterministic URL recorder; the store must be the only URL owner.
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

test("staged originals are immutable byte handles with checksums and revisions", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const bytes = bytesOf("original-bytes");
  const [asset] = await store.stage([{ bytes, mimeType: "video/mp4" }]);
  assert.equal(asset.revision, 1);
  assert.equal(asset.byteLength, bytes.size);
  assert.equal(
    asset.sha256,
    createHash("sha256").update("original-bytes").digest("hex"),
  );
  assert.equal(await asset.bytes.text(), "original-bytes");
  assert.equal(await sourceChecksum(bytes), asset.sha256);
  // Staging allocates no URL; ownership starts at the first reference.
  assert.equal(urls.created.length, 0);
  assert.equal(store.bytesFor(asset.sourceId), bytes);
});

test("identical bytes in one batch share one source while clip state stays independent", async () => {
  const store = new MediaSourceStore(fakeUrls().api);
  const [a, b, c] = await store.stage([
    { bytes: bytesOf("shared"), mimeType: "video/mp4" },
    { bytes: bytesOf("shared"), mimeType: "video/mp4" },
    { bytes: bytesOf("other"), mimeType: "video/mp4" },
  ]);
  assert.equal(a.sourceId, b.sourceId);
  assert.notEqual(a.sourceId, c.sourceId);
  assert.equal(store.snapshot().sources.length, 2);
  // Repeated-source clip instances keep independent edit state by construction.
  const clips = [
    { id: "clip-1", sourceId: a.sourceId, trimStart: 0.1, trimEnd: 0.2 },
    { id: "clip-2", sourceId: b.sourceId, trimStart: 0.5, trimEnd: 0 },
  ];
  clips[0].trimStart = 0.9;
  assert.equal(clips[1].trimStart, 0.5);
});

test("object URLs are created and revoked only through explicit references", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const [asset] = await store.stage([
    { bytes: bytesOf("a"), mimeType: "image/png" },
  ]);
  store.pin(asset.sourceId);
  assert.equal(urls.created.length, 1);
  assert.ok(store.urlFor(asset.sourceId));
  store.syncPins([]);
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
  assert.equal(store.urlFor(asset.sourceId), undefined);
  // A disposed, unreferenced source is purged with its bytes.
  assert.equal(store.snapshot().sources.length, 0);
});

test("a job lease keeps media alive through project replacement and deletion", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const [asset] = await store.stage([
    { bytes: bytesOf("job"), mimeType: "video/mp4" },
  ]);
  store.pin(asset.sourceId);
  const lease = store.acquire(asset.sourceId, "export");
  // Replace the project and delete the source outright.
  store.syncPins([]);
  store.remove(asset.sourceId);
  assert.deepEqual(urls.revoked, []);
  assert.ok(store.urlFor(asset.sourceId));
  assert.equal(await store.bytesFor(asset.sourceId).text(), "job");
  // Only the job's release may revoke the media it still reads.
  lease.release();
  lease.release(); // idempotent
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
  assert.equal(store.snapshot().sources.length, 0);
});

test("acquireAll holds every source of a job and releases partial leases on failure", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  const [a, b] = await store.stage([
    { bytes: bytesOf("a"), mimeType: "video/mp4" },
    { bytes: bytesOf("b"), mimeType: "audio/wav" },
  ]);
  const leases = store.acquireAll(
    [a.sourceId, b.sourceId, a.sourceId],
    "export",
  );
  assert.equal(leases.length, 2);
  assert.equal(urls.created.length, 2);
  assert.throws(() => store.acquireAll([a.sourceId, "missing"], "export"));
  for (const lease of leases) lease.release();
  assert.equal(urls.revoked.length, 2);
});

test("a failed staging batch is disposed without leaking sources or URLs", async () => {
  const urls = fakeUrls();
  const store = new MediaSourceStore(urls.api);
  await assert.rejects(
    () =>
      store.stage([
        { bytes: bytesOf("fine"), mimeType: "video/mp4" },
        { bytes: new Blob([]), mimeType: "video/mp4" },
      ]),
    /Empty media data/,
  );
  assert.deepEqual(store.snapshot(), { sources: [], pinned: [] });
  assert.deepEqual(urls.created, []);
});

test("derived media hangs off its source and is dropped with it", async () => {
  const store = new MediaSourceStore(fakeUrls().api);
  const [asset] = await store.stage([
    { bytes: bytesOf("src"), mimeType: "video/mp4" },
  ]);
  store.attachDerived(asset.sourceId, {
    key: "proxy:480p",
    mimeType: "video/mp4",
    bytes: bytesOf("proxy"),
  });
  assert.equal(store.derivedFor(asset.sourceId, "proxy:480p").bytes.size, 5);
  assert.deepEqual(store.snapshot().sources[0].derived, ["proxy:480p"]);
  store.dropDerived(asset.sourceId, "proxy:480p");
  assert.equal(store.derivedFor(asset.sourceId, "proxy:480p"), undefined);
  store.attachDerived(asset.sourceId, {
    key: "proxy:480p",
    mimeType: "video/mp4",
    bytes: bytesOf("proxy"),
  });
  store.remove(asset.sourceId);
  assert.equal(store.snapshot().sources.length, 0);
});

test("serialization keeps source bytes identical and repeated sources share one payload", async () => {
  const store = new MediaSourceStore(fakeUrls().api);
  const [a, b] = await store.stage([
    { bytes: bytesOf("repeated-bytes"), mimeType: "video/mp4" },
    { bytes: bytesOf("repeated-bytes"), mimeType: "video/mp4" },
  ]);
  assert.equal(a.sourceId, b.sourceId);
  const clip = {
    id: "clip",
    mediaId: "media",
    sourceId: a.sourceId,
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
  const toBase64 = async (sourceId) =>
    Buffer.from(await store.bytesFor(sourceId).arrayBuffer()).toString(
      "base64",
    );
  const text = await serializeProject(
    {
      mediaAssets: [
        { ...clip, id: "one" },
        { ...clip, id: "two", trimStart: 0.5, duration: 0.5 },
      ],
      audioTracks: [],
      aspectRatio: "16:9",
      fitMode: "contain",
      transitionDuration: 0.5,
      currentTime: 0.25,
    },
    toBase64,
  );
  const saved = JSON.parse(text);
  for (const entry of saved.mediaAssets) {
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(entry.base64, "base64"))
        .digest("hex"),
      a.sha256,
    );
    assert.equal(entry.sourceId, undefined); // runtime-only field is not persisted
  }
  const parsed = parseProject(text);
  assert.equal(parsed.sources.length, 1); // repeated payload deduped to one source
  assert.equal(parsed.mediaAssets[0].sourceId, parsed.mediaAssets[1].sourceId);
  assert.equal(parsed.currentTime, 0.25);
  assert.equal(parsed.transitionDuration, 0.5);
});


