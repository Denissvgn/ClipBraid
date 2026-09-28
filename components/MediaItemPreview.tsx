import React, { useEffect, useRef, memo } from 'react';
import { MediaAsset, VisualFilter } from '../types';
interface MediaItemPreviewProps {
  asset: MediaAsset;
  currentTime: number;
  isPlaying: boolean;
  fitMode: 'contain' | 'cover';
  opacity: number;
  zIndex: number;
}
export const MediaItemPreview = memo(({
  asset,
  currentTime,
  isPlaying,
  fitMode,
  opacity,
  zIndex
}: MediaItemPreviewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Calculate local time adjusted by trim offset
  const localTime = (currentTime - asset.startTime) + asset.trimStart;
  const isVisible = currentTime >= asset.startTime - 0.5 && currentTime <= asset.startTime + asset.duration + 0.5;
  useEffect(() => {
    if (asset.type !== 'video' || !videoRef.current) return;
    const video = videoRef.current;
    const isActive = currentTime >= asset.startTime && currentTime < asset.startTime + asset.duration;
    if (isActive) {
      if (isPlaying) {
        if (Math.abs(video.currentTime - localTime) > 0.3) {
          video.currentTime = localTime;
        }
        if (video.paused) {
          video.play().catch(() => {});
        }
      } else {
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - localTime) > 0.05) {
          video.currentTime = localTime;
        }
      }
    } else {
      if (!video.paused) {
        video.pause();
      }
    }
  }, [localTime, isPlaying, currentTime, asset.startTime, asset.duration, asset.type]);
  const getFilterStyle = (filter: VisualFilter): string => {
    switch (filter) {
      case 'grayscale': return 'grayscale(100%)';
      case 'sepia': return 'sepia(100%)';
      case 'noir': return 'grayscale(100%) contrast(150%) brightness(80%)';
      case 'vintage': return 'sepia(50%) contrast(90%) brightness(110%) saturate(80%)';
      case 'warm': return 'sepia(30%) saturate(120%) brightness(105%)';
      case 'cool': return 'hue-rotate(180deg) saturate(80%) brightness(105%)';
      default: return 'none';
    }
  };
  const style: React.CSSProperties = {
    objectFit: fitMode,
    width: '100%',
    height: '100%',
    position: 'absolute',
    top: 0,
    left: 0,
    opacity: isVisible ? opacity : 0,
    zIndex,
    display: isVisible || opacity > 0 ? 'block' : 'none',
    pointerEvents: 'none',
    filter: getFilterStyle(asset.filter),
    transition: 'filter 0.3s ease-out'
  };
  const url = asset.blobUrl || `data:${asset.mimeType};base64,${asset.base64}`;
  if (asset.type === 'video') {
    return (
      <video
        ref={videoRef}
        src={url}
        style={style}
        muted={asset.muted === true}
        playsInline
        disablePictureInPicture
        preload="auto"
        onLoadedMetadata={() => {
          if (videoRef.current) {
            videoRef.current.currentTime = Math.max(asset.trimStart, localTime);
          }
        }}
      />
    );
  }
  return (
    <img
      src={url}
      style={style}
      alt={asset.name}
    />
  );
});
MediaItemPreview.displayName = 'MediaItemPreview';
