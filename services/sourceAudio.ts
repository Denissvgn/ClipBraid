import { Input, BlobSource, ALL_FORMATS } from "mediabunny";
import type { ExportSnapshot } from "./exportJob";
import type { AssetInventory } from "./mediaProbe";

/** Detect source metadata without decoding. Unreadable drafts remain relinkable. */
export function sourceHasAudio(blob: Blob, signal?: AbortSignal): Promise<boolean> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); input.dispose();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal?.reason ?? new DOMException("Source check cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Source audio metadata timed out.")), 10000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void input.getAudioTracks().then(tracks => finish(undefined, tracks.length > 0), error => finish(error));
  });
}

/** Technical flags are observations; mute and gain remain the user's choices. */
export function resolveSourceAudio(snapshot: ExportSnapshot, inventory: AssetInventory[]): ExportSnapshot {
  const byId = new Map(inventory.filter(asset => asset.kind === "video").map(asset => [asset.id, asset]));
  const mediaAssets = snapshot.mediaAssets.map(asset => {
    if (asset.type !== "video") return asset;
    const actual = byId.get(asset.id);
    if (!actual || actual.sourceId !== asset.sourceId) throw new Error("Missing source audio inventory.");
    return Object.freeze({ ...asset, hasAudio: !!actual.audio });
  });
  Object.freeze(mediaAssets);
  return Object.freeze({ ...snapshot, mediaAssets });
}
