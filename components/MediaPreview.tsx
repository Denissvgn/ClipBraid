import React, { useMemo } from "react";
import { MediaAsset } from "../types";
import { MediaItemPreview } from "./MediaItemPreview";
import { Icon } from "./Icon";
import { createOpacitySampler } from "../services/timeline";
interface MediaPreviewProps {
  mediaAssets: MediaAsset[];
  currentTime: number;
  isPlaying: boolean;
  aspectRatio: "16:9" | "9:16" | "1:1";
  fitMode: "contain" | "cover";
  showSafeZones: boolean;
}
export const MediaPreview: React.FC<MediaPreviewProps> = ({
  mediaAssets,
  currentTime,
  isPlaying,
  aspectRatio,
  fitMode,
  showSafeZones,
}) => {
  const mountedAssets = useMemo(
    () =>
      mediaAssets.filter(
        (asset) =>
          currentTime >= asset.startTime - 2 &&
          currentTime <= asset.startTime + asset.duration + 2,
      ),
    [mediaAssets, currentTime],
  );
  const sampleOpacity = useMemo(
    () => createOpacitySampler(mediaAssets),
    [mediaAssets],
  );
  const calculateOpacity = (asset: MediaAsset): number =>
    sampleOpacity(asset, currentTime);
  const ratio =
    { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 }[aspectRatio] ?? 16 / 9;
  return (
    <div className="preview-surface">
      {mediaAssets.length === 0 ? (
        <div className="preview-empty">
          <div className="empty-media-mark">
            <Icon name="video" size={34} />
            <Icon name="music" size={22} />
          </div>
          <h2>A place for your next video</h2>
          <p>
            Add video clips or photos to begin.
            <br />
            Your audio gets its own space below.
          </p>
        </div>
      ) : (
        <div
          className="preview-frame"
          style={
            {
              "--preview-ratio": ratio,
              isolation: "isolate",
            } as React.CSSProperties
          }
        >
          {mountedAssets.map((asset) => (
            <MediaItemPreview
              key={asset.id}
              asset={asset}
              currentTime={currentTime}
              isPlaying={isPlaying}
              fitMode={fitMode}
              opacity={calculateOpacity(asset)}
              zIndex={
                currentTime >= asset.startTime &&
                currentTime < asset.startTime + asset.duration
                  ? 2
                  : 1
              }
            />
          ))}
          {showSafeZones && (
            <div className="safe-zones" aria-hidden="true">
              <div />
              <div />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
