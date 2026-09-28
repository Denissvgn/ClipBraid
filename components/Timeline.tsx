import React, { useRef, useMemo } from "react";
import { MediaAsset, AudioFragment } from "../types";
import { Icon } from "./Icon";
interface TimelineProps {
  mediaAssets: MediaAsset[];
  audioTracks: AudioFragment[];
  currentTime: number;
  zoom: number;
  selectedAssetId: string | null;
  onSeek: (time: number) => void;
  onDeleteMedia: (id: string) => void;
  onDeleteAudio: (id: string) => void;
  onMoveMedia: (id: string, direction: "left" | "right") => void;
  onToggleMute: (id: string) => void;
  onSelectAsset: (id: string) => void;
}
const timeLabel = (t: number) =>
  `${Math.floor(t / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(t % 60)
    .toString()
    .padStart(2, "0")}`;
export const Timeline: React.FC<TimelineProps> = ({
  mediaAssets,
  audioTracks,
  currentTime,
  zoom,
  selectedAssetId,
  onSeek,
  onDeleteAudio,
  onSelectAsset,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelWidth = 144;
  const totalDuration = useMemo(
    () =>
      Math.max(
        10,
        ...mediaAssets.map((a) => a.startTime + a.duration),
        ...audioTracks.map((a) => a.startTime + a.duration),
      ),
    [mediaAssets, audioTracks],
  );
  const step = zoom < 20 ? 10 : zoom < 50 ? 5 : 2;
  // Bound visual tick creation; imported schema validation remains a separate concern.
  const markers = Array.from(
    { length: Math.min(2000, Math.ceil(totalDuration / step) + 1) },
    (_, i) => i * step,
  );
  const handleTimelineClick = (event: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const x =
      event.clientX -
      container.getBoundingClientRect().left +
      container.scrollLeft;
    onSeek(Math.min(Math.max(0, (x - labelWidth) / zoom), totalDuration));
  };
  return (
    <section className="timeline" aria-label="Timeline tracks">
      <div
        className="timeline-scroll"
        ref={containerRef}
        onClick={handleTimelineClick}
      >
        <div
          className="timeline-content"
          style={{ width: labelWidth + totalDuration * zoom + 64 }}
        >
          <div className="timeline-ruler">
            <span className="ruler-label">Time</span>
            {markers.map((t) => (
              <span
                key={t}
                className="ruler-tick"
                style={{ left: labelWidth + t * zoom }}
              >
                {timeLabel(t)}
              </span>
            ))}
          </div>
          <div className="timeline-row visual-row">
            <div className="track-label">
              <Icon name="video" />
              <span>Visuals</span>
            </div>
            {mediaAssets.map((asset) => (
              <div
                key={asset.id}
                className={`timeline-clip ${asset.type} ${selectedAssetId === asset.id ? "selected" : ""}`}
                style={{
                  left: labelWidth + asset.startTime * zoom,
                  width: Math.max(8, asset.duration * zoom),
                }}
              >
                <button
                  className="clip-select"
                  aria-label={`Edit ${asset.name}`}
                  title={asset.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectAsset(asset.id);
                  }}
                >
                  <Icon
                    name={asset.type === "image" ? "image" : "video"}
                    size={16}
                  />
                  <span>{asset.name}</span>
                  {asset.type === "video" && asset.muted && (
                    <Icon name="mute" size={14} />
                  )}
                </button>
                <span className="clip-duration">
                  {asset.duration.toFixed(1)}s
                </span>
              </div>
            ))}
            {!mediaAssets.length && (
              <span className="track-empty">
                Video clips and photos appear here
              </span>
            )}
          </div>
          {audioTracks.length ? (
            audioTracks.map((track, index) => (
              <div
                key={track.id}
                className={`timeline-row audio-row tone-${index % 2}`}
                data-audio-track={track.id}
              >
                <div className="track-label">
                  <Icon name="music" />
                  <span>Audio {index + 1}</span>
                  <button
                    className="track-remove"
                    aria-label={`Remove ${track.name}`}
                    title={`Remove ${track.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteAudio(track.id);
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <div
                  className="timeline-audio"
                  style={{
                    left: labelWidth + track.startTime * zoom,
                    width: Math.max(8, track.duration * zoom),
                  }}
                  title={track.name}
                >
                  <Icon name="audio" size={16} />
                  <span>{track.name}</span>
                  <span className="clip-duration">
                    {track.duration.toFixed(1)}s
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="timeline-row audio-row">
              <div className="track-label">
                <Icon name="music" />
                <span>Audio</span>
              </div>
              <span className="track-empty">
                Add your music, narration or another layer of sound
              </span>
            </div>
          )}
          <div
            className="playhead"
            style={{ left: labelWidth + currentTime * zoom }}
            aria-hidden="true"
          >
            <span />
          </div>
        </div>
      </div>
    </section>
  );
};
