import { renderVisualPlan, validateSegments } from "./encoderPlan";
import { deliverVideo, deliveryFailure, assertVideoSize } from "./delivery";
import { outputProfile, frameSegments } from "./outputProfile";
import { renderInWorker } from "./renderWorker";
import { preflightAssets } from "./preflight";
import { decodeAudioInWorker } from "./audioWorker";
import { ExportResources } from "./exportJob";
import { clipHasSound, mixPolicy, trackGain } from "./mixing";
import { resolveSourceAudio } from "./sourceAudio";
import { Flow } from "../platform";
import { ffmpegService } from "./ffmpegService";
import { scheduleAudioChunk, combineAudioChunks, type AudioSelection } from "./audio";
import { activeIntervals, canvasFit, createOpacitySampler, estimateExport, exportFrameRate, frameCount,
  frameTimestamp, intervalsOverlap, sourceTimeAt, sourceWindow } from "./timeline";
import { logEvent as sysLog } from "./journalService";
import { BRAND } from "./brand";
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
      const value = chans[c][i];
      if (!Number.isFinite(value) || Math.abs(value) > 1.00001)
        throw new Error("Audio mix exceeds full scale. Lower a track volume before exporting; the mix was not silently clipped.");
      const s = Math.max(-1, Math.min(1, value));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return bytes;
};
export async function runExportPipeline(snapshot: ExportSnapshot, context: ExportContext): Promise<ExportResult> {
  const { getBlob, addLog, setExportProgress, phase, report } = context;
  const segmentProgress = { current: [0, 0] };
  const resources = context.resources;
  const releaseFFmpeg = resources.own(() => ffmpegService.terminate());
  try {
    const inventory = await preflightAssets(snapshot, context);
    const checked = resolveSourceAudio(snapshot, inventory);
    const { mediaAssets, audioTracks, aspectRatio, fitMode, exportQuality, totalDuration } = checked;
    report({ phase: "preparing", assets: inventory });
    await resources.wait(ffmpegService.load(addLog), releaseFFmpeg);
    await initMediaCodecs();
    sysLog(
      "export",
      `Export started: ${exportQuality}, ${totalDuration.toFixed(1)}s timeline, ${mediaAssets.length} clips + ${audioTracks.length} audio tracks`,
    );
    addLog("PASS 1/4: Initializing Parallel Visual Pipeline...");
    const profile = outputProfile(exportQuality, aspectRatio, totalDuration, inventory);
    report({ phase: "preparing", profile });
    const { width: targetWidth, height: targetHeight, fps, videoBitrate, audioBitrate } = profile;
    const frameDuration = 1 / fps;
    profile.conversions.forEach(addLog);
    addLog(
      `Target: ${targetWidth}x${targetHeight} @ ${fps}fps, ${Math.round(videoBitrate / 1000)} kbps (${exportQuality.toUpperCase()})`,
    );
    phase("rendering");
    addLog(`Splitting workload into 2 parallel threads...`);
    const mixAudio = async (signal?: AbortSignal, owned: ExportResources = new ExportResources(), onLog: (message: string) => void = () => {}): Promise<Uint8Array> => {
      const rate = 44100;
      const policy = mixPolicy(mediaAssets, audioTracks);
      const frames = Math.ceil(Math.max(1, totalDuration * rate));
      const mixed = new Uint8Array(44 + frames * 4);
      // OfflineAudioContext has no close(). Keep its native work bounded and
      // drain the current two-second batch before acknowledging cancellation.
      for (let first = 0; first < frames; first += 2 * rate) {
        signal?.throwIfAborted();
        const length = Math.min(2 * rate, frames - first);
        const offset = first / rate;
        const offlineCtx = new OfflineAudioContext(2, length, rate);
        const nodes: AudioNode[] = [];
        const bus = offlineCtx.createGain();
        bus.gain.value = policy.gain; bus.connect(offlineCtx.destination); nodes.push(bus);
        let rendering: Promise<AudioBuffer> | undefined;
        const stop = async () => {
          nodes.forEach(node => { if (node instanceof AudioBufferSourceNode) try { node.stop(); } catch {} node.disconnect(); });
          if (rendering) await rendering.catch(() => {});
        };
        const releaseAudio = owned?.own(stop) ?? stop;
        try {
          const mixSource = async (sourceId: string, name: string, selection: AudioSelection, gain: number, allowSilentVideo = false) => {
            signal?.throwIfAborted();
            const from = Math.max(selection.sourceStart, selection.sourceStart - selection.timelineStart);
            const to = Math.min(selection.sourceEnd, selection.sourceStart + selection.timelineEnd - selection.timelineStart);
            if (to <= from) return;
            try {
              const chunks = await decodeAudioInWorker(await getBlob(sourceId), from, to, owned, allowSilentVideo, onLog);
              const chunk = combineAudioChunks(chunks);
              if (chunk) {
                signal?.throwIfAborted();
                scheduleAudioChunk(offlineCtx, chunk.buffer, chunk.timestamp, selection,
                  { gain, destination: bus, onNode: node => nodes.push(node) });
              }
            } catch (error) { throw new Error(`Cannot decode audio for ${name}: ${String(error)}`); }
          };
          const windowEnd = Math.min(length / rate, totalDuration - offset);
          for (const asset of mediaAssets) {
            if (!clipHasSound(asset)) continue;
            const window = sourceWindow(asset);
            await mixSource(asset.sourceId, asset.name, { sourceStart: window.start,
              sourceEnd: Math.min(window.end, window.start + asset.duration),
              timelineStart: asset.startTime - offset, timelineEnd: windowEnd }, trackGain(asset), true);
          }
          for (const track of audioTracks) {
            if (trackGain(track) === 0) continue;
            await mixSource(track.sourceId, track.name, { sourceStart: 0, sourceEnd: track.duration,
              timelineStart: track.startTime - offset, timelineEnd: windowEnd }, trackGain(track));
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
    const cancellation = resources;
    const run = async <T,>(work: () => Promise<T>) => {
      try {
        return await work();
      } catch (error) {
        cancellation.abort(error);
        throw error;
      }
    };
    // A failed branch cancels its siblings; settle their cleanup before a retry.
    const results = await Promise.allSettled([
      run(() => renderVisualPlan(checked, profile, context)),
      run(() => mixAudio(cancellation.signal, resources, addLog)),
    ]);
    const visual = results[0]; if (visual.status === "rejected") throw visual.reason;
    const audio = results[1]; if (audio.status === "rejected") throw audio.reason;
    const { chunks, plan, attempts, preference } = visual.value, audioData = audio.value;
    report({ phase: "rendering", segments: chunks.map(chunk => chunk.byteLength), audioBytes: audioData.byteLength, plan, attempts, preference });
    phase("muxing"); setExportProgress(70);
    await ffmpegService.writeFile("mix.wav", audioData);
    if (chunks.length === 1) await ffmpegService.writeFile("joined.mp4", chunks[0]);
    else {
      await ffmpegService.writeFile("seg1.mp4", chunks[0]);
      await ffmpegService.writeFile("seg2.mp4", chunks[1]);
      await ffmpegService.writeFile("list.txt", new TextEncoder().encode("file 'seg1.mp4'\nfile 'seg2.mp4'"));
      addLog("Merging video segments...");
      await ffmpegService.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-y", "joined.mp4"]);
    }
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
    await validateSegments([masterBytes], profile, frameSegments(profile, 1), context);
    const verifiedInput = new Input({ source: new BlobSource(new Blob([masterBytes as Uint8Array<ArrayBuffer>])), formats: ALL_FORMATS });
    const releaseVerification = resources.own(() => verifiedInput.dispose());
    try {
      if (!(await resources.wait(verifiedInput.getPrimaryAudioTrack(), releaseVerification))) throw new Error("Muxed output is missing its audio stream.");
      context.event("verified", { videoFrames: profile.frames, width: profile.width, height: profile.height, bytes: masterBytes.byteLength });
    } finally { await releaseVerification(); }
    phase("saving");
    assertVideoSize(masterBytes.byteLength);
    const b64 = await blobToBase64(
      new Blob([masterBytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" }), resources.signal,
    );

    setExportProgress(95);
    assertVideoSize(masterBytes.byteLength, b64.length);
    addLog(
      `Final payload: ${(b64.length / 1048576).toFixed(1)} MiB (base64)`,
    );
    try {
      resources.signal.throwIfAborted();
      context.beginDelivery();
      const receipt = await resources.wait(deliverVideo({
        base64: b64,
        mimeType: "video/mp4",
        name: BRAND.videoFilename, signal: resources.signal,
      }));
      context.event(receipt.outcome, { bytes: masterBytes.byteLength });
      addLog(receipt.outcome === "download-started" ? "DOWNLOAD STARTED: browser initiated the video download" : "HOST ACCEPTED: host acknowledged the video");
      sysLog(
        "save",
        `Video handed to save adapter: ${BRAND.videoFilename} (${(b64.length / 1048576).toFixed(1)} MiB base64)`,
      );
      report({ phase: "saving", accepted: true });
      return { videoBytes: masterBytes.byteLength, delivery: receipt.outcome };
    } catch (e) {
      const error = deliveryFailure(e, resources.signal.aborted && e === resources.signal.reason);
      context.event(error.category === "cancelled" ? "cancelled" : error.deliveryMayHaveStarted ? "unknown" : "failed",
        { category: error.category, message: error.message, deliveryMayHaveStarted: error.deliveryMayHaveStarted });
      throw error;
    }


  } finally {
    // This worker and its in-memory filesystem belong to this job. Termination
    // discards every file without waiting for more replies from a stalled core.
    await releaseFFmpeg();
  }
}
