import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { Flow } from "./platform";
import { BrandMark } from "./components/BrandMark";
import { Icon } from "./components/Icon";
import { ffmpegService } from "./services/ffmpegService";
import { MediaAsset, AudioFragment, VisualFilter } from "./types";
import { Timeline } from "./components/Timeline";
import { MediaPreview } from "./components/MediaPreview";
import { AudioEngine } from "./components/AudioEngine";
import { IntroModal } from "./components/IntroModal";
import { JournalViewer } from "./components/JournalViewer";
import {
  parseJournal,
  logEvent,
  type SystemEventKind,
} from "./services/journalService";
// The development journal resolves to an empty module in every build.
import journalMarkdown from "virtual:development-journal";
import {
  Input,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  BlobSource,
  ALL_FORMATS,
  CanvasSource,
  VideoSampleSource,
  VideoSample,
  VideoSampleSink,
  AudioBufferSink,
  canEncodeVideo,
} from "mediabunny";
import { registerAc3Decoder } from "@mediabunny/ac3";
let encodersInitialized = false;
async function initMediaCodecs() {
  if (encodersInitialized) return;
  registerAc3Decoder();
  encodersInitialized = true;
}
const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  try {
    const raw = base64.includes(",") ? base64.split(",")[1] : base64;
    const binaryString = atob(raw.replace(/\s/g, ""));
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("Base64 error:", e);
    throw new Error("Data reading error.");
  }
};
/** Probes a video source once: audio-stream presence, actual frame rate
 *  (deduced from packet timestamps, not unreliable metadata) + native size
 *  (source metadata only; originals are never replaced). */
const probeVideoSource = async (
  blobUrl: string,
): Promise<{
  hasAudio: boolean;
  fps: number;
  width: number;
  height: number;
}> => {
  try {
    const blob = await (await fetch(blobUrl)).blob();
    const input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
    const hasAudio = (await input.getAudioTracks()).length > 0;
    let fps = 0,
      width = 0,
      height = 0;
    const vTrack = await input.getPrimaryVideoTrack();
    if (vTrack) {
      try {
        fps = (await vTrack.computeFrameRateMetrics({ targetPacketCount: 128 }))
          .bestGuessFrameRate;
      } catch {
        fps = 0;
      }
      try {
        width = await vTrack.getCodedWidth();
        height = await vTrack.getCodedHeight();
      } catch {
        /* keep 0 */
      }
    }
    return { hasAudio, fps, width, height };
  } catch {
    return { hasAudio: true, fps: 0, width: 0, height: 0 };
  }
};
const probeDuration = (
  blobUrl: string,
  type: "image" | "video" | "audio",
): Promise<number> => {
  return new Promise((resolve) => {
    if (type === "image") return resolve(5);
    const el = document.createElement(type === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const d = el.duration;
      el.src = "";
      el.load();
      resolve(Number.isFinite(d) && d > 0 ? d : 5);
    };
    el.onerror = () => resolve(5);
    el.src = blobUrl;
  });
};
const createBlobUrl = (base64: string, mimeType: string) => {
  if (!base64) return "";
  try {
    const bytes = base64ToUint8Array(base64);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch (e) {
    return "";
  }
};
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};
/**
 * Serializes an AudioBuffer to a 16-bit PCM WAV file.
 * Used because Android WebView has no WebCodecs AAC *encoder* — the mix is
 * encoded to AAC by ffmpeg.wasm instead (its software encoder is always there).
 */
