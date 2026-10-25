import type { ExportSnapshot, ExportContext } from "./exportJob";
import type { RenderSettings } from "./renderSegment";

export async function renderInWorker(snapshot: ExportSnapshot, settings: RenderSettings,
  start: number, end: number, index: number, context: ExportContext): Promise<Uint8Array> {
  context.resources.signal.throwIfAborted();
  const sources: [string, Blob][] = [];
  for (const id of new Set(snapshot.mediaAssets.map(asset => asset.sourceId)))
    sources.push([id, await context.getBlob(id)]);
  context.resources.signal.throwIfAborted();
  const worker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
  const release = context.resources.own(() => {
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
    worker.terminate();
  });
  try {
    return await context.resources.wait(new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.jobId !== context.jobId) return;
        if (data.type === "log") context.addLog(data.message);
        if (data.type === "progress") context.setExportProgress(data.progress);
        if (data.type === "diagnostic") context.diagnostic(data.point);
        if (data.type === "result") resolve(data.bytes);
        if (data.type === "error") reject(new Error(data.error));
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error(event.message || "Renderer worker failed")); };
      worker.onmessageerror = () => reject(new Error("Renderer worker message failed"));
      worker.postMessage({ jobId: context.jobId, type: "render", media: snapshot.mediaAssets,
        settings, sources, start, end, index });
    }), release);
  } finally { await release(); }
}
