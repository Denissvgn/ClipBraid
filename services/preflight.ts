import type { ExportSnapshot, ExportContext } from "./exportJob";
import type { AssetInventory } from "./mediaProbe";
export async function preflightAssets(snapshot: ExportSnapshot, context: ExportContext): Promise<AssetInventory[]> {
  const sources: [string, Blob][] = [];
  for (const id of new Set([...snapshot.mediaAssets, ...snapshot.audioTracks].map(asset => asset.sourceId))) sources.push([id, await context.getBlob(id)]);
  context.resources.signal.throwIfAborted();
  const worker = new Worker(new URL("./preflight.worker.ts", import.meta.url), { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = context.resources.own(() => { clearTimeout(timer); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); });
  try {
    return await context.resources.wait(new Promise<AssetInventory[]>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.jobId !== context.jobId) return;
        if (data.type === "begin") {
          clearTimeout(timer); context.addLog(`Checking media: ${data.name}`);
          timer = setTimeout(() => context.resources.abort(Object.assign(new Error(`Media check timed out: ${data.name}`), { category: "asset", assetId: data.id })), 15_000);
        }
        if (data.type === "asset") { clearTimeout(timer); context.addLog(`Media checked: ${data.name}`); }
        if (data.type === "error") reject(Object.assign(new Error(data.error), { category: "asset", assetId: data.assetId }));
        if (data.type === "result") resolve(data.inventories);
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error(event.message || "Media check worker failed")); };
      worker.onmessageerror = () => reject(new Error("Media check response failed"));
      worker.postMessage({ jobId: context.jobId, snapshot, sources });
    }), release);
  } finally { await release(); }
}
