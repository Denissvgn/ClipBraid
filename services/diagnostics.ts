import type { ExportState } from "./exportJob";

const phases = ["idle", "preparing", "rendering", "muxing", "saving", "cancelling", "cleaning", "cancelled", "complete", "failed"] as const;
const outcomes = ["running", "failed", "cancelled", "unknown", "aborted", "download-started", "host-accepted"] as const;
const eventTypes = ["started", "heartbeat", "rendered", "muxed", "verified", "delivery-started", "download-started", "host-accepted", "failed", "cancelled", "unknown"] as const;
const categories = ["asset", "processing", "cleanup", "rejected", "cancelled", "denied", "unsupported", "transport", "unknown", "size-limit"] as const;
const warnings = ["profile-conversion", "cleanup-incomplete", "delivery-uncertain", "device-storage-unconfirmed", "single-encoder-retry", "previous-session-unobserved"] as const;
const numericResources = ["elapsedMs", "ownedResources", "sourceLeases", "segment", "inputs", "images", "frameIndex", "sourceTime", "waitMs", "decodersCreated", "decodersActive", "encodersCreated", "encodersActive"];
const profileKeys = ["width", "height", "fps", "fpsNumerator", "fpsDenominator", "frames", "duration", "videoBitrate", "audioBitrate"];
type Dict = Record<string, unknown>;
export interface JobReport {
  schemaVersion: 1; jobId: string; buildId: string; startedAt: string | null; updatedAt: string | null; endedAt: string | null;
  outcome: typeof outcomes[number]; phase: typeof phases[number]; progress: number; cleanupComplete: boolean; category: string | null;
  input: { fingerprint: string | null; clips: number; audioTracks: number; duration: number; quality: string; aspectRatio: string; fitMode: string };
  profile: Record<string, number> | null; timingsMs: Record<string, number>; warnings: string[];
  events: { type: string; elapsedMs: number; at: string | null }[]; resources: Record<string, number>[];
}
const object = (value: unknown): Dict => value && typeof value === "object" && !Array.isArray(value) ? value as Dict : {};
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const timestamp = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const numbers = (value: unknown, keys: readonly string[]) => Object.fromEntries(keys.filter(key => typeof object(value)[key] === "number" && Number.isFinite(object(value)[key])).map(key => [key, finite(object(value)[key])]));

/** An allow-list, rather than regex redaction of potentially identifying free text. */
export function sanitizeReport(value: unknown): JobReport | null {
  const data = object(value), input = object(data.input);
  if (data.schemaVersion !== 1 || typeof data.jobId !== "string" || !/^[a-f0-9-]{36}$/.test(data.jobId)) return null;
  return { schemaVersion: 1, jobId: data.jobId,
    buildId: typeof data.buildId === "string" && /^[a-f0-9]{64}:(production|test|development)$/.test(data.buildId) ? data.buildId : "unqualified",
    startedAt: timestamp(data.startedAt), updatedAt: timestamp(data.updatedAt), endedAt: timestamp(data.endedAt),
    outcome: oneOf(data.outcome, outcomes, "unknown"), phase: oneOf(data.phase, phases, "idle"), progress: Math.min(100, finite(data.progress)),
    cleanupComplete: data.cleanupComplete === true, category: categories.includes(data.category as typeof categories[number]) ? data.category as string : null,
    input: { fingerprint: typeof input.fingerprint === "string" && /^[a-f0-9]{64}$/.test(input.fingerprint) ? input.fingerprint : null,
      clips: finite(input.clips), audioTracks: finite(input.audioTracks), duration: finite(input.duration),
      quality: oneOf(input.quality, ["draft", "standard", "high"], "standard"), aspectRatio: oneOf(input.aspectRatio, ["16:9", "9:16", "1:1"], "16:9"), fitMode: oneOf(input.fitMode, ["contain", "cover"], "contain") },
    profile: data.profile ? numbers(data.profile, profileKeys) : null, timingsMs: numbers(data.timingsMs, phases),
    warnings: Array.isArray(data.warnings) ? data.warnings.filter(value => warnings.includes(value)).slice(0, 6) : [],
    events: Array.isArray(data.events) ? data.events.slice(-80).map(value => object(value)).filter(value => eventTypes.includes(value.type as typeof eventTypes[number]))
      .map(value => ({ type: value.type as string, elapsedMs: finite(value.elapsedMs), at: timestamp(value.at) })) : [],
    resources: Array.isArray(data.resources) ? data.resources.slice(-32).map(value => numbers(value, numericResources)) : [] };
}

export function createJobReport(state: ExportState): JobReport | null {
  if (!state.jobId || state.phase === "idle") return null;
  const profile = state.phaseResults?.find(result => result.phase === "preparing" && "profile" in result);
  const render = state.phaseResults?.find(result => result.phase === "rendering");
  return sanitizeReport({ schemaVersion: 1, jobId: state.jobId, buildId: state.buildId, startedAt: state.startedAt,
    updatedAt: state.updatedAt, endedAt: state.endedAt, phase: state.phase, progress: state.progress,
    outcome: state.active ? "running" : state.phase === "failed" ? (state.cleanupComplete && !state.result && state.failure?.deliveryMayHaveStarted ? "unknown" : "failed") : state.phase === "cancelled" ? "cancelled" : state.result?.delivery ?? "unknown",
    category: state.failure?.category, cleanupComplete: state.cleanupComplete, input: state.input,
    profile: profile && "profile" in profile ? profile.profile : null, timingsMs: state.phaseTimingsMs,
    warnings: [profile ? "profile-conversion" : null, !state.cleanupComplete && !state.active ? "cleanup-incomplete" : null,
      state.failure?.deliveryMayHaveStarted && !state.result ? "delivery-uncertain" : null, state.result ? "device-storage-unconfirmed" : null,
      render && "attempts" in render && (render.attempts ?? 0) > 1 ? "single-encoder-retry" : null],
    events: state.events, resources: state.diagnostics });
}

export const DIAGNOSTIC_KEY = "clipbraid.export-diagnostics.v1";
const MAX_REPORT_BYTES = 24 * 1024, MAX_HISTORY_BYTES = 256 * 1024;
/** Small atomic local-storage records; storage denial/quota is reported to the UI. */
export class DiagnosticHistory {
  constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}
  read(): JobReport[] {
    const text = this.storage.getItem(DIAGNOSTIC_KEY);
    if (!text) return [];
    if (text.length > MAX_HISTORY_BYTES) throw new Error("Diagnostic history exceeded its size limit.");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length > 10) throw new Error("Invalid diagnostic history.");
    return parsed.map(sanitizeReport).filter((report): report is JobReport => report !== null);
  }
  record(report: JobReport): JobReport[] {
    const clean = sanitizeReport(report);
    if (!clean || JSON.stringify(clean).length > MAX_REPORT_BYTES) throw new Error("Invalid diagnostic report.");
    const history = [clean, ...this.read().filter(previous => previous.jobId !== clean.jobId)].slice(0, 10);
    const text = JSON.stringify(history);
    if (text.length > MAX_HISTORY_BYTES) throw new Error("Diagnostic history exceeded its size limit.");
    this.storage.setItem(DIAGNOSTIC_KEY, text);
    return history;
  }
  clear() { this.storage.removeItem(DIAGNOSTIC_KEY); }
}
