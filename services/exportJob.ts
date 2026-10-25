import type { MediaAsset, AudioFragment } from "../types";
import type { MediaSourceStore, SourceLease } from "./mediaSources";
import type { ExportQuality } from "./timeline";

export interface ExportSnapshot {
  mediaAssets: MediaAsset[];
  audioTracks: AudioFragment[];
  aspectRatio: "16:9" | "9:16" | "1:1";
  fitMode: "contain" | "cover";
  exportQuality: ExportQuality;
  totalDuration: number;
}
export type ExportPhase = "idle" | "preparing" | "rendering" | "muxing" | "saving" | "complete" | "failed";
export type ExportPhaseResult =
  | { phase: "rendering"; segments: number[]; audioBytes: number }
  | { phase: "muxing"; videoBytes: number }
  | { phase: "saving"; accepted: true };
export interface ExportResult { videoBytes: number; delivery: "adapter-accepted" }
export interface ExportState {
  jobId: string | null;
  phase: ExportPhase;
  active: boolean;
  progress: number;
  logs: string[];
  error: string | null;
  result: ExportResult | null;
  phaseResults: ExportPhaseResult[];
}
export interface ExportContext {
  jobId: string;
  getBlob(sourceId: string | undefined): Promise<Blob>;
  phase(phase: "preparing" | "rendering" | "muxing" | "saving"): void;
  addLog(message: string): void;
  setExportProgress(progress: number): void;
  report(result: ExportPhaseResult): void;
}
export type ExportRunner = (snapshot: ExportSnapshot, context: ExportContext) => Promise<ExportResult>;

/** One job owns a frozen edit/settings snapshot, original leases and all events. */
export class ExportJobs {
  private state: ExportState = Object.freeze({ jobId: null, phase: "idle", active: false,
    progress: 0, logs: [], error: null, result: null, phaseResults: [] });
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  constructor(
    private store: Pick<MediaSourceStore, "acquireAll" | "bytesFor">,
    private run: ExportRunner,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  dismissFailure = () => {
    if (!this.state.active) this.publish({ phase: "idle", error: null });
  };
  private publish(update: Partial<ExportState>) {
    this.state = Object.freeze({ ...this.state, ...update });
    for (const listener of this.listeners) listener();
  }
  start(input: ExportSnapshot): Promise<void> {
    if (this.running) return this.running;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    this.running = pending;
    const jobId = crypto.randomUUID();
    const started = performance.now();
    const snapshot = Object.freeze({ ...input,
      mediaAssets: input.mediaAssets.map(asset => Object.freeze({ ...asset })),
      audioTracks: input.audioTracks.map(track => Object.freeze({ ...track })),
    });
    Object.freeze(snapshot.mediaAssets);
    Object.freeze(snapshot.audioTracks);
    const leases: SourceLease[] = [];
    const blobs = new Map<string, Blob>();
    const update = (patch: Partial<ExportState>) => {
      if (this.state.jobId === jobId && this.state.active) this.publish(patch);
    };
    const context: ExportContext = {
      jobId,
      getBlob: async id => {
        const blob = id ? blobs.get(id) : undefined;
        if (!blob) throw new Error("Missing media source in export snapshot.");
        return blob;
      },
      phase: phase => {
        if (this.state.jobId !== jobId || !this.state.active) return;
        const order: ExportPhase[] = ["preparing", "rendering", "muxing", "saving"];
        if (order.indexOf(phase) < order.indexOf(this.state.phase))
          throw new Error(`Invalid export phase: ${this.state.phase} → ${phase}`);
        update({ phase });
      },
      addLog: message => update({ logs: [...this.state.logs.slice(-19),
        `[+${Math.floor(performance.now() - started)}ms] ${message}`] }),
      setExportProgress: progress => update({ progress: Math.min(100, Math.max(0, progress)) }),
      report: result => update({ phaseResults: [...this.state.phaseResults, result] }),
    };
    let setupError: unknown;
    try {
      leases.push(...this.store.acquireAll(
        [...snapshot.mediaAssets, ...snapshot.audioTracks].map(item => item.sourceId), "export"));
      for (const lease of leases) {
        const bytes = this.store.bytesFor(lease.sourceId);
        if (!bytes) throw new Error("Missing media source.");
        blobs.set(lease.sourceId, bytes);
      }
    } catch (error) { setupError = error; }
    this.publish({ jobId, phase: "preparing", active: true, progress: 0, logs: [],
      error: null, result: null, phaseResults: [] });
    context.addLog("EXPORT STARTED");
    void (async () => {
      let result: ExportResult | null = null, error: string | null = null;
      try {
        if (setupError) throw setupError;
        result = await this.run(snapshot, context);
      } catch (cause) {
        error = String(cause);
        context.addLog(`EXPORT FAILED: ${error}`);
      } finally {
        leases.forEach(lease => lease.release());
        blobs.clear();
        this.running = null;
        this.publish({ active: false, phase: error ? "failed" : "complete", error, result,
          progress: error ? this.state.progress : 100 });
        finish();
      }
    })();
    return pending;
  }
}
