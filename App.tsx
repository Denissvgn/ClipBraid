import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { Flow } from "./platform";
import {
  assertProjectSize,
  parseProject,
  serializeProject,
} from "./services/project";
import { MediaSourceStore, type SourceLease } from "./services/mediaSources";
import {
  activeIntervals,
  canvasFit,
  clampPlayhead,
  createOpacitySampler,
  estimateExport,
  exportFrameRate,
  frameCount,
  frameTimestamp,
  intervalsOverlap,
  projectDuration,
  recalculateMediaStartTimes as sequenceMediaStartTimes,
  sourceTimeAt,
  sourceWindow,
  trimmedDuration,
  type ExportQuality,
} from "./services/timeline";
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
  bytes: Blob,
): Promise<{
  hasAudio: boolean;
  fps: number;
  width: number;
  height: number;
}> => {
  const input = new Input({
    source: new BlobSource(bytes),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error("The selected file has no video track.");
    const fps = (
      await video.computeFrameRateMetrics({ targetPacketCount: 128 })
    ).bestGuessFrameRate;
    return {
      hasAudio: (await input.getAudioTracks()).length > 0,
      fps,
      width: await video.getCodedWidth(),
      height: await video.getCodedHeight(),
    };
  } finally {
    input.dispose();
  }
};
const probeDuration = (
  blobUrl: string,
  type: "image" | "video" | "audio",
): Promise<number> => {
  return new Promise((resolve, reject) => {
    const element = document.createElement(type === "image" ? "img" : type);
    const timer = setTimeout(
      () => finish(new Error("Media metadata timed out.")),
      15_000,
    );
    const finish = (error?: Error, duration?: number) => {
      clearTimeout(timer);
      element.onload = null;
      element.onerror = null;
      if (element instanceof HTMLMediaElement) {
        element.onloadedmetadata = null;
        element.removeAttribute("src");
        element.load();
      } else element.removeAttribute("src");
      if (error) reject(error);
      else resolve(duration!);
    };
    element.onerror = () => finish(new Error("Cannot read this media file."));
    if (element instanceof HTMLMediaElement) {
      element.preload = "metadata";
      element.onloadedmetadata = () => {
        const duration = element.duration;
        if (!Number.isFinite(duration) || duration <= 0)
          finish(new Error("Invalid media duration."));
        else finish(undefined, duration);
      };
    } else element.onload = () => finish(undefined, 5);
    element.src = blobUrl;
  });
};
const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const bytes = base64ToUint8Array(base64);
  if (!bytes.length) throw new Error("Empty media data.");
  return new Blob([bytes], { type: mimeType });
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

  // Media ownership: immutable originals and every object URL live in this
  // store; state holds clip instances that reference sources by ID.
  const storeRef = useRef<MediaSourceStore | null>(null);
  if (!storeRef.current) storeRef.current = new MediaSourceStore();
  const sourceUrl = useCallback(
    (sourceId: string) => storeRef.current!.urlFor(sourceId),
    [],
  );

  useEffect(() => {
    cleanupRef.current = { mediaAssets, audioTracks };
  }, [mediaAssets, audioTracks]);
  const isExportingRef = useRef(isExporting);
  useEffect(() => {
    isExportingRef.current = isExporting;
  }, [isExporting]);
  // One save at a time: each save serializes one leased, immutable snapshot.
  const saveInFlightRef = useRef(false);
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
  // The pin-sync effect owns source release: commits pre-pin additions so URLs
  // exist at first render, and unreferenced sources are released only after
  // the state that drops them has committed — never while a job lease is open.
  useEffect(() => {
    storeRef.current!.syncPins(
      [...mediaAssets, ...audioTracks].map((item) => item.sourceId),
    );
  }, [mediaAssets, audioTracks]);
  useEffect(() => {
    return () => {
      storeRef.current!.clear();
    };
  }, []);
  const totalDuration = useMemo(
    () => projectDuration(mediaAssets, audioTracks),
    [mediaAssets, audioTracks],
  );
  const exportEstimate = useMemo(
    () => estimateExport(exportQuality, totalDuration),
    [exportQuality, totalDuration],
  );
  const seekTo = useCallback(
    (t: number) => {
      const clamped = clampPlayhead(t, totalDuration);
      setCurrentTime(clamped);
      if (isPlaying) {
        startTimeRef.current = clamped;
        playbackStartTimeRef.current = performance.now();
      }
    },
    [isPlaying, totalDuration],
  );
  const recalculateMediaStartTimes = useCallback(
    (assets: MediaAsset[]): MediaAsset[] =>
      sequenceMediaStartTimes(assets, transitionDuration),
    [transitionDuration],
  );
  // Duration-changing edits also clamp a paused playhead. Loading uses the
  // same pure rule below, but against the restored project's own duration.
  useEffect(() => {
    const clamped = clampPlayhead(currentTime, totalDuration);
    if (clamped === currentTime) return;
    setCurrentTime(clamped);
    startTimeRef.current = clamped;
    playbackStartTimeRef.current = performance.now();
  }, [currentTime, totalDuration]);
  const handleImportMedia = async () => {
    const tx = storeRef.current!.beginTransaction();
    try {
      const selected = await Flow.media.select({ filter: "all" });
      if (!selected) {
        tx.rollback();
        return;
      }
      setStatus("PROBING MEDIA...");
      if (selected.type !== "image" && selected.type !== "video")
        throw new Error("Choose a video or image.");
      // Host transport delivers base64; the store holds Blob originals.
      const [asset] = await tx.stage([
        { bytes: base64ToBlob(selected.base64, selected.mimeType), mimeType: selected.mimeType },
      ]);
      const probeLease = tx.acquire(asset.sourceId, "import-probe");
      try {
        const dur = await probeDuration(probeLease.url, selected.type);
        const {
          hasAudio,
          fps: sourceFps,
          width: sourceWidth,
          height: sourceHeight,
        } = selected.type === "video"
          ? await probeVideoSource(asset.bytes)
          : { hasAudio: false, fps: 0, width: 0, height: 0 };
        const newAssetBase: MediaAsset = {
          id: crypto.randomUUID(),
          mediaId: selected.mediaId,
          sourceId: asset.sourceId,
          mimeType: selected.mimeType,
          type: selected.type as "image" | "video",
          name: selected.name,
          duration: dur,
          originalDuration: dur,
          trimStart: 0,
          trimEnd: 0,
          filter: "none",
          startTime: 0,
          hasAudio,
          muted: false,
          sourceFps: sourceFps || undefined,
          sourceWidth: sourceWidth || undefined,
          sourceHeight: sourceHeight || undefined,
        };
        tx.pin(asset.sourceId);
        setMediaAssets((prev) =>
          recalculateMediaStartTimes([...prev, newAssetBase]),
        );
        tx.commit();
        sysLog(
          "import",
          `Clip: ${selected.name} (${selected.type}, ${dur.toFixed(1)}s${sourceFps ? `, ${Number(sourceFps.toFixed(3))}fps` : ""}${sourceWidth ? `, ${sourceWidth}x${sourceHeight}` : ""})`,
        );
        setStatus("READY");
      } finally {
        probeLease.release();
      }
    } catch (err) {
      tx.rollback();
      setStatus("IMPORT ERROR");
      sysLog("error", `Clip import failed: ${String(err).slice(0, 120)}`);
    }
  };
  const handleImportGalleryAudio = async () => {
    const tx = storeRef.current!.beginTransaction();
    try {
      const selected = await Flow.media.select({ filter: "audio" });
      if (!selected) {
        tx.rollback();
        return;
      }
      setStatus("LOADING AUDIO...");
      const [asset] = await tx.stage([
        {
          bytes: base64ToBlob(selected.base64, selected.mimeType),
          mimeType: selected.mimeType,
        },
      ]);
      const probeLease = tx.acquire(asset.sourceId, "import-probe");
      let duration: number;
      try {
        duration = await probeDuration(probeLease.url, "audio");
      } finally {
        probeLease.release();
      }
      tx.pin(asset.sourceId);
      setAudioTracks((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          mediaId: selected.mediaId,
          sourceId: asset.sourceId,
          mimeType: selected.mimeType,
          name: selected.name,
          startTime: currentTime,
          duration,
        },
      ]);
      tx.commit();
      sysLog(
        "import",
        `Audio track: ${selected.name} (${duration.toFixed(1)}s @ ${currentTime.toFixed(1)}s)`,
      );
      setStatus("READY");
    } catch (err) {
      tx.rollback();
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
    const tx = storeRef.current!.beginTransaction();
    setStatus("IMPORTING AUDIO...");
    try {
      // One batch: identical files share a single immutable source.
      const assets = await tx.stage(
        files.map((file) => ({ bytes: file, mimeType: file.type })),
      );
      for (const [index, file] of files.entries()) {
        const asset = assets[index];
        const probeLease = tx.acquire(asset.sourceId, "import-probe");
        let duration: number;
        try {
          duration = await probeDuration(probeLease.url, "audio");
        } finally {
          probeLease.release();
        }
        const id = crypto.randomUUID();
        staged.push({
          id,
          // No gallery reference for a local file: use the entry ID, the same
          // default the project schema applies to missing references.
          mediaId: id,
          sourceId: asset.sourceId,
          mimeType: file.type,
          name: file.name,
          startTime,
          duration,
        });
      }
      staged.forEach((track) => tx.pin(track.sourceId));
      setAudioTracks((previous) => [...previous, ...staged]);
      tx.commit();
      sysLog(
        "import",
        `Added ${staged.length} audio file(s) in parallel at ${startTime.toFixed(2)}s`,
      );
      setStatus("READY");
    } catch (error) {
      tx.rollback();
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
    const tx = storeRef.current!.beginTransaction();
    try {
      const audio = await Flow.microphone.record({
        durationMs: recDuration * 1000,
      });
      const [asset] = await tx.stage([
        {
          bytes: base64ToBlob(audio.base64, audio.mimeType),
          mimeType: audio.mimeType,
        },
      ]);
      tx.pin(asset.sourceId);
      const timeStr = new Date().toLocaleTimeString("en-US", { hour12: false });
      const id = crypto.randomUUID();
      setAudioTracks((prev) => [
        ...prev,
        {
          id,
          mediaId: id,
          sourceId: asset.sourceId,
          mimeType: audio.mimeType,
          name: `VOICE_${timeStr}`,
          startTime: currentTime,
          duration: audio.durationMs / 1000,
        },
      ]);
      tx.commit();
      setStatus("READY");
      sysLog(
        "import",
        `Voice-over (${(audio.durationMs / 1000).toFixed(1)}s @ ${currentTime.toFixed(1)}s)`,
      );
    } catch (err) {
      tx.rollback();
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
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setStatus("SAVING PROJECT...");
    // One consistent snapshot of a single render's state. Every source is
    // leased before the first await, so replacing or deleting the project
    // mid-save retires pins but cannot purge the bytes this save is reading.
    const snapshot = {
      mediaAssets,
      audioTracks,
      aspectRatio,
      fitMode,
      transitionDuration,
      currentTime,
    };
    let leases: SourceLease[] = [];
    try {
      leases = storeRef.current!.acquireAll(
        [...snapshot.mediaAssets, ...snapshot.audioTracks].map(
          (item) => item.sourceId,
        ),
        "project-save",
      );
      // Base64 appears only at this transport boundary.
      const json = await serializeProject(snapshot, async (sourceId) => {
        const bytes = storeRef.current!.bytesFor(sourceId);
        if (!bytes) throw new Error("Missing media source.");
        return blobToBase64(bytes);
      });
      const base64 = await blobToBase64(
        new Blob([json], { type: "application/json" }),
      );
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
        `Project saved: ${snapshot.mediaAssets.length} clips, ${snapshot.audioTracks.length} audio tracks (${(base64.length / 1048576).toFixed(1)} MiB)`,
      );
      setStatus("READY");
    } catch (err) {
      setStatus("SAVE ERROR");
      sysLog("error", `Project save failed: ${String(err).slice(0, 120)}`);
    } finally {
      for (const lease of leases) lease.release();
      saveInFlightRef.current = false;
    }
  };
  const loadProjectText = async (text: string): Promise<boolean> => {
    setStatus("LOADING PROJECT...");
    const tx = storeRef.current!.beginTransaction();
    try {
      const data = parseProject(text);
      // Stage and validate every source before touching live state; identical
      // payloads share one immutable original. No URL exists until commit.
      const staged = await tx.stage(
        data.sources.map((source) => ({
          bytes: base64ToBlob(source.base64, source.mimeType),
          mimeType: source.mimeType,
        })),
      );
      const stagedIds = [...new Set(staged.map((asset) => asset.sourceId))];
      const idMap = new Map(
        data.sources.map((source, index) => [
          source.sourceId,
          staged[index].sourceId,
        ]),
      );
      const restoredMedia = data.mediaAssets.map((clip) => ({
        ...clip,
        sourceId: idMap.get(clip.sourceId)!,
      }));
      const restoredAudio = data.audioTracks.map((track) => ({
        ...track,
        sourceId: idMap.get(track.sourceId)!,
      }));
      const restoredTime = clampPlayhead(
        data.currentTime,
        projectDuration(restoredMedia, restoredAudio),
      );
      // Commit: pre-pin so URLs exist at the first render, then publish one
      // batched state update. The pin-sync effect releases the replaced
      // project's sources only after that commit. Any failure before this
      // point rolls the transaction back and leaves the old project untouched.
      stagedIds.forEach((sourceId) => tx.pin(sourceId));
      setIsPlaying(false);
      setSelectedAssetId(null);
      setMediaAssets(restoredMedia);
      setAudioTracks(restoredAudio);
      setAspectRatio(data.aspectRatio);
      setFitMode(data.fitMode);
      setTransitionDuration(data.transitionDuration);
      setCurrentTime(restoredTime);
      startTimeRef.current = restoredTime;
      cleanupRef.current = {
        mediaAssets: restoredMedia,
        audioTracks: restoredAudio,
      };
      tx.commit();
      sysLog(
        "import",
        `Project loaded: ${restoredMedia.length} clips, ${restoredAudio.length} audio tracks`,
      );
      setStatus("READY");
      return true;
    } catch (err) {
      tx.rollback();
      setStatus("LOAD ERROR");
      sysLog("error", `Project load failed: ${String(err).slice(0, 120)}`);
      return false;
    }
  };
  const handleLoadProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Gate on the real byte size before reading, parsing or allocating anything.
    // File reads are inside the same error boundary as staged load failures,
    // and the input is reset even when the host filesystem read rejects.
    try {
      assertProjectSize(file.size);
      await loadProjectText(await file.text());
    } catch (err) {
      setStatus("LOAD ERROR");
      sysLog("error", `Project load failed: ${String(err).slice(0, 120)}`);
    } finally {
      e.target.value = "";
    }
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
        merged.duration = trimmedDuration(merged);
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

    // Hold every original for the job's lifetime: replacing or deleting the
    // project cannot revoke media an active export still reads.
    const jobLeases: SourceLease[] = [];
    try {
      jobLeases.push(
        ...storeRef.current!.acquireAll(
          [...mediaAssets, ...audioTracks].map((item) => item.sourceId),
          "export",
        ),
      );
      addLog("EXPORT STARTED");
      setIsPlaying(false);
      await ffmpegService.load();
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
      // Original bytes are read through the source store; job leases keep
      // them alive for the whole export, so no URL fetch is needed here.
      const getBlob = async (sourceId: string | undefined): Promise<Blob> => {
        const bytes = sourceId
          ? storeRef.current!.bytesFor(sourceId)
          : undefined;
        if (!bytes) throw new Error("missing media source");
        return bytes;
      };
      let maxSourceFps = 0;
      for (const asset of mediaAssets) {
        if (asset.type !== "video") continue;
        let f = asset.sourceFps || 0;
        if (!f) {
          // Legacy drafts predate sourceFps — probe cheaply from packet timestamps.
          try {
            const input = new Input({
              source: new BlobSource(await getBlob(asset.sourceId)),
              formats: ALL_FORMATS,
            });
            try {
              const vt = await input.getPrimaryVideoTrack();
              if (!vt) throw new Error("Missing video track");
              f = (await vt.computeFrameRateMetrics({ targetPacketCount: 128 }))
                .bestGuessFrameRate;
            } finally {
              input.dispose();
            }
          } catch {
            /* keep 0 */
          }
        }
        maxSourceFps = Math.max(maxSourceFps, f);
      }
      const fps = exportFrameRate(maxSourceFps);
      const frameDuration = 1 / fps;
      const { videoBitrate, audioBitrate } = estimateExport(
        exportQuality,
        totalDuration,
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
      const mixAudio = async (signal?: AbortSignal): Promise<Uint8Array> => {
        const offlineCtx = new OfflineAudioContext(
          2,
          Math.ceil(Math.max(1, totalDuration * 44100)),
          44100,
        );
        for (const asset of mediaAssets) {
          signal?.throwIfAborted();
          if (asset.type !== "video" || !asset.hasAudio || asset.muted)
            continue;
          const input = new Input({
            source: new BlobSource(await getBlob(asset.sourceId)),
            formats: ALL_FORMATS,
          });
          try {
            const track = await input.getPrimaryAudioTrack();
            // Older drafts may not know that a valid video is silent.
            if (!track) continue;
            if (!(await track.canDecode()))
              throw new Error("Unsupported audio codec");
            const sink = new AudioBufferSink(track);
            const window = sourceWindow(asset);
            const selectionEnd = window.start + asset.duration;
            for await (const wrapped of sink.buffers(
              window.start,
              selectionEnd,
            )) {
              signal?.throwIfAborted();
              const from = Math.max(wrapped.timestamp, window.start);
              const to = Math.min(
                wrapped.timestamp + wrapped.buffer.duration,
                selectionEnd,
              );
              if (to <= from) continue;
              const source = offlineCtx.createBufferSource();
              source.buffer = wrapped.buffer;
              source.connect(offlineCtx.destination);
              source.start(
                asset.startTime + from - window.start,
                from - wrapped.timestamp,
                to - from,
              );
            }
          } catch (error) {
            throw new Error(
              `Cannot decode audio for ${asset.name}: ${String(error)}`,
            );
          } finally {
            input.dispose();
          }
        }
        for (const track of audioTracks) {
          signal?.throwIfAborted();
          try {
            const buffer = await offlineCtx.decodeAudioData(
              await (await getBlob(track.sourceId)).arrayBuffer(),
            );
            const source = offlineCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(offlineCtx.destination);
            source.start(
              track.startTime,
              0,
              Math.min(track.duration, buffer.duration),
            );
          } catch (error) {
            throw new Error(
              `Cannot decode audio for ${track.name}: ${String(error)}`,
            );
          }
        }
        signal?.throwIfAborted();
        return audioBufferToWav(await offlineCtx.startRendering());
      };
      const opacityAt = createOpacitySampler(mediaAssets);
      const renderSegment = async (
        start: number,
        end: number,
        index: number,
        signal?: AbortSignal,
      ): Promise<Uint8Array> => {
        const segmentDuration = end - start;
        if (segmentDuration <= 0) return new Uint8Array(0);
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: "in-memory" }),
          target: new BufferTarget(),
        });
        const videoSource = new VideoSampleSource({
          codec: "avc",
          bitrate: videoBitrate,
          keyFrameInterval: 4,
        });
        output.addVideoTrack(videoSource, { frameRate: fps });
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext("2d", { alpha: false })!;
        const sinks = new Map<string, VideoSampleSink>();
        const images = new Map<string, ImageBitmap>();
        const inputs: Input[] = [];
        const relevantAssets = mediaAssets.filter((asset) =>
          intervalsOverlap(asset, start, end),
        );
        let finalized = false;
        let passed = 0,
          composited = 0;
        try {
          for (const asset of relevantAssets) {
            signal?.throwIfAborted();
            try {
              const blob = await getBlob(asset.sourceId);
              if (asset.type === "image") {
                images.set(asset.id, await createImageBitmap(blob));
              } else {
                // Each timeline clip owns its decoder, even for repeated sources.
                const input = new Input({
                  source: new BlobSource(blob),
                  formats: ALL_FORMATS,
                });
                inputs.push(input);
                const track = await input.getPrimaryVideoTrack();
                if (!track || !(await track.canDecode()))
                  throw new Error("Missing or unsupported video track");
                sinks.set(asset.id, new VideoSampleSink(track));
              }
            } catch (error) {
              throw new Error(`Cannot decode ${asset.name}: ${String(error)}`);
            }
          }
          await output.start();
          const totalFrames = frameCount(segmentDuration, fps);
          const segmentStarted = performance.now();
          for (let i = 0; i < totalFrames; i++) {
            signal?.throwIfAborted();
            const t = frameTimestamp(i, fps, start);
            const outTs = frameTimestamp(i, fps);
            const visible = activeIntervals(relevantAssets, t);
            const decoded = new Map<string, VideoSample>();
            const frameFor = async (asset: MediaAsset) => {
              if (decoded.has(asset.id)) return decoded.get(asset.id)!;
              const sink = sinks.get(asset.id);
              if (!sink) throw new Error(`Missing decoder for ${asset.name}`);
              const local = sourceTimeAt(asset, t);
              const sample = await sink.getSample(local);
              if (!sample)
                throw new Error(
                  `No decoded frame for ${asset.name} at ${local.toFixed(3)}s`,
                );
              decoded.set(asset.id, sample);
              return sample;
            };
            try {
              let handled = false;
              if (visible.length === 1) {
                const asset = visible[0];
                if (
                  asset.type === "video" &&
                  asset.filter === "none" &&
                  opacityAt(asset, t) === 1
                ) {
                  const src = await frameFor(asset);
                  const par = src.pixelAspectRatio;
                  if (
                    src.displayWidth === targetWidth &&
                    src.displayHeight === targetHeight &&
                    src.rotation === 0 &&
                    !src.flip &&
                    par?.num === 1 &&
                    par?.den === 1
                  ) {
                    src.setTimestamp(outTs);
                    src.setDuration(frameDuration);
                    await videoSource.add(src);
                    handled = true;
                    passed++;
                  }
                }
              }
              if (!handled) {
                // Always reset the entire matte, including contain margins and
                // frames following a different geometry/filter/transition.
                ctx.globalAlpha = 1;
                ctx.filter = "none";
                ctx.globalCompositeOperation = "source-over";
                ctx.fillStyle = "#000000";
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.globalCompositeOperation = "lighter";
                for (const asset of visible) {
                  ctx.globalAlpha = opacityAt(asset, t);
                  applyCanvasFilter(ctx, asset.filter);
                  if (asset.type === "image") {
                    const image = images.get(asset.id);
                    if (!image)
                      throw new Error(`Missing image for ${asset.name}`);
                    const fit = canvasFit(
                      image.width,
                      image.height,
                      targetWidth,
                      targetHeight,
                      fitMode,
                    );
                    ctx.drawImage(
                      image,
                      fit.x,
                      fit.y,
                      fit.width,
                      fit.height,
                    );
                  } else {
                    const sample = await frameFor(asset);
                    const fit = canvasFit(
                      sample.displayWidth,
                      sample.displayHeight,
                      targetWidth,
                      targetHeight,
                      fitMode,
                    );
                    sample.draw(ctx, fit.x, fit.y, fit.width, fit.height);
                  }
                }
                ctx.globalAlpha = 1;
                ctx.filter = "none";
                ctx.globalCompositeOperation = "source-over";
                const sample = new VideoSample(canvas, {
                  timestamp: outTs,
                  duration: frameDuration,
                });
                try {
                  await videoSource.add(sample);
                } finally {
                  sample.close();
                }
                composited++;
              }
            } finally {
              decoded.forEach((sample) => sample.close());
            }
            if (i % 200 === 199 || i === totalFrames - 1) {
              const seconds = (performance.now() - segmentStarted) / 1000;
              addLog(
                `Thread ${index + 1}: ${i + 1}/${totalFrames} fr | ${passed} passthrough | ${((i + 1) / seconds).toFixed(1)} fps`,
              );
            }
            if (i % 15 === 0) {
              segmentProgress.current[index] = i / totalFrames;
              setExportProgress(
                ((segmentProgress.current[0] + segmentProgress.current[1]) /
                  2) *
                  70,
              );
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }
          videoSource.close();
          await output.finalize();
          finalized = true;
          segmentProgress.current[index] = 1;
          addLog(
            `Thread ${index + 1} done: ${passed} passthrough / ${composited} composited frames`,
          );
          return new Uint8Array(output.target.buffer!);
        } finally {
          if (!finalized) await output.cancel().catch(() => {});
          images.forEach((image) => image.close());
          inputs.forEach((input) => input.dispose());
        }
      };
      const mid = Math.round((totalDuration / 2) * fps) / fps;
      const cancellation = new AbortController();
      const run = async (work: () => Promise<Uint8Array>) => {
        try {
          return await work();
        } catch (error) {
          cancellation.abort(error);
          throw error;
        }
      };
      // A failed branch cancels its siblings; settle their cleanup before a retry.
      const results = await Promise.allSettled([
        run(() => renderSegment(0, mid, 0, cancellation.signal)),
        run(() => renderSegment(mid, totalDuration, 1, cancellation.signal)),
        run(() => mixAudio(cancellation.signal)),
      ]);
      const [chunk1, chunk2, audioData] = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
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
        String(audioBitrate),
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
      addLog(
        `Final payload: ${(b64.length / 1048576).toFixed(1)} MiB (base64)`,
      );
      try {
        const saved = await Flow.save({
          base64: b64,
          mimeType: "video/mp4",
          name: "clipbraid_video.mp4",
        });
        if (saved === false)
          throw new Error("Save adapter rejected the video.");
        addLog("EXPORT COMPLETE: save adapter accepted the video");
        sysLog(
          "save",
          `Video handed to save adapter: clipbraid_video.mp4 (${(b64.length / 1048576).toFixed(1)} MiB base64)`,
        );
      } catch (e) {
        throw new Error(
          `Save rejected (${(masterBytes.byteLength / 1048576).toFixed(1)} MiB video): ${String(e)}`,
        );
      }

      setExportProgress(100);
      sysLog(
        "export",
        `Export complete: ${exportQuality}, ${(b64.length / 1048576).toFixed(1)} MiB`,
      );
      setStatus("READY");
    } catch (err) {
      addLog(`EXPORT FAILED: ${String(err)}`);
      setStatus("EXPORT ERROR");
      sysLog("error", `Export failed: ${String(err).slice(0, 200)}`);
      setExportFailed(true);
      setErrorDetail(String(err));
    } finally {
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
          /* already gone or worker reset */
        }
      }
      jobLeases.forEach((lease) => lease.release());
      setIsExporting(false);
    }
  };
  const videos = mediaAssets.filter((asset) => asset.type === "video");
  const allVideoMuted =
    videos.length > 0 && videos.every((asset) => asset.muted);
  const activeClip = activeIntervals(mediaAssets, currentTime).at(-1);
  const audioOnly =
    !activeClip && activeIntervals(audioTracks, currentTime).length > 0;
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
        sourceUrl={sourceUrl}
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
              {activeClip?.name ||
                (audioOnly ? "Audio only" : "Your video starts here")}
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
              sourceUrl={sourceUrl}
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
                    ~{exportEstimate.estimatedMiB.toFixed(1)} MiB estimated ·
                    actual size varies
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
