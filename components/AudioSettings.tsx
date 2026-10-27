import React from "react";
import type {AudioFragment} from "../types";
import {MAX_TIMELINE_SECONDS} from "../services/project";
import {trackGain} from "../services/mixing";
import {Icon} from "./Icon";
import {TimeInput} from "./TimeInput";

interface Props {
  track:AudioFragment;currentTime:number;
  closeRef:React.RefObject<HTMLButtonElement|null>;
  onClose():void;onRemove():void;
  onMove(time:number):void;onTrim(change:{trimStart?:number;trimEnd?:number}):void;onGain(gain:number):void;
}
export function AudioSettings({track,currentTime,closeRef,onClose,onRemove,onMove,onTrim,onGain}:Props){
  const original=track.originalDuration??track.duration,start=track.trimStart??0,end=track.trimEnd??0;
  const minimum=Math.min(.01,original);
  return <>
    <div className="inspector-heading"><h2>Audio settings</h2>
      <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close audio settings"><Icon name="close" /></button>
    </div>
    <div className="selected-file"><Icon name="audio" size={24} /><div><strong title={track.name}>{track.name}</strong>
      <span>{track.duration.toFixed(2)} seconds on timeline</span></div></div>
    <TimeInput label="Audio start time (seconds)" value={track.startTime} min={0} max={MAX_TIMELINE_SECONDS} onCommit={onMove} />
    <button className="button secondary full-width" onClick={()=>onMove(currentTime)}>Move audio to playhead</button>
    <TimeInput label="Audio trim from start (seconds)" value={start} min={0} max={Math.max(0,original-end-minimum)} onCommit={trimStart=>onTrim({trimStart})} />
    <TimeInput label="Audio trim from end (seconds)" value={end} min={0} max={Math.max(0,original-start-minimum)} onCommit={trimEnd=>onTrim({trimEnd})} />
    <p className="helper-text">Uses {start.toFixed(2)}–{(original-end).toFixed(2)}s of the {original.toFixed(2)}s original. Trimming keeps the original file.</p>
    <div className="inspector-section"><label htmlFor="selected-audio-volume">Audio volume<span>{Math.round(trackGain(track)*100)}%</span></label>
      <input id="selected-audio-volume" type="range" min="0" max="100" step="1" value={trackGain(track)*100} onChange={event=>onGain(Number(event.target.value)/100)} />
    </div>
    <button className="button danger" onClick={onRemove}><Icon name="delete" />Remove audio track</button>
  </>;
}
