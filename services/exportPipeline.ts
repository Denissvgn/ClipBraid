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
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
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

export async function runExportPipeline(snapshot: ExportSnapshot, context: ExportContext): Promise<ExportResult> {
  const { mediaAssets, audioTracks, aspectRatio, fitMode, exportQuality, totalDuration } = snapshot;
  const { getBlob, addLog, setExportProgress, phase, report } = context;
  const segmentProgress = { current: [0, 0] };
  try {
    await ffmpegService.load(addLog);
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
    phase("rendering");
    addLog(`Splitting workload into 2 parallel threads...`);
    const mixAudio = async (signal?: AbortSignal): Promise<Uint8Array> => {
      const offlineCtx = new OfflineAudioContext(
        2,
        Math.ceil(Math.max(1, totalDuration * 44100)),
        44100,
      );
      const mixSource = async (
        sourceId: string,
        name: string,
        selection: AudioSelection,
        allowSilentVideo = false,
      ) => {
        signal?.throwIfAborted();
        const input = new Input({
          source: new BlobSource(await getBlob(sourceId)),
          formats: ALL_FORMATS,
        });
        try {
          const track = await input.getPrimaryAudioTrack();
          // Older drafts may not know that a valid video is silent.
          if (!track) {
            if (allowSilentVideo) return;
            throw new Error("Missing audio track");
          }
          if (!(await track.canDecode()))
            throw new Error("Unsupported audio codec");
          const sink = new AudioBufferSink(track);
          for await (const wrapped of sink.buffers(
            selection.sourceStart,
            selection.sourceEnd,
          )) {
            signal?.throwIfAborted();
            scheduleAudioChunk(
              offlineCtx,
              wrapped.buffer,
              wrapped.timestamp,
              selection,
            );
          }
        } catch (error) {
          throw new Error(
            `Cannot decode audio for ${name}: ${String(error)}`,
          );
        } finally {
          input.dispose();
        }
      };
      for (const asset of mediaAssets) {
        if (asset.type !== "video" || !asset.hasAudio || asset.muted)
          continue;
        const window = sourceWindow(asset);
        await mixSource(
          asset.sourceId,
          asset.name,
          {
            sourceStart: window.start,
            sourceEnd: Math.min(window.end, window.start + asset.duration),
            timelineStart: asset.startTime,
            timelineEnd: totalDuration,
          },
          true,
        );
      }
      for (const track of audioTracks) {
        await mixSource(track.sourceId, track.name, {
          sourceStart: 0,
          sourceEnd: track.duration,
          timelineStart: track.startTime,
          timelineEnd: totalDuration,
        });
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
    const b64 = await blobToBase64(
      new Blob([masterBytes.buffer as ArrayBuffer], { type: "video/mp4" }),
    );

    report({ phase: "muxing", videoBytes: masterBytes.byteLength });
    phase("saving");
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
      if (!saved)
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


    report({ phase: "saving", accepted: true });
    return { videoBytes: masterBytes.byteLength, delivery: "adapter-accepted" };
  } finally {
    for (const name of ["seg1.mp4", "seg2.mp4", "mix.wav", "list.txt", "joined.mp4", "master.mp4"]) {
      try { await ffmpegService.deleteFile(name); } catch { /* worker may have reset */ }
    }
  }
}
