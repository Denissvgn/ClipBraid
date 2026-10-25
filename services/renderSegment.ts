import type { MediaAsset, VisualFilter } from "../types";
import { activeIntervals, canvasFit, createOpacitySampler, frameCount, frameTimestamp, intervalsOverlap, sourceTimeAt } from "./timeline";
import { Input, Output, Mp4OutputFormat, BufferTarget, BlobSource, ALL_FORMATS, VideoSampleSource, VideoSample, VideoSampleSink } from "mediabunny";
export interface RenderSettings { targetWidth: number; targetHeight: number; videoBitrate: number; fps: number; frameDuration: number; fitMode: "contain" | "cover"; frameStart?: number; frameEnd?: number; hardwareAcceleration?: "no-preference" | "prefer-software" }
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


export function createRenderer(mediaAssets: MediaAsset[], settings: RenderSettings,
  getBlob: (id: string) => Promise<Blob>, addLog: (message: string) => void,
  setExportProgress: (value: number) => void) {
  const { targetWidth, targetHeight, videoBitrate, fps, frameDuration, fitMode } = settings;
  const opacityAt = createOpacitySampler(mediaAssets);
  const segmentProgress = { current: [0, 0] };
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
    hardwareAcceleration: settings.hardwareAcceleration ?? "no-preference",
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" })!;
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
    const totalFrames = settings.frameStart === undefined ? frameCount(segmentDuration, fps) : settings.frameEnd! - settings.frameStart;
    const segmentStarted = performance.now();
    for (let i = 0; i < totalFrames; i++) {
      signal?.throwIfAborted();
      const t = settings.frameStart === undefined ? frameTimestamp(i, fps, start) : frameTimestamp(settings.frameStart + i, fps);
      const outTs = frameTimestamp(i, fps);
      const visible = activeIntervals(relevantAssets, t);
      const decoded = new Map<string, VideoSample>();
      const frameFor = async (asset: MediaAsset) => {
        if (decoded.has(asset.id)) return decoded.get(asset.id)!;
        const sink = sinks.get(asset.id);
        if (!sink) throw new Error(`Missing decoder for ${asset.name}`);
        const local = sourceTimeAt(asset, t);
            if (i === 0) addLog("Decoding visual media");
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
                  if (i === 0) addLog("Encoding visual media");
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
                if (i === 0) addLog("Encoding visual media");
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
        addLog("Finalizing visual stream");
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

  return renderSegment;
}
