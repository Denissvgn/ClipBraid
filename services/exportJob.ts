import type { MediaAsset, AudioFragment } from "../types";
import type { MediaSourceStore, SourceLease } from "./mediaSources";
import type { ExportQuality } from "./timeline";
import type { AssetInventory } from "./mediaProbe";
import type { OutputProfile } from "./outputProfile";

export interface ExportSnapshot {
  mediaAssets: MediaAsset[];
  audioTracks: AudioFragment[];
  aspectRatio: "16:9" | "9:16" | "1:1";
  fitMode: "contain" | "cover";
  exportQuality: ExportQuality;
  totalDuration: number;
  segmentPreference?: 1 | 2;
}
export type ExportPhase = "idle" | "preparing" | "rendering" | "muxing" | "saving" | "cancelling" | "cleaning" | "cancelled" | "complete" | "failed";
export type ExportPhaseResult =
  | { phase: "preparing"; assets: AssetInventory[] }
  | { phase: "preparing"; profile: OutputProfile }
  | { phase: "rendering"; segments: number[]; audioBytes: number; plan?: "single" | "parallel"; attempts?: number; preference?: string }
  | { phase: "muxing"; videoBytes: number }
  | { phase: "saving"; accepted: true };
export interface ExportResult { videoBytes: number; delivery: "download-started" | "host-accepted" }
export type ExportEventType = "started" | "heartbeat" | "rendered" | "muxed" | "verified" | "delivery-started" | "download-started" | "host-accepted" | "failed" | "cancelled" | "unknown";
export interface ExportEvent { schemaVersion: 1; jobId: string; buildId: string; type: ExportEventType; at: string; elapsedMs: number; detail: Record<string, unknown> }
export interface ExportState {
  jobId: string | null;
  phase: ExportPhase;
  active: boolean;
  progress: number;
  logs: string[];
  error: string | null;
  failure: { category: string; assetId?: string; deliveryMayHaveStarted?: boolean } | null;
  result: ExportResult | null;
  phaseResults: ExportPhaseResult[];
  cancellable: boolean;
  cleanupComplete: boolean;
  buildId: string;
  events: ExportEvent[];
  diagnostics: Record<string, unknown>[];
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  phaseTimingsMs: Partial<Record<ExportPhase, number>>;
  input: { fingerprint: string | null; clips: number; audioTracks: number; duration: number;
    quality: ExportQuality; aspectRatio: ExportSnapshot["aspectRatio"]; fitMode: ExportSnapshot["fitMode"] } | null;
}
export interface ExportContext {
  jobId: string;
  getBlob(sourceId: string | undefined): Promise<Blob>;
  phase(phase: "preparing" | "rendering" | "muxing" | "saving"): void;
  addLog(message: string): void;
  setExportProgress(progress: number): void;
  report(result: ExportPhaseResult): void;
  resources: ExportResources;
  beginDelivery(): void;
  event(type: ExportEventType, detail?: Record<string, unknown>): void;
  diagnostic(point: Record<string, unknown>): void;
}
export type ExportRunner = (snapshot: ExportSnapshot, context: ExportContext) => Promise<ExportResult>;

/** Abort closes real owners; waits discard late values only after owner disposal. */
export class ExportResources {
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private owners = new Set<() => Promise<void>>();
  private closing = new Set<Promise<void>>();
  private errors: unknown[] = [];
  abort = (reason: unknown = new DOMException("Export cancelled", "AbortError")) => this.controller.abort(reason);
  own(dispose: () => void | Promise<void>): () => Promise<void> {
    let closed: Promise<void> | undefined;
    const release = () => {
      if (closed) return closed;
      this.owners.delete(release);
      this.signal.removeEventListener("abort", onAbort);
      closed = Promise.resolve().then(dispose);
      this.closing.add(closed);
      void closed.then(() => this.closing.delete(closed!), error => {
        this.errors.push(error); this.closing.delete(closed!);
      });
      return closed;
    };
    const onAbort = () => { void release(); };
    this.owners.add(release);
    this.signal.addEventListener("abort", onAbort, { once: true });
    if (this.signal.aborted) onAbort();
    return release;
  }
  wait<T>(operation: Promise<T>, stop: () => void | Promise<void> = () => {}, lateDispose?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void Promise.resolve().then(stop).then(() => reject(this.signal.reason), reject);
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(value => {
        this.signal.removeEventListener("abort", onAbort);
        if (this.signal.aborted) { lateDispose?.(value); reject(this.signal.reason); }
        else resolve(value);
      }, error => {
        this.signal.removeEventListener("abort", onAbort); reject(error);
      });
      if (this.signal.aborted) onAbort();
    });
  }
  async close() {
    await Promise.allSettled([...this.owners].map(close => close()));
    await Promise.allSettled([...this.closing]);
    if (this.errors.length) throw new Error(`Export cleanup failed: ${String(this.errors[0])}`);
  }
  get size() { return this.owners.size + this.closing.size; }
}
export interface ExportDeadlines {
  stageMs?: number;
  inactivityMs?: number;
  cleanupMs?: number;
  stages?: Partial<Record<"preparing" | "rendering" | "muxing" | "saving", number>>;
}

