import { probeAsset } from "./mediaProbe";
import type { ExportSnapshot } from "./exportJob";
const scope = self as unknown as { onmessage: (event: MessageEvent) => void; postMessage(message: unknown): void };
scope.onmessage = async ({ data }: MessageEvent<{ jobId: string; snapshot: ExportSnapshot; sources: [string, Blob][] }>) => {
  const sources = new Map(data.sources), inventories = [];
  for (const asset of [...data.snapshot.mediaAssets, ...data.snapshot.audioTracks]) {
    scope.postMessage({ jobId: data.jobId, type: "begin", id: asset.id, name: asset.name });
    try {
      const blob = sources.get(asset.sourceId);
      if (!blob) throw new Error("Missing original source.");
      inventories.push(await probeAsset(asset, blob));
      scope.postMessage({ jobId: data.jobId, type: "asset", id: asset.id, name: asset.name });
    } catch (error) {
      scope.postMessage({ jobId: data.jobId, type: "error", error: `Cannot use ${asset.name} (${asset.id}): ${String(error)}` }); return;
    }
  }
  scope.postMessage({ jobId: data.jobId, type: "result", inventories });
};
