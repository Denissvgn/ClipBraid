import type { AssetInventory } from "./mediaProbe";
import { estimateExport, exportFrameRate, type ExportQuality } from "./timeline";
export interface OutputProfile {
  width: number; height: number; fps: number; fpsNumerator: number; fpsDenominator: number;
  frames: number; duration: number; videoBitrate: number; audioBitrate: number;
  conversions: string[];
}
export function outputProfile(quality: ExportQuality, aspect: "16:9" | "9:16" | "1:1", duration: number,
  assets: AssetInventory[]): OutputProfile {
  const base = quality === "draft" ? 480 : 720, wide = quality === "draft" ? 854 : 1280;
  const [width, height] = aspect === "1:1" ? [base, base] : aspect === "9:16" ? [base, wide] : [wide, base];
  const actual = assets.filter(asset => asset.kind === "video").map(asset => asset.video!.fps);
  const selected = exportFrameRate(Math.max(0, ...actual));
  const canonical = [[24000, 1001], [24, 1], [30000, 1001], [30, 1], [12, 1]]
    .find(([num, den]) => Math.abs(num / den - selected) < 0.001);
  const [fpsNumerator, fpsDenominator] = canonical ?? [Math.round(selected * 1_000_000), 1_000_000];
  const fps = fpsNumerator / fpsDenominator, frames = Math.max(1, Math.ceil(duration * fps - 1e-9));
  const conversions = ["AVC video and 44.1 kHz stereo AAC; square pixels; browser-managed SDR sRGB conversion"];
  if (actual.some(rate => rate > 30.001 || Math.abs(rate - fps) > 0.001)) conversions.push(`Source frame rates are sampled onto ${fpsNumerator}/${fpsDenominator} CFR`);
  if (assets.some(asset => asset.video?.variableFrameRate)) conversions.push("Variable-rate sources are sampled onto a constant output grid");
  if (assets.some(asset => asset.video && (asset.video.width !== width || asset.video.height !== height))) conversions.push(`Sources are framed/resized to ${width}×${height}`);
  return { width, height, fps, fpsNumerator, fpsDenominator, frames, duration: frames / fps,
    ...estimateExport(quality, duration), conversions };
}
export function frameSegments(profile: OutputProfile, count = 2) {
  const split = count === 1 || profile.frames < 2 ? [0, profile.frames] : [0, Math.floor(profile.frames / 2), profile.frames];
  return split.slice(0, -1).map((frameStart, index) => ({ index, frameStart, frameEnd: split[index + 1],
    start: frameStart / profile.fps, end: split[index + 1] / profile.fps }));
}
