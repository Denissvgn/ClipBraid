import { ExportResources } from "./exportJob";
export interface DecodedAudioChunk { timestamp: number; buffer: AudioBuffer }
/** At most one bounded batch is retained. Termination also closes stalled codecs. */
export async function decodeAudioInWorker(blob: Blob, from: number, to: number,
  resources: ExportResources, allowSilent = false, log: (message: string) => void = () => {}): Promise<DecodedAudioChunk[]> {
  resources.signal.throwIfAborted();
  const jobId = crypto.randomUUID();
  const worker = new Worker(new URL("./audio.worker.ts", import.meta.url), { type: "module" });
  const release = resources.own(() => {
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
  });
  try {
    return await resources.wait(new Promise<DecodedAudioChunk[]>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.jobId !== jobId) return;
        if (data.type === "log") log(data.message);
        if (data.type === "error") reject(new Error(data.error));
        if (data.type === "result") {
          try {
            resolve(data.chunks.map((chunk: { timestamp: number; sampleRate: number; channels: Float32Array[] }) => {
              const buffer = new AudioBuffer({ numberOfChannels: chunk.channels.length,
                length: chunk.channels[0].length, sampleRate: chunk.sampleRate });
              chunk.channels.forEach((pcm, channel) => buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, channel));
              return { timestamp: chunk.timestamp, buffer };
            }));
          } catch (error) { reject(error); }
        }
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error(event.message || "Audio worker failed")); };
      worker.onmessageerror = () => reject(new Error("Audio worker message failed"));
      worker.postMessage({ jobId, type: "decode", blob, from, to, allowSilent });
    }), release);
  } finally { await release(); }
}
