import { Input, BlobSource, ALL_FORMATS, AudioSampleSink } from "mediabunny";
import { registerAc3Decoder } from "@mediabunny/ac3";
registerAc3Decoder();
const workerScope = self as unknown as { onmessage: (event: MessageEvent) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void };
workerScope.onmessage = async ({ data }: MessageEvent<{
  jobId: string; blob: Blob; from: number; to: number; allowSilent: boolean;
}>) => {
  const { jobId, blob, from, to, allowSilent } = data;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      if (allowSilent) { workerScope.postMessage({ jobId, type: "result", chunks: [] }); return; }
      throw new Error("Missing audio track");
    }
    if (!(await track.canDecode())) throw new Error("Unsupported audio codec");
    const chunks: { timestamp: number; sampleRate: number; channels: Float32Array[] }[] = [];
    const transfer: Transferable[] = [];
    workerScope.postMessage({ jobId, type: "log", message: "Decoding audio samples" });
    for await (const sample of new AudioSampleSink(track).samples(from, to)) {
      try {
        const channels = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
          const pcm = new Float32Array(sample.numberOfFrames);
          sample.copyTo(pcm, { planeIndex, format: "f32-planar" });
          transfer.push(pcm.buffer); return pcm;
        });
        chunks.push({ timestamp: sample.timestamp, sampleRate: sample.sampleRate, channels });
      } finally { sample.close(); }
    }
    workerScope.postMessage({ jobId, type: "result", chunks }, transfer);
  } catch (error) { workerScope.postMessage({ jobId, type: "error", error: String(error) }); }
  finally { input.dispose(); }
};
