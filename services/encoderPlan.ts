import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink, canEncodeVideo } from "mediabunny";
import { ExportResources, type ExportContext, type ExportSnapshot } from "./exportJob";
import { frameSegments, type OutputProfile } from "./outputProfile";
import { renderInWorker } from "./renderWorker";
const descriptionKey = (description?: AllowSharedBufferSource) => {
  if (!description) return "";
  const bytes = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
};
export async function validateSegments(chunks: Uint8Array[], profile: OutputProfile, segments: ReturnType<typeof frameSegments>, context: ExportContext) {
  const signatures = [];
  for (let index = 0; index < chunks.length; index++) {
    const input = new Input({ source: new BlobSource(new Blob([chunks[index] as Uint8Array<ArrayBuffer>])), formats: ALL_FORMATS });
    const release = context.resources.own(() => input.dispose());
    try {
      const video = await context.resources.wait(input.getPrimaryVideoTrack(), release);
      if (!video) throw new Error("Segment has no video.");
      const config = await context.resources.wait(video.getDecoderConfig(), release);
      if (!config) throw new Error("Encoded segment decoder configuration is missing.");
      if (!/^avc[13]\./i.test(config.codec)) throw new Error("Encoded segment codec is not AVC.");
      const duration = await context.resources.wait(video.computeDuration(), release), first = await video.getFirstTimestamp();
      const resolution = await context.resources.wait(video.getTimeResolution(), release);
      const expectedFrames = segments[index].frameEnd - segments[index].frameStart;
      if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || !Number.isFinite(resolution) || resolution <= 0)
        throw new Error("Encoded segment timing configuration is invalid.");
      const tolerance = Math.min(.1 / profile.fps, 1 / resolution + 1e-6), seen = new Uint8Array(expectedFrames);
      let frames = 0;
      for await (const packet of new EncodedPacketSink(video).packets()) {
        context.resources.signal.throwIfAborted();
        if (frames === 0 && packet.type !== "key") throw new Error("Encoded segment is not independently decodable from a keyframe.");
        const frame = Math.round(packet.timestamp * profile.fps);
        if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration <= 0 ||
          frame < 0 || frame >= expectedFrames || seen[frame] ||
          Math.abs(packet.timestamp - frame / profile.fps) > tolerance || Math.abs(packet.duration - 1 / profile.fps) > 2 * tolerance)
          throw new Error("Encoded segment timestamps do not match the output frame grid.");
        seen[frame] = 1; frames++;
      }
      if (config.codedWidth !== profile.width || config.codedHeight !== profile.height || frames !== expectedFrames ||
        !Number.isFinite(first) || !Number.isFinite(duration) || duration <= 0 ||
        Math.abs(first) > 1e-5 || Math.abs(duration - frames / profile.fps) > 1 / profile.fps + 1e-5)
        throw new Error("Encoded segment geometry, frame count or timestamps are incompatible.");
      signatures.push(JSON.stringify({ codec: config.codec, width: config.codedWidth, height: config.codedHeight,
        description: descriptionKey(config.description), colorSpace: config.colorSpace }));
    } finally { await release(); }
  }
  if (new Set(signatures).size > 1) throw new Error("Encoded segment configurations are incompatible.");
}
export async function renderVisualPlan(snapshot: ExportSnapshot, profile: OutputProfile, context: ExportContext) {
  const config = { width: profile.width, height: profile.height, bitrate: profile.videoBitrate, frameRate: profile.fps };
  const normal = await context.resources.wait(canEncodeVideo("avc", { ...config, hardwareAcceleration: "no-preference" }));
  const software = await context.resources.wait(canEncodeVideo("avc", { ...config, hardwareAcceleration: "prefer-software" }));
  if (!normal && !software) throw new Error("This device cannot encode the requested AVC profile.");
  const initialCount = snapshot.segmentPreference ?? (normal ? 2 : 1);
  const plans = [{ count: initialCount, preference: normal ? "no-preference" : "prefer-software" },
    { count: 1, preference: software ? "prefer-software" : "no-preference" }] as const;
  let failure: unknown;
  for (let attempt = 0; attempt < plans.length; attempt++) {
    context.resources.signal.throwIfAborted();
    if (attempt && !/encod|capacity|resource|segment|compatib|configuration/i.test(String(failure))) throw failure;
    const plan = plans[attempt], segments = frameSegments(profile, plan.count), resources = new ExportResources();
    let active = true;
    const release = context.resources.own(async () => { resources.abort(context.resources.signal.reason); await resources.close(); });
    const progress = [0, 0];
    const child: ExportContext = { ...context, resources,
      addLog: message => { if (active && !resources.signal.aborted) context.addLog(message); },
      setExportProgress: () => {},
    };
    try {
      context.addLog(`Encoder plan ${attempt + 1}: ${segments.length} segment(s), ${plan.preference}; acceleration unmeasured`);
      const results = await Promise.allSettled(segments.map(async segment => {
        try {
          return await renderInWorker(snapshot, { targetWidth: profile.width, targetHeight: profile.height,
            videoBitrate: profile.videoBitrate, fps: profile.fps, frameDuration: 1 / profile.fps, fitMode: snapshot.fitMode,
            frameStart: segment.frameStart, frameEnd: segment.frameEnd, hardwareAcceleration: plan.preference },
          segment.start, segment.end, segment.index, { ...child, setExportProgress: value => {
            if (!active || resources.signal.aborted) return;
            progress[segment.index] = value;
            context.setExportProgress(progress.reduce((sum, x) => sum + x, 0) * 2 / segments.length);
          } });
        } catch (error) { resources.abort(error); throw error; }
      }));
      const chunks = results.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
      await validateSegments(chunks, profile, segments, child);
      return { chunks, plan: segments.length === 1 ? "single" as const : "parallel" as const, preference: plan.preference, attempts: attempt + 1 };
    } catch (error) { failure = error; context.addLog(`Encoder plan failed: ${String(error)}`); }
    finally { active = false; await release(); }
  }
  throw failure;
}
