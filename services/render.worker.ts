import { createRenderer, type RenderSettings } from "./renderSegment";
import type { MediaAsset } from "../types";
const nativeDecoder = globalThis.VideoDecoder, nativeEncoder = globalThis.VideoEncoder;
const decoders = new Set<VideoDecoder>(), encoders = new Set<VideoEncoder>();
let decodersCreated = 0, encodersCreated = 0;
if (nativeDecoder) globalThis.VideoDecoder = class extends nativeDecoder {
  constructor(init: VideoDecoderInit) {
    let instance: VideoDecoder;
    super({ ...init, error: error => { decoders.delete(instance); init.error(error); } });
    instance = this; decoders.add(this); decodersCreated++;
  }
  close() { decoders.delete(this); if (this.state !== "closed") super.close(); }
};
if (nativeEncoder) globalThis.VideoEncoder = class extends nativeEncoder {
  constructor(init: VideoEncoderInit) {
    let instance: VideoEncoder;
    super({ ...init, error: error => { encoders.delete(instance); init.error(error); } });
    instance = this; encoders.add(this); encodersCreated++;
  }
  close() { encoders.delete(this); if (this.state !== "closed") super.close(); }
};
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
    progress => workerScope.postMessage({ jobId, type: "progress", progress }),
    point => workerScope.postMessage({ jobId, type: "diagnostic", point: { ...point,
      decodersCreated, decodersActive: decoders.size, encodersCreated, encodersActive: encoders.size } }));
    const bytes = await render(start, end, index);
    workerScope.postMessage({ jobId, type: "result", bytes }, [bytes.buffer]);
  } catch (error) {
    workerScope.postMessage({ jobId, type: "error", error: String(error) });
  }
};
