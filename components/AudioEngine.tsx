import React, { useEffect, useRef, memo } from "react";
import { AudioFragment, MediaAsset } from "../types";
interface AudioEngineProps {
  audioTracks: AudioFragment[];
  mediaAssets: MediaAsset[];
  currentTime: number;
  isPlaying: boolean;
}
export const AudioEngine = memo(
  ({
    audioTracks = [],
    mediaAssets = [],
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
          asset.blobUrl || `data:${asset.mimeType};base64,${asset.base64}`,
        ]),
      );
      for (const [id, audio] of audioRefs.current.entries()) {
        if (!currentIds.has(id) || audio.src !== desiredUrls.get(id)) {
          audio.pause();
          audio.src = "";
          audioRefs.current.delete(id);
        }
      }
      // Load soundrack audio
      for (const track of audioTracks) {
        if (!audioRefs.current.has(track.id)) {
          const url =
            track.blobUrl || `data:${track.mimeType};base64,${track.base64}`;
          const audio = new Audio(url);
          audio.loop = false;
          audio.preload = "auto";
          audioRefs.current.set(track.id, audio);
        }
      }
      // Load video clip audio
      for (const asset of mediaAssets) {
        if (asset.type === "video" && asset.hasAudio && !asset.muted) {
          if (!audioRefs.current.has(asset.id)) {
            const url =
              asset.blobUrl || `data:${asset.mimeType};base64,${asset.base64}`;
            const audio = new Audio(url);
            audio.loop = false;
            audio.preload = "auto";
            audioRefs.current.set(asset.id, audio);
          }
        }
      }
    }, [audioTracks, mediaAssets]);
    useEffect(
      () => () => {
        for (const audio of audioRefs.current.values()) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        audioRefs.current.clear();
      },
      [],
    );
    useEffect(() => {
      // Sync soundtracks
      audioTracks.forEach((track) => {
        const audio = audioRefs.current.get(track.id);
        if (!audio) return;
        const trackEnd = track.startTime + track.duration;
        const isWithinRange =
          currentTime >= track.startTime && currentTime < trackEnd;
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
        const assetEnd = asset.startTime + asset.duration;
        const isWithinRange =
          currentTime >= asset.startTime && currentTime < assetEnd;
        if (isPlaying && isWithinRange) {
          const targetTime = currentTime - asset.startTime + asset.trimStart;
          if (Math.abs(audio.currentTime - targetTime) > 0.35)
            audio.currentTime = targetTime;
          if (audio.paused) audio.play().catch(() => {});
        } else {
          if (!audio.paused) audio.pause();
          if (isWithinRange) {
            const targetTime = currentTime - asset.startTime + asset.trimStart;
            if (Math.abs(audio.currentTime - targetTime) > 0.05) {
              audio.currentTime = targetTime;
            }
          }
        }
      });
    }, [isPlaying, currentTime, audioTracks, mediaAssets]);
    return null;
  },
);
AudioEngine.displayName = "AudioEngine";