const audioBufferToWav = (buffer: AudioBuffer): Uint8Array<ArrayBuffer> => {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
  const dataBytes = len * numCh * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * numCh * 2, true);
  dv.setUint16(32, numCh * 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, dataBytes, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return bytes;
};
type ExportQuality = "draft" | "standard" | "high";
export default function App() {
  const [showIntro, setShowIntro] = useState(true);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [audioTracks, setAudioTracks] = useState<AudioFragment[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(40);
  const [status, setStatus] = useState("BOOTING...");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  // Export states
  const [isExporting, setIsExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [exportLogs, setExportLogs] = useState<string[]>([]);
  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");

  const [isRecording, setIsRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(10);

  const [transitionDuration, setTransitionDuration] = useState(0.5);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16" | "1:1">(
    "16:9",
  );
  const [fitMode, setFitMode] = useState<"contain" | "cover">("contain");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const journalEntries = useMemo(() => parseJournal(journalMarkdown), []);
  const requestRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const playbackStartTimeRef = useRef<number>(performance.now());
  const exportStartTimeRef = useRef<number>(0);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);

  // Progress tracker for parallel segments
  const segmentProgress = useRef<number[]>([0, 0]);
  const cleanupRef = useRef<{
    mediaAssets: MediaAsset[];
    audioTracks: AudioFragment[];
  }>({
    mediaAssets: [],
    audioTracks: [],
  });

  useEffect(() => {
    cleanupRef.current = { mediaAssets, audioTracks };
  }, [mediaAssets, audioTracks]);
  const isExportingRef = useRef(isExporting);
  useEffect(() => {
    isExportingRef.current = isExporting;
  }, [isExporting]);
  const addLog = useCallback((msg: string) => {
    const elapsed = isExportingRef.current
      ? Math.floor(performance.now() - exportStartTimeRef.current)
      : 0;
    const timestamp = isExportingRef.current ? `[+${elapsed}ms] ` : "";
    setExportLogs((prev) => [...prev.slice(-19), `${timestamp}${msg}`]);
  }, []);
  // System journal: every user-visible state change lands here as a live
  // event (viewer tab 1). Export-phase chatter stays in exportLogs only —
  // the journal records lifecycle, not per-frame progress.
  const sysLog = useCallback((kind: SystemEventKind, msg: string) => {
    logEvent(kind, msg);
  }, []);
  useEffect(() => {
    ffmpegService
      .load((msg) => {
        if (isExportingRef.current) {
          addLog(msg);
        } else {
          setStatus(msg.slice(0, 30).toUpperCase());
        }
      })
      .then(() => setStatus("READY"))
      .catch((err) => {
        setStatus("FATAL ERROR");
        setErrorDetail(`FFmpeg failed to load: ${err.message}`);
      });
  }, [addLog]);
  useEffect(() => {
    return () => {
      const { mediaAssets: m, audioTracks: a } = cleanupRef.current;
      m.forEach((asset) => asset.blobUrl && URL.revokeObjectURL(asset.blobUrl));
      a.forEach((track) => track.blobUrl && URL.revokeObjectURL(track.blobUrl));
    };
  }, []);
  const totalDuration = useMemo(() => {
    const mediaEnd = mediaAssets.reduce(
      (max, asset) => Math.max(max, asset.startTime + asset.duration),
      0,
    );
    const audioEnd = audioTracks.reduce(
      (max, track) => Math.max(max, track.startTime + track.duration),
      0,
    );
    return Math.max(mediaEnd, audioEnd, 1);
  }, [mediaAssets, audioTracks]);
  const exportEstimate = useMemo(() => {
    const targetMBMap = { draft: 16, standard: 32, high: 64 } as const;
    const mb = targetMBMap[exportQuality];
    const vb = Math.min(
      4_000_000,
      Math.max(
        500_000,
        Math.floor((mb * 8 * 1024 * 1024 * 0.8) / totalDuration) - 192_000,
      ),
    );
    return { mb, kbps: Math.round(vb / 1000) };
  }, [exportQuality, totalDuration]);
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(0, t), totalDuration);
      setCurrentTime(clamped);
      if (isPlaying) {
        startTimeRef.current = clamped;
        playbackStartTimeRef.current = performance.now();
      }
    },
    [isPlaying, totalDuration],
  );
  const clampTransition = useCallback(
    (duration: number, prevDuration: number, currentDuration: number) => {
      return Math.max(
        0,
        Math.min(duration, prevDuration - 0.1, currentDuration - 0.1),
      );
    },
    [],
  );
  const recalculateMediaStartTimes = useCallback(
    (assets: MediaAsset[]): MediaAsset[] => {
      let currentOffset = 0;
      return assets.map((m, index) => {
        const prev = assets[index - 1];
        const trans =
          index === 0
            ? 0
            : clampTransition(
                m.transitionDuration ?? transitionDuration,
                prev.duration,
                m.duration,
              );
        const start = Math.max(0, currentOffset - trans);
        const updated = { ...m, startTime: start, transitionDuration: trans };
        currentOffset = start + m.duration;
        return updated;
      });
    },
    [transitionDuration, clampTransition],
  );
  const handleImportMedia = async () => {
    try {
      const selected = await Flow.media.select({ filter: "all" });
      if (!selected) return;
      setStatus("PROBING MEDIA...");
      const bUrl = createBlobUrl(selected.base64, selected.mimeType);
      const dur = await probeDuration(bUrl, selected.type as any);
      const {
        hasAudio,
        fps: sourceFps,
        width: sourceWidth,
        height: sourceHeight,
      } = selected.type === "video"
        ? await probeVideoSource(bUrl)
        : { hasAudio: false, fps: 0, width: 0, height: 0 };
      const newAssetBase: MediaAsset = {
        id: crypto.randomUUID(),
        mediaId: selected.mediaId,
        base64: selected.base64,
        mimeType: selected.mimeType,
        type: selected.type as "image" | "video",
        name: selected.name,
        duration: dur,
        originalDuration: dur,
        trimStart: 0,
        trimEnd: 0,
        filter: "none",
        startTime: 0,
        blobUrl: bUrl,
        hasAudio,
        muted: false,
        sourceFps: sourceFps || undefined,
        sourceWidth: sourceWidth || undefined,
        sourceHeight: sourceHeight || undefined,
      };
      setMediaAssets((prev) => {
        const last = prev[prev.length - 1];
        const trans = last
          ? clampTransition(transitionDuration, last.duration, dur)
          : 0;
        const start = last
          ? Math.max(0, last.startTime + last.duration - trans)
          : 0;
        return [
          ...prev,
          { ...newAssetBase, startTime: start, transitionDuration: trans },
        ];
      });
      sysLog(
        "import",
        `Clip: ${selected.name} (${selected.type}, ${dur.toFixed(1)}s${sourceFps ? `, ${Math.round(sourceFps)}fps` : ""}${sourceWidth ? `, ${sourceWidth}x${sourceHeight}` : ""})`,
      );
      setStatus("READY");
    } catch (err) {
      setStatus("IMPORT ERROR");
      sysLog("error", `Clip import failed: ${String(err).slice(0, 120)}`);
    }
  };
  const handleImportGalleryAudio = async () => {
    try {
      const selected = await Flow.media.select({ filter: "audio" });
      if (!selected) return;
      setStatus("LOADING AUDIO...");
      const bUrl = createBlobUrl(selected.base64, selected.mimeType);
      const duration = await probeDuration(bUrl, "audio");
      setAudioTracks((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          mediaId: selected.mediaId,
          base64: selected.base64,
          mimeType: selected.mimeType,
          name: selected.name,
          startTime: currentTime,
          duration,
          blobUrl: bUrl,
        },
      ]);
      sysLog(
        "import",
        `Audio track: ${selected.name} (${duration.toFixed(1)}s @ ${currentTime.toFixed(1)}s)`,
      );
      setStatus("READY");
    } catch (err) {
      setStatus("AUDIO ERROR");
      sysLog("error", `Audio import failed: ${String(err).slice(0, 120)}`);
    }
  };
  const handleImportLocalAudio = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const startTime = currentTime;
    const staged: AudioFragment[] = [];
    const urls: string[] = [];
    setStatus("IMPORTING AUDIO...");
    try {
      for (const file of files) {
        const blobUrl = URL.createObjectURL(file);
        urls.push(blobUrl);
        const duration = await probeDuration(blobUrl, "audio");
        const base64 = await blobToBase64(file);
        staged.push({
          id: crypto.randomUUID(),
          mediaId: "",
          base64,
          mimeType: file.type,
          name: file.name,
          startTime,
          duration,
          blobUrl,
        });
      }
      setAudioTracks((previous) => [...previous, ...staged]);
      sysLog(
        "import",
        `Added ${staged.length} audio file(s) in parallel at ${startTime.toFixed(2)}s`,
      );
      setStatus("READY");
    } catch (error) {
      urls.forEach((url) => URL.revokeObjectURL(url));
      setStatus("AUDIO ERROR");
      sysLog("error", `Audio import failed: ${String(error).slice(0, 120)}`);
    } finally {
      event.target.value = "";
    }
  };
  const handleRecord = async () => {
    if (isRecording) return;
    setIsRecording(true);
    setIsPlaying(false);
    setStatus(`RECORDING...`);
    try {
      const audio = await Flow.microphone.record({
        durationMs: recDuration * 1000,
      });
      const bUrl = createBlobUrl(audio.base64, audio.mimeType);
      const timeStr = new Date().toLocaleTimeString("en-US", { hour12: false });
      setAudioTracks((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          mediaId: "",
          base64: audio.base64,
          mimeType: audio.mimeType,
          name: `VOICE_${timeStr}`,
          startTime: currentTime,
          duration: audio.durationMs / 1000,
          blobUrl: bUrl,
        },
      ]);
      setStatus("READY");
      sysLog(
        "import",
        `Voice-over (${(audio.durationMs / 1000).toFixed(1)}s @ ${currentTime.toFixed(1)}s)`,
      );
    } catch (err) {
      setStatus("RECORD ERROR");
      sysLog("error", `Voice recording failed: ${String(err).slice(0, 120)}`);
    } finally {
      setIsRecording(false);
    }
  };
  const togglePlayback = () => {
    if (!isPlaying) {
      playbackStartTimeRef.current = performance.now();
      startTimeRef.current = currentTime;
    }
    setIsPlaying(!isPlaying);
  };
  const animate = useCallback(
    (time: number) => {
      if (!isPlaying) return;
      const elapsed = (time - playbackStartTimeRef.current) / 1000;
      const newTime = startTimeRef.current + elapsed;
      if (newTime >= totalDuration) {
        setIsPlaying(false);
        setCurrentTime(totalDuration);
      } else {
        setCurrentTime(newTime);
        requestRef.current = requestAnimationFrame(animate);
      }
    },
    [totalDuration, isPlaying],
  );
  useEffect(() => {
    if (isPlaying) requestRef.current = requestAnimationFrame(animate);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying, animate]);
  const handleMoveMedia = useCallback(
    (id: string, direction: "left" | "right") => {
      setMediaAssets((prev) => {
        const index = prev.findIndex((m) => m.id === id);
        if (
          index === -1 ||
          (direction === "left" && index === 0) ||
          (direction === "right" && index === prev.length - 1)
        )
          return prev;
        const newAssets = [...prev];
        const target = direction === "left" ? index - 1 : index + 1;
        [newAssets[index], newAssets[target]] = [
          newAssets[target],
          newAssets[index],
        ];
        return recalculateMediaStartTimes(newAssets);
      });
    },
    [recalculateMediaStartTimes],
  );
  const handleToggleMute = useCallback((id: string) => {
    setMediaAssets((prev) =>
      prev.map((m) => (m.id === id ? { ...m, muted: !m.muted } : m)),
    );
  }, []);
  const handleDeleteMedia = useCallback(
    (id: string) => {
      const asset = cleanupRef.current.mediaAssets.find((m) => m.id === id);
      if (asset?.blobUrl) {
        URL.revokeObjectURL(asset.blobUrl);
      }
      if (asset) logEvent("info", `Clip removed: ${asset.name}`);
      if (selectedAssetId === id) setSelectedAssetId(null);
      setMediaAssets((prev) => {
        return recalculateMediaStartTimes(prev.filter((m) => m.id !== id));
      });
    },
    [recalculateMediaStartTimes, selectedAssetId],
  );
  const handleDeleteAudio = useCallback((id: string) => {
    const track = cleanupRef.current.audioTracks.find((t) => t.id === id);
    if (track?.blobUrl) {
      URL.revokeObjectURL(track.blobUrl);
    }
    if (track) logEvent("info", `Audio track removed: ${track.name}`);
    setAudioTracks((prev) => prev.filter((t) => t.id !== id));
  }, []);
  // Keyboard shortcuts: Space = play/pause, arrows = seek (Shift = 5s),
  // Delete/Backspace = remove selected clip. Ignored while typing or exporting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isExporting || isRecording || showIntro || showJournal) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.tagName === "BUTTON" ||
          target.isContentEditable)
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayback();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekTo(currentTime - (e.shiftKey ? 5 : 1));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekTo(currentTime + (e.shiftKey ? 5 : 1));
      } else if (
        (e.code === "Delete" || e.code === "Backspace") &&
        selectedAssetId
      ) {
        e.preventDefault();
        handleDeleteMedia(selectedAssetId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    isExporting,
    isRecording,
    showIntro,
    showJournal,
    currentTime,
    selectedAssetId,
    togglePlayback,
    seekTo,
    handleDeleteMedia,
  ]);
  const handleSaveProject = async () => {
    setStatus("SAVING PROJECT...");
    try {
      const data = {
        mediaAssets: mediaAssets.map(({ blobUrl, ...rest }) => rest),
        audioTracks: audioTracks.map(({ blobUrl, ...rest }) => rest),
        aspectRatio,
        fitMode,
        transitionDuration,
        currentTime,
      };
      const blob = new Blob([JSON.stringify(data)], {
        type: "application/json",
      });
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(",")[1];
          const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 16);
          await Flow.download({
            base64,
            mimeType: "application/json",
            filename: `clipbraid_project_${stamp}.json`,
          });
          sysLog(
            "save",
            `Project saved: ${mediaAssets.length} clips, ${audioTracks.length} audio tracks (${(base64.length / 1048576).toFixed(1)} MB)`,
          );
          setStatus("READY");
        } catch (err) {
          setStatus("SAVE ERROR");
          sysLog("error", `Project save failed: ${String(err).slice(0, 120)}`);
        }
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      setStatus("SAVE ERROR");
      sysLog("error", `Project save failed: ${String(err).slice(0, 120)}`);
    }
  };
  const loadProjectText = async (text: string): Promise<boolean> => {
    setStatus("LOADING PROJECT...");
    try {
      const data = JSON.parse(text);
      mediaAssets.forEach((a) => a.blobUrl && URL.revokeObjectURL(a.blobUrl));
      audioTracks.forEach((a) => a.blobUrl && URL.revokeObjectURL(a.blobUrl));
      const restoredMedia = (data.mediaAssets || []).map((m: any) => ({
        ...m,
        blobUrl: createBlobUrl(m.base64, m.mimeType),
        hasAudio: m.hasAudio !== false,
        muted: m.muted ?? false,
        filter: m.filter || "none",
        trimStart: m.trimStart || 0,
        trimEnd: m.trimEnd || 0,
        originalDuration: m.originalDuration || m.duration,
        sourceFps: m.sourceFps || undefined,
        sourceWidth: m.sourceWidth || undefined,
        sourceHeight: m.sourceHeight || undefined,
        normalized: m.normalized ?? false,
      }));
      const restoredAudio = (data.audioTracks || []).map((a: any) => ({
        ...a,
        blobUrl: createBlobUrl(a.base64, a.mimeType),
      }));
      setMediaAssets(restoredMedia);
      setAudioTracks(restoredAudio);
      if (data.aspectRatio) setAspectRatio(data.aspectRatio);
      if (data.fitMode) setFitMode(data.fitMode);
      if (data.transitionDuration !== undefined)
        setTransitionDuration(data.transitionDuration);
      if (data.currentTime !== undefined) seekTo(data.currentTime);
      sysLog(
        "import",
        `Project loaded: ${restoredMedia.length} clips, ${restoredAudio.length} audio tracks`,
      );
      setStatus("READY");
      return true;
    } catch (err) {
      setStatus("LOAD ERROR");
      sysLog("error", `Project load failed: ${String(err).slice(0, 120)}`);
      return false;
    }
  };
  const handleLoadProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadProjectText(await file.text());
    e.target.value = "";
  };
  // Test/measurement hook (test-mode dev server + ?e2e=1 only): loads a
  // draft from a URL and run the export — the local measurement harness.
  const loadProjectTextRef = useRef(loadProjectText);
  loadProjectTextRef.current = loadProjectText;
  useEffect(() => {
    if (
      !__DEV_AUTOMATION__ ||
      !new URLSearchParams(window.location.search).has("e2e")
    )
      return;
    (window as any).__clipbraidE2E = {
      loadFromUrl: async (url: string) => {
        const text = await (await fetch(url)).text();
        return loadProjectTextRef.current(text);
      },
      // Legacy measurement API: normalization is deliberately disabled.
      normalizeAll: async () => 0,
    };
    return () => {
      delete (window as any).__clipbraidE2E;
    };
  }, []);
  const updateSelectedAsset = (updates: Partial<MediaAsset>) => {
    if (!selectedAssetId) return;
    setMediaAssets((prev) => {
      const index = prev.findIndex((m) => m.id === selectedAssetId);
      if (index === -1) return prev;
      const newAssets = [...prev];
      const asset = newAssets[index];
      const merged = { ...asset, ...updates };

      if (updates.trimStart !== undefined || updates.trimEnd !== undefined) {
        merged.duration = Math.max(
          0.1,
          merged.originalDuration - (merged.trimStart + merged.trimEnd),
        );
      }

      newAssets[index] = merged;
      return recalculateMediaStartTimes(newAssets);
    });
  };
  const selectedAsset = useMemo(
    () => mediaAssets.find((m) => m.id === selectedAssetId),
    [mediaAssets, selectedAssetId],
  );
  // Originals stay authoritative. Proxy generation returns only with
  // provide separate, cancellable storage; never rewrite imported bytes in idle time.
  const applyCanvasFilter = (
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    filter: VisualFilter,
  ) => {
    switch (filter) {
      case "grayscale":
        ctx.filter = "grayscale(100%)";
        break;
      case "sepia":
        ctx.filter = "sepia(100%)";
        break;
      case "noir":
        ctx.filter = "grayscale(100%) contrast(150%) brightness(80%)";
        break;
      case "vintage":
        ctx.filter = "sepia(50%) contrast(90%) brightness(110%) saturate(80%)";
        break;
      case "warm":
        ctx.filter = "sepia(30%) saturate(120%) brightness(105%)";
        break;
      case "cool":
        ctx.filter = "hue-rotate(180deg) saturate(80%) brightness(105%)";
        break;
      default:
        ctx.filter = "none";
        break;
    }
  };
  const handleExport = async () => {
    if (mediaAssets.length === 0 || isExporting) return;
    setIsExporting(true);
    setExportFailed(false);
    setErrorDetail(null);
    setExportProgress(0);
    setExportLogs([]);
    segmentProgress.current = [0, 0];
    exportStartTimeRef.current = performance.now();

    try {
      await initMediaCodecs();
      sysLog(
        "export",
        `Export started: ${exportQuality}, ${totalDuration.toFixed(1)}s timeline, ${mediaAssets.length} clips + ${audioTracks.length} audio tracks`,
      );
      addLog("PASS 1/4: Initializing Parallel Visual Pipeline...");
      const isDraft = exportQuality === "draft";
      const baseRes = isDraft ? 480 : 720;

      let targetWidth, targetHeight;
      if (aspectRatio === "16:9") {
        targetWidth = isDraft ? 854 : 1280;
        targetHeight = baseRes;
      } else if (aspectRatio === "9:16") {
        targetWidth = baseRes;
        targetHeight = isDraft ? 854 : 1280;
      } else {
        // 1:1
        targetWidth = baseRes;
        targetHeight = baseRes;
      }
      // --- T1: render at the sources' frame rate (no duplicated frames) ---
      // Blobs are fetched once per export and shared by the fps probe,
      // the segment renderers and the audio mix.
      const blobByUrl = new Map<string, Blob>();
      const getBlob = async (url: string | undefined): Promise<Blob> => {
        if (!url) throw new Error("missing media URL");
        if (!blobByUrl.has(url))
          blobByUrl.set(url, await (await fetch(url)).blob());
        return blobByUrl.get(url)!;
      };
      let maxSourceFps = 0;
      for (const asset of mediaAssets) {
        if (asset.type !== "video") continue;
        let f = asset.sourceFps || 0;
        if (!f && asset.blobUrl) {
          // Legacy drafts predate sourceFps — probe cheaply from packet timestamps.
          try {
            const input = new Input({
              source: new BlobSource(await getBlob(asset.blobUrl)),
              formats: ALL_FORMATS,
            });
            const vt = await input.getPrimaryVideoTrack();
            if (vt)
              f = (await vt.computeFrameRateMetrics({ targetPacketCount: 128 }))
                .bestGuessFrameRate;
          } catch {
            /* keep 0 */
          }
        }
        maxSourceFps = Math.max(maxSourceFps, f);
      }
      const fps = Math.max(12, Math.min(30, Math.round(maxSourceFps || 30)));
      const frameDuration = 1 / fps;
      const targetMBMap = { draft: 16, standard: 32, high: 64 };

      const videoBitrate = Math.min(
        4_000_000,
        Math.max(
          500_000,
          Math.floor(
            (targetMBMap[exportQuality] * 8 * 1024 * 1024 * 0.8) /
              totalDuration,
          ) - 192_000,
        ),
      );
      // Pre-flight: fail fast with a clear message if this device has no AVC encoder
      // (same capability-gap class as the AAC encoder — verify codec availability before export).
      if (
        !(await canEncodeVideo("avc", {
          width: targetWidth,
          height: targetHeight,
        }))
      ) {
        throw new Error(
          "This device cannot encode AVC video — export is not supported in this environment.",
        );
      }
      addLog(
        `Target: ${targetWidth}x${targetHeight} @ ${fps}fps, ${Math.round(videoBitrate / 1000)} kbps (${exportQuality.toUpperCase()})`,
      );
      addLog(`Splitting workload into 2 parallel threads...`);
      const mixAudio = async (): Promise<Uint8Array> => {
        // Defensive: wrap sample length in Math.ceil to prevent engine-dependent truncation errors
        const offlineCtx = new OfflineAudioContext(
          2,
          Math.ceil(Math.max(1, totalDuration * 44100)),
          44100,
        );

        for (const asset of mediaAssets) {
          if (asset.type === "video" && asset.hasAudio && !asset.muted) {
            try {
              const blob = await getBlob(asset.blobUrl);
              const input = new Input({
                source: new BlobSource(blob),
                formats: ALL_FORMATS,
              });
              const audioTrack = await input.getPrimaryAudioTrack();
              if (audioTrack) {
                const sink = new AudioBufferSink(audioTrack);
                // Drain only the trimmed window; schedule each decoded chunk at
                // its offset on the master timeline.
                for await (const wrapped of sink.buffers(
                  asset.trimStart,
                  asset.trimStart + asset.duration,
                )) {
                  const source = offlineCtx.createBufferSource();
                  source.buffer = wrapped.buffer;
                  source.connect(offlineCtx.destination);
                  source.start(
                    asset.startTime +
                      Math.max(0, wrapped.timestamp - asset.trimStart),
                  );
                }
              }
            } catch (e) {
              console.warn(`Audio skip: ${asset.name}`);
            }
          }
        }
        for (const track of audioTracks) {
          try {
            const blob = await getBlob(track.blobUrl);
            const arrayBuffer = await blob.arrayBuffer();
            const buffer = await offlineCtx.decodeAudioData(arrayBuffer);
            const source = offlineCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(offlineCtx.destination);
            source.start(track.startTime);
          } catch (e) {
            console.warn(`Audio skip: ${track.name}`);
          }
        }
        const mixedBuffer = await offlineCtx.startRendering();
        // AAC via WebCodecs is unavailable on Android WebView — hand ffmpeg a
        // PCM WAV instead; its software AAC encoder is deterministic everywhere.
        return audioBufferToWav(mixedBuffer);
      };
      // --- T4: precompute neighbor links once (was an O(N) find per frame) ---
      const nextAssetOf = new Map<string, MediaAsset | undefined>();
      {
        const ordered = [...mediaAssets].sort(
          (a, b) => a.startTime - b.startTime,
        );
        ordered.forEach((a, i) => nextAssetOf.set(a.id, ordered[i + 1]));
      }
      const opacityAt = (asset: MediaAsset, t: number): number => {
        const local = t - asset.startTime;
        let opacity = 1;
        if (
          asset.transitionDuration &&
          local >= 0 &&
          local < asset.transitionDuration
        ) {
          opacity = local / asset.transitionDuration;
        }
        const next = nextAssetOf.get(asset.id);
        if (next && next.transitionDuration) {
          const until = next.startTime - t;
          if (until < next.transitionDuration && until > 0)
            opacity = until / next.transitionDuration;
        }
        return Math.max(0, Math.min(1, opacity));
      };
      const renderSegment = async (
        start: number,
        end: number,
        index: number,
      ): Promise<Uint8Array> => {
        const segmentDuration = end - start;
        if (segmentDuration <= 0) return new Uint8Array(0);
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: "in-memory" }),
          target: new BufferTarget(),
        });
        // --- T2: a raw-sample source — plain frames skip the canvas entirely ---
        const videoSource = new VideoSampleSource({
          codec: "avc",
          bitrate: videoBitrate,
          keyFrameInterval: 4,
        });
        output.addVideoTrack(videoSource);
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext("2d", { alpha: false })!;
        const sinks = new Map<string, VideoSampleSink>();
        const imageBitmaps = new Map<string, ImageBitmap>();
        const relevantAssets = mediaAssets.filter(
          (a) => a.startTime < end && a.startTime + a.duration > start,
        );

        for (const asset of relevantAssets) {
          if (asset.type !== "video" || !asset.blobUrl) {
            if (asset.type === "image" && asset.blobUrl) {
              try {
                const bitmap = await createImageBitmap(
                  await getBlob(asset.blobUrl),
                );
                imageBitmaps.set(asset.id, bitmap);
              } catch (e) {
                addLog(`Thread ${index + 1} Image Cache Error: ${asset.name}`);
              }
            }
            continue;
          }
          // Each timeline clip owns its decoder. Sharing sources across clips
          // must not share mutable decoder state; the long-stall cause remains
          // unknown and this existing invariant is not proof of a stall repair.
          try {
            const input = new Input({
              source: new BlobSource(await getBlob(asset.blobUrl)),
              formats: ALL_FORMATS,
            });
            const vTrack = await input.getPrimaryVideoTrack();
            if (vTrack) sinks.set(asset.id, new VideoSampleSink(vTrack));
          } catch (e) {
            addLog(`Thread ${index + 1} Sink Error: ${asset.name}`);
          }
        }
        await output.start();
        const totalFrames = Math.ceil(segmentDuration * fps);
        // Rendering diagnostics
        let passed = 0,
          composited = 0;
        const segStartMs = performance.now();

        for (let i = 0; i < totalFrames; i++) {
          const t = start + i * frameDuration;
          const outTs = i * frameDuration;
          // Half-open [start, end) visibility with a tiny float-safety slack.
          const visible = relevantAssets.filter(
            (a) =>
              t >= a.startTime - 1e-4 && t < a.startTime + a.duration - 1e-4,
          );

          // --- T2 passthrough: one visible clip, no fade/filter, native size →
          // the decoded frame goes straight to the encoder (zero canvas work).
          let handled = false;
          if (visible.length === 1) {
            const asset = visible[0];
            const sink = sinks.get(asset.id);
            if (
              asset.type === "video" &&
              asset.filter === "none" &&
              sink &&
              opacityAt(asset, t) === 1
            ) {
              const localT = t - asset.startTime + asset.trimStart;
              // Never ask the decoder past the trimmable media: at the
              // timeline tail localT can exceed originalDuration - trimEnd
              // (fade math), and some decoders never resolve that request —
              // clamp to the last decodable instant instead.
              const maxT = asset.originalDuration - asset.trimEnd - 1e-3;
              const src = await sink.getSample(Math.min(localT, maxT));
              // Re-timing needs identical geometry — the encoder track is fixed
              // at targetWidth × targetHeight, and passthrough must not alter
              // rotation/flip/PAR metadata either.
              const par = src?.pixelAspectRatio;
              if (
                src &&
                src.displayWidth === targetWidth &&
                src.displayHeight === targetHeight &&
                src.rotation === 0 &&
                !src.flip &&
                par?.num === 1 &&
                par?.den === 1
              ) {
                // Re-time the decoded sample in place (no rewrap) —
                // the VideoFrame round-trip doubles close()s and can alias a
                // closed surface. Timestamps are segment-relative — each
                // segment is its own Output file, so 0-based keeps the muxer
                // GOP check happy (segments are concatenated afterwards).
                src.setTimestamp(outTs);
                src.setDuration(frameDuration);
                await videoSource.add(src);
                src.close();
                handled = true;
                passed++;
              } else if (src) {
                // Size/aspect mismatch → composite this frame through the canvas.
                src.close();
              }
            }
          }

          if (!handled) {
            // --- T4: a single opaque unfiltered clip needs no clear and no alpha ---
            const plain =
              visible.length === 1 &&
              visible[0].filter === "none" &&
              opacityAt(visible[0], t) === 1;
            if (!plain) {
              ctx.fillStyle = "#000000";
              ctx.fillRect(0, 0, targetWidth, targetHeight);
            }
            for (const asset of visible) {
              if (!plain) ctx.globalAlpha = opacityAt(asset, t);
              applyCanvasFilter(ctx, asset.filter);
              if (asset.type === "image") {
                const img = imageBitmaps.get(asset.id);
                if (img) {
                  const scale =
                    fitMode === "cover"
                      ? Math.max(
                          targetWidth / img.width,
                          targetHeight / img.height,
                        )
                      : Math.min(
                          targetWidth / img.width,
                          targetHeight / img.height,
                        );
                  ctx.drawImage(
                    img,
                    (targetWidth - img.width * scale) / 2,
                    (targetHeight - img.height * scale) / 2,
                    img.width * scale,
                    img.height * scale,
                  );
                }
              } else {
                const sink = sinks.get(asset.id);
                if (sink) {
                  const localT = t - asset.startTime + asset.trimStart;
                  const maxT = asset.originalDuration - asset.trimEnd - 1e-3;
                  const sample = await sink.getSample(Math.min(localT, maxT));
                  if (sample) {
                    const scale =
                      fitMode === "cover"
                        ? Math.max(
                            targetWidth / sample.displayWidth,
                            targetHeight / sample.displayHeight,
                          )
                        : Math.min(
                            targetWidth / sample.displayWidth,
                            targetHeight / sample.displayHeight,
                          );
                    sample.draw(
                      ctx,
                      (targetWidth - sample.displayWidth * scale) / 2,
                      (targetHeight - sample.displayHeight * scale) / 2,
                      sample.displayWidth * scale,
                      sample.displayHeight * scale,
                    );
                    sample.close();
                  }
                }
              }
              ctx.filter = "none";
            }
            ctx.globalAlpha = 1.0;
            const sample = new VideoSample(canvas, {
              timestamp: outTs,
              duration: frameDuration,
            });
            await videoSource.add(sample);
            sample.close();
            composited++;
          }

          if (i % 200 === 199 || i === totalFrames - 1) {
            const el = (performance.now() - segStartMs) / 1000;
            addLog(
              `Thread ${index + 1}: ${i + 1}/${totalFrames} fr | ${passed} passthrough | ${((i + 1) / el).toFixed(1)} fps`,
            );
          }
          if (i % 15 === 0) {
            segmentProgress.current[index] = i / totalFrames;
            const totalP =
              (segmentProgress.current[0] + segmentProgress.current[1]) / 2;
            setExportProgress(totalP * 70);
            // The frame loop never yields to the event loop, so React cannot
            // paint progress between awaits that resolve in microtasks. Yield
            // one macrotask per progress tick so the % ring actually moves.
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        addLog(`Thread ${index + 1}: finalizing…`);
        videoSource.close();
        await output.finalize();

        imageBitmaps.forEach((bitmap) => bitmap.close());
        segmentProgress.current[index] = 1.0;
        addLog(
          `Thread ${index + 1} done: ${passed} passthrough / ${composited} composited frames`,
        );
        return new Uint8Array(output.target.buffer!);
      };
      // Ensure the split point is frame-aligned to avoid seams
      const mid = Math.round((totalDuration / 2) * fps) / fps;
      const [chunk1, chunk2, audioData] = await Promise.all([
        renderSegment(0, mid, 0),
        renderSegment(mid, totalDuration, 1),
        mixAudio(),
      ]);
      setExportProgress(70);
      addLog("PASS 2/4: Concatenating Visual Stream...");

      await ffmpegService.writeFile("seg1.mp4", chunk1);
      await ffmpegService.writeFile("seg2.mp4", chunk2);
      await ffmpegService.writeFile("mix.wav", audioData);

      const concatList = "file 'seg1.mp4'\nfile 'seg2.mp4'";
      await ffmpegService.writeFile(
        "list.txt",
        new TextEncoder().encode(concatList),
      );

      addLog("Merging video segments...");
      await ffmpegService.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "list.txt",
        "-c",
        "copy",
        "-y",
        "joined.mp4",
      ]);

      setExportProgress(80);
      addLog("PASS 3/4: Encoding Master Audio (AAC)...");
      // AAC encoded here by ffmpeg's software encoder — WebCodecs has none on Android WebView.
      await ffmpegService.exec([
        "-i",
        "joined.mp4",
        "-i",
        "mix.wav",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-y",
        "master.mp4",
      ]);

      setExportProgress(90);
      addLog("PASS 4/4: Finalizing Master File...");
      const masterBytes = (await ffmpegService.readFile(
        "master.mp4",
      )) as Uint8Array;
      const b64 = await blobToBase64(
        new Blob([masterBytes.buffer as ArrayBuffer], { type: "video/mp4" }),
      );

      setExportProgress(95);
      addLog(`Final payload: ${(b64.length / 1048576).toFixed(1)} MB (base64)`);
      try {
        await Flow.save({
          base64: b64,
          mimeType: "video/mp4",
          name: "clipbraid_video.mp4",
        });
        sysLog(
          "save",
          `Video handed to save adapter: clipbraid_video.mp4 (${(b64.length / 1048576).toFixed(1)} MB base64)`,
        );
      } catch (e) {
        throw new Error(
          `Save rejected — platform limit reached (~${(b64.length / 1048576).toFixed(0)} MB base64). Try 'Draft' quality or a shorter project. (${String(e)})`,
        );
      }

      setExportProgress(100);
      sysLog(
        "export",
        `Export complete: ${exportQuality}, ${(b64.length / 1048576).toFixed(1)} MB`,
      );
      setStatus("READY");
    } catch (err) {
      setStatus("EXPORT ERROR");
      sysLog("error", `Export failed: ${String(err).slice(0, 200)}`);
      setExportFailed(true);
      setErrorDetail(String(err));
    } finally {
      setIsExporting(false);
      // Temp files must be removed even after a failure, or a retry hits
      // "file exists" errors inside the wasm filesystem.
      for (const f of [
        "seg1.mp4",
        "seg2.mp4",
        "mix.wav",
        "list.txt",
        "joined.mp4",
        "master.mp4",
      ]) {
        try {
          await ffmpegService.deleteFile(f);
        } catch {
          /* already gone */
        }
      }
    }
  };
  const videos = mediaAssets.filter((asset) => asset.type === "video");
  const allVideoMuted =
    videos.length > 0 && videos.every((asset) => asset.muted);
  const activeClip = mediaAssets.find(
    (asset) =>
      currentTime >= asset.startTime &&
      currentTime < asset.startTime + asset.duration,
  );
  const displayTime = (time: number) =>
    `${Math.floor(time / 60)
      .toString()
      .padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;
  const displayStatus =
    status === "READY"
      ? "Ready"
      : status.charAt(0) + status.slice(1).toLowerCase();
  return (
    <div className={`editor-app ${isTheaterMode ? "theater-mode" : ""}`}>
      {showIntro && <IntroModal onDismiss={() => setShowIntro(false)} />}
      {showJournal && (
        <JournalViewer
          entries={journalEntries}
          onClose={() => setShowJournal(false)}
        />
      )}
      <AudioEngine
        audioTracks={audioTracks}
        mediaAssets={mediaAssets}
        currentTime={currentTime}
        isPlaying={isPlaying}
      />
      <input
        type="file"
        ref={projectInputRef}
        hidden
        accept=".json"
        onChange={handleLoadProject}
      />
      <input
        type="file"
        ref={audioInputRef}
        hidden
        multiple
        accept="audio/*"
        onChange={handleImportLocalAudio}
      />
      <header className="app-header">
        <button
          className="brand-lockup"
          onClick={() => setShowIntro(true)}
          aria-label="About ClipBraid"
        >
          <BrandMark />
          <span>
            <span className="wordmark">ClipBraid</span>
            <span className="brand-descriptor">browser video editor</span>
          </span>
        </button>
        <div className="project-actions" aria-label="Project actions">
          <button
            className="button quiet"
            onClick={() => projectInputRef.current?.click()}
            title="Open Project"
            disabled={isExporting}
          >
            <Icon name="folder" />
            Open project
          </button>
          <button
            className="button quiet"
            onClick={handleSaveProject}
            title="Save Project"
            disabled={isExporting}
          >
            <Icon name="save" />
            Save project
          </button>
        </div>
        <div className="creation-actions" aria-label="Create your video">
          <button
            className="button secondary"
            onClick={handleImportMedia}
            disabled={isExporting}
          >
            <Icon name="plus" />
            Add visuals
          </button>
          <button
            className="button secondary"
            onClick={() => audioInputRef.current?.click()}
            disabled={isExporting}
          >
            <Icon name="music" />
            Add audio
          </button>
          <button
            className="button primary"
            onClick={handleExport}
            disabled={!mediaAssets.length || isExporting || isRecording}
            aria-busy={isExporting}
          >
            <Icon name="download" />
            {isExporting ? "Exporting…" : "Export video"}
          </button>
        </div>
      </header>
      {mediaAssets.some(
        (asset) =>
          (asset.sourceWidth ?? 0) > 1280 || (asset.sourceHeight ?? 0) > 1280,
      ) && (
        <p role="note" className="source-notice">
          <Icon name="info" size={16} />
          Original media retained. Large clips may take more memory and time;
          optimized proxies are temporarily disabled.
        </p>
      )}
      <main className="editor-workspace">
        <section className="preview-workspace" aria-label="Video preview">
          <div className="preview-heading">
            <h1>Preview</h1>
            <span className="preview-caption">
              {activeClip?.name || "Your video starts here"}
            </span>
            <div
              className="segmented ratio-controls"
              aria-label="Video aspect ratio"
            >
              {(["16:9", "9:16", "1:1"] as const).map((ratio) => (
                <button
                  key={ratio}
                  onClick={() => setAspectRatio(ratio)}
                  aria-pressed={aspectRatio === ratio}
                  aria-label={`${ratio} aspect ratio`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </div>
          <div className="preview-stage">
            <MediaPreview
              mediaAssets={mediaAssets}
              currentTime={currentTime}
              isPlaying={isPlaying}
              aspectRatio={aspectRatio}
              fitMode={fitMode}
              showSafeZones={showSafeZones}
            />
            {(isExporting || exportFailed) && (
              <div
                className="export-overlay"
                role={exportFailed ? "alert" : undefined}
              >
                <div className="export-message">
                  <Icon name={exportFailed ? "alert" : "video"} size={32} />
                  <h2>
                    {exportFailed
                      ? "Couldn’t export this video"
                      : "Preparing your video"}
                  </h2>
                  {!exportFailed ? (
                    <>
                      <p>{Math.round(exportProgress)}% complete</p>
                      <progress
                        max="100"
                        value={exportProgress}
                        aria-label="Video export progress"
                      />
                    </>
                  ) : (
                    <p>{errorDetail}</p>
                  )}
                  <details className="technical-details">
                    <summary>Technical details</summary>
                    <div className="export-log">
                      {exportLogs.map((log, index) => (
                        <p key={index}>{log}</p>
                      ))}
                    </div>
                  </details>
                  {exportFailed && (
                    <button
                      className="button primary"
                      onClick={() => setExportFailed(false)}
                    >
                      Back to editing
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="playback-toolbar">
            <span className="time-readout">
              {displayTime(currentTime)}
              <span>
                {" "}
                /{" "}
                {displayTime(
                  mediaAssets.length || audioTracks.length ? totalDuration : 0,
                )}
              </span>
            </span>
            <div className="transport-controls">
              <button
                className="icon-button"
                onClick={() => seekTo(0)}
                aria-label="Go to start"
                title="Go to start"
              >
                <Icon name="back" />
              </button>
              <button
                className="play-button"
                onClick={togglePlayback}
                aria-label={isPlaying ? "Pause preview" : "Play preview"}
                title="Play/Pause (Space)"
                disabled={!mediaAssets.length && !audioTracks.length}
              >
                <Icon name={isPlaying ? "pause" : "play"} size={21} />
              </button>
              <button
                className="icon-button"
                onClick={() => seekTo(totalDuration)}
                aria-label="Go to end"
                title="Go to end"
              >
                <Icon name="next" />
              </button>
            </div>
            <div className="view-controls">
              <button
                className="icon-button"
                onClick={() => setShowSafeZones(!showSafeZones)}
                aria-label="Show framing guides"
                aria-pressed={showSafeZones}
                title="Framing guides"
              >
                <Icon name="grid" />
              </button>
              <button
                className="icon-button"
                onClick={() => setIsTheaterMode(!isTheaterMode)}
                aria-label={
                  isTheaterMode ? "Exit expanded preview" : "Expand preview"
                }
                title={
                  isTheaterMode ? "Exit expanded preview" : "Expand preview"
                }
              >
                <Icon name={isTheaterMode ? "minimize" : "expand"} />
              </button>
            </div>
          </div>
        </section>
        {!isTheaterMode && (
          <aside
            className="editor-inspector"
            aria-label={selectedAsset ? "Clip settings" : "Project settings"}
          >
            {selectedAsset ? (
              <>
                <div className="inspector-heading">
                  <h2>Clip settings</h2>
                  <button
                    className="icon-button"
                    onClick={() => setSelectedAssetId(null)}
                    aria-label="Close clip settings"
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className="selected-file">
                  <Icon
                    name={selectedAsset.type === "video" ? "video" : "image"}
                    size={24}
                  />
                  <div>
                    <strong title={selectedAsset.name}>
                      {selectedAsset.name}
                    </strong>
                    <span>
                      {selectedAsset.type === "video" ? "Video" : "Photo"} ·{" "}
                      {selectedAsset.duration.toFixed(2)} seconds
                    </span>
                  </div>
                </div>
                <div className="inspector-section">
                  <label htmlFor="clip-filter">Look</label>
                  <select
                    id="clip-filter"
                    value={selectedAsset.filter}
                    onChange={(event) =>
                      updateSelectedAsset({
                        filter: event.target.value as VisualFilter,
                      })
                    }
                  >
                    {Object.entries({
                      none: "Original",
                      grayscale: "Black & white",
                      sepia: "Sepia",
                      noir: "Noir",
                      vintage: "Vintage",
                      warm: "Warm",
                      cool: "Cool",
                    }).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedAsset.type === "video" && (
                  <>
                    <div className="inspector-section">
                      <label htmlFor="trim-start">
                        Trim from start
                        <span>{selectedAsset.trimStart.toFixed(2)}s</span>
                      </label>
                      <input
                        id="trim-start"
                        type="range"
                        min="0"
                        max={Math.max(
                          0,
                          selectedAsset.originalDuration -
                            selectedAsset.trimEnd -
                            0.1,
                        )}
                        step="0.05"
                        value={selectedAsset.trimStart}
                        onChange={(event) =>
                          updateSelectedAsset({
                            trimStart: Number(event.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="inspector-section">
                      <label htmlFor="trim-end">
                        Trim from end
                        <span>{selectedAsset.trimEnd.toFixed(2)}s</span>
                      </label>
                      <input
                        id="trim-end"
                        type="range"
                        min="0"
                        max={Math.max(
                          0,
                          selectedAsset.originalDuration -
                            selectedAsset.trimStart -
                            0.1,
                        )}
                        step="0.05"
                        value={selectedAsset.trimEnd}
                        onChange={(event) =>
                          updateSelectedAsset({
                            trimEnd: Number(event.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="inspector-section">
                      <div className="switch-row">
                        <span>Original clip sound</span>
                        <button
                          className="switch"
                          role="switch"
                          aria-label="Original clip sound"
                          aria-checked={!selectedAsset.muted}
                          onClick={() =>
                            updateSelectedAsset({ muted: !selectedAsset.muted })
                          }
                        >
                          <span />
                        </button>
                      </div>
                      <p className="helper-text">
                        {selectedAsset.muted
                          ? "Off. Your added audio still plays."
                          : "On. Plays alongside your added audio."}
                      </p>
                    </div>
                  </>
                )}
                <div className="inspector-section">
                  <label htmlFor="clip-crossfade">
                    Crossfade
                    <span>
                      {(selectedAsset.transitionDuration || 0).toFixed(1)}s
                    </span>
                  </label>
                  <input
                    id="clip-crossfade"
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={selectedAsset.transitionDuration || 0}
                    onChange={(event) =>
                      updateSelectedAsset({
                        transitionDuration: Number(event.target.value),
                      })
                    }
                  />
                </div>
                <div className="clip-order-controls">
                  <button
                    className="button secondary"
                    onClick={() => handleMoveMedia(selectedAsset.id, "left")}
                    disabled={mediaAssets[0]?.id === selectedAsset.id}
                  >
                    <Icon name="left" />
                    Earlier
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => handleMoveMedia(selectedAsset.id, "right")}
                    disabled={
                      mediaAssets[mediaAssets.length - 1]?.id ===
                      selectedAsset.id
                    }
                  >
                    Later
                    <Icon name="right" />
                  </button>
                </div>
                <button
                  className="button danger"
                  onClick={() => handleDeleteMedia(selectedAsset.id)}
                >
                  <Icon name="delete" />
                  Remove clip
                </button>
              </>
            ) : (
              <>
                <div className="inspector-heading">
                  <h2>Make it yours</h2>
                  <Icon name="settings" />
                </div>
                <section className="inspector-section">
                  <h3>Your soundtrack</h3>
                  <p className="helper-text">
                    Layer music, narration and other audio. Each file gets its
                    own track.
                  </p>
                  <button
                    className="button secondary full-width"
                    onClick={() => audioInputRef.current?.click()}
                    disabled={isExporting}
                  >
                    <Icon name="plus" />
                    Add audio files
                  </button>
                  <button
                    className="text-button"
                    onClick={handleImportGalleryAudio}
                    disabled={isExporting}
                  >
                    Choose audio from gallery
                    <Icon name="right" size={14} />
                  </button>
                </section>
                <section className="inspector-section">
                  <div className="switch-row">
                    <h3>Original video sound</h3>
                    <button
                      className="switch"
                      role="switch"
                      aria-label="Original video sound"
                      aria-checked={videos.length > 0 && !allVideoMuted}
                      disabled={!videos.length || isExporting}
                      onClick={() =>
                        setMediaAssets((prev) =>
                          prev.map((asset) =>
                            asset.type === "video"
                              ? { ...asset, muted: !allVideoMuted }
                              : asset,
                          ),
                        )
                      }
                    >
                      <span />
                    </button>
                  </div>
                  <p className="helper-text">
                    {!videos.length
                      ? "Add a video to control its original sound."
                      : allVideoMuted
                        ? "Off for all clips. Only your added audio plays."
                        : "Keep it on, or turn it off for your own soundtrack."}
                  </p>
                </section>
                <section className="inspector-section">
                  <h3>Framing</h3>
                  <div className="segmented">
                    <button
                      onClick={() => setFitMode("contain")}
                      aria-pressed={fitMode === "contain"}
                    >
                      Fit whole image
                    </button>
                    <button
                      onClick={() => setFitMode("cover")}
                      aria-pressed={fitMode === "cover"}
                    >
                      Fill frame
                    </button>
                  </div>
                </section>
                <section className="inspector-section">
                  <h3>Export quality</h3>
                  <div className="segmented">
                    {(["draft", "standard", "high"] as ExportQuality[]).map(
                      (quality) => (
                        <button
                          key={quality}
                          onClick={() => setExportQuality(quality)}
                          aria-pressed={exportQuality === quality}
                        >
                          {quality}
                        </button>
                      ),
                    )}
                  </div>
                  <p className="helper-text">
                    {exportEstimate.mb} MB target · size is an estimate
                  </p>
                </section>
                <details className="recorder">
                  <summary>
                    <Icon name="mic" />
                    Record voice-over
                  </summary>
                  <label htmlFor="record-duration">
                    Recording length<span>{recDuration}s</span>
                  </label>
                  <input
                    id="record-duration"
                    type="range"
                    min="1"
                    max="60"
                    value={recDuration}
                    disabled={isRecording}
                    onChange={(event) =>
                      setRecDuration(Number(event.target.value))
                    }
                  />
                  <button
                    className="button secondary full-width"
                    onClick={handleRecord}
                    disabled={isRecording || isExporting}
                    aria-busy={isRecording}
                  >
                    <Icon name="mic" />
                    {isRecording ? "Recording…" : "Start recording"}
                  </button>
                </details>
                <p className="inspector-tip">
                  Select a clip in the timeline to trim it, change its look or
                  adjust its sound.
                </p>
              </>
            )}
          </aside>
        )}
      </main>
      <section
        className="timeline-workspace"
        ref={timelineContainerRef}
        aria-label="Video and audio arrangement"
      >
        <div className="timeline-heading">
          <h2>Timeline</h2>
          <span>
            {mediaAssets.length} visual{mediaAssets.length === 1 ? "" : "s"} ·{" "}
            {audioTracks.length} audio track
            {audioTracks.length === 1 ? "" : "s"}
          </span>
          <label className="zoom-control" htmlFor="timeline-zoom">
            Zoom
            <input
              id="timeline-zoom"
              type="range"
              min="16"
              max="100"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
        </div>
        <Timeline
          mediaAssets={mediaAssets}
          audioTracks={audioTracks}
          currentTime={currentTime}
          zoom={zoom}
          selectedAssetId={selectedAssetId}
          onSeek={seekTo}
          onDeleteMedia={handleDeleteMedia}
          onDeleteAudio={handleDeleteAudio}
          onMoveMedia={handleMoveMedia}
          onToggleMute={handleToggleMute}
          onSelectAsset={setSelectedAssetId}
        />
      </section>
      <footer className="editor-statusbar">
        <span
          role="status"
          aria-live="polite"
          data-editor-status={status}
          className={status.includes("ERROR") ? "status-error" : ""}
        >
          <span className="status-dot" />
          {displayStatus}
        </span>
        <span className="status-hint">
          Audio files start at the playhead. Add several to layer them.
        </span>
        <button
          className="text-button"
          onClick={() => setShowJournal(true)}
          title="Diagnostics"
        >
          <Icon name="info" size={15} />
          Details
        </button>
      </footer>
    </div>
  );
}
