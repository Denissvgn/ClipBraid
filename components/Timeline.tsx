import React, { useRef, useMemo, useState } from "react";
import { MediaAsset, AudioFragment } from "../types";
import {
  clampPlayhead,
  timelineViewportDuration,
} from "../services/timeline";
import { Icon } from "./Icon";
import {moveAudio} from "../services/editing";
interface TimelineProps {
  mediaAssets: MediaAsset[];
  audioTracks: AudioFragment[];
  currentTime: number;
  zoom: number;
  selectedAssetId: string | null;
  selectedAudioId: string | null;
  onSeek: (time: number) => void;
  onDeleteMedia: (id: string) => void;
  onDeleteAudio: (id: string) => void;
  onMoveMedia: (id: string, direction: "left" | "right") => void;
  onToggleMute: (id: string) => void;
  onSelectAsset: (id: string) => void;
  onSelectAudio:(id:string)=>void;
  onMoveAudio:(id:string,time:number)=>void;
  onBeginAudioMove:()=>void;
  onEndAudioMove:()=>void;
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
  selectedAudioId,
  onSeek,
  onDeleteAudio,
  onSelectAsset,
  onSelectAudio,onMoveAudio,onBeginAudioMove,onEndAudioMove,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelWidth = 144;
  const drag=useRef<{id:string;pointer:number;x:number;start:number;next:number;moved:boolean}|null>(null);
  const [placement,setPlacement]=useState<{id:string;time:number}|null>(null);
  const suppressClick=useRef(false);
  const finishMove=(event:{currentTarget:HTMLButtonElement;pointerId:number},cancel=false)=>{
    const move=drag.current;if(!move||move.pointer!==event.pointerId)return;
    drag.current=null;setPlacement(null);
    if(move.moved){
      if(!cancel)onMoveAudio(move.id,move.next);
      onEndAudioMove();suppressClick.current=true;
    }
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const totalDuration = useMemo(
    () => timelineViewportDuration(mediaAssets, audioTracks),
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
    onSeek(clampPlayhead((x - labelWidth) / zoom, totalDuration));
  };
  return (
    <section className="timeline" aria-label="Timeline tracks">
      {!!audioTracks.length&&<p className="timeline-help" id="audio-move-help">Select audio to edit. Drag it horizontally to move, or focus it and use Left/Right (0.1s), Shift+Left/Right (1s), or Home.</p>}
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
                  aria-pressed={selectedAssetId === asset.id}
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
                <button
                  className={`timeline-audio ${selectedAudioId===track.id?"selected":""}`}
                  aria-label={`Edit audio ${index+1}: ${track.name}`}
                  aria-pressed={selectedAudioId===track.id}
                  aria-describedby="audio-move-help"
                  style={{
                    left: labelWidth + (placement?.id===track.id?placement.time:track.startTime) * zoom,
                    width: Math.max(8, track.duration * zoom),
                  }}
                  title={track.name}
                  onClick={event=>{event.stopPropagation();if(suppressClick.current){suppressClick.current=false;return}onSelectAudio(track.id)}}
                  onPointerDown={event=>{
                    if(!event.isPrimary||event.button!==0||drag.current)return;suppressClick.current=false;
                    drag.current={id:track.id,pointer:event.pointerId,x:event.clientX,start:track.startTime,next:track.startTime,moved:false};
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={event=>{
                    const move=drag.current;if(!move||move.id!==track.id||move.pointer!==event.pointerId)return;
                    const delta=event.clientX-move.x;
                    if(!move.moved&&Math.abs(delta)<4)return;
                    if(!move.moved){move.moved=true;onBeginAudioMove()}
                    move.next=moveAudio(track,Math.round((move.start+delta/zoom)*100)/100).startTime;
                    setPlacement({id:track.id,time:move.next});
                  }}
                  onPointerUp={event=>finishMove(event)}
                  onPointerCancel={event=>finishMove(event,true)}
                  onLostPointerCapture={event=>finishMove(event,true)}
                  onKeyDown={event=>{
                    if(event.key==="Escape"&&drag.current){event.preventDefault();finishMove({currentTarget:event.currentTarget,pointerId:drag.current.pointer},true);return}
                    if(event.key==="Enter"||event.key===" ")suppressClick.current=false;
                    if(event.altKey||event.ctrlKey||event.metaKey)return;
                    if(["ArrowLeft","ArrowRight","Home"].includes(event.key)){
                      event.preventDefault();event.stopPropagation();
                      if(!event.repeat)onBeginAudioMove();
                      const amount=event.shiftKey?1:.1;
                      onMoveAudio(track.id,event.key==="Home"?0:Math.round((track.startTime+(event.key==="ArrowRight"?amount:-amount))*100)/100);
                    }
                  }}
                  onKeyUp={event=>{if(["ArrowLeft","ArrowRight","Home"].includes(event.key))onEndAudioMove()}}
                  onBlur={()=>{if(!drag.current)onEndAudioMove()}}
                >
                  <Icon name="audio" size={16} />
                  <span>{track.name}</span>
                  <span className="clip-duration">
                    {track.duration.toFixed(1)}s
                  </span>
                </button>
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
