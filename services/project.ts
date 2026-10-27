import type { MediaAsset, AudioFragment, VisualFilter } from "../types";

/** Current on-disk schema. Format identity is the schema, not the display name. */
export const PROJECT_SCHEMA_VERSION = 3;
/** Maximum accepted project document size in bytes (256 MiB). */
export const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
/** Maximum accepted decoded media payload size in bytes (256 MiB). */
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
/** Maximum accepted clip/track start or source duration: 24 hours per field. */
export const MAX_TIMELINE_SECONDS = 24 * 60 * 60;
const MAX_SOURCE_FPS = 1000;
const MAX_SOURCE_DIMENSION = 100000;

// Reject oversized documents before JSON parsing, timeline allocation or URL
// replacement. File callers pass the exact byte size; text callers pass the
// UTF-16 length, which never exceeds the UTF-8 byte length.
export function assertProjectSize(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength < 0)
    throw new Error("Invalid project file size.");
  if (byteLength > MAX_PROJECT_BYTES)
    throw new Error(
      `Project file is too large (${byteLength} bytes); the limit is ${MAX_PROJECT_BYTES} bytes (256 MiB). ` +
        "Reduce embedded media or split the draft. The file was not modified.",
    );
}

// Four base64 characters encode at most three bytes; validate the encoded
// length before decoding or staging any media bytes.
export function assertMediaPayloadSize(base64Length: number): void {
  if (base64Length > 4 * Math.ceil(MAX_MEDIA_BYTES / 3))
    throw new Error(
      `Media payload exceeds the ${MAX_MEDIA_BYTES}-byte limit; re-link a smaller source file.`,
    );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid project object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}.`);
  return value;
}
function number(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = MAX_TIMELINE_SECONDS,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(
      `Invalid ${label}: expected a finite number in [${minimum}, ${maximum}].`,
    );
  return value;
}
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (!choices.includes(value as T)) throw new Error(`Invalid ${label}.`);
  return value as T;
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("Invalid project flag.");
  return value;
}
function optionalNumber(
  value: unknown,
  label: string,
  maximum = MAX_TIMELINE_SECONDS,
): number | undefined {
  if (value === undefined || value === 0) return undefined;
  return number(value, label, Number.MIN_VALUE, maximum);
}

// Unversioned documents are the original RED VOX draft format; version 1 uses
// the same fields without configured gains. Version 2 adds optional gains;
// version 3 adds selected source windows for standalone audio.
// Migration stamps the version and rebuilds missing or
// empty media references from the entry ID (legacy drafts could persist an
// empty reference; the payload itself is authoritative). Source media, trims,
// transitions, audio offsets, canvas options and the playhead are preserved.
// Unsupported versions are rejected before anything is modified.
export function migrateProjectDocument(
  value: unknown,
): Record<string, unknown> {
  const data = record(value);
  const version = data.schemaVersion;
  if (version === PROJECT_SCHEMA_VERSION) return data;
  if (version !== undefined && version !== 1 && version !== 2)
    throw new Error(
      `Unsupported project version ${JSON.stringify(version) ?? "unknown"}; ` +
        `this build reads unversioned drafts and versions 1–${PROJECT_SCHEMA_VERSION}. The file was not modified.`,
    );
  const migrated: Record<string, unknown> = {
    ...data,
    schemaVersion: PROJECT_SCHEMA_VERSION,
  };
  // Earlier readers ignored these audio fields. Preserve their audible window,
  // rather than activating unknown extension data as a newly meaningful trim.
  if(Array.isArray(data.audioTracks))migrated.audioTracks=data.audioTracks.map(entry=>{
    if(!entry||typeof entry!=="object"||Array.isArray(entry))return entry;
    const {originalDuration,trimStart,trimEnd,...legacy}=entry as Record<string,unknown>;
    return legacy;
  });
  if(version!==undefined)return migrated;
  for (const key of ["mediaAssets", "audioTracks"]) {
    const entries = migrated[key];
    if (!Array.isArray(entries)) continue;
    migrated[key] = entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return entry; // strict validation reports malformed entries
      const item = entry as Record<string, unknown>;
      if (typeof item.mediaId === "string" && item.mediaId.trim())
        return entry;
      if (typeof item.id !== "string" || !item.id.trim()) return entry;
      return { ...item, mediaId: item.id };
    });
  }
  return migrated;
}

// Parse the complete serializable state before allocating or replacing any URLs.
// Media bytes are returned once per unique payload as document-local sources;
// callers stage them as immutable originals and remap the synthetic source IDs.
export interface ProjectSourcePayload {
  /** Document-local reference (`s0`, `s1`, …); remapped when staged. */
  sourceId: string;
  base64: string;
  mimeType: string;
}
export function parseProject(textValue: string) {
  assertProjectSize(textValue.length);
  assertProjectSize(new Blob([textValue]).size);
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    throw new Error("Project file is not valid JSON; no changes were made.");
  }
  const data = migrateProjectDocument(parsed);
  const sources: ProjectSourcePayload[] = [];
  const sourceByKey = new Map<string, string>();
  const sourceFor = (base64: string, mimeType: string): string => {
    assertMediaPayloadSize(base64.length);
    const key = `${mimeType}\u0000${base64}`;
    const existing = sourceByKey.get(key);
    if (existing) return existing;
    const sourceId = `s${sources.length}`;
    sourceByKey.set(key, sourceId);
    sources.push({ sourceId, base64, mimeType });
    return sourceId;
  };
  const state = validateMetadata(data, item => sourceFor(
    text(item.base64, "media data"), text(item.mimeType, "media type")));
  return { ...state, sources };
}

/** Validate Blob-backed local snapshots with the same edit/settings rules. */
export function validateProjectMetadata(value: unknown): ProjectSnapshot {
  return validateMetadata(record(value), item => text(item.sourceId, "source reference"));
}
function validateMetadata(data: Record<string, unknown>, resolveSource: (item: Record<string, unknown>) => string): ProjectSnapshot {
  const media = data.mediaAssets ?? [];
  const audio = data.audioTracks ?? [];
  if (!Array.isArray(media) || !Array.isArray(audio)) throw new Error("Project media must be arrays.");
  const ids = new Set<string>();
  function common(value: unknown) {
    const item = record(value);
    const id = text(item.id, "media ID");
    if (ids.has(id)) throw new Error(`Duplicate media ID: ${id}`);
    ids.add(id);
    return {
      item,
      id,
      mediaId:
        item.mediaId === undefined ? id : text(item.mediaId, "media reference"),
      name: text(item.name, "media name"),
      sourceId: resolveSource(item),
      mimeType: text(item.mimeType, "media type"),
      startTime: number(item.startTime, "start time"),
      duration: number(item.duration, "duration", Number.MIN_VALUE),
      ...(item.gain === undefined ? {} : { gain: number(item.gain, "track volume", 0, 1) }),
    };
  }
  const mediaAssets: MediaAsset[] = media.map((value) => {
    const { item, ...base } = common(value);
    const type = choice(item.type, ["image", "video"] as const, "visual type");
    const trimStart = number(item.trimStart ?? 0, "trim start");
    const trimEnd = number(item.trimEnd ?? 0, "trim end");
    const originalDuration = number(
      item.originalDuration ?? base.duration,
      "original duration",
      Number.MIN_VALUE,
    );
    if (
      type === "video" &&
      (trimStart + trimEnd >= originalDuration ||
        trimStart + trimEnd + base.duration > originalDuration + 0.01)
    )
      throw new Error("Trim exceeds source duration.");
    return {
      ...base,
      type,
      originalDuration,
      trimStart,
      trimEnd,
      filter: choice(
        item.filter ?? "none",
        [
          "none",
          "grayscale",
          "sepia",
          "noir",
          "vintage",
          "warm",
          "cool",
        ] as const,
        "filter",
      ) as VisualFilter,
      transitionDuration: number(
        item.transitionDuration ?? 0,
        "transition duration",
      ),
      hasAudio: bool(item.hasAudio, type === "video"),
      muted: bool(item.muted, false),
      normalized: bool(item.normalized, false),
      sourceFps: optionalNumber(item.sourceFps, "source frame rate", MAX_SOURCE_FPS),
      sourceWidth: optionalNumber(item.sourceWidth, "source width", MAX_SOURCE_DIMENSION),
      sourceHeight: optionalNumber(item.sourceHeight, "source height", MAX_SOURCE_DIMENSION),
    };
  });
  const audioTracks: AudioFragment[] = audio.map((value) => {
    const { item, ...base } = common(value);
    if(item.originalDuration===undefined&&item.trimStart===undefined&&item.trimEnd===undefined)return base;
    const originalDuration=number(item.originalDuration??base.duration,"original audio duration",Number.MIN_VALUE);
    const trimStart=number(item.trimStart??0,"audio trim start"),trimEnd=number(item.trimEnd??0,"audio trim end");
    if(trimStart+trimEnd>=originalDuration||Math.abs(originalDuration-trimStart-trimEnd-base.duration)>1e-6)
      throw new Error("Audio trim and duration do not match the selected source interval.");
    return {...base,originalDuration,trimStart,trimEnd};
  });
  // Each start/duration is bounded above, so a valid interval can end as late
  // as twice that bound. Seeking to that end must remain saveable.
  const maximumPlayhead = Math.max(
    mediaAssets.reduce((end, asset) => Math.max(end, asset.startTime + asset.duration), MAX_TIMELINE_SECONDS),
    audioTracks.reduce((end, track) => Math.max(end, track.startTime + track.duration), MAX_TIMELINE_SECONDS),
  );
  return {
    mediaAssets,
    audioTracks,
    aspectRatio: choice(
      data.aspectRatio ?? "16:9",
      ["16:9", "9:16", "1:1"] as const,
      "aspect ratio",
    ),
    fitMode: choice(
      data.fitMode ?? "contain",
      ["contain", "cover"] as const,
      "fit mode",
    ),
    transitionDuration: number(
      data.transitionDuration ?? 0.5,
      "transition duration",
    ),
    currentTime: number(
      data.currentTime ?? 0,
      "playhead",
      -MAX_TIMELINE_SECONDS,
      maximumPlayhead,
    ),
  };
}

export interface ProjectSnapshot {
  mediaAssets: MediaAsset[];
  audioTracks: AudioFragment[];
  aspectRatio: "16:9" | "9:16" | "1:1";
  fitMode: "contain" | "cover";
  transitionDuration: number;
  currentTime: number;
}

/**
 * Deterministic project serialization. Base64 media payloads are produced
 * here — the required transport boundary — from the immutable source bytes;
 * runtime state itself holds only Blob handles and source IDs. The emitted
 * field set is the version 3 format and stays identical across round trips.
 */
export async function serializeProject(
  state: ProjectSnapshot,
  sourceBase64: (sourceId: string) => Promise<string>,
): Promise<string> {
  state = validateProjectMetadata(state);
  const mediaAssets = [];
  for (const clip of state.mediaAssets) {
    mediaAssets.push({
      id: clip.id,
      mediaId: clip.mediaId,
      base64: "",
      mimeType: clip.mimeType,
      type: clip.type,
      name: clip.name,
      duration: clip.duration,
      originalDuration: clip.originalDuration,
      startTime: clip.startTime,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      filter: clip.filter,
      transitionDuration: clip.transitionDuration ?? 0,
      hasAudio: clip.hasAudio,
      muted: clip.muted ?? false,
      normalized: clip.normalized ?? false,
      sourceFps: clip.sourceFps,
      sourceWidth: clip.sourceWidth,
      sourceHeight: clip.sourceHeight,
      ...(clip.gain === undefined ? {} : { gain: clip.gain }),
    });
  }
  const audioTracks = [];
  for (const track of state.audioTracks) {
    audioTracks.push({
      id: track.id,
      mediaId: track.mediaId,
      base64: "",
      mimeType: track.mimeType,
      name: track.name,
      startTime: track.startTime,
      duration: track.duration,
      ...(track.originalDuration===undefined?{}:{originalDuration:track.originalDuration,trimStart:track.trimStart??0,trimEnd:track.trimEnd??0}),
      ...(track.gain === undefined ? {} : { gain: track.gain }),
    });
  }
  const document = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    mediaAssets,
    audioTracks,
    aspectRatio: state.aspectRatio,
    fitMode: state.fitMode,
    transitionDuration: state.transitionDuration,
    currentTime: state.currentTime,
  };
  let bytes = new Blob([JSON.stringify(document)]).size;
  assertProjectSize(bytes);
  const payloads = new Map<string, { data: string; bytes: number }>();
  const sources = [...state.mediaAssets, ...state.audioTracks];
  const entries = [...mediaAssets, ...audioTracks];
  for (let index = 0; index < entries.length; index++) {
    const id = sources[index].sourceId;
    let payload = payloads.get(id);
    if (!payload) {
      const data = text(await sourceBase64(id), "media data");
      assertMediaPayloadSize(data.length);
      // A lower bound rejects a large payload before JSON escaping/copying it.
      assertProjectSize(bytes + data.length);
      const encodedBytes = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(data)
        ? data.length : new Blob([JSON.stringify(data)]).size - 2;
      payload = { data, bytes: encodedBytes }; payloads.set(id, payload);
    }
    bytes += payload.bytes;
    assertProjectSize(bytes);
    entries[index].base64 = payload.data;
  }
  const json = JSON.stringify(document);
  assertProjectSize(new Blob([json]).size);
  return json;
}
