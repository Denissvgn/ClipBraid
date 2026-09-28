import React from "react";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Expand,
  FileImage,
  Film,
  FolderOpen,
  Grid2X2,
  Info,
  Mic,
  Minimize,
  Music2,
  Pause,
  Play,
  Plus,
  Save,
  Settings2,
  SkipBack,
  SkipForward,
  Trash2,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
const icons = {
  audio: AudioLines,
  left: ChevronLeft,
  right: ChevronRight,
  help: CircleHelp,
  download: Download,
  expand: Expand,
  image: FileImage,
  video: Film,
  folder: FolderOpen,
  grid: Grid2X2,
  info: Info,
  mic: Mic,
  minimize: Minimize,
  music: Music2,
  pause: Pause,
  play: Play,
  plus: Plus,
  save: Save,
  settings: Settings2,
  back: SkipBack,
  next: SkipForward,
  delete: Trash2,
  alert: TriangleAlert,
  volume: Volume2,
  mute: VolumeX,
  close: X,
};
export type IconName = keyof typeof icons;
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Glyph = icons[name];
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
    />
  );
}
