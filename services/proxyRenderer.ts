import { Input, BlobSource, ALL_FORMATS } from "mediabunny";
import { createFFmpegService } from "./ffmpegService";
import type { ExportResources } from "./exportJob";
import type { SourceAsset, DerivedMedia } from "./mediaSources";

async function inventory(blob: Blob, resources: ExportResources) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const release = resources.own(() => input.dispose());
  try {
    const video = await resources.wait(input.getPrimaryVideoTrack(), release);
    if (!video || !(await resources.wait(video.canDecode(), release))) throw new Error("No decodable video track.");
    return {
      width: await resources.wait(video.getDisplayWidth(), release),
      height: await resources.wait(video.getDisplayHeight(), release),
      rotation: await resources.wait(video.getRotation(), release),
      duration: await resources.wait(input.computeDuration(), release),
      fps: (await resources.wait(video.computeFrameRateMetrics({ targetPacketCount: 128 }), release)).bestGuessFrameRate,
      hasAudio: (await resources.wait(input.getAudioTracks(), release)).length > 0,
    };
  } finally { await release(); }
}

export async function renderProxy(source: SourceAsset, key: string, resources: ExportResources): Promise<DerivedMedia> {
  if (source.bytes.size > 64 * 1024 * 1024) throw new Error("Preview optimization supports originals up to 64 MiB; use the original preview for this file.");
  const service = createFFmpegService();
  const release = resources.own(() => service.terminate());
  const original = await inventory(source.bytes, resources);
  await resources.wait(service.load(), release);
  try {
    resources.signal.throwIfAborted();
    await service.writeFile("original", new Uint8Array(await source.bytes.arrayBuffer()));
    await service.exec(["-i", "original", "-vf", "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-r", String(Math.min(30, original.fps || 30)), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-an", "-metadata:s:v:0", "rotate=0", "-movflags", "+faststart", "-y", "preview.mp4"]);
    const bytes = await service.readFile("preview.mp4") as Uint8Array<ArrayBuffer>;
    resources.signal.throwIfAborted();
    const blob = new Blob([bytes], { type: "video/mp4" });
    const metadata = await inventory(blob, resources);
    if (blob.type !== "video/mp4" || metadata.hasAudio || metadata.rotation !== 0 ||
      metadata.width <= 0 || metadata.height <= 0 || Math.max(metadata.width, metadata.height) > 720 ||
      Math.abs(metadata.width / metadata.height - original.width / original.height) > 0.025 ||
      Math.abs(metadata.duration - original.duration) > Math.max(0.1, 2 / metadata.fps) ||
      !Number.isFinite(metadata.fps) || metadata.fps <= 0 || metadata.fps > 30.01)
      throw new Error("Preview metadata did not match the original.");
    return { key, mimeType: "video/mp4", bytes: blob, metadata };
  } finally {
    for (const name of ["original", "preview.mp4"]) try { await service.deleteFile(name); } catch {}
    await release();
  }
}
