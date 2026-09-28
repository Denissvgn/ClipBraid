import type { MediaAsset, AudioFragment, VisualFilter } from "../types";

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
function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error(`Invalid ${label}.`);
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
function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === 0) return undefined;
  return number(value, label, Number.MIN_VALUE);
}

// Parse the complete serializable state before allocating or replacing any URLs.
// Unversioned drafts are the original format; version 1 has the same fields.
export function parseProject(textValue: string) {
  const data = record(JSON.parse(textValue));
  if (data.schemaVersion !== undefined && data.schemaVersion !== 1)
    throw new Error("Unsupported project version.");
  const media = data.mediaAssets ?? [];
  const audio = data.audioTracks ?? [];
  if (!Array.isArray(media) || !Array.isArray(audio))
    throw new Error("Project media must be arrays.");
  const ids = new Set<string>();
  function common(value: unknown) {
    const item = record(value);
    const id = text(item.id, "media ID");
    if (ids.has(id)) throw new Error(`Duplicate media ID: ${id}`);
    ids.add(id);
    return {
      item,
      id,
      mediaId: typeof item.mediaId === "string" ? item.mediaId : id,
      name: text(item.name, "media name"),
      base64: text(item.base64, "media data"),
      mimeType: text(item.mimeType, "media type"),
      startTime: number(item.startTime, "start time"),
      duration: number(item.duration, "duration", Number.MIN_VALUE),
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
      sourceFps: optionalNumber(item.sourceFps, "source frame rate"),
      sourceWidth: optionalNumber(item.sourceWidth, "source width"),
      sourceHeight: optionalNumber(item.sourceHeight, "source height"),
    };
  });
  const audioTracks: AudioFragment[] = audio.map((value) => {
    const { item, ...base } = common(value);
    return base;
  });
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
    currentTime: number(data.currentTime ?? 0, "playhead", -Number.MAX_VALUE),
  };
}
