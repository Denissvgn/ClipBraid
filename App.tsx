import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore,
} from "react";
import { Flow, audioFileType } from "./platform";
import { platformFailure, PlatformError } from "./services/platformError";
import { recordedDuration } from "./services/audioDuration";
import { sourceHasAudio } from "./services/sourceAudio";
import {
  assertProjectSize,
  parseProject,
  serializeProject,
  validateProjectMetadata,
  MAX_TIMELINE_SECONDS,
  type ProjectSnapshot,
} from "./services/project";
import { MediaSourceStore, type SourceLease } from "./services/mediaSources";
import { ProjectWork, type ProjectWorkUnit } from "./services/projectWork";
import { EditHistory, type ProjectContent } from "./services/editHistory";
import { PlaybackClock } from "./services/playbackClock";
import {moveAudio,trimAudio,resizeImage} from "./services/editing";
import { ExportJobs } from "./services/exportJob";
import { runExportPipeline } from "./services/exportPipeline";
import { ProxyQueue } from "./services/proxyQueue";
import { renderProxy } from "./services/proxyRenderer";
import { useProjectRecovery } from "./components/useProjectRecovery";
import { ProjectOpenPrompt } from "./components/ProjectOpenPrompt";
import type { RecoveryData } from "./services/recovery";
import { mixPolicy, trackGain } from "./services/mixing";
import { BUILD_ID } from "./services/buildIdentity";
import { BRAND, defaultProjectFilename } from "./services/brand";
import { normalizeProjectFilename } from "./services/projectNames";
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
import { AudioSettings } from "./components/AudioSettings";
import { TimeInput } from "./components/TimeInput";
import { IntroModal } from "./components/IntroModal";
import { JournalViewer } from "./components/JournalViewer";
import { ExportFeedback } from "./components/ExportFeedback";
import { mediaRecovery, mediaNoticeTitle } from "./services/exportFeedback";
import { createJobReport } from "./services/diagnostics";
import { useJobDiagnostics } from "./components/useJobDiagnostics";
import {
  logEvent,
  type SystemEventKind,
} from "./services/journalService";
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
  signal?: AbortSignal,
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
  const stop = () => input.dispose();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new PlatformError("The selected file has no video track.", "media");
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
    signal?.removeEventListener("abort", stop);
    input.dispose();
  }
};
const probeDuration = (
  blobUrl: string,
  type: "image" | "video" | "audio",
  signal?: AbortSignal,
): Promise<number> => {
  return new Promise((resolve, reject) => {
    const element = document.createElement(type === "image" ? "img" : type);
    const timer = setTimeout(
      () => finish(new PlatformError("Media metadata timed out.", "media")),
      15_000,
    );
    const finish = (error?: Error, duration?: number) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
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
    const abort = () => finish(signal?.reason ?? new DOMException("Action cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    element.onerror = () => finish(new PlatformError("Cannot read this media file.", "media"));
    if (element instanceof HTMLMediaElement) {
      element.preload = "metadata";
      element.onloadedmetadata = () => {
        const duration = element.duration;
        if (!Number.isFinite(duration) || duration <= 0)
          finish(new PlatformError("Invalid media duration.", "media"));
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
const probeAudioDuration = async (blob: Blob, url: string, signal?: AbortSignal): Promise<number> => {
  try { await probeDuration(url, "audio", signal); }
  catch (error) {
    // Streamable WebM recordings can omit duration metadata; inspect packets.
    if (!(error instanceof Error) || error.message !== "Invalid media duration.") throw error;
  }
  return (await recordedDuration(blob, signal)) / 1000;
};
const readProjectText = (file: File, signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  const cleanup = () => { signal.removeEventListener("abort", abort); reader.onload = null; reader.onerror = null; reader.onabort = null; };
  const abort = () => { cleanup(); reader.abort(); reject(signal.reason ?? new DOMException("Project load cancelled", "AbortError")); };
  reader.onload = () => { cleanup(); resolve(String(reader.result)); };
  reader.onerror = () => { const error = reader.error ?? new Error("Could not read project file."); cleanup(); reject(error); };
  reader.onabort = abort;
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  else try { reader.readAsText(file); } catch (error) { cleanup(); reject(error); }
});
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};
export default function App() {
  const storeRef = useRef<MediaSourceStore | null>(null);
  if (!storeRef.current) storeRef.current = new MediaSourceStore();
  const historyRef = useRef<EditHistory | null>(null);
  if (!historyRef.current) historyRef.current = new EditHistory(storeRef.current);
  const editHistory = historyRef.current;
  const historyState = useSyncExternalStore(editHistory.subscribe, editHistory.getSnapshot);
  const { mediaAssets, audioTracks, aspectRatio, fitMode, transitionDuration } = historyState.project;
  const clockRef = useRef<PlaybackClock | null>(null);
  if(!clockRef.current)clockRef.current=new PlaybackClock();
  const playbackClock=clockRef.current;
  const playbackState=useSyncExternalStore(playbackClock.subscribe,playbackClock.getSnapshot);
  const currentTime=playbackState.time,isPlaying=playbackState.playing;
  const setIsPlaying=useCallback((playing:boolean)=>{if(playing)void playbackClock.play();else playbackClock.pause()},[playbackClock]);
  const setCurrentTime=useCallback((value:React.SetStateAction<number>)=>{
    const project=editHistory.getSnapshot().project;playbackClock.setDuration(projectDuration(project.mediaAssets,project.audioTracks));
    playbackClock.seek(typeof value === "function"?value(playbackClock.getTime()):value);
  },[playbackClock,editHistory]);
  const playbackFailure=useCallback((message:string)=>playbackClock.fail(message),[playbackClock]);

  const [showIntro, setShowIntro] = useState(true);
  const [projectFilename, setProjectFilename] = useState<string | null>(null);
  const [seekRevision, setSeekRevision] = useState(0);
  const [zoom, setZoom] = useState(40);
  const [status, setStatus] = useState("BOOTING...");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedAudioId,setSelectedAudioId]=useState<string|null>(null);
  const audioCloseRef=useRef<HTMLButtonElement>(null);
  const audioTriggerRef=useRef<HTMLElement|null>(null);
  const audioReturnRef=useRef<string|null>(null);

  // Export states
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [singleEncoder, setSingleEncoder] = useState(false);
  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");

  const [isRecording, setIsRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(10);
  const recordingRef = useRef<{ cancel: AbortController; stop: AbortController; epoch: number } | null>(null);
  const recordingEpoch = useRef(0);
  const [mediaNotice, setMediaNotice] = useState<{ category: string; message: string; deliveryMayHaveStarted?: boolean } | null>(null);
  const mediaFailure = (error: unknown) => { const value = platformFailure(error); setMediaNotice({ category: value.category, message: value.message, deliveryMayHaveStarted: value.deliveryMayHaveStarted }); return value; };

  const [showSafeZones, setShowSafeZones] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const clipSettingsCloseRef = useRef<HTMLButtonElement>(null);
  const clipTriggerRef = useRef<HTMLElement | null>(null);
  const addVisualRef = useRef<HTMLButtonElement>(null);
  const audioSettingsRef = useRef<HTMLElement>(null);
  const [focusAudioSettings, setFocusAudioSettings] = useState(false);
  useEffect(() => {
    if (!focusAudioSettings || selectedAssetId || selectedAudioId || isTheaterMode || !audioSettingsRef.current) return;
    const control = audioSettingsRef.current.querySelector<HTMLInputElement>('input[type="range"]') ?? audioSettingsRef.current;
    control.focus(); control.scrollIntoView({ block: "center", inline: "nearest" }); setFocusAudioSettings(false);
  }, [focusAudioSettings, selectedAssetId, selectedAudioId, isTheaterMode]);
  useEffect(() => {
    if (selectedAssetId && !isTheaterMode) clipSettingsCloseRef.current?.focus();
  }, [selectedAssetId, isTheaterMode]);
  useEffect(()=>{if(selectedAudioId&&!isTheaterMode)audioCloseRef.current?.focus()},[selectedAudioId,isTheaterMode]);
  useEffect(()=>{
    if(selectedAudioId||isTheaterMode||!audioReturnRef.current)return;
    const id=audioReturnRef.current;audioReturnRef.current=null;
    const opener=[...document.querySelectorAll<HTMLButtonElement>('[data-audio-edit]')].find(button=>button.dataset.audioEdit===id);
    if(opener)opener.focus();else setFocusAudioSettings(true);
  },[selectedAudioId,isTheaterMode]);
  const selectClip = (id: string) => {
    clipTriggerRef.current = document.activeElement as HTMLElement | null;
    setIsTheaterMode(false);
    setSelectedAssetId(id);
    setSelectedAudioId(null);
    if (id === selectedAssetId && !isTheaterMode) clipSettingsCloseRef.current?.focus();
  };
  const selectAudio=(id:string)=>{
    audioTriggerRef.current=document.activeElement as HTMLElement|null;
    setIsTheaterMode(false);setSelectedAssetId(null);setSelectedAudioId(id);
    if(id===selectedAudioId&&!isTheaterMode)audioCloseRef.current?.focus();
  };
  const closeAudioSettings=()=>{
    setSelectedAudioId(null);
    if(audioTriggerRef.current?.isConnected)audioTriggerRef.current.focus();else audioReturnRef.current=selectedAudioId;
  };
  const closeClipSettings = () => {
    setSelectedAssetId(null);
    const opener = clipTriggerRef.current?.isConnected ? clipTriggerRef.current : addVisualRef.current;
    opener?.focus();
  };

  const editProject = useCallback((label: string, change: (project: ProjectContent) => ProjectContent) => {
    const changed = editHistory.update(label, change);
    if (changed) setIsPlaying(false);
    return changed;
  }, [editHistory]);
  const setMediaAssets = useCallback((update: React.SetStateAction<MediaAsset[]>, label = "Edit clips") =>
    editProject(label, project => ({ ...project, mediaAssets: typeof update === "function" ? update(project.mediaAssets) : update })), [editProject]);
  const setAudioTracks = useCallback((update: React.SetStateAction<AudioFragment[]>, label = "Edit audio") =>
    editProject(label, project => ({ ...project, audioTracks: typeof update === "function" ? update(project.audioTracks) : update })), [editProject]);
  const setAspectRatio = useCallback((value: ProjectContent["aspectRatio"]) => editProject("Change aspect ratio", project => ({ ...project, aspectRatio: value })), [editProject]);
  const setFitMode = useCallback((value: ProjectContent["fitMode"]) => editProject("Change framing", project => ({ ...project, fitMode: value })), [editProject]);
  const setTransitionDuration = useCallback((value: number) => editProject("Change crossfades", project => ({ ...project, transitionDuration: value,
    mediaAssets: sequenceMediaStartTimes(project.mediaAssets, value) })), [editProject]);
  const beginEditGesture = (event: React.SyntheticEvent) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") editHistory.beginGroup(event.type === "pointerdown");
  };
  const endEditGesture = (event: React.SyntheticEvent) => {
    if(event.type === "blur" && !(event.target instanceof HTMLInputElement && event.target.type === "range"))return;
    editHistory.endGroup();
  };
  const [pendingProject, setPendingProjectState] = useState<File | null>(null);
  const pendingProjectRef = useRef<File | null>(null);
  const setPendingProject = (file: File | null) => { pendingProjectRef.current=file;setPendingProjectState(file); };

  const cleanupRef = useRef<{
    mediaAssets: MediaAsset[];
    audioTracks: AudioFragment[];
  }>({
    mediaAssets: [],
    audioTracks: [],
  });

  // Media ownership: immutable originals and every object URL live in this
  // store; state holds clip instances that reference sources by ID.
  const projectWorkRef = useRef<ProjectWork | null>(null);
  if (!projectWorkRef.current) projectWorkRef.current = new ProjectWork(storeRef.current);
  const projectWork = projectWorkRef.current;
  const exportJobsRef = useRef<ExportJobs | null>(null);
  if (!exportJobsRef.current) exportJobsRef.current = new ExportJobs(storeRef.current, runExportPipeline, {}, BUILD_ID);
  const exportJobs = exportJobsRef.current;
  const proxyQueueRef = useRef<ProxyQueue | null>(null);
  if (!proxyQueueRef.current) proxyQueueRef.current = new ProxyQueue(storeRef.current, renderProxy);
  const proxyQueue = proxyQueueRef.current;
  const proxyState = useSyncExternalStore(proxyQueue.subscribe, proxyQueue.getSnapshot);
  const exportState = useSyncExternalStore(exportJobs.subscribe, exportJobs.getSnapshot);
  const jobDiagnostics = useJobDiagnostics(exportState);
  const isExporting = exportState.active;
  const exportFailed = exportState.phase === "failed";
  const previewWorkPaused = isPlaying || playbackState.preparing || isExporting || !exportState.cleanupComplete;
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
  useEffect(() => { proxyQueue.sync(mediaAssets, previewWorkPaused); }, [proxyQueue, mediaAssets, previewWorkPaused]);

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
      if (attempt === bootAttemptRef.current) logEvent("info", message);
    }).then(() => {
      if (attempt === bootAttemptRef.current && !exportJobs.getSnapshot().active && !projectWork.busy) setStatus("READY");
    }).catch(error => {
      if (attempt !== bootAttemptRef.current) return;
      setStatus("FATAL ERROR"); setErrorDetail(`FFmpeg failed to load: ${error.message}`);
    });
  }, [exportJobs, projectWork]);
  useEffect(() => {
    const release = ffmpegService.retain();
    void loadMediaTools();
    return () => {
      bootAttemptRef.current++;
      void release().catch(error => logEvent("error", `Media tools cleanup failed: ${String(error)}`));
    };
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
      projectWork.invalidate();
      exportJobs.dispose();
      recordingEpoch.current++; recordingRef.current?.cancel.abort();
      proxyQueue.dispose();
      playbackClock.dispose();
      editHistory.dispose();
      storeRef.current!.clear();
    };
  }, []);
  const totalDuration = useMemo(
    () => projectDuration(mediaAssets, audioTracks),
    [mediaAssets, audioTracks],
  );
  useEffect(()=>{playbackClock.setDuration(totalDuration)},[playbackClock,totalDuration]);
  useEffect(()=>{
    const hidden=()=>{const state=playbackClock.getSnapshot();if(document.hidden&&(state.playing||state.preparing))playbackClock.pause("Preview paused while the page was hidden. Press Play when you return.")};
    document.addEventListener("visibilitychange",hidden);return()=>document.removeEventListener("visibilitychange",hidden);
  },[playbackClock]);
  const localSnapshot = useMemo(() => ({ mediaAssets, audioTracks, aspectRatio, fitMode,
    transitionDuration, currentTime }), [mediaAssets, audioTracks, aspectRatio, fitMode, transitionDuration, currentTime]);
  const localUI = useMemo(() => ({ exportQuality, zoom, showSafeZones, isTheaterMode,
    ...(projectFilename ? { projectFilename } : {}) }),
    [exportQuality, zoom, showSafeZones, isTheaterMode, projectFilename]);
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
      setSeekRevision(value => value + 1);
      setCurrentTime(clamped);
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
  }, [currentTime, totalDuration]);
  const handleImportMedia = async () => {
    setMediaNotice(null);
    const work = projectWork.beginEdit(), tx = work.tx;
    try {
      const selected = await Flow.media.select({ filter: "all", signal: work.signal });
      work.check();
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
        const dur = await probeDuration(probeLease.url, selected.type, work.signal);
        const {
          hasAudio,
          fps: sourceFps,
          width: sourceWidth,
          height: sourceHeight,
        } = selected.type === "video"
          ? await probeVideoSource(asset.bytes, work.signal)
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
        work.check(); tx.pin(asset.sourceId);
        setMediaAssets((prev) =>
          recalculateMediaStartTimes([...prev, newAssetBase]),
        );
        work.commit();
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
      if (!work.isCurrent()) return;
      const error = mediaFailure(work.signal.aborted ? work.signal.reason : err);
      setStatus(error.category === "cancelled" ? "IMPORT CANCELLED" : "IMPORT ERROR");
      sysLog("error", `Clip import failed: ${String(err).slice(0, 120)}`);
    } finally { work.finish(); }
  };
  const handleImportGalleryAudio = async () => {
    setMediaNotice(null);
    const work = projectWork.beginEdit(), tx = work.tx;
    try {
      const selected = await Flow.media.select({ filter: "audio", signal: work.signal });
      work.check();
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
        duration = await probeAudioDuration(asset.bytes, probeLease.url, work.signal);
      } finally {
        probeLease.release();
      }
      work.check(); tx.pin(asset.sourceId);
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
          originalDuration:duration,trimStart:0,trimEnd:0,
        },
      ]);
      work.commit();
      sysLog(
        "import",
        `Audio track: ${selected.name} (${duration.toFixed(1)}s @ ${currentTime.toFixed(1)}s)`,
      );
      setStatus("READY");
    } catch (err) {
      tx.rollback();
      if (!work.isCurrent()) return;
      const error = mediaFailure(work.signal.aborted ? work.signal.reason : err);
      setStatus(error.category === "cancelled" ? "AUDIO CANCELLED" : "AUDIO ERROR");
      sysLog("error", `Audio import failed: ${String(err).slice(0, 120)}`);
    } finally { work.finish(); }
  };
  const handleImportLocalAudio = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const startTime = currentTime;
    const staged: AudioFragment[] = [];
    setMediaNotice(null);
    const work = projectWork.beginEdit(), tx = work.tx;
    setStatus("IMPORTING AUDIO...");
    try {
      const mimeTypes = files.map(audioFileType);
      // One batch: identical files share a single immutable source.
      const assets = await tx.stage(
        files.map((file, index) => ({ bytes: file, mimeType: mimeTypes[index] })),
      );
      for (const [index, file] of files.entries()) {
        const asset = assets[index];
        const probeLease = tx.acquire(asset.sourceId, "import-probe");
        let duration: number;
        try {
          duration = await probeAudioDuration(asset.bytes, probeLease.url, work.signal);
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
          mimeType: mimeTypes[index],
          name: file.name,
          startTime,
          duration,
          originalDuration:duration,trimStart:0,trimEnd:0,
        });
      }
      work.check(); staged.forEach((track) => tx.pin(track.sourceId));
      setAudioTracks((previous) => [...previous, ...staged]);
      work.commit();
      sysLog(
        "import",
        `Added ${staged.length} audio file(s) in parallel at ${startTime.toFixed(2)}s`,
      );
      setStatus("READY");
    } catch (error) {
      tx.rollback();
      if (!work.isCurrent()) return;
      const failure = mediaFailure(work.signal.aborted ? work.signal.reason : error);
      setStatus(failure.category === "cancelled" ? "AUDIO CANCELLED" : "AUDIO ERROR");
      sysLog("error", `Audio import failed: ${String(error).slice(0, 120)}`);
    } finally {
      if (work.isCurrent()) event.target.value = "";
      work.finish();
    }
  };
  const handleRecord = async () => {
    if (isRecording) return;
    setIsRecording(true);
    setIsPlaying(false);
    setStatus(`RECORDING...`);
    setMediaNotice(null);
    const capture = { cancel: new AbortController(), stop: new AbortController(), epoch: ++recordingEpoch.current };
    recordingRef.current = capture;
    const work = projectWork.beginEdit(), tx = work.tx;
    const cancelCapture = () => capture.cancel.abort(work.signal.reason);
    const cancelStaging = () => work.cancel(capture.cancel.signal.reason);
    work.signal.addEventListener("abort", cancelCapture, { once: true });
    capture.cancel.signal.addEventListener("abort", cancelStaging, { once: true });
    try {
      const audio = await Flow.microphone.record({
        durationMs: recDuration * 1000, signal: capture.cancel.signal, stopSignal: capture.stop.signal,
      });
      capture.cancel.signal.throwIfAborted();
      if (capture.epoch !== recordingEpoch.current) throw new DOMException("Project changed", "AbortError");
      const [asset] = await tx.stage([
        {
          bytes: base64ToBlob(audio.base64, audio.mimeType),
          mimeType: audio.mimeType,
        },
      ]);
      work.check(); capture.cancel.signal.throwIfAborted(); tx.pin(asset.sourceId);
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
          originalDuration:audio.durationMs/1000,trimStart:0,trimEnd:0,
        },
      ]);
      work.commit();
      setStatus("READY");
      sysLog(
        "import",
        `Voice-over (${(audio.durationMs / 1000).toFixed(1)}s @ ${currentTime.toFixed(1)}s)`,
      );
    } catch (err) {
      tx.rollback();
      if (!work.isCurrent() || capture.epoch !== recordingEpoch.current) return;
      const error = mediaFailure(work.signal.aborted ? work.signal.reason : err);
      setStatus(error.category === "cancelled" ? "RECORD CANCELLED" : "RECORD ERROR");
      sysLog("error", `Voice recording failed: ${String(err).slice(0, 120)}`);
    } finally {
      work.signal.removeEventListener("abort", cancelCapture);
      capture.cancel.signal.removeEventListener("abort", cancelStaging);
      work.finish();
      if (recordingRef.current === capture) { recordingRef.current = null; setIsRecording(false); }
    }
  };
  const togglePlayback = () => {
    const state=playbackClock.getSnapshot();
    if(state.playing||state.preparing)playbackClock.pause();else void playbackClock.play();
  };
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
    if(selectedAudioId===id){setSelectedAudioId(null);setFocusAudioSettings(true)}
  }, [selectedAudioId]);
  const travelHistory = useCallback((direction: "undo" | "redo") => {
    if (exportJobs.getSnapshot().active || isRecording || !editHistory.getSnapshot()[direction === "undo" ? "canUndo" : "canRedo"]) return;
    projectWork.invalidate();setIsPlaying(false);editHistory[direction]();setSeekRevision(value=>value+1);
    const next=editHistory.getSnapshot().project;
    setCurrentTime(time=>clampPlayhead(time,projectDuration(next.mediaAssets,next.audioTracks)));
    setSelectedAssetId(id=>next.mediaAssets.some(asset=>asset.id===id)?id:null);
    setSelectedAudioId(id=>next.audioTracks.some(track=>track.id===id)?id:null);
  }, [editHistory,exportJobs,isRecording,projectWork]);
  useEffect(() => {
    const warn=(event:BeforeUnloadEvent)=>{if(editHistory.getSnapshot().dirty && recoveryStateRef.current.status!=="saved"){event.preventDefault();event.returnValue=""}};
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  }, [editHistory]);
  useEffect(() => {
    const key=(event:KeyboardEvent)=>{
      if(!(event.ctrlKey||event.metaKey)||event.altKey||showIntro||showJournal||pendingProject)return;
      const target=event.target as HTMLElement|null;
      if(target?.isContentEditable||target?.closest('textarea, input:not([type="range"])'))return;
      const undo=event.key.toLowerCase()==="z"&&!event.shiftKey,redo=(event.key.toLowerCase()==="z"&&event.shiftKey)||event.key.toLowerCase()==="y";
      if(undo||redo){event.preventDefault();travelHistory(undo?"undo":"redo")}
    };
    window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);
  },[travelHistory,showIntro,showJournal,pendingProject]);
  // Keyboard shortcuts: Space = play/pause, arrows = seek (Shift = 5s),
  // Delete/Backspace = remove selected clip. Ignored while typing or exporting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isExporting || isRecording || showIntro || showJournal || pendingProject) return;
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
    pendingProject,
    currentTime,
    selectedAssetId,
    togglePlayback,
    seekTo,
    handleDeleteMedia,
  ]);
  const handleSaveProject = async () => {
    if (saveInFlightRef.current) return;
    setMediaNotice(null);
    saveInFlightRef.current = true;
    setStatus("SAVING PROJECT...");
    // One consistent snapshot of a single render's state. Every source is
    // leased before the first await, so replacing or deleting the project
    // mid-save retires pins but cannot purge the bytes this save is reading.
    const savedGeneration = editHistory.generation;
    const snapshot = {
      projectFilename,
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
      const accepted = await Flow.download({
        base64,
        mimeType: "application/json",
        filename: snapshot.projectFilename || defaultProjectFilename(),
      });
      if (!accepted) throw new Error("Project download was not acknowledged.");
      editHistory.markSaved({ mediaAssets: snapshot.mediaAssets, audioTracks: snapshot.audioTracks, aspectRatio: snapshot.aspectRatio, fitMode: snapshot.fitMode, transitionDuration: snapshot.transitionDuration }, savedGeneration);
      sysLog(
        "save",
        `Project file handed to download adapter: ${snapshot.mediaAssets.length} clips, ${snapshot.audioTracks.length} audio tracks (${(base64.length / 1048576).toFixed(1)} MiB)`,
      );
      setStatus("READY");
      return true;
    } catch (err) {
      const error = mediaFailure(err);
      setStatus(error.category === "cancelled" ? "SAVE CANCELLED" : "SAVE ERROR");
      sysLog("error", `Project save failed: ${String(err).slice(0, 120)}`);
      return false;
    } finally {
      for (const lease of leases) lease.release();
      saveInFlightRef.current = false;
    }
  };
  const loadProjectState = async (data: ProjectSnapshot, sources: { sourceId: string; bytes: Blob; mimeType: string }[],
    work: ProjectWorkUnit, options: { filename?: string | null; ui?: RecoveryData["record"]["ui"] } = {}): Promise<boolean> => {
    work.check();
    setMediaNotice(null);
    setStatus("LOADING PROJECT...");
    const tx = work.tx;
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
      work.check();
      const stagedIds = [...new Set(staged.map((asset) => asset.sourceId))];
      const idMap = new Map(
        sources.map((source, index) => [
          source.sourceId,
          staged[index].sourceId,
        ]),
      );
      const videoSources = new Set(data.mediaAssets.filter(clip => clip.type === "video").map(clip => idMap.get(clip.sourceId)!));
      const audioPresence = new Map<string, boolean>();
      for (const sourceId of videoSources) {
        try { audioPresence.set(sourceId, await sourceHasAudio(storeRef.current!.bytesFor(sourceId)!, work.signal)); }
        catch { work.check(); /* Keep damaged sources available for inspection/relink; export preflight will reject them. */ }
      }
      work.check();
      const restoredMedia = data.mediaAssets.map((clip) => ({
        ...clip,
        sourceId: idMap.get(clip.sourceId)!,
        hasAudio: clip.type === "video" ? audioPresence.get(idMap.get(clip.sourceId)!) ?? clip.hasAudio : clip.hasAudio,
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
      recordingEpoch.current++; recordingRef.current?.cancel.abort();
      setIsPlaying(false);
      setSelectedAssetId(null);
      setSelectedAudioId(null);
      setPendingProject(null);
      editHistory.reset({ mediaAssets: restoredMedia, audioTracks: restoredAudio,
        aspectRatio: data.aspectRatio, fitMode: data.fitMode, transitionDuration: data.transitionDuration }, !options.ui);
      setCurrentTime(restoredTime);
      setProjectFilename(options.filename ?? null);
      if (options.ui) {
        setExportQuality(options.ui.exportQuality); setZoom(options.ui.zoom);
        setShowSafeZones(options.ui.showSafeZones); setIsTheaterMode(options.ui.isTheaterMode);
      }
      cleanupRef.current = {
        mediaAssets: restoredMedia,
        audioTracks: restoredAudio,
      };
      work.commit();
      sysLog(
        "import",
        `Project loaded: ${restoredMedia.length} clips, ${restoredAudio.length} audio tracks`,
      );
      setStatus("READY");
      return true;
    } catch (err) {
      tx.rollback();
      if (!work.isCurrent() || work.signal.aborted) return false;
      setStatus("LOAD ERROR");
      setMediaNotice({ category: "project", message: "Could not open this project. Your current project is still available." });
      sysLog("error", `Project load failed: ${String(err).slice(0, 120)}`);
      return false;
    }
  };
  const loadProjectText = async (text: string, filename?: string, request?: ProjectWorkUnit): Promise<boolean> => {
    const work = request ?? projectWork.beginLoad();
    try {
      work.check();
      const data = parseProject(text);
      return await loadProjectState(data, data.sources.map(source => ({
        sourceId: source.sourceId, bytes: base64ToBlob(source.base64, source.mimeType), mimeType: source.mimeType,
      })), work, { filename: normalizeProjectFilename(filename) });
    } catch (error) {
      if (!work.isCurrent()) return false;
      setMediaNotice({ category: "project", message: "Could not open this project. Your current project is still available." });
      setStatus("LOAD ERROR"); sysLog("error", `Project load failed: ${String(error).slice(0, 120)}`); return false;
    } finally { if (!request) work.finish(); }
  };
  async function restoreLocal(data: RecoveryData, signal: AbortSignal) {
    const work = projectWork.beginLoad();
    const cancel = () => {
      work.cancel(signal.reason);
      if (work.isCurrent() && !projectWork.busy) setStatus("READY");
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      return await loadProjectState(data.record.snapshot, data.sources, work,
        { filename: data.record.ui.projectFilename, ui: data.record.ui });
    }
    finally { signal.removeEventListener("abort", cancel); work.finish(); }
  }
  const handleLoadProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (editHistory.getSnapshot().dirty) { setPendingProject(file); return; }
    await openProjectFile(file);
  };
  const openProjectFile = async (file: File) => {
    const work = projectWork.beginLoad();
    setMediaNotice(null); setStatus("LOADING PROJECT...");
    // Gate on the real byte size before reading, parsing or allocating anything.
    // File reads are inside the same error boundary as staged load failures,
    // and the input is reset even when the host filesystem read rejects.
    try {
      assertProjectSize(file.size);
      const text = await readProjectText(file, work.signal);
      work.check();
      await loadProjectText(text, file.name, work);
    } catch (err) {
      if (!work.isCurrent()) return;
      setStatus("LOAD ERROR");
      setMediaNotice({ category: "project", message: "Could not read this project file. Your current project is still available." });
      sysLog("error", `Project load failed: ${String(err).slice(0, 120)}`);
    } finally {
      work.finish();
    }
  };
  const handleRelinkOriginal = async () => {
    if (!selectedAssetId || isExporting) return;
    const target = cleanupRef.current.mediaAssets.find(asset => asset.id === selectedAssetId);
    if (!target || target.type !== "video") return;
    setMediaNotice(null);
    const work = projectWork.beginEdit(), tx = work.tx;
    try {
      const selected = await Flow.media.select({ filter: "video", signal: work.signal });
      work.check();
      if (!selected) { tx.rollback(); return; }
      if (!selected.mimeType.startsWith("video/")) throw new Error("Choose an original video file.");
      const [source] = await tx.stage([{ bytes: base64ToBlob(selected.base64, selected.mimeType), mimeType: selected.mimeType }]);
      const lease = tx.acquire(source.sourceId);
      const duration = await probeDuration(lease.url, "video", work.signal);
      const metadata = await probeVideoSource(source.bytes, work.signal);
      work.check();
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
      tx.pin(source.sourceId); setMediaAssets(updated); work.commit();
      setStatus("READY"); sysLog("import", "Original video relinked; clip selections were preserved.");
    } catch (error) {
      tx.rollback(); if (!work.isCurrent()) return;
      setStatus("RELINK ERROR");
      setMediaNotice({ category: "relink", message: "Could not relink the original file." });
      sysLog("error", `Could not relink original: ${String(error)}`);
    } finally { work.finish(); }
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
        const work = projectWork.beginLoad();
        try {
          const text = await (await fetch(url, { signal: work.signal })).text();
          work.check(); return await loadProjectTextRef.current(text, undefined, work);
        } finally { work.finish(); }
      },
      loadText: (text: string, filename?: string) => loadProjectTextRef.current(text, filename),
      projectWorkIdle: projectWork.idle,
      normalizeAll: async () => {
        proxyQueue.request(cleanupRef.current.mediaAssets);
        await proxyQueue.idle();
        return proxyQueue.getSnapshot().filter(job => job.status === "ready").length;
      },
      proxyState: proxyQueue.getSnapshot,
      mediaInventory: () => storeRef.current!.snapshot(),
      playbackClock: playbackClock.observe,
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
    const label = updates.trimStart !== undefined || updates.trimEnd !== undefined ? "Trim clip"
      : updates.filter !== undefined ? "Change look" : updates.gain !== undefined ? "Change clip volume"
      : updates.transitionDuration !== undefined ? "Change crossfade" : "Edit clip";
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
    }, label);
  };
  const selectedAsset = useMemo(
    () => mediaAssets.find((m) => m.id === selectedAssetId),
    [mediaAssets, selectedAssetId],
  );
  const selectedAudio=audioTracks.find(track=>track.id===selectedAudioId);
  const changeAudio=(id:string,label:string,change:(track:AudioFragment)=>AudioFragment)=>
    setAudioTracks(tracks=>tracks.map(track=>track.id===id?change(track):track),label);
  const moveAudioTrack=(id:string,time:number)=>changeAudio(id,"Move audio",track=>moveAudio(track,time));
  // Originals stay authoritative. Proxy generation returns only with
  // provide separate, cancellable storage; never rewrite imported bytes in idle time.
  const handleExport = () => {
    if (!mediaAssets.length || exportJobs.getSnapshot().active || !exportJobs.getSnapshot().cleanupComplete) return;
    setIsPlaying(false);
    setStatus("EXPORTING...");
    const exportedProject = editHistory.getSnapshot().project, exportedGeneration = editHistory.generation;
    const completion = exportJobs.start({ mediaAssets, audioTracks, aspectRatio, fitMode,
      exportQuality, totalDuration, segmentPreference: singleEncoder ? 1 : 2 });
    const jobId = exportJobs.getSnapshot().jobId;
    void completion.then(() => { const state = exportJobs.getSnapshot();
      if (state.jobId === jobId && state.phase === "complete" && state.result) editHistory.markExported(exportedProject, exportedGeneration);
    });
  };
  const videos = mediaAssets.filter((asset) => asset.type === "video");
  const allVideoMuted =
    videos.length > 0 && videos.every((asset) => asset.muted);
  const failedSource = exportState.failure?.asset;
  const failedSourcePresent = !!failedSource && [...mediaAssets, ...audioTracks].some(asset => asset.id === failedSource.id && asset.sourceId === failedSource.sourceId);
  const inspectFailedSource = () => {
    if (!failedSource || !failedSourcePresent) return;
    exportJobs.dismissFailure();
    if (failedSource.kind === "audio") {
      setIsTheaterMode(false); setSelectedAssetId(null);setSelectedAudioId(null);
      const row = [...(timelineContainerRef.current?.querySelectorAll<HTMLElement>("[data-audio-track]") ?? [])].find(element => element.dataset.audioTrack === failedSource.id);
      const control = row?.querySelector<HTMLButtonElement>("button");
      control?.focus(); control?.scrollIntoView({ block: "center", inline: "nearest" });
    } else selectClip(failedSource.id);
  };
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
      : status === "FATAL ERROR" ? "Media tools unavailable"
      : status === "BOOTING..." ? "Starting editor…"
      : status.charAt(0) + status.slice(1).toLowerCase();
  return (
    <div className={`editor-app ${isTheaterMode ? "theater-mode" : ""}`} data-build-id={BUILD_ID}
      onPointerDownCapture={beginEditGesture} onPointerUpCapture={endEditGesture} onPointerCancelCapture={endEditGesture}
      onFocusCapture={beginEditGesture} onBlurCapture={endEditGesture}
      onKeyDownCapture={event => { if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key)) beginEditGesture(event); }} onKeyUpCapture={endEditGesture}>
      <output hidden id="export-evidence" aria-hidden="true">{JSON.stringify(exportState)}</output>
      <output hidden id="export-diagnostic-report" aria-hidden="true">{JSON.stringify(createJobReport(exportState))}</output>
      {showIntro && <IntroModal onDismiss={() => setShowIntro(false)} />}
      {showJournal && (
        <JournalViewer
          reports={jobDiagnostics.reports} warning={jobDiagnostics.warning} onClear={jobDiagnostics.clear}
          currentJobId={exportState.active ? exportState.jobId : null}
          currentReport={jobDiagnostics.currentReport}
          onClose={() => setShowJournal(false)}
        />
      )}
      {pendingProject && <ProjectOpenPrompt filename={pendingProject.name}
        onCancel={() => setPendingProject(null)}
        onOpen={() => { const file=pendingProject; setPendingProject(null); void openProjectFile(file); }}
        onSave={async () => { const file=pendingProject; if(await handleSaveProject() && pendingProjectRef.current===file){setPendingProject(null);await openProjectFile(file);return true}return false }} />}
      <AudioEngine
        audioTracks={audioTracks}
        mediaAssets={mediaAssets}
        sourceUrl={sourceUrl}
        currentTime={currentTime}
        isPlaying={isPlaying}
        seekRevision={seekRevision}
        timeAt={playbackClock.getTime} onPlaybackError={playbackFailure}
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
          aria-label={`About ${BRAND.name}`}
        >
          <BrandMark />
          <span>
            <span className="wordmark">{BRAND.name}</span>
            <span className="brand-descriptor">{BRAND.descriptor}</span>
          </span>
        </button>
        <div className="project-actions" aria-label="Edit history" title="Undo history is session-local: up to 50 edits and 256 MiB of retained originals. Save a project backup before large changes.">
          <button className="button secondary" onClick={() => travelHistory("undo")} disabled={!historyState.canUndo || isExporting || isRecording}
            title={historyState.undoLabel ? `Undo ${historyState.undoLabel}` : "Nothing to undo"}><Icon name="undo" />Undo</button>
          <button className="button secondary" onClick={() => travelHistory("redo")} disabled={!historyState.canRedo || isExporting || isRecording}
            title={historyState.redoLabel ? `Redo ${historyState.redoLabel}` : "Nothing to redo"}><Icon name="redo" />Redo</button>
        </div>
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
      {mediaNotice && <div className="source-notice recovery-notice" data-media-category={mediaNotice.category} role={mediaNotice.category === "cancelled" ? "status" : "alert"}>
        <span><strong>{mediaNoticeTitle(mediaNotice.category)}</strong> {["project", "relink"].includes(mediaNotice.category) ? mediaNotice.message : ""} {mediaRecovery(mediaNotice.category)}</span>
        {mediaNotice.deliveryMayHaveStarted && <p>Check your downloads or host files before retrying; a file may already exist.</p>}
        <details><summary>Technical details</summary><p>{mediaNotice.message}</p></details>
        <button className="button secondary" onClick={() => setMediaNotice(null)}>Dismiss media message</button>
      </div>}
      {jobDiagnostics.warning && <p className="source-notice" role="alert">{jobDiagnostics.warning}</p>}
      {!exportState.active && !exportState.cleanupComplete && exportState.phase === "idle" && <div className="source-notice recovery-notice" role="alert">
        <span>Export is blocked because media cleanup failed. Save your project, then reload this page before another export.</span>
        <button className="button secondary" onClick={() => void handleSaveProject()}>Save project backup</button>
      </div>}
      {exportState.result && <p className="source-notice" role="status" data-delivery-outcome={exportState.result.delivery}>
        {exportState.result.delivery === "download-started" ? "Last export: Download started. Video/audio structure was checked; final disk storage is controlled by your browser." : "Last export: Host accepted the checked video. Host acceptance does not confirm final device storage."}
      </p>}
      {exportState.phase === "cancelled" && <div className="source-notice recovery-notice" role="status">
        <span>Export cancelled. You can keep editing or retry.</span>
        {mediaAssets.length > 0 ? <button className="button secondary" onClick={handleExport}>Retry export</button> : <span>Add visuals or open a project before exporting again.</span>}
      </div>}
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
          <span>Media tools could not start. Check your connection and retry; save your project before reloading this page.</span>
          <button className="button secondary" onClick={() => void loadMediaTools()}>Retry media tools</button>
          <details><summary>Technical details</summary><p>{errorDetail}</p></details>
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
      {(playbackState.error||playbackState.notice||playbackState.preparing)&&<section className="source-notice" role={playbackState.error?"alert":"status"}>
        <p>{playbackState.error||playbackState.notice||"Preparing preview playback…"}</p>
        {!playbackState.preparing&&<button className="button secondary" onClick={playbackClock.clearError}>Dismiss playback message</button>}
      </section>}
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
              seekRevision={seekRevision}
              timeAt={playbackClock.getTime} onPlaybackError={playbackFailure} registerVideo={playbackClock.registerVideo}
            />
            {(isExporting || exportFailed) && <ExportFeedback
              key={exportState.jobId} state={exportState}
              assetName={failedSource?.name} sourcePresent={failedSource ? failedSourcePresent : undefined} canRetry={mediaAssets.length > 0}
              onCancel={exportJobs.cancel} onRetry={handleExport} onClose={exportJobs.dismissFailure}
              onSaveProject={() => void handleSaveProject()}
              onInspect={failedSourcePresent ? inspectFailedSource : undefined}
              onReviewAudio={() => { exportJobs.dismissFailure(); setIsTheaterMode(false); setSelectedAssetId(null);setSelectedAudioId(null); setFocusAudioSettings(true); }}
            />}
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
                aria-label={playbackState.preparing ? "Cancel playback start" : isPlaying ? "Pause preview" : "Play preview"}
                title="Play/Pause (Space)"
                disabled={isExporting || (!mediaAssets.length && !audioTracks.length)}
              >
                <Icon name={isPlaying || playbackState.preparing ? "pause" : "play"} size={21} />
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
            aria-label={selectedAsset ? "Clip settings" : selectedAudio ? "Audio settings" : "Project settings"}
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
                {selectedAsset.type === "image"&&<TimeInput label="Photo duration (seconds)" value={selectedAsset.duration} min={.1} max={MAX_TIMELINE_SECONDS}
                  onCommit={duration=>setMediaAssets(assets=>sequenceMediaStartTimes(assets.map(asset=>asset.id===selectedAsset.id?resizeImage(asset,duration):asset),transitionDuration),"Change photo duration")} />}
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
            ) : selectedAudio ? (
              <AudioSettings track={selectedAudio} currentTime={currentTime} closeRef={audioCloseRef}
                onClose={closeAudioSettings} onRemove={()=>handleDeleteAudio(selectedAudio.id)}
                onMove={time=>moveAudioTrack(selectedAudio.id,time)}
                onTrim={change=>changeAudio(selectedAudio.id,"Trim audio",track=>trimAudio(track,change))}
                onGain={gain=>changeAudio(selectedAudio.id,"Change audio volume",track=>({...track,gain}))} />
            ) : (
              <>
                <div className="inspector-heading">
                  <h2>Make it yours</h2>
                  <Icon name="settings" />
                </div>
                <section className="inspector-section audio-settings" ref={audioSettingsRef} tabIndex={-1} aria-label="Audio levels">
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
                    <div className="track-level" key={track.id}><label className="track-volume">
                      <span>{track.name} · {Math.round(trackGain(track) * 100)}%</span>
                      <input type="range" min="0" max="100" step="1"
                        aria-label={`Volume for audio ${index + 1}: ${track.name}`}
                        value={trackGain(track) * 100}
                        onChange={event => {
                          const gain = Number(event.target.value) / 100;
                          setAudioTracks(previous => previous.map(value => value.id === track.id ? { ...value, gain } : value));
                        }} />
                    </label><button className="text-button" data-audio-edit={track.id} onClick={()=>selectAudio(track.id)}>Edit audio {index+1}</button></div>
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
                  <p className="helper-text">Draft: smaller 480p video. Standard: 720p. High: 720p with a higher bitrate and larger estimated file.</p>
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
                  <p className="helper-text">Video handoff is capped at 96 MiB; host limits may be lower.</p>
                  <details className="profile-details"><summary>Export profile details</summary>
                    <p className="helper-text">Export uses up to 30 fps, square pixels and SDR color. Framing, resizing and frame-rate conversion may change the source appearance.</p>
                    <p className="helper-text">{Math.round(exportEstimate.videoBitrate / 1000)} kb/s video + {Math.round(exportEstimate.audioBitrate / 1000)} kb/s audio. Estimated base64 handoff: ~{exportEstimate.base64MiB.toFixed(1)} MiB.</p>
                  </details>
                  {exportEstimate.estimatedBytes > 96 * 1048576 && <p className="helper-text">This estimate exceeds the delivery cap. Consider a lower profile or shorter timeline; actual bytes are checked before delivery.</p>}
                </section>
                {videos.length > 0 && (
                  <section className="inspector-section" aria-label="Preview optimization">
                    <h3>Preview performance</h3>
                    <p className="helper-text" role="status">
                      {proxyState.filter(job => job.status === "ready").length} optimized previews.
                      {proxyState.some(job => job.status === "running") ? " Optimizing preview…" :
                        proxyState.some(job => job.status === "queued") ? (previewWorkPaused ? " Preview optimization is paused." : " Optimization queued.") : ""}
                      {" "}Project files, original sound and exports use your originals.
                    </p>
                    <button className="button secondary" onClick={() => proxyQueue.request(mediaAssets)} disabled={isExporting || !exportState.cleanupComplete}>Optimize previews</button>
                    {proxyState.some(job => job.status === "queued" || job.status === "running") &&
                      <button className="button secondary" onClick={proxyQueue.cancel}>Cancel optimization</button>}
                    {proxyState.filter(job => job.status === "failed").map(job => <div key={job.sourceId}>
                      <p className="helper-text">Could not optimize “{job.name}”. Original media is retained. Continue editing or try optimization again.</p>
                      <details><summary>Optimization details</summary><p className="helper-text">{job.error}</p></details>
                    </div>)}
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
                  {isRecording && <>
                    <button className="button secondary" onClick={() => recordingRef.current?.stop.abort()}>Stop recording and keep audio</button>
                    <button className="button secondary" onClick={() => recordingRef.current?.cancel.abort()}>Cancel recording</button>
                  </>}
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
          key={editHistory.generation}
          mediaAssets={mediaAssets}
          audioTracks={audioTracks}
          currentTime={currentTime}
          zoom={zoom}
          selectedAssetId={selectedAssetId}
          selectedAudioId={selectedAudioId}
          onSeek={seekTo}
          onDeleteMedia={handleDeleteMedia}
          onDeleteAudio={handleDeleteAudio}
          onMoveMedia={handleMoveMedia}
          onToggleMute={handleToggleMute}
          onSelectAsset={selectClip}
          onSelectAudio={selectAudio}
          onMoveAudio={moveAudioTrack}
          onBeginAudioMove={()=>{editHistory.beginGroup(true);setIsPlaying(false)}}
          onEndAudioMove={()=>editHistory.endGroup()}
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
        <span className="project-backup-status" role="status" data-project-dirty={historyState.dirty}>
          {historyState.dirty ? "Project file: unsaved edits" : "Project file: no unsaved edits"}
          {historyState.limited && " · Older undo history removed at its limit"}
          {historyState.exported ? " · Current edits exported" : " · Export not current"}
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
