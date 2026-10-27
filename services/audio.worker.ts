import { Input, BlobSource, ALL_FORMATS, AudioSampleSink } from "mediabunny";
import { registerAc3Decoder } from "@mediabunny/ac3";
import { mp3Timing } from "./mp3Timing";
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
    const isMp3 = (await track.getCodec()) === "mp3";
    const timing = isMp3 && await track.getFirstTimestamp() === 0 ? await mp3Timing(blob) : null;
    const delay = timing ? timing.delaySamples / timing.sampleRate : 0;
    const chunks: { timestamp: number; sampleRate: number; channels: Float32Array[] }[] = [];
    const transfer: Transferable[] = [];
    workerScope.postMessage({ jobId, type: "log", message: "Decoding audio samples" });
    // MP3 seeks need bounded reservoir/filterbank preroll, even without a tag.
    const decodeFrom = Math.max(0, from + delay - (isMp3 ? .5 : 0));
    const decodeTo = Math.min(to, timing?.duration ?? Infinity) + delay;
    for await (const sample of new AudioSampleSink(track).samples(decodeFrom, decodeTo)) {
      try {
        const timestamp = sample.timestamp - delay;
        const first = timing ? Math.max(0, Math.ceil(-timestamp * sample.sampleRate - 1e-6)) : 0;
        const end = timing ? Math.min(sample.numberOfFrames, Math.ceil((timing.duration - timestamp) * sample.sampleRate - 1e-6)) : sample.numberOfFrames;
        if (end <= first) continue;
        const channels = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
          const decoded = new Float32Array(sample.numberOfFrames);
          sample.copyTo(decoded, { planeIndex, format: "f32-planar" });
          for (const value of decoded) if (!Number.isFinite(value)) throw new Error("Decoded audio contains non-finite samples.");
          const pcm = first || end !== decoded.length ? decoded.slice(first, end) : decoded;
          transfer.push(pcm.buffer); return pcm;
        });
        chunks.push({ timestamp: timestamp + first / sample.sampleRate, sampleRate: sample.sampleRate, channels });
      } finally { sample.close(); }
    }
    workerScope.postMessage({ jobId, type: "result", chunks }, transfer);
  } catch (error) { workerScope.postMessage({ jobId, type: "error", error: String(error) }); }
  finally { input.dispose(); }
};