/** One job owns a frozen edit/settings snapshot, original leases and all events. */
export class ExportJobs {
  private state: ExportState = Object.freeze({ jobId: null, phase: "idle", active: false,
    progress: 0, logs: [], error: null, failure: null, result: null, phaseResults: [], cancellable: false, cleanupComplete: true, buildId: "unqualified", events: [], diagnostics: [],
    startedAt: null, updatedAt: null, endedAt: null, phaseTimingsMs: {}, input: null });
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private resources: ExportResources | null = null;
  private publishedAt = performance.now();
  constructor(
    private store: Pick<MediaSourceStore, "acquireAll" | "bytesFor"> & Partial<Pick<MediaSourceStore, "get">>,
    private run: ExportRunner,
    private deadlines: ExportDeadlines = {},
    private buildId = "unqualified",
  ) {}
  setDeadlines = (deadlines: ExportDeadlines) => { if (!this.running) this.deadlines = deadlines; };
  cancel = () => {
    if (!this.state.active || !this.state.cancellable) return;
    this.publish({ phase: "cancelling", cancellable: false });
    this.resources?.abort();
  };
  dispose = () => {
    if (this.state.active) this.resources?.abort(new DOMException("Editor closed", "AbortError"));
  };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  dismissFailure = () => {
    if (!this.state.active) this.publish({ phase: "idle", error: null, failure: null });
  };
  private publish(update: Partial<ExportState>) {
    const now = performance.now(), sameJob = !update.jobId || update.jobId === this.state.jobId;
    const timings = { ...this.state.phaseTimingsMs };
    if (sameJob && this.state.active) timings[this.state.phase] = (timings[this.state.phase] ?? 0) + now - this.publishedAt;
    this.publishedAt = now;
    this.state = Object.freeze({ ...this.state, phaseTimingsMs: timings, ...update, updatedAt: new Date().toISOString() });
    for (const listener of this.listeners) listener();
  }
  start(input: ExportSnapshot): Promise<void> {
    if (this.running) return this.running;
    if (!this.state.cleanupComplete) return Promise.resolve();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    this.running = pending;
    const resources = new ExportResources();
    this.resources = resources;
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
    const diagnostics: Record<string, unknown>[] = [];
    let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
    let abortCleanupTimer: ReturnType<typeof setTimeout> | undefined;
    resources.signal.addEventListener("abort", () => {
      abortCleanupTimer = setTimeout(() => {
        if (this.state.jobId === jobId && this.state.active) this.publish({
          active: false, phase: "failed", cancellable: false, cleanupComplete: false,
          failure: { category: "cleanup" },
          error: "Media cleanup has not finished. Save your project and reload before another export.",
        });
      }, this.deadlines.cleanupMs ?? 5000);
    }, { once: true });
    let stageTimer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined;
    const beat = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => resources.abort(new Error(`Export ${this.state.phase} inactive; retry the export.`)), this.deadlines.inactivityMs ?? 30_000);
    };
    const armStage = (phase: "preparing" | "rendering" | "muxing" | "saving") => {
      clearTimeout(stageTimer);
      stageTimer = setTimeout(() => resources.abort(new Error(`Export ${phase} timed out; retry the export.`)),
        this.deadlines.stages?.[phase] ?? this.deadlines.stageMs ?? 300_000);
      beat();
    };
    const update = (patch: Partial<ExportState>) => {
      if (this.state.jobId === jobId && this.state.active) this.publish(patch);
    };
    const context: ExportContext = {
      jobId,
      resources,
      diagnostic: point => {
        if (this.state.jobId !== jobId || !this.state.active) return;
        diagnostics.push({ ...point, elapsedMs: Math.floor(performance.now() - started), ownedResources: resources.size, sourceLeases: leases.length });
        if (diagnostics.length > 80) diagnostics.shift();
        if (!diagnosticTimer) diagnosticTimer = setTimeout(() => {
          diagnosticTimer = undefined;
          if (this.state.jobId === jobId && this.state.active) update({ diagnostics: [...diagnostics] });
        }, 250);
      },
      beginDelivery: () => { context.event("delivery-started"); update({ cancellable: false }); },
      event: (type, detail = {}) => {
        if (this.state.jobId !== jobId || !this.state.active) return;
        const event: ExportEvent = { schemaVersion: 1, jobId, buildId: this.buildId, type, at: new Date().toISOString(),
          elapsedMs: Math.floor(performance.now() - started), detail };
        update({ events: [...this.state.events.slice(-79), event],
          logs: [...this.state.logs.slice(-19), `EXPORT EVENT ${JSON.stringify(event)}`] });
      },
      getBlob: async id => {
        const blob = id ? blobs.get(id) : undefined;
        if (!blob) throw new Error("Missing media source in export snapshot.");
        return blob;
      },
      phase: phase => {
        if (this.state.jobId !== jobId || !this.state.active || resources.signal.aborted) return;
        const order: ExportPhase[] = ["preparing", "rendering", "muxing", "saving"];
        if (order.indexOf(phase) < order.indexOf(this.state.phase))
          throw new Error(`Invalid export phase: ${this.state.phase} → ${phase}`);
        update({ phase });
        armStage(phase);
      },
      addLog: message => {
        if (this.state.jobId !== jobId || !this.state.active) return;
        beat(); update({ logs: [...this.state.logs.slice(-19), `[+${Math.floor(performance.now() - started)}ms] ${message}`] });
      },
      setExportProgress: progress => {
        if (this.state.jobId !== jobId || !this.state.active || resources.signal.aborted) return;
        beat(); update({ progress: Math.max(this.state.progress, Math.min(100, Math.max(0, progress))) });
      },
      report: result => {
        update({ phaseResults: [...this.state.phaseResults, result] });
        if (result.phase === "rendering") context.event("rendered", { ...result });
        if (result.phase === "muxing") context.event("muxed", { ...result });
      },
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
      error: null, failure: null, result: null, phaseResults: [], cancellable: true, cleanupComplete: false, buildId: this.buildId, events: [], diagnostics: [],
      startedAt: new Date().toISOString(), endedAt: null, phaseTimingsMs: {}, input: {
        fingerprint: null, clips: snapshot.mediaAssets.length, audioTracks: snapshot.audioTracks.length, duration: snapshot.totalDuration,
        quality: snapshot.exportQuality, aspectRatio: snapshot.aspectRatio, fitMode: snapshot.fitMode } });
    armStage("preparing");
    context.addLog("EXPORT STARTED");
    context.event("started");
    const heartbeat = setInterval(() => {
      if (!this.state.active || this.state.jobId !== jobId) clearInterval(heartbeat);
      else context.event("heartbeat");
    }, 5000);
    void (async () => {
      let result: ExportResult | null = null, error: string | null = null;
      try {
        if (setupError) throw setupError;
        const identity = [...snapshot.mediaAssets, ...snapshot.audioTracks].map(asset => {
          const { name: _name, id: _id, sourceId, mediaId: _transport, ...edit } = asset;
          return { checksum: this.store.get?.(sourceId)?.sha256, edit };
        });
        if (identity.every(asset => asset.checksum)) {
          const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ identity,
            aspectRatio: snapshot.aspectRatio, fitMode: snapshot.fitMode, quality: snapshot.exportQuality })))), byte => byte.toString(16).padStart(2, "0")).join("");
          update({ input: { ...this.state.input!, fingerprint } });
        }
        result = await this.run(snapshot, context);
        resources.signal.throwIfAborted();
      } catch (cause) {
        error = String(cause);
        const detail = cause as { category?: string; assetId?: string; deliveryMayHaveStarted?: boolean; name?: string } | null;
        update({ failure: { category: detail?.category ?? (detail?.name === "AbortError" ? "cancelled" : "processing"),
          assetId: detail?.assetId, deliveryMayHaveStarted: detail?.deliveryMayHaveStarted } });
        resources.abort(cause);
        context.addLog(`EXPORT STOPPED: ${error}`);
      } finally {
        clearInterval(heartbeat);
        clearTimeout(diagnosticTimer);
        update({ diagnostics: [...diagnostics] });
        clearTimeout(abortCleanupTimer);
        clearTimeout(stageTimer); clearTimeout(idleTimer);
        this.publish({ phase: "cleaning", cancellable: false });
        let cleanupComplete = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Export cleanup did not finish; reload before another export.")), this.deadlines.cleanupMs ?? 5000);
            resources.close().then(resolve, reject);
          });
        } catch (cause) { cleanupComplete = false; error = String(cause); }
        finally { clearTimeout(timer); }
        for (const lease of leases) {
          try { lease.release(); }
          catch (cause) { cleanupComplete = false; error = `Source cleanup failed: ${String(cause)}`; }
        }
        blobs.clear();
        this.running = null;
        this.resources = null;
        const cancelled = resources.signal.aborted && resources.signal.reason?.name === "AbortError";
        if (error) context.event(cancelled ? "cancelled" : "failed", { message: error,
          category: (resources.signal.reason as { category?: string })?.category ?? "processing", cleanupComplete });
        this.publish({ active: false, phase: error ? (cancelled && cleanupComplete ? "cancelled" : "failed") : "complete", error, result,
          progress: error ? this.state.progress : 100, cleanupComplete, cancellable: false, endedAt: new Date().toISOString() });
        finish();
      }
    })();
    return pending;
  }
}
