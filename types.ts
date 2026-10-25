export type VisualFilter =
  "none" | "grayscale" | "sepia" | "noir" | "vintage" | "warm" | "cool";
export interface MediaAsset {
  id: string; // timeline clip instance ID; edit state is per instance
  mediaId: string;
  /** Runtime identity of the immutable original; resolved via the media
   *  source store. Not part of the serialized project format. */
  sourceId: string;
  mimeType: string;
  type: "image" | "video";
  name: string;
  duration: number; // calculated duration (after trim)
  originalDuration: number; // original duration of the file
  startTime: number; // position on timeline in seconds
  trimStart: number; // offset from start in seconds
  trimEnd: number; // offset from end in seconds
  filter: VisualFilter;
  transitionDuration?: number; // Duration of the crossfade with the PREVIOUS clip
  hasAudio: boolean; // Detected audio stream presence
  muted?: boolean; // User-controlled mute state for original clip audio
  gain?: number; // Linear original-audio volume, 0–1; omitted legacy value is unity
  sourceFps?: number; // Detected source frame rate; retained within the 12–30 fps export range
  sourceWidth?: number; // Native coded width of the retained source
  sourceHeight?: number; // Native coded height of the retained source
  normalized?: boolean; // Legacy draft flag: bytes may already be a lossy rendition; not rewritten
}
export interface AudioFragment {
  id: string;
  mediaId: string;
  /** Runtime identity of the immutable original; see MediaAsset.sourceId. */
  sourceId: string;
  mimeType: string;
  name: string;
  startTime: number; // position on timeline in seconds
  duration: number; // in seconds
  gain?: number; // Linear track volume, 0–1; zero is intentional silence
}
