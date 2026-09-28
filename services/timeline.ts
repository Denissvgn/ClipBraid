import type { MediaAsset, AudioFragment } from "../types";

export function projectDuration(
  media: MediaAsset[],
  audio: AudioFragment[],
): number {
  const end = (max: number, asset: { startTime: number; duration: number }) =>
    Math.max(max, asset.startTime + asset.duration);
  return Math.max(media.reduce(end, 1), audio.reduce(end, 1));
}

export function nextAssets(
  media: MediaAsset[],
): Map<string, MediaAsset | undefined> {
  const ordered = [...media].sort((a, b) => a.startTime - b.startTime);
  return new Map(ordered.map((asset, index) => [asset.id, ordered[index + 1]]));
}

// Weights are used with additive compositing in both preview and export, so
// a crossfade does not darken when the two half-opacity layers overlap.
export function clipOpacity(
  asset: MediaAsset,
  time: number,
  next?: MediaAsset,
): number {
  const local = time - asset.startTime;
  if (local < 0 || local >= asset.duration) return 0;
  let weight = 1;
  if (asset.transitionDuration && local < asset.transitionDuration) {
    weight = local / asset.transitionDuration;
  }
  if (next?.transitionDuration) {
    const overlap = Math.min(
      next.transitionDuration,
      asset.startTime + asset.duration - next.startTime,
    );
    const elapsed = time - next.startTime;
    if (overlap > 0 && elapsed >= 0)
      weight = Math.min(weight, 1 - elapsed / overlap);
  }
  return Math.max(0, Math.min(1, weight));
}

// Short adjacent clips can produce three-way overlaps. Normalize weights so
// additive blending cannot brighten the picture above the original sources.
// Cache one timestamp: export asks for several clips at the same frame time.
export function createOpacitySampler(media: MediaAsset[]) {
  const next = nextAssets(media);
  let previousTime = NaN;
  const weights = new Map<string, number>();
  return (asset: MediaAsset, time: number) => {
    if (time !== previousTime) {
      previousTime = time;
      weights.clear();
      let sum = 0;
      for (const clip of media) {
        const weight = clipOpacity(clip, time, next.get(clip.id));
        weights.set(clip.id, weight);
        sum += weight;
      }
      if (sum > 1)
        for (const [id, weight] of weights) weights.set(id, weight / sum);
    }
    return weights.get(asset.id) ?? 0;
  };
}

export type ExportQuality = "draft" | "standard" | "high";
export function exportFrameRate(sourceFps: number): number {
  return Number.isFinite(sourceFps) && sourceFps > 0
    ? Math.max(12, Math.min(30, sourceFps))
    : 30;
}
export function estimateExport(quality: ExportQuality, duration: number) {
  const sizeGoal = { draft: 16, standard: 32, high: 64 }[quality];
  const audioBitrate = 192_000;
  const videoBitrate = Math.min(
    4_000_000,
    Math.max(
      500_000,
      Math.floor((sizeGoal * 8 * 1024 * 1024 * 0.8) / duration) - audioBitrate,
    ),
  );
  // Bitrate budgets are approximate. Include audio and a container allowance;
  // the video-quality floor can exceed the sizing goal on a long timeline.
  const estimatedBytes = Math.ceil(
    (((videoBitrate + audioBitrate) * duration) / 8) * 1.05,
  );
  return {
    videoBitrate,
    audioBitrate,
    estimatedMiB: estimatedBytes / 1048576,
    base64MiB: (Math.ceil(estimatedBytes / 3) * 4) / 1048576,
  };
}
