export type VisualFilter = 'none' | 'grayscale' | 'sepia' | 'noir' | 'vintage' | 'warm' | 'cool';
export interface MediaAsset {
  id: string;
  mediaId: string;
  base64: string;
  mimeType: string;
  type: 'image' | 'video';
  name: string;
  duration: number; // calculated duration (after trim)
  originalDuration: number; // original duration of the file
  startTime: number; // position on timeline in seconds
  trimStart: number; // offset from start in seconds
  trimEnd: number; // offset from end in seconds
  filter: VisualFilter;
  blobUrl?: string; // High-performance URL for preview
  transitionDuration?: number; // Duration of the crossfade with the PREVIOUS clip
  hasAudio: boolean; // Detected audio stream presence
  muted?: boolean; // User-controlled mute state for original clip audio
  sourceFps?: number; // Detected source frame rate (export renders at it — no duplicate frames)
  sourceWidth?: number; // Native coded width of the retained source
  sourceHeight?: number; // Native coded height of the retained source
  normalized?: boolean; // Legacy draft flag: bytes may already be a lossy rendition; not rewritten
}
export interface AudioFragment {
  id: string;
  mediaId: string;
  base64: string;
  mimeType: string;
  name: string;
  startTime: number; // position on timeline in seconds
  duration: number; // in seconds
  blobUrl?: string; // High-performance URL for preview
}
