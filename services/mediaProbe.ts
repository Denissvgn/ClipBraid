import { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink } from "mediabunny";
import { registerAc3Decoder } from "@mediabunny/ac3";
import type { MediaAsset, AudioFragment } from "../types";
import { sourceWindow } from "./timeline";
import { trackGain } from "./mixing";
registerAc3Decoder();
export interface AssetInventory {
  id: string; sourceId: string; name: string; kind: "image" | "video" | "audio";
  mimeType: string; byteLength: number; duration: number | null;
  video?: { width: number; height: number; rotation: number; codec: string; fps: number; firstTimestamp: number; endTimestamp: number; pixelAspectRatio: { num: number; den: number }; variableFrameRate?: boolean; colorSpace?: VideoColorSpaceInit };
  audio?: { codec: string; decodable: boolean; firstTimestamp: number; endTimestamp: number };
}
export async function probeAsset(asset: MediaAsset | AudioFragment, blob: Blob): Promise<AssetInventory> {
  const kind = "type" in asset ? asset.type : "audio";
  const result: AssetInventory = { id: asset.id, sourceId: asset.sourceId, name: asset.name, kind,
    mimeType: blob.type || asset.mimeType, byteLength: blob.size, duration: null };
  if (!blob.size) throw new Error("Empty source.");
  if (kind === "image") {
    const image = await createImageBitmap(blob);
    try {
      if (!image.width || !image.height || image.width * image.height > 32_000_000) throw new Error("Image geometry exceeds the supported 32-megapixel limit.");
      result.video = { width: image.width, height: image.height, rotation: 0, codec: "image", fps: 0,
        firstTimestamp: 0, endTimestamp: asset.duration, pixelAspectRatio: { num: 1, den: 1 } };
      return result;
    } finally { image.close(); }
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    result.duration = await input.computeDuration();
    if (!Number.isFinite(result.duration) || result.duration <= 0) throw new Error("Invalid source duration.");
    if (kind === "video") {
      const clip = asset as MediaAsset, track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error("Missing or unsupported video track.");
      const metrics = await track.computeFrameRateMetrics({ targetPacketCount: 256 }), fps = metrics.bestGuessFrameRate;
      if (await track.hasHighDynamicRange()) throw new Error("Wide-gamut/HDR video requires conversion to SDR before import.");
      const colorSpace = await track.getColorSpace();
      const firstTimestamp = await track.getFirstTimestamp(), endTimestamp = await track.computeDuration();
      const window = sourceWindow(clip), end = Math.min(window.end, window.start + clip.duration);
      const tolerance = 1 / (fps > 0 ? fps : 30) + 1e-6;
      if (window.start < firstTimestamp - tolerance || end > endTimestamp + tolerance)
        throw new Error(`Selected video interval ${window.start.toFixed(3)}–${end.toFixed(3)}s is outside source ${firstTimestamp.toFixed(3)}–${endTimestamp.toFixed(3)}s.`);
      const sink = new VideoSampleSink(track);
      const times = [Math.max(firstTimestamp, window.start), Math.max(window.start, Math.min(endTimestamp, end) - tolerance)];
      const samples = sink.samplesAtTimestamps(times);
      try { for await (const sample of samples) {
        if (!sample) throw new Error("No decoded video frame in the selected interval.");
        try {
          result.video = { width: sample.displayWidth, height: sample.displayHeight, rotation: sample.rotation,
            codec: String(await track.getCodec()), fps, firstTimestamp, endTimestamp, colorSpace,
            variableFrameRate: !metrics.frameRateIsConstant,
            pixelAspectRatio: sample.pixelAspectRatio ?? { num: 1, den: 1 } };
        } finally { sample.close(); }
      } } finally { await samples.return(); }
      if (!result.video || result.video.width <= 0 || result.video.height <= 0 || result.video.width * result.video.height > 32_000_000)
        throw new Error("Unsupported video geometry.");
    }
    const audio = await input.getPrimaryAudioTrack();
    if (!audio && kind === "audio") throw new Error("Missing audio track.");
    if (audio) {
      const decodable = await audio.canDecode(), firstTimestamp = await audio.getFirstTimestamp(), endTimestamp = await audio.computeDuration();
      result.audio = { codec: String(await audio.getCodec()), decodable, firstTimestamp, endTimestamp };
      const required = trackGain(asset) > 0 && (kind === "audio" || ((asset as MediaAsset).hasAudio && !(asset as MediaAsset).muted));
      if (required) {
        if (!decodable) throw new Error("Unsupported audio codec.");
        const start = kind === "video" ? (asset as MediaAsset).trimStart : 0, end = Math.min(endTimestamp, start + asset.duration);
        if (end > Math.max(start, firstTimestamp)) {
          const samples = new AudioSampleSink(audio).samplesAtTimestamps([Math.max(start, firstTimestamp), Math.max(start, end - 0.05)]);
          try { for await (const sample of samples) { if (!sample) throw new Error("No decoded audio in the selected interval."); sample.close(); } }
          finally { await samples.return(); }
        }
      }
    }
    return result;
  } finally { input.dispose(); }
}
