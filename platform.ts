/** Normalized browser/Flow contracts. External device persistence remains host-owned. */
import { PlatformError, platformFailure, abortable } from "./services/platformError";
import { recordedDuration } from "./services/audioDuration";
import { saveReceipt } from "./services/saveReceipt";
import { decodeBase64Bytes } from "./services/base64Bytes";
export interface SelectedMedia { mediaId: string; base64: string; mimeType: string; type: "image" | "video" | "audio" | string; name: string }
export interface RecordedAudio { base64: string; mimeType: string; durationMs: number }
export interface FlowApi {
  capabilities?: { maxSaveBytes?: number; maxBase64Chars?: number };
  media: { select(opts: { filter: string; signal?: AbortSignal }): Promise<SelectedMedia | null> };
  microphone: { record(opts: { durationMs: number; signal?: AbortSignal; stopSignal?: AbortSignal }): Promise<RecordedAudio>; stop?(): Promise<unknown>; cancel?(): Promise<unknown> };
  download(opts: { base64: string; mimeType: string; filename: string }): Promise<unknown>;
  save(opts: { base64: string; mimeType: string; name: string; signal?: AbortSignal }): Promise<unknown>;
}
const MAX_SOURCE_BYTES = 256 * 1048576;
function base64(value: unknown): string {
  if (typeof value !== "string") throw new PlatformError("Media response has no byte payload.", "transport");
  const raw = (value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value).replace(/\s/g, "");
  if (!raw || raw.length > 4 * Math.ceil(MAX_SOURCE_BYTES / 3) || raw.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
    throw new PlatformError("Media payload is empty, invalid or above 256 MiB.", "transport");
  return raw;
}
function readBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const done = (error?: unknown, result?: string) => { signal?.removeEventListener("abort", abort); reader.onload = reader.onerror = reader.onabort = null; if (error) reject(error); else resolve(result!); };
    const abort = () => { reader.abort(); done(new PlatformError("Media read cancelled.", "cancelled")); };
    reader.onload = () => done(undefined, String(reader.result).split(",")[1]);
    reader.onerror = () => done(new PlatformError(`Media read failed: ${reader.error?.message ?? "unknown error"}`, "transport"));
    reader.onabort = () => done(new PlatformError("Media read cancelled.", "cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; } reader.readAsDataURL(blob);
  });
}
function pickFile(accept: string, signal?: AbortSignal): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input"); input.type = "file"; input.accept = accept; input.hidden = true; input.dataset.platformPicker = "true";
    let finished = false, focusTimer: ReturnType<typeof setTimeout> | undefined, lostFocus = false;
    const cleanup = () => { clearTimeout(deadline); clearTimeout(focusTimer); input.onchange = input.oncancel = null; window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); signal?.removeEventListener("abort", abort); input.remove(); };
    const finish = (file: File | null, error?: unknown) => { if (finished) return; finished = true; cleanup(); if (error) reject(error); else resolve(file); };
    const abort = () => finish(null, new PlatformError("File selection cancelled.", "cancelled"));
    const blur = () => { lostFocus = true; };
    const focus = () => { if (lostFocus) focusTimer = setTimeout(() => finish(input.files?.[0] ?? null), 1000); };
    const deadline = setTimeout(() => finish(null, new PlatformError("File selection timed out.", "cancelled")), 300000);
    input.onchange = () => finish(input.files?.[0] ?? null);
    if ("oncancel" in input) input.oncancel = () => finish(null);
    else { window.addEventListener("blur", blur); window.addEventListener("focus", focus); }
    signal?.addEventListener("abort", abort, { once: true }); document.body.append(input);
    if (signal?.aborted) { abort(); return; }
    try { input.click(); } catch (error) { finish(null, platformFailure(error)); }
  });
}
function selected(value: unknown, filter: string): SelectedMedia | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new PlatformError("The picker did not return a media result.", "transport");
  const item = value as Partial<SelectedMedia>, mime = item.mimeType;
  if (typeof mime !== "string" || !/^(image|video|audio)\//.test(mime)) throw new PlatformError("Unsupported media type.", "unsupported");
  const kind = mime.split("/")[0];
  if ((filter === "all" && !["image", "video"].includes(kind)) || (filter !== "all" && filter !== kind) || (item.type !== undefined && item.type !== kind))
    throw new PlatformError("The selected file does not match this picker.", "unsupported");
  if (typeof item.name !== "string" || !item.name.trim()) throw new PlatformError("Media response has no file name.", "transport");
  return { name: item.name, mimeType: mime, type: kind, mediaId: typeof item.mediaId === "string" && item.mediaId.trim() ? item.mediaId : `selected-${crypto.randomUUID()}`, base64: base64(item.base64) };
}
const inferMime = (file: File, filter: string) => {
  if (file.type) return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return ({ mp4: "video/mp4", mov: "video/quicktime", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", webm: filter === "audio" ? "audio/webm" : "video/webm" } as Record<string,string>)[extension ?? ""] ?? "application/octet-stream";
};
async function browserRecord(options: { durationMs: number; signal?: AbortSignal; stopSignal?: AbortSignal }): Promise<RecordedAudio> {
  const { signal, stopSignal, durationMs } = options;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new PlatformError("Microphone recording is unsupported in this browser.", "unsupported");
  const permissionSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const stream = await abortable(navigator.mediaDevices.getUserMedia({ audio: true }), permissionSignal, value => value.getTracks().forEach(track => track.stop()));
  let recorder: MediaRecorder | undefined, timer: ReturnType<typeof setTimeout> | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = true;
  let rejectRecording: (error: unknown) => void = () => {};
  const stop = () => {
    try { if (recorder && recorder.state !== "inactive") recorder.stop(); }
    catch (error) { rejectRecording(platformFailure(error)); }
    finally { stream.getTracks().forEach(track => track.stop()); }
    if (pending && !stopTimer) stopTimer = setTimeout(() => rejectRecording(new PlatformError("Recording did not finish after stop. Try recording again.", "transport")), 5000);
  };
  const cancel = () => { stop(); rejectRecording(new PlatformError("Recording cancelled.", "cancelled")); };
  try {
    signal?.throwIfAborted();
    const preferred = ["audio/webm;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
    recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const result = new Promise<Blob>((resolve, reject) => {
      rejectRecording = error => { pending = false; clearTimeout(stopTimer); reject(error); };
      recorder!.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder!.onstop = () => { pending = false; clearTimeout(stopTimer); resolve(new Blob(chunks, { type: recorder!.mimeType })); };
      recorder!.onerror = event => rejectRecording(platformFailure((event as Event & { error?: unknown }).error ?? new Error("Recorder failed.")));
    });
    signal?.addEventListener("abort", cancel, { once: true }); stopSignal?.addEventListener("abort", stop, { once: true });
    recorder.start(); timer = setTimeout(stop, durationMs); if (stopSignal?.aborted) stop();
    const blob = await result; stream.getTracks().forEach(track => track.stop());
    if (!blob.size) throw new PlatformError("Recording was empty or too short.", "cancelled");
    const actual = await recordedDuration(blob, signal);
    return { base64: await readBlob(blob, signal), mimeType: blob.type, durationMs: actual };
  } finally {
    pending = false; clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener("abort", cancel); stopSignal?.removeEventListener("abort", stop);
    if (recorder) { recorder.ondataavailable = recorder.onstop = recorder.onerror = null; try { stop(); } catch {} }
    stream.getTracks().forEach(track => track.stop());
  }
}
export function audioFileType(file: File) {
  const mime = inferMime(file, "audio");
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new PlatformError("Audio file is empty or above 256 MiB.", "size-limit");
  if (!mime.startsWith("audio/")) throw new PlatformError("Choose a supported audio file.", "unsupported");
  return mime;
}
function requestPayload(payload: { base64: string; mimeType: string; name?: string; filename?: string }) {
  if (!payload || typeof payload.mimeType !== "string" || !(payload.name || payload.filename)) throw new PlatformError("Invalid download request.", "unsupported");
  return { ...payload, base64: base64(payload.base64) };
}
async function triggerDownload(payload: { base64: string; mimeType: string; name?: string; filename?: string; signal?: AbortSignal }) {
  const value = requestPayload(payload); payload.signal?.throwIfAborted();
  const bytes = decodeBase64Bytes(value.base64);
  const url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
  try { const anchor = document.createElement("a"); anchor.href = url; anchor.download = value.name || value.filename!; document.body.append(anchor); anchor.click(); anchor.remove(); }
  catch (error) { URL.revokeObjectURL(url); throw error; }
  setTimeout(() => URL.revokeObjectURL(url), 10000); return true;
}
const host = () => window.Flow;
const invokedFailure = (error: unknown) => {
  const failure = platformFailure(error);
  return new PlatformError(failure.message, failure.category, failure.deliveryMayHaveStarted || ["transport", "unknown"].includes(failure.category));
};
const guard = async <T,>(action: () => Promise<T>) => { try { return await action(); } catch (error) { throw platformFailure(error); } };
export const Flow: FlowApi = {
  get capabilities() {
    const value = host()?.capabilities;
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object") throw new PlatformError("Invalid host capabilities.", "unsupported");
    for (const number of [value.maxSaveBytes, value.maxBase64Chars]) if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0)) throw new PlatformError("Invalid host delivery limit.", "unsupported");
    return { ...value };
  },
  media: { select: options => guard(async () => {
    options.signal?.throwIfAborted();
    if (!["all","audio","video","image"].includes(options.filter)) throw new PlatformError("Unsupported picker filter.", "unsupported");
    if (host()) {
      if (typeof host()!.media?.select !== "function") throw new PlatformError("Host picker is unavailable.", "unsupported");
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
      return selected(await abortable(host()!.media.select({ filter: options.filter, signal }), signal), options.filter);
    }
    const accept = options.filter === "all" ? "video/*,image/*" : `${options.filter}/*`;
    const file = await pickFile(accept, options.signal); if (!file) return null;
    if (!file.size || file.size > MAX_SOURCE_BYTES) throw new PlatformError("Selected file is empty or above 256 MiB.", "size-limit");
    const mimeType = inferMime(file, options.filter);
    return selected({ name: file.name, mediaId: `local-${crypto.randomUUID()}`, mimeType, base64: await readBlob(file, options.signal) }, options.filter);
  }) },
  microphone: { record: options => guard(async () => {
    options.signal?.throwIfAborted(); options.stopSignal?.throwIfAborted();
    if (!Number.isFinite(options.durationMs) || options.durationMs < 1 || options.durationMs > 60000) throw new PlatformError("Recording length must be 1 ms to 60 seconds.", "unsupported");
    if (!host()) return browserRecord(options);
    const microphone = host()!.microphone;
    if (typeof microphone?.record !== "function" || typeof microphone.cancel !== "function") throw new PlatformError("This host has no cancellable microphone contract. Record externally and import the file.", "unsupported");
    let cancellation: Promise<unknown> | undefined, completed = false, recordingReturned = false;
    let rejectControl!: (error: unknown) => void;
    const controlFailure = new Promise<never>((_, reject) => { rejectControl = reject; });
    void controlFailure.catch(() => {});
    const cancelRequest = () => cancellation ??= Promise.resolve().then(() => microphone.cancel!());
    const cancel = () => { void cancelRequest().catch(() => {}); };
    const stop = () => {
      if (recordingReturned || typeof microphone.stop !== "function") return;
      void Promise.resolve().then(() => microphone.stop!()).then(acknowledgement => {
        if (recordingReturned) return;
        if (acknowledgement === false) throw new PlatformError("The host rejected early recording stop; capture was cancelled.", "rejected");
        const value = acknowledgement as { stopped?: unknown; cancelled?: unknown; accepted?: unknown } | null;
        if (acknowledgement !== true && !(value && typeof value === "object" && (value.stopped === true || value.cancelled === true || value.accepted === true)))
          throw new PlatformError("The host did not confirm early recording stop; capture cancellation was requested.", "unknown");
      }).catch(error => rejectControl(platformFailure(error)));
    };
    if (options.stopSignal && typeof microphone.stop !== "function") throw new PlatformError("This host cannot stop recording early.", "unsupported");
    options.signal?.addEventListener("abort", cancel, { once: true }); options.stopSignal?.addEventListener("abort", stop, { once: true });
    try {
      const deadline = AbortSignal.timeout(options.durationMs + 10000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const result = await abortable(Promise.race([microphone.record({ durationMs: options.durationMs }), controlFailure]), signal);
      recordingReturned = true;
      if (!result || typeof result.mimeType !== "string" || !result.mimeType.startsWith("audio/") || !Number.isFinite(result.durationMs) || result.durationMs <= 0) throw new PlatformError("Invalid host recording response.", "transport");
      const data = base64(result.base64), blob = new Blob([decodeBase64Bytes(data)], { type: result.mimeType });
      const durationMs = await recordedDuration(blob, options.signal); completed = true;
      return { base64: data, mimeType: result.mimeType, durationMs };
    } finally {
      options.signal?.removeEventListener("abort", cancel); options.stopSignal?.removeEventListener("abort", stop);
      if (!completed) {
        const acknowledgement = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new PlatformError("Host recording stop was not confirmed. Use host controls to stop capture.", "unknown")), 3000);
          cancelRequest().then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(platformFailure(error)); });
        });
        if (acknowledgement !== true && !(acknowledgement && typeof acknowledgement === "object" && (acknowledgement as {cancelled?:unknown}).cancelled === true))
          throw new PlatformError("Host recording stop was not acknowledged. Use host controls to stop capture.", "unknown");
      }
    }
  }) },
  download: payload => guard(async () => {
    const request = requestPayload(payload);
    if (!host()) return triggerDownload(request);
    if (typeof host()!.download !== "function") throw new PlatformError("Host project download is unavailable.", "unsupported");
    let result: unknown;
    try { result = await abortable(host()!.download({ ...payload, base64: request.base64 }), AbortSignal.timeout(30000)); }
    catch (error) { throw invokedFailure(error); }
    saveReceipt(result, true); return true;
  }),
  save: payload => guard(async () => {
    payload.signal?.throwIfAborted();
    const request = requestPayload(payload);
    const adapter = host();
    if (!adapter) { await triggerDownload({ ...request, signal: payload.signal }); return { outcome: "download-started" }; }
    if (typeof adapter.save !== "function") throw new PlatformError("Host video save is unavailable.", "unsupported");
    let result: unknown;
    try { result = await adapter.save({ ...payload, base64: request.base64 }); }
    catch (error) { throw invokedFailure(error); }
    return saveReceipt(result, true);
  }),
};
declare global { interface Window { Flow?: FlowApi } }
export const isHostedFlow = () => !!host();
