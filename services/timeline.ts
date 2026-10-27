import type { MediaAsset, AudioFragment } from "../types";

export interface TimelineInterval {
  startTime: number;
  duration: number;
}

// Timeline intervals are half-open: a clip is active at its start and inactive
// at its exact end. Adjacent clips therefore never both own the cut timestamp.
export function intervalEnd(interval: TimelineInterval): number {
  return interval.startTime + interval.duration;
}

export function isIntervalActive(
  interval: TimelineInterval,
  time: number,
): boolean {
  return (
    interval.duration > 0 &&
    time >= interval.startTime &&
    time < intervalEnd(interval)
  );
}

export function activeIntervals<T extends TimelineInterval>(
  intervals: T[],
  time: number,
): T[] {
  return intervals.filter((interval) => isIntervalActive(interval, time));
}

export function intervalsOverlap(
  interval: TimelineInterval,
  start: number,
  end: number,
): boolean {
  return (
    end > start && interval.startTime < end && intervalEnd(interval) > start
  );
}

export function clampPlayhead(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || Number.isNaN(time))
    return 0;
  return Math.min(Math.max(0, time), duration);
}

// Standalone audio deliberately extends the project beyond the last visual.
// Export supplies black frames for that tail; the editor labels it Audio only.
export function projectDuration(
  media: MediaAsset[],
  audio: AudioFragment[],
): number {
  const end = (max: number, interval: TimelineInterval) =>
    Math.max(max, intervalEnd(interval));
  return Math.max(media.reduce(end, 0), audio.reduce(end, 0));
}

export function timelineViewportDuration(
  media: MediaAsset[],
  audio: AudioFragment[],
): number {
  return Math.max(10, projectDuration(media, audio));
}

export function clampTransition(
  duration: number,
  previousDuration: number,
  currentDuration: number,
): number {
  return Math.max(
    0,
    Math.min(duration, previousDuration - 0.1, currentDuration - 0.1),
  );
}

// Array order is timeline/stacking order. Each clip keeps its own edit state,
// including when several instances reference the same immutable source.
export function recalculateMediaStartTimes(
  media: MediaAsset[],
  defaultTransition = 0,
): MediaAsset[] {
  let currentOffset = 0;
  return media.map((asset, index) => {
    const previous = media[index - 1];
    const transition =
      index === 0
        ? 0
        : clampTransition(
            asset.transitionDuration ?? defaultTransition,
            previous.duration,
            asset.duration,
          );
    const startTime = Math.max(0, currentOffset - transition);
    const updated = { ...asset, startTime, transitionDuration: transition };
    currentOffset = intervalEnd(updated);
    return updated;
  });
}

export function sourceWindow(
  asset: Pick<MediaAsset, "trimStart" | "trimEnd" | "originalDuration">,
): { start: number; end: number } {
  const start = Math.max(0, asset.trimStart);
  return {
    start,
    end: Math.max(start, asset.originalDuration - asset.trimEnd),
  };
}

export function trimmedDuration(
  asset: Pick<MediaAsset, "trimStart" | "trimEnd" | "originalDuration">,
): number {
  const window = sourceWindow(asset);
  return window.end - window.start;
}

export function sourceTimeAt(
  asset: Pick<
    MediaAsset,
    "startTime" | "trimStart" | "trimEnd" | "originalDuration"
  >,
  time: number,
  timeResolution?: number,
): number {
  const window = sourceWindow(asset);
  const last = Math.max(window.start, window.end - 1e-3);
  const selected = time - asset.startTime + window.start;
  const result = Math.max(
    window.start,
    // Keep valid in-range queries exact. The conservative last-frame guard
    // is only for requests at/beyond the source end, never a trim adjustment.
    selected < window.end ? selected : last,
  );
  if (timeResolution !== undefined && Number.isFinite(timeResolution) && timeResolution > 0) {
    // Subtracting timeline offsets can put an exact packet boundary a few
    // floating-point ulps early. Snap only that arithmetic noise to the native
    // time grid; genuine fractional trims and half-open source bounds stay exact.
    const snapped = Math.round(result * timeResolution) / timeResolution;
    const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(time), Math.abs(asset.startTime), Math.abs(result));
    if (Math.abs(result - snapped) <= tolerance && snapped >= window.start && snapped < window.end) return snapped;
  }
  return result;
}

