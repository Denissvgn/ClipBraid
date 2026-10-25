import { createRenderer, type RenderSettings } from "./renderSegment";
import type { MediaAsset } from "../types";
const workerScope = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
workerScope.onmessage = async ({ data }: MessageEvent<{
  jobId: string; media: MediaAsset[]; settings: RenderSettings;
  sources: [string, Blob][]; start: number; end: number; index: number;
}>) => {
  const { jobId, media, settings, start, end, index } = data;
  const sources = new Map(data.sources);
  try {
    const render = createRenderer(media, settings, async id => {
      const blob = sources.get(id);
      if (!blob) throw new Error("Missing worker source.");
      return blob;
    }, message => workerScope.postMessage({ jobId, type: "log", message }),
    progress => workerScope.postMessage({ jobId, type: "progress", progress }));
    const bytes = await render(start, end, index);
    workerScope.postMessage({ jobId, type: "result", bytes }, [bytes.buffer]);
  } catch (error) {
    workerScope.postMessage({ jobId, type: "error", error: String(error) });
  }
};
