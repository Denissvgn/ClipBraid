import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const { validateProjectMetadata, serializeProject, MAX_PROJECT_BYTES } = loadModule("services/project.ts");
const snapshot = { mediaAssets: [], audioTracks: [], aspectRatio: "16:9", fitMode: "contain", transitionDuration: 0.5, currentTime: 0 };
test("local metadata rejects malformed edits with the external project validator", () => {
  assert.deepEqual(validateProjectMetadata(snapshot), snapshot);
  for (const bad of [{ ...snapshot, fitMode: "stretch" }, { ...snapshot, currentTime: Infinity },
    { ...snapshot, mediaAssets: {} }, { ...snapshot, audioTracks: [{ id: "bad", duration: -1 }] }])
    assert.throws(() => validateProjectMetadata(bad));
});
test("download serialization rejects a document exceeding the reader's byte limit", async () => {
  const NativeBlob = globalThis.Blob;
  globalThis.Blob = class extends NativeBlob { get size() { return MAX_PROJECT_BYTES + 1; } };
  try { await assert.rejects(serializeProject(snapshot, async () => "unused"), /file is too large/); }
  finally { globalThis.Blob = NativeBlob; }
});
