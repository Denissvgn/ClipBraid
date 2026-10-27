import type { MediaAsset, AudioFragment } from "../types";
import { intervalEnd } from "./timeline";

export function trackGain(track: { gain?: number }): number {
  const gain = track.gain ?? 1;
  if (!Number.isFinite(gain) || gain < 0 || gain > 1) throw new Error("Track volume must be between 0 and 100%.");
  return gain;
}
export function clipHasSound(clip: MediaAsset): boolean {
  return clip.type === "video" && clip.hasAudio && !clip.muted && trackGain(clip) > 0;
}
/** Constant headroom across a project avoids gain jumps at interval boundaries. */
export function mixPolicy(media: readonly MediaAsset[], audio: readonly AudioFragment[]) {
  const lanes = [...media.filter(clipHasSound), ...audio.filter(track => trackGain(track) > 0)]
    .filter(lane => lane.duration > 0 && intervalEnd(lane) > lane.startTime);
  const events = lanes.flatMap(lane => [{ time: lane.startTime, delta: 1 }, { time: intervalEnd(lane), delta: -1 }])
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0, maxOverlap = 0;
  for (const event of events) { active += event.delta; maxOverlap = Math.max(maxOverlap, active); }
  return { maxOverlap, gain: 1 / Math.max(1, maxOverlap) };
}
