import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore,
} from "react";
import { Flow } from "./platform";
import {
  assertProjectSize,
  parseProject,
  serializeProject,
  validateProjectMetadata,
  type ProjectSnapshot,
} from "./services/project";
import { MediaSourceStore, type SourceLease } from "./services/mediaSources";
import { ExportJobs } from "./services/exportJob";
import { runExportPipeline } from "./services/exportPipeline";
import { ProxyQueue } from "./services/proxyQueue";
import { renderProxy } from "./services/proxyRenderer";
import { useProjectRecovery } from "./components/useProjectRecovery";
import type { RecoveryData } from "./services/recovery";
import { mixPolicy, trackGain } from "./services/mixing";
import {
  activeIntervals,
  clampPlayhead,
  estimateExport,
  projectDuration,
  recalculateMediaStartTimes as sequenceMediaStartTimes,
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
import { Input, BlobSource, ALL_FORMATS } from "mediabunny";
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
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [singleEncoder, setSingleEncoder] = useState(false);
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
  const projectInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const clipSettingsCloseRef = useRef<HTMLButtonElement>(null);
  const clipTriggerRef = useRef<HTMLElement | null>(null);
  const addVisualRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selectedAssetId) clipSettingsCloseRef.current?.focus();
  }, [selectedAssetId]);
  const closeClipSettings = () => {
    setSelectedAssetId(null);
    clipTriggerRef.current?.focus();
  };

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
  const exportJobsRef = useRef<ExportJobs | null>(null);
  if (!exportJobsRef.current) exportJobsRef.current = new ExportJobs(storeRef.current, runExportPipeline);
  const exportJobs = exportJobsRef.current;
  const proxyQueueRef = useRef<ProxyQueue | null>(null);
  if (!proxyQueueRef.current) proxyQueueRef.current = new ProxyQueue(storeRef.current, renderProxy);
  const proxyQueue = proxyQueueRef.current;
  const proxyState = useSyncExternalStore(proxyQueue.subscribe, proxyQueue.getSnapshot);
  const exportState = useSyncExternalStore(exportJobs.subscribe, exportJobs.getSnapshot);
  const isExporting = exportState.active;
  const exportFailed = exportState.phase === "failed";
  const exportProgress = exportState.progress;
  const exportLogs = exportState.logs;
  useEffect(() => {
    if (exportState.phase === "complete") setStatus("READY");
    if (exportState.phase === "cancelled") setStatus("EXPORT CANCELLED");
    if (exportState.phase === "failed") {
      setStatus("EXPORT ERROR");
      logEvent("error", `Export failed: ${exportState.error}`);
    }
  }, [exportState.phase]);
  const sourceUrl = useCallback(
    (sourceId: string) => storeRef.current!.urlFor(sourceId),
    [],
  );
  const previewUrl = useCallback(
    (id: string) => proxyQueue.urlFor(id) || storeRef.current!.urlFor(id),
    [proxyQueue, proxyState],
  );
  useEffect(() => { proxyQueue.sync(mediaAssets, isExporting); }, [proxyQueue, mediaAssets, isExporting]);

  useEffect(() => {
    cleanupRef.current = { mediaAssets, audioTracks };
  }, [mediaAssets, audioTracks]);
  const saveInFlightRef = useRef(false);
  const bootAttemptRef = useRef(0);
  // System journal: every user-visible state change lands here as a live
  // event (viewer tab 1). Export-phase chatter stays in exportLogs only —
  // the journal records lifecycle, not per-frame progress.
  const sysLog = useCallback((kind: SystemEventKind, msg: string) => {
    logEvent(kind, msg);
  }, []);
  const loadMediaTools = useCallback(() => {
    const attempt = ++bootAttemptRef.current;
    setStatus("LOADING MEDIA TOOLS...");
    return ffmpegService.load(message => {
      if (attempt === bootAttemptRef.current && !exportJobs.getSnapshot().active)
        setStatus(message.slice(0, 30).toUpperCase());
    }).then(() => {
      if (attempt === bootAttemptRef.current && !exportJobs.getSnapshot().active) setStatus("READY");
    }).catch(error => {
      if (attempt !== bootAttemptRef.current) return;
      setStatus("FATAL ERROR"); setErrorDetail(`FFmpeg failed to load: ${error.message}`);
    });
  }, [exportJobs]);
  useEffect(() => {
    void loadMediaTools();
    return () => { bootAttemptRef.current++; };
  }, [loadMediaTools]);
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
      exportJobs.dispose();
      proxyQueue.dispose();
      storeRef.current!.clear();
    };
  }, []);
  const totalDuration = useMemo(
    () => projectDuration(mediaAssets, audioTracks),
    [mediaAssets, audioTracks],
  );
  const localSnapshot = useMemo(() => ({ mediaAssets, audioTracks, aspectRatio, fitMode,
    transitionDuration, currentTime }), [mediaAssets, audioTracks, aspectRatio, fitMode, transitionDuration, currentTime]);
  const localUI = useMemo(() => ({ exportQuality, zoom, showSafeZones, isTheaterMode }),
    [exportQuality, zoom, showSafeZones, isTheaterMode]);
  const recovery = useProjectRecovery(storeRef.current, localSnapshot, localUI, isPlaying, restoreLocal);
  const recoveryStateRef = useRef(recovery); recoveryStateRef.current = recovery;
  const exportEstimate = useMemo(
    () => estimateExport(exportQuality, totalDuration),
    [exportQuality, totalDuration],
  );
  const soundPolicy = useMemo(() => mixPolicy(mediaAssets, audioTracks), [mediaAssets, audioTracks]);
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
      if (selectedAssetId === id) {
        setSelectedAssetId(null);
        addVisualRef.current?.focus();
      }
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
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isExporting || isRecording || showIntro || showJournal) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest("input, textarea, select, button, summary, a, [role=dialog]") ||
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
      const accepted = await Flow.download({
        base64,
        mimeType: "application/json",
        filename: `clipbraid_project_${stamp}.json`,
      });
      if (!accepted) throw new Error("Project download was not acknowledged.");
      sysLog(
        "save",
        `Project file handed to download adapter: ${snapshot.mediaAssets.length} clips, ${snapshot.audioTracks.length} audio tracks (${(base64.length / 1048576).toFixed(1)} MiB)`,
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
  const loadProjectState = async (data: ProjectSnapshot, sources: { sourceId: string; bytes: Blob; mimeType: string }[]): Promise<boolean> => {
    setStatus("LOADING PROJECT...");
    const tx = storeRef.current!.beginTransaction();
    try {
      data = validateProjectMetadata(data);
      const ids = new Set(sources.map(source => source.sourceId));
      for (const item of [...data.mediaAssets, ...data.audioTracks])
        if (!ids.has(item.sourceId)) throw new Error("Missing referenced source.");
      // Stage and validate every source before touching live state; identical
      // payloads share one immutable original. No URL exists until commit.
      const staged = await tx.stage(
        sources.map((source) => ({
          bytes: source.bytes,
          mimeType: source.mimeType,
        })),
      );
      const stagedIds = [...new Set(staged.map((asset) => asset.sourceId))];
      const idMap = new Map(
        sources.map((source, index) => [
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
  const loadProjectText = async (text: string): Promise<boolean> => {
    try {
      const data = parseProject(text);
      return await loadProjectState(data, data.sources.map(source => ({
        sourceId: source.sourceId, bytes: base64ToBlob(source.base64, source.mimeType), mimeType: source.mimeType,
      })));
    } catch (error) {
      setStatus("LOAD ERROR"); sysLog("error", `Project load failed: ${String(error).slice(0, 120)}`); return false;
    }
  };
  async function restoreLocal(data: RecoveryData) {
    const restored = await loadProjectState(data.record.snapshot, data.sources);
    if (restored) {
      setExportQuality(data.record.ui.exportQuality); setZoom(data.record.ui.zoom);
      setShowSafeZones(data.record.ui.showSafeZones); setIsTheaterMode(data.record.ui.isTheaterMode);
    }
    return restored;
  }
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
  const handleRelinkOriginal = async () => {
    if (!selectedAssetId || isExporting) return;
    const target = cleanupRef.current.mediaAssets.find(asset => asset.id === selectedAssetId);
    if (!target || target.type !== "video") return;
    const tx = storeRef.current!.beginTransaction();
    try {
      const selected = await Flow.media.select({ filter: "video" });
      if (!selected) { tx.rollback(); return; }
      if (!selected.mimeType.startsWith("video/")) throw new Error("Choose an original video file.");
      const [source] = await tx.stage([{ bytes: base64ToBlob(selected.base64, selected.mimeType), mimeType: selected.mimeType }]);
      const lease = tx.acquire(source.sourceId);
      const duration = await probeDuration(lease.url, "video");
      const metadata = await probeVideoSource(source.bytes);
      const current = cleanupRef.current.mediaAssets;
      if (!current.some(asset => asset.sourceId === target.sourceId)) throw new Error("This source is no longer in the project.");
      const updated = current.map(asset => {
        if (asset.sourceId !== target.sourceId) return asset;
        if (asset.trimStart + asset.duration > duration + 0.001) throw new Error("The chosen file is shorter than a selected source interval; choose the full original.");
        return { ...asset, sourceId: source.sourceId, mimeType: selected.mimeType,
          originalDuration: duration, trimEnd: Math.max(0, duration - asset.trimStart - asset.duration),
          hasAudio: metadata.hasAudio, sourceFps: metadata.fps, sourceWidth: metadata.width,
          sourceHeight: metadata.height, normalized: false };
      });
      tx.pin(source.sourceId); setMediaAssets(updated); tx.commit();
      setStatus("READY"); sysLog("import", "Original video relinked; clip selections were preserved.");
    } catch (error) {
      tx.rollback(); setStatus("RELINK ERROR");
      sysLog("error", `Could not relink original: ${String(error)}`);
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
      normalizeAll: async () => {
        proxyQueue.request(cleanupRef.current.mediaAssets);
        await proxyQueue.idle();
        return proxyQueue.getSnapshot().filter(job => job.status === "ready").length;
      },
      proxyState: proxyQueue.getSnapshot,
      mediaInventory: () => storeRef.current!.snapshot(),
      localRecovery: () => ({ status: recoveryStateRef.current.status, revision: recoveryStateRef.current.revision,
        usage: recoveryStateRef.current.usage }),
      exportState: exportJobs.getSnapshot,
      exportDeadlines: exportJobs.setDeadlines,
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
  const handleExport = () => {
    if (!mediaAssets.length || exportJobs.getSnapshot().active || !exportJobs.getSnapshot().cleanupComplete) return;
    setIsPlaying(false);
    setStatus("EXPORTING...");
    void exportJobs.start({ mediaAssets, audioTracks, aspectRatio, fitMode,
      exportQuality, totalDuration, segmentPreference: singleEncoder ? 1 : 2 });
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
            ref={addVisualRef}
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
            disabled={!mediaAssets.length || isExporting || isRecording || !exportState.cleanupComplete}
            aria-busy={isExporting}
          >
            <Icon name="download" />
            {isExporting ? "Exporting…" : "Export video"}
          </button>
        </div>
      </header>
      {(recovery.available || recovery.status === "error" || recovery.status === "unavailable") && (
        <section className="source-notice recovery-notice" aria-label="Local project recovery"
          role={recovery.status === "error" || recovery.status === "unavailable" ? "alert" : "status"}>
          <p>{recovery.message || "A committed local draft is available. Restore it, or keep the current project."}</p>
          {recovery.available ? <>
            <button className="button primary" onClick={() => void recovery.restore()} disabled={recovery.status === "restoring"}>Restore local revision</button>
            <button className="button secondary" onClick={recovery.continueCurrent}>Keep current project</button>
          </> : <button className="button secondary" onClick={() => void recovery.retry()}>Retry local storage</button>}
        </section>
      )}
      {status === "FATAL ERROR" && (
        <div className="source-notice" role="alert">
          <span>{errorDetail}</span>
          <button className="button secondary" onClick={() => void loadMediaTools()}>Retry media tools</button>
        </div>
      )}
      {mediaAssets.some(
        (asset) =>
          (asset.sourceWidth ?? 0) > 1280 || (asset.sourceHeight ?? 0) > 1280,
      ) && (
        <p role="note" className="source-notice">
          <Icon name="info" size={16} />
          Original media retained. Large clips may take more memory and time;
          optimized previews never change project or export sources.
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
              sourceUrl={previewUrl}
              currentTime={currentTime}
              isPlaying={isPlaying}
              aspectRatio={aspectRatio}
              fitMode={fitMode}
              showSafeZones={showSafeZones}
            />
            {(isExporting || exportFailed) && (
              <div
                className="export-overlay"
                data-export-job={exportState.jobId}
                data-export-phase={exportState.phase}
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
                      <button
                        className="button secondary"
                        onClick={exportJobs.cancel}
                        disabled={!exportState.cancellable}
                      >
                        Cancel export
                      </button>
                      <p role="status">
                        {exportState.phase === "cancelling" || exportState.phase === "cleaning"
                          ? "Stopping and releasing media…"
                          : !exportState.cancellable ? "Waiting for the save adapter; delivery may have started." : "You can cancel and keep editing."}
                      </p>
                    </>
                  ) : (
                    <p>{exportState.error || errorDetail}</p>
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
                      onClick={exportJobs.dismissFailure}
                    >
                      Back to editing
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          <label className="playhead-control">
            Playhead
            <input
              type="range"
              aria-label="Playhead time"
              min="0"
              max={totalDuration}
              step="0.01"
              value={currentTime}
              aria-valuetext={`${currentTime.toFixed(2)} seconds`}
              onChange={event => seekTo(Number(event.target.value))}
              disabled={isExporting}
            />
          </label>
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
                disabled={isExporting || (!mediaAssets.length && !audioTracks.length)}
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
                    ref={clipSettingsCloseRef}
                    className="icon-button"
                    onClick={closeClipSettings}
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
                {selectedAsset.type === "video" && (
                  <section className="inspector-section">
                    {selectedAsset.normalized && <p className="helper-text">This legacy draft may use a reduced source. Relink an original when available.</p>}
                    <button className="button secondary" onClick={handleRelinkOriginal} disabled={isExporting}>Relink original video</button>
                  </section>
                )}
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
                      <label htmlFor="clip-volume">Original clip volume<span>{Math.round(trackGain(selectedAsset) * 100)}%</span></label>
                      <input id="clip-volume" type="range" min="0" max="100" step="1"
                        value={trackGain(selectedAsset) * 100}
                        onChange={event => updateSelectedAsset({ gain: Number(event.target.value) / 100 })} />
                    </div>
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
                  {soundPolicy.maxOverlap > 0 && <p className="helper-text">Mix level: {Math.round(soundPolicy.gain * 100)}%. Headroom reserves space for up to {soundPolicy.maxOverlap} enabled sounds at once.</p>}
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
                  {audioTracks.map((track, index) => (
                    <label className="track-volume" key={track.id}>
                      <span>{track.name} · {Math.round(trackGain(track) * 100)}%</span>
                      <input type="range" min="0" max="100" step="1"
                        aria-label={`Volume for audio ${index + 1}: ${track.name}`}
                        value={trackGain(track) * 100}
                        onChange={event => {
                          const gain = Number(event.target.value) / 100;
                          setAudioTracks(previous => previous.map(value => value.id === track.id ? { ...value, gain } : value));
                        }} />
                    </label>
                  ))}
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
                  <label><input type="checkbox" checked={singleEncoder} onChange={event => setSingleEncoder(event.target.checked)} />Compatibility render (one encoder)</label>
                  <p className="helper-text">Draft: 480p. Standard/High: 720p. Export uses up to 30 fps, square pixels and SDR color; framing and frame-rate conversion may change the source appearance.</p>
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
                {videos.length > 0 && (
                  <section className="inspector-section" aria-label="Preview optimization">
                    <h3>Preview performance</h3>
                    <p className="helper-text" role="status">
                      {proxyState.filter(job => job.status === "ready").length} optimized preview(s).
                      {proxyState.some(job => job.status === "queued" || job.status === "running") ? " Optimizing while idle…" : ""}
                      {" "}Project files, original sound and exports use your originals.
                    </p>
                    <button className="button secondary" onClick={() => proxyQueue.request(mediaAssets)} disabled={isExporting}>Optimize previews</button>
                    {proxyState.some(job => job.status === "queued" || job.status === "running") &&
                      <button className="button secondary" onClick={proxyQueue.cancel}>Cancel optimization</button>}
                    {proxyState.filter(job => job.status === "failed").map(job => <p key={job.sourceId} className="helper-text">{job.name}: {job.error}</p>)}
                  </section>
                )}
                <section className="inspector-section" aria-label="Local draft storage">
                  <h3>Local drafts</h3>
                  <p className="helper-text">Local autosave stays in this browser. Save project downloads a separate file. Browser data can be removed externally.</p>
                  <p className="helper-text">{(recovery.usage.bytes / 1048576).toFixed(1)} MiB in {recovery.usage.revisions} local revision(s). Keeps up to two revisions within 128 MiB.</p>
                  {recovery.quota && <p className="helper-text">Browser quota estimate: {(recovery.quota / 1048576).toFixed(0)} MiB.</p>}
                  <button className="button secondary" onClick={() => void recovery.cleanOlder()} disabled={!recovery.revision || recovery.status === "saving"}>Remove older local revisions</button>
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
          onSelectAsset={id => {
            clipTriggerRef.current = document.activeElement as HTMLElement;
            setSelectedAssetId(id);
            if (id === selectedAssetId) clipSettingsCloseRef.current?.focus();
          }}
        />
      </section>
      <footer className="editor-statusbar">
        <span
          role={status.includes("ERROR") ? "alert" : "status"}
          aria-live={status.includes("ERROR") ? "assertive" : "polite"}
          data-editor-status={status}
          className={status.includes("ERROR") ? "status-error" : ""}
        >
          <span className="status-dot" />
          {displayStatus}
        </span>
        <span className="autosave-summary" role="status" data-autosave-status={recovery.status}>
          {recovery.status === "saved" ? `Saved locally · revision ${recovery.revision}` :
            recovery.status === "saving" ? "Saving locally…" : recovery.status === "choice" ? "Local recovery available" :
            recovery.status === "unavailable" ? "Local autosave unavailable" : "Unsaved local changes"}
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