export function canvasFit(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fitMode: "contain" | "cover",
): { x: number; y: number; width: number; height: number } {
  if (
    ![sourceWidth, sourceHeight, targetWidth, targetHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return { x: 0, y: 0, width: 0, height: 0 };
  const scale =
    fitMode === "cover"
      ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
      : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

export function frameCount(duration: number, fps: number): number {
  return Number.isFinite(duration) &&
    Number.isFinite(fps) &&
    duration > 0 &&
    fps > 0
    ? Math.max(1, Math.ceil(duration * fps - 1e-9))
    : 0;
}

export function frameTimestamp(
  index: number,
  fps: number,
  start = 0,
): number {
  return start + index / fps;
}

function chronological(media: MediaAsset[]): MediaAsset[] {
  return [...media].sort((a, b) => a.startTime - b.startTime);
}

export function nextAssets(
  media: MediaAsset[],
): Map<string, MediaAsset | undefined> {
  const ordered = chronological(media);
  return new Map(ordered.map((asset, index) => [asset.id, ordered[index + 1]]));
}

export function previousAssets(
  media: MediaAsset[],
): Map<string, MediaAsset | undefined> {
  const ordered = chronological(media);
  return new Map(ordered.map((asset, index) => [asset.id, ordered[index - 1]]));
}

// Weights are used with additive compositing in both preview and export, so
// a crossfade does not darken when the two half-opacity layers overlap.
export function clipOpacity(
  asset: MediaAsset,
  time: number,
  next?: MediaAsset,
  previous?: MediaAsset,
): number {
  const local = time - asset.startTime;
  if (local < 0 || local >= asset.duration) return 0;
  let weight = 1;
  if (previous && asset.transitionDuration) {
    const overlap = Math.min(
      asset.transitionDuration,
      asset.duration,
      intervalEnd(previous) - asset.startTime,
    );
    if (overlap > 0 && local < overlap) weight = local / overlap;
  }
  if (next?.transitionDuration) {
    const overlap = Math.min(
      next.transitionDuration,
      next.duration,
      intervalEnd(asset) - next.startTime,
    );
    const elapsed = time - next.startTime;
    if (overlap > 0 && elapsed >= 0)
      weight = Math.min(weight, 1 - elapsed / overlap);
  }
  return Math.max(0, Math.min(1, weight));
}

// Short adjacent clips can produce three-way overlaps. Keep a partition of
// unity wherever visuals are active, avoiding artificial brightness/darkness.
// Cache one timestamp: export asks for several clips at the same frame time.
export function createOpacitySampler(media: MediaAsset[]) {
  const next = nextAssets(media);
  const previous = previousAssets(media);
  let previousTime = NaN;
  const weights = new Map<string, number>();
  return (asset: MediaAsset, time: number) => {
    if (time !== previousTime) {
      previousTime = time;
      weights.clear();
      let sum = 0;
      for (const clip of media) {
        const weight = clipOpacity(
          clip,
          time,
          next.get(clip.id),
          previous.get(clip.id),
        );
        weights.set(clip.id, weight);
        sum += weight;
      }
      if (sum > 0 && sum !== 1)
        for (const [id, weight] of weights) weights.set(id, weight / sum);
      if (sum === 0) {
        // A short overlay can end before an older clip. Its completed fade
        // must not leave the remaining, active visual permanently invisible.
        const visible = activeIntervals(media, time).at(-1);
        if (visible) weights.set(visible.id, 1);
      }
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
  const audioBitrate = 192_000;
  const videoBitrate = { draft: 500_000, standard: 2_000_000, high: 4_000_000 }[quality];
  // Advisory VBR estimate with container allowance; never an output-size promise.
  const estimatedBytes = Math.ceil(
    (((videoBitrate + audioBitrate) * duration) / 8) * 1.05,
  );
  return {
    videoBitrate,
    audioBitrate,
    estimatedBytes,
    estimatedMiB: estimatedBytes / 1048576,
    base64MiB: (Math.ceil(estimatedBytes / 3) * 4) / 1048576,
  };
}
