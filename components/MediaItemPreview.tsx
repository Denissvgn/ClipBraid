import React, { useEffect, useRef, memo } from "react";
import { MediaAsset, VisualFilter } from "../types";
import {
  intervalsOverlap,
  isIntervalActive,
  sourceTimeAt,
} from "../services/timeline";
interface MediaItemPreviewProps {
  asset: MediaAsset;
  /** Resolved object URL for the immutable source; hidden while undefined. */
  url: string | undefined;
  currentTime: number;
  isPlaying: boolean;
  fitMode: "contain" | "cover";
  opacity: number;
  zIndex: number;
  seekRevision?: number;
}
export const MediaItemPreview = memo(
  ({
    asset,
    url,
    currentTime,
    isPlaying,
    fitMode,
    opacity,
    zIndex,
    seekRevision = 0,
  }: MediaItemPreviewProps) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const previousSeek = useRef(seekRevision);
    const previousPlacement = useRef({ start: asset.startTime, trim: asset.trimStart });

    const localTime = sourceTimeAt(asset, currentTime);
    const isVisible = intervalsOverlap(
      asset,
      currentTime - 0.5,
      currentTime + 0.5,
    );
    useEffect(() => {
      if (asset.type !== "video" || !videoRef.current) return;
      const video = videoRef.current;
      const seeked = previousSeek.current !== seekRevision;
      previousSeek.current = seekRevision;
      const moved = previousPlacement.current.start !== asset.startTime || previousPlacement.current.trim !== asset.trimStart;
      previousPlacement.current = { start: asset.startTime, trim: asset.trimStart };
      const isActive = isIntervalActive(asset, currentTime);
      if (isActive) {
        if (isPlaying) {
          if (video.paused || seeked || moved || Math.abs(video.currentTime - localTime) > 0.3) {
            video.currentTime = localTime;
          }
          if (video.paused) {
            video.play().catch(() => {});
          }
        } else {
          if (!video.paused) video.pause();
          if (Math.abs(video.currentTime - localTime) > 1e-6) {
            video.currentTime = localTime;
          }
        }
      } else {
        if (!video.paused) {
          video.pause();
        }
      }
    }, [
      localTime,
      isPlaying,
      currentTime,
      asset.startTime,
      asset.duration,
      asset.type,
      url,
      seekRevision,
    ]);
    const getFilterStyle = (filter: VisualFilter): string => {
      switch (filter) {
        case "grayscale":
          return "grayscale(100%)";
        case "sepia":
          return "sepia(100%)";
        case "noir":
          return "grayscale(100%) contrast(150%) brightness(80%)";
        case "vintage":
          return "sepia(50%) contrast(90%) brightness(110%) saturate(80%)";
        case "warm":
          return "sepia(30%) saturate(120%) brightness(105%)";
        case "cool":
          return "hue-rotate(180deg) saturate(80%) brightness(105%)";
        default:
          return "none";
      }
    };
    const style: React.CSSProperties = {
      objectFit: fitMode,
      width: "100%",
      height: "100%",
      position: "absolute",
      top: 0,
      left: 0,
      opacity: isVisible ? opacity : 0,
      mixBlendMode: "plus-lighter",
      zIndex,
      display: isVisible || opacity > 0 ? "block" : "none",
      pointerEvents: "none",
      filter: getFilterStyle(asset.filter),
      transition: "filter 0.3s ease-out",
    };
    if (!url) return null;
    if (asset.type === "video") {
      return (
        <video
          ref={videoRef}
          src={url}
          style={style}
          muted
          playsInline
          disablePictureInPicture
          preload="auto"
          onLoadedMetadata={() => {
            if (videoRef.current) {
              videoRef.current.currentTime = Math.max(
                asset.trimStart,
                localTime,
              );
            }
          }}
        />
      );
    }
    return <img src={url} style={style} alt={asset.name} />;
  },
);
MediaItemPreview.displayName = "MediaItemPreview";
