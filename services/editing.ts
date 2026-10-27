import type {AudioFragment,MediaAsset} from "../types";
import {MAX_TIMELINE_SECONDS} from "./project";

function finite(value:number,label:string):number {
  if(!Number.isFinite(value))throw new Error(`${label} must be a finite time.`);
  return value;
}

export function moveAudio(track:AudioFragment,time:number):AudioFragment {
  return {...track,startTime:Math.min(MAX_TIMELINE_SECONDS,Math.max(0,finite(time,"Start time")))};
}

export function trimAudio(track:AudioFragment,change:{trimStart?:number;trimEnd?:number}):AudioFragment {
  const originalDuration=track.originalDuration??track.duration;
  const trimStart=finite(change.trimStart??track.trimStart??0,"Trim from start");
  const trimEnd=finite(change.trimEnd??track.trimEnd??0,"Trim from end");
  const duration=originalDuration-trimStart-trimEnd;
  if(trimStart<0||trimEnd<0||duration<Math.min(.01,originalDuration)-1e-8)
    throw new Error("Keep at least 0.01 seconds of the audio source.");
  return {...track,originalDuration,trimStart,trimEnd,duration};
}

export function resizeImage(asset:MediaAsset,duration:number):MediaAsset {
  finite(duration,"Photo duration");
  if(asset.type!=="image"||duration<.1||duration>MAX_TIMELINE_SECONDS)
    throw new Error("Photo duration must be between 0.1 and 86400 seconds.");
  return {...asset,duration,originalDuration:duration,trimStart:0,trimEnd:0};
}
