export interface JobReport {
  schemaVersion: 1; jobId: string; buildId: string; startedAt: string | null; updatedAt: string | null; endedAt: string | null;
  outcome: "running" | "failed" | "cancelled" | "unknown" | "aborted" | "download-started" | "host-accepted";
  phase: "idle" | "preparing" | "rendering" | "muxing" | "saving" | "cancelling" | "cleaning" | "cancelled" | "complete" | "failed";
  progress: number; cleanupComplete: boolean; category: string | null;
  input: { fingerprint: string | null; clips: number; audioTracks: number; duration: number; quality: string; aspectRatio: string; fitMode: string };
  profile: Record<string, number> | null; timingsMs: Record<string, number>; warnings: string[];
  events: { type: string; elapsedMs: number; at: string | null }[]; resources: Record<string, number | string>[];
}
export const JOB_ID: RegExp;
export const BUILD_ID: RegExp;
export function sanitizeReport(value: unknown): JobReport | null;
export function historicalReport(report: JobReport, currentJobId: string | null): JobReport;
