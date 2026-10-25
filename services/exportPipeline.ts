import { renderInWorker } from "./renderWorker";
import { decodeAudioInWorker } from "./audioWorker";
import { ExportResources } from "./exportJob";
import { Flow } from "../platform";
import { ffmpegService } from "./ffmpegService";
import { scheduleAudioChunk, type AudioSelection } from "./audio";
import { activeIntervals, canvasFit, createOpacitySampler, estimateExport, exportFrameRate, frameCount,
  frameTimestamp, intervalsOverlap, sourceTimeAt, sourceWindow } from "./timeline";
import { logEvent as sysLog } from "./journalService";
import type { MediaAsset, VisualFilter } from "../types";
import type { ExportSnapshot, ExportContext, ExportResult } from "./exportJob";
import { Input, Output, Mp4OutputFormat, BufferTarget, BlobSource, ALL_FORMATS,
  VideoSampleSource, VideoSample, VideoSampleSink, AudioBufferSink, canEncodeVideo } from "mediabunny";
import { registerAc3Decoder } from "@mediabunny/ac3";
let encodersInitialized = false;
async function initMediaCodecs() {
  if (encodersInitialized) return;
  registerAc3Decoder();
  encodersInitialized = true;
}
const blobToBase64 = (blob: Blob, signal?: AbortSignal): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => { reader.abort(); cleanup(); reject(signal?.reason); };
    reader.onload = () => { cleanup(); resolve((reader.result as string).split(",")[1]); };
    reader.onerror = () => { cleanup(); reject(reader.error); };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(blob);
  });
};
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
export async function runExportPipeline(snapshot: ExportSnapshot, context: ExportContext): Promise<ExportResult> {
  const { mediaAssets, audioTracks, aspectRatio, fitMode, exportQuality, totalDuration } = snapshot;
  const { getBlob, addLog, setExportProgress, phase, report } = context;
  const segmentProgress = { current: [0, 0] };
  const resources = context.resources;
  const releaseFFmpeg = resources.own(() => ffmpegService.terminate());
  try {
    await resources.wait(ffmpegService.load(addLog), releaseFFmpeg);
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
          const releaseInput = resources.own(() => input.dispose());
          try {
            const vt = await resources.wait(input.getPrimaryVideoTrack(), releaseInput);
            if (!vt) throw new Error("Missing video track");
            f = (await resources.wait(vt.computeFrameRateMetrics({ targetPacketCount: 128 }), releaseInput))
              .bestGuessFrameRate;
          } finally {
            await releaseInput();
          }
        } catch {
          resources.signal.throwIfAborted();
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
      !(await resources.wait(canEncodeVideo("avc", {
        width: targetWidth,
        height: targetHeight,
      })))
    ) {
      throw new Error(
        "This device cannot encode AVC video — export is not supported in this environment.",
      );
    }
    addLog(
      `Target: ${targetWidth}x${targetHeight} @ ${fps}fps, ${Math.round(videoBitrate / 1000)} kbps (${exportQuality.toUpperCase()})`,
    );
    phase("rendering");
    addLog(`Splitting workload into 2 parallel threads...`);
    const mixAudio = async (signal?: AbortSignal, owned: ExportResources = new ExportResources(), onLog: (message: string) => void = () => {}): Promise<Uint8Array> => {
      const rate = 44100;
      const frames = Math.ceil(Math.max(1, totalDuration * rate));
      const mixed = new Uint8Array(44 + frames * 4);
      // OfflineAudioContext has no close(). Keep its native work bounded and
      // drain the current two-second batch before acknowledging cancellation.
      for (let first = 0; first < frames; first += 2 * rate) {
        signal?.throwIfAborted();
        const length = Math.min(2 * rate, frames - first);
        const offset = first / rate;
        const offlineCtx = new OfflineAudioContext(2, length, rate);
        const nodes: AudioBufferSourceNode[] = [];
        let rendering: Promise<AudioBuffer> | undefined;
        const stop = async () => {
          nodes.forEach(node => { try { node.stop(); } catch {} node.disconnect(); });
          if (rendering) await rendering.catch(() => {});
        };
        const releaseAudio = owned?.own(stop) ?? stop;
        try {
          const mixSource = async (sourceId: string, name: string, selection: AudioSelection, allowSilentVideo = false) => {
            signal?.throwIfAborted();
            const from = Math.max(selection.sourceStart, selection.sourceStart - selection.timelineStart);
            const to = Math.min(selection.sourceEnd, selection.sourceStart + selection.timelineEnd - selection.timelineStart);
            if (to <= from) return;
            try {
              const chunks = await decodeAudioInWorker(await getBlob(sourceId), from, to, owned, allowSilentVideo, onLog);
              for (const chunk of chunks) {
                signal?.throwIfAborted();
                const node = scheduleAudioChunk(offlineCtx, chunk.buffer, chunk.timestamp, selection);
                if (node) nodes.push(node);
              }
            } catch (error) { throw new Error(`Cannot decode audio for ${name}: ${String(error)}`); }
          };
          const windowEnd = Math.min(length / rate, totalDuration - offset);
          for (const asset of mediaAssets) {
            if (asset.type !== "video" || !asset.hasAudio || asset.muted) continue;
            const window = sourceWindow(asset);
            await mixSource(asset.sourceId, asset.name, { sourceStart: window.start,
              sourceEnd: Math.min(window.end, window.start + asset.duration),
              timelineStart: asset.startTime - offset, timelineEnd: windowEnd }, true);
          }
          for (const track of audioTracks) {
            await mixSource(track.sourceId, track.name, { sourceStart: 0, sourceEnd: track.duration,
              timelineStart: track.startTime - offset, timelineEnd: windowEnd });
          }
          signal?.throwIfAborted();
          rendering = offlineCtx.startRendering();
          const batch = await rendering;
          signal?.throwIfAborted();
          const wav = audioBufferToWav(batch);
          if (first === 0) mixed.set(wav.subarray(0, 44));
          mixed.set(wav.subarray(44), 44 + first * 4);
          onLog(`Audio mixed: ${Math.min(totalDuration, (first + length) / rate).toFixed(1)}s`);
          await new Promise(resolve => setTimeout(resolve, 0));
        } finally { await releaseAudio(); }
      }
      const header = new DataView(mixed.buffer);
      header.setUint32(4, 36 + frames * 4, true);
      header.setUint32(40, frames * 4, true);
      return mixed;
    };
    const renderSegment = (start: number, end: number, index: number) =>
      renderInWorker(snapshot, { targetWidth, targetHeight, videoBitrate, fps, frameDuration, fitMode }, start, end, index,
        { ...context, setExportProgress: progress => {
          segmentProgress.current[index] = progress;
          setExportProgress(segmentProgress.current[0] + segmentProgress.current[1]);
        } });
    const mid = Math.round((totalDuration / 2) * fps) / fps;
    const cancellation = resources;
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
      run(() => renderSegment(0, mid, 0)),
      run(() => renderSegment(mid, totalDuration, 1)),
      run(() => mixAudio(cancellation.signal, resources, addLog)),
    ]);
    const [chunk1, chunk2, audioData] = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    report({ phase: "rendering", segments: [chunk1.byteLength, chunk2.byteLength], audioBytes: audioData.byteLength });
    phase("muxing");
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
    report({ phase: "muxing", videoBytes: masterBytes.byteLength });
    phase("saving");
    const b64 = await blobToBase64(
      new Blob([masterBytes.buffer as ArrayBuffer], { type: "video/mp4" }), resources.signal,
    );

    setExportProgress(95);
    addLog(
      `Final payload: ${(b64.length / 1048576).toFixed(1)} MiB (base64)`,
    );
    try {
      resources.signal.throwIfAborted();
      context.beginDelivery();
      const saved = await resources.wait(Flow.save({
        base64: b64,
        mimeType: "video/mp4",
        name: "clipbraid_video.mp4", signal: resources.signal,
      }));
      if (!saved)
        throw new Error("Save adapter rejected the video.");
      addLog("EXPORT COMPLETE: save adapter accepted the video");
      sysLog(
        "save",
        `Video handed to save adapter: clipbraid_video.mp4 (${(b64.length / 1048576).toFixed(1)} MiB base64)`,
      );
    } catch (e) {
      throw new Error(
        `Save not acknowledged (${(masterBytes.byteLength / 1048576).toFixed(1)} MiB video); delivery may have started: ${String(e)}`,
      );
    }


    report({ phase: "saving", accepted: true });
    return { videoBytes: masterBytes.byteLength, delivery: "adapter-accepted" };
  } finally {
    for (const name of ["seg1.mp4", "seg2.mp4", "mix.wav", "list.txt", "joined.mp4", "master.mp4"]) {
      try { await ffmpegService.deleteFile(name); } catch { /* worker may have reset */ }
    }
  }
}
