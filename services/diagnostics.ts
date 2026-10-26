import type { ExportState } from "./exportJob";

import { sanitizeReport } from "./reportPolicy.mjs";
import type { JobReport } from "./reportPolicy.mjs";
export { sanitizeReport } from "./reportPolicy.mjs";
export type { JobReport } from "./reportPolicy.mjs";

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
