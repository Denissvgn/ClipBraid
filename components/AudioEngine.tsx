import React, { useEffect, useRef, useMemo, memo } from "react";
import { AudioFragment, MediaAsset } from "../types";
import { isIntervalActive, sourceTimeAt } from "../services/timeline";
import { clipHasSound, mixPolicy, trackGain } from "../services/mixing";
interface AudioEngineProps {
  audioTracks: AudioFragment[];
  mediaAssets: MediaAsset[];
  /** Resolves a source ID to its live object URL (media source store). */
  sourceUrl: (sourceId: string) => string | undefined;
  currentTime: number;
  isPlaying: boolean;
  seekRevision?: number;
}

const releaseAudio = (audio: HTMLAudioElement) => {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
};

export const AudioEngine = memo(
  ({
    audioTracks = [],
    mediaAssets = [],
    sourceUrl,
    currentTime = 0,
    isPlaying = false,
    seekRevision = 0,
  }: AudioEngineProps) => {
    const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
    const previousSeek = useRef(seekRevision);
    const previousMapping = useRef(new Map<string, { start: number; source: number }>());
    const policy = useMemo(() => mixPolicy(mediaAssets, audioTracks), [mediaAssets, audioTracks]);
    useEffect(() => {
      // Collect IDs for current audio requirements
      const currentIds = new Set([
        ...audioTracks.filter(track => trackGain(track) > 0).map((t) => t.id),
        ...mediaAssets
          .filter(clipHasSound)
          .map((a) => a.id),
      ]);

      // Cleanup unused audio elements
      const desiredUrls = new Map(
        [...audioTracks, ...mediaAssets].map((asset) => [
          asset.id,
          sourceUrl(asset.sourceId),
        ]),
      );
      for (const [id, audio] of audioRefs.current.entries()) {
        if (!currentIds.has(id) || audio.src !== desiredUrls.get(id)) {
          releaseAudio(audio);
          audioRefs.current.delete(id);
        }
      }
      // Load soundrack audio
      for (const track of audioTracks) {
        if (trackGain(track) === 0) continue;
        const url = desiredUrls.get(track.id);
        if (url && !audioRefs.current.has(track.id)) {
          const audio = new Audio(url);
          audio.loop = false;
          audio.preload = "auto";
          audioRefs.current.set(track.id, audio);
        }
      }
      // Load video clip audio
      for (const asset of mediaAssets) {
        if (clipHasSound(asset)) {
          const url = desiredUrls.get(asset.id);
          if (url && !audioRefs.current.has(asset.id)) {
            const audio = new Audio(url);
            audio.loop = false;
            audio.preload = "auto";
            audioRefs.current.set(asset.id, audio);
          }
        }
      }
    }, [audioTracks, mediaAssets, sourceUrl]);
    useEffect(
      () => () => {
        for (const audio of audioRefs.current.values()) releaseAudio(audio);
        audioRefs.current.clear();
      },
      [],
    );
    useEffect(() => {
      const seeked = previousSeek.current !== seekRevision;
      previousSeek.current = seekRevision;
      const nextMapping = new Map<string, { start: number; source: number }>();
      const sync = (id: string, audio: HTMLAudioElement, active: boolean, target: number, start: number, source = 0) => {
        const before = previousMapping.current.get(id);
        const moved = !before || before.start !== start || before.source !== source;
        nextMapping.set(id, { start, source });
        const ended = (Number.isFinite(audio.duration) && target >= audio.duration)
          || (audio.ended && target >= audio.currentTime - 1e-6);
        if (!active || !isPlaying || ended) {
          if (!audio.paused) audio.pause();
          if (active && !ended && Math.abs(audio.currentTime - target) > 1e-6) audio.currentTime = target;
          return;
        }
        // Drift tolerance applies only during continuous playback. A new
        // source/start or explicit seek must honor even a very short trim.
        if (audio.paused || seeked || moved || Math.abs(audio.currentTime - target) > 0.35) audio.currentTime = target;
        if (audio.paused) audio.play().catch(() => {});
      };
      // Sync soundtracks
      audioTracks.forEach((track) => {
        const audio = audioRefs.current.get(track.id);
        if (!audio) return;
        audio.volume = trackGain(track) * policy.gain;
        const isWithinRange = isIntervalActive(track, currentTime);
        sync(track.id, audio, isWithinRange, currentTime - track.startTime, track.startTime);
      });
      // Sync video clip audio
      mediaAssets.forEach((asset) => {
        if (!clipHasSound(asset)) return;
        const audio = audioRefs.current.get(asset.id);
        if (!audio) return;
        audio.volume = trackGain(asset) * policy.gain;
        const isWithinRange = isIntervalActive(asset, currentTime);
        const targetTime = sourceTimeAt(asset, currentTime);
        sync(asset.id, audio, isWithinRange, targetTime, asset.startTime, asset.trimStart);
      });
      previousMapping.current = nextMapping;
    }, [isPlaying, currentTime, audioTracks, mediaAssets, sourceUrl, policy.gain, seekRevision]);
    return null;
  },
);
AudioEngine.displayName = "AudioEngine";
