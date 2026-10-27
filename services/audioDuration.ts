import { Input, BlobSource, ALL_FORMATS } from "mediabunny";
import { PlatformError } from "./platformError";
import { mp3Timing } from "./mp3Timing";
export async function recordedDuration(blob: Blob, signal?: AbortSignal): Promise<number> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: number) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); input.dispose();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new PlatformError("Recording cancelled.", "cancelled"));
    const timer = setTimeout(() => finish(new PlatformError("Recorded audio metadata timed out.", "transport")), 10000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void (async () => {
      try {
        const audio = await input.getPrimaryAudioTrack();
        if (!audio) throw new PlatformError("Recording has no audio stream.", "unsupported");
        const timing = await audio.getCodec() === "mp3" && await audio.getFirstTimestamp() === 0 ? await mp3Timing(blob) : null;
        const duration = timing?.duration ?? await audio.computeDuration();
        if (!Number.isFinite(duration) || duration <= 0) throw new PlatformError("Recording has no measurable duration.", "unsupported");
        finish(undefined, duration * 1000);
      } catch (error) { finish(error); }
    })();
  });
}
