import React, { useEffect, useRef, memo } from "react";
import { AudioFragment, MediaAsset } from "../types";
import { isIntervalActive, sourceTimeAt } from "../services/timeline";
interface AudioEngineProps {
  audioTracks: AudioFragment[];
  mediaAssets: MediaAsset[];
  /** Resolves a source ID to its live object URL (media source store). */
  sourceUrl: (sourceId: string) => string | undefined;
  currentTime: number;
  isPlaying: boolean;
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
  }: AudioEngineProps) => {
    const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
    useEffect(() => {
      // Collect IDs for current audio requirements
      const currentIds = new Set([
        ...audioTracks.map((t) => t.id),
        ...mediaAssets
          .filter((a) => a.type === "video" && a.hasAudio && !a.muted)
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
        if (asset.type === "video" && asset.hasAudio && !asset.muted) {
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
      // Sync soundtracks
      audioTracks.forEach((track) => {
        const audio = audioRefs.current.get(track.id);
        if (!audio) return;
        const isWithinRange = isIntervalActive(track, currentTime);
        if (isPlaying && isWithinRange) {
          const targetTime = currentTime - track.startTime;
          if (Math.abs(audio.currentTime - targetTime) > 0.35)
            audio.currentTime = targetTime;
          if (audio.paused) audio.play().catch(() => {});
        } else {
          if (!audio.paused) audio.pause();
          if (isWithinRange) {
            if (
              Math.abs(audio.currentTime - (currentTime - track.startTime)) >
              0.05
            ) {
              audio.currentTime = currentTime - track.startTime;
            }
          }
        }
      });
      // Sync video clip audio
      mediaAssets.forEach((asset) => {
        if (asset.type !== "video" || !asset.hasAudio || asset.muted) return;
        const audio = audioRefs.current.get(asset.id);
        if (!audio) return;
        const isWithinRange = isIntervalActive(asset, currentTime);
        const targetTime = sourceTimeAt(asset, currentTime);
        if (isPlaying && isWithinRange) {
          if (Math.abs(audio.currentTime - targetTime) > 0.35)
            audio.currentTime = targetTime;
          if (audio.paused) audio.play().catch(() => {});
        } else {
          if (!audio.paused) audio.pause();
          if (
            isWithinRange &&
            Math.abs(audio.currentTime - targetTime) > 0.05
          ) {
            audio.currentTime = targetTime;
          }
        }
      });
    }, [isPlaying, currentTime, audioTracks, mediaAssets, sourceUrl]);
    return null;
  },
);
AudioEngine.displayName = "AudioEngine";
