import type { MediaAsset } from "../types";
import type { MediaSourceStore, SourceAsset, SourceLease, DerivedMedia } from "./mediaSources";
import { ExportResources } from "./exportJob";
export const proxyKey = (source: SourceAsset) => `preview:${source.sha256}:${source.revision}:720:30`;
export type ProxyRunner = (source: SourceAsset, key: string, resources: ExportResources) => Promise<DerivedMedia>;
export interface ProxyStatus { sourceId: string; name: string; status: "queued" | "running" | "ready" | "failed"; error?: string; attempts: number; failures: number }

/** One idle job, separate from export; only immutable originals enter a runner. */
export class ProxyQueue {
  private jobs = new Map<string, ProxyStatus>();
  private references = new Set<string>();
  private previews = new Map<string, SourceLease>();
  private current: { sourceId: string; resources: ExportResources } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private paused = false;
  private listeners = new Set<() => void>();
  private state: readonly ProxyStatus[] = [];
  constructor(private store: MediaSourceStore, private run: ProxyRunner, private idleMs = 500, private budget = 64 * 1024 * 1024) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.state = [...this.jobs.values()].map(job => ({ ...job })); for (const listener of this.listeners) listener(); }
  urlFor = (id: string) => this.previews.get(id)?.url;
  sync(assets: MediaAsset[], busy: boolean) {
    this.references = new Set(assets.filter(asset => asset.type === "video").map(asset => asset.sourceId));
    this.paused = busy;
    for (const [id, lease] of this.previews) if (!this.references.has(id)) {
      lease.release(); this.previews.delete(id);
      const source = this.store.get(id); if (source) this.store.dropDerived(id, proxyKey(source));
    }
    for (const id of this.jobs.keys()) if (!this.references.has(id)) this.jobs.delete(id);
    if (this.current && (busy || !this.references.has(this.current.sourceId))) this.current.resources.abort();
    for (const asset of assets) if (asset.type === "video" && Math.max(asset.sourceWidth ?? 0, asset.sourceHeight ?? 0) > 1280) this.enqueue(asset);
    this.publish(); this.schedule();
  }
  request(assets: MediaAsset[]) {
    for (const asset of assets) if (asset.type === "video") this.references.add(asset.sourceId);
    for (const asset of assets) if (asset.type === "video") this.enqueue(asset, true);
    this.publish(); this.schedule();
  }
  private enqueue(asset: MediaAsset, retry = false) {
    const existing = this.jobs.get(asset.sourceId);
    if (existing && (!retry || existing.status !== "failed")) return;
    this.jobs.set(asset.sourceId, { sourceId: asset.sourceId, name: asset.name, status: "queued", attempts: 0, failures: 0 });
  }
  cancel = () => {
    clearTimeout(this.timer); this.timer = undefined;
    for (const job of this.jobs.values()) if (job.status === "queued" || job.status === "running") {
      job.status = "failed"; job.error = "Preview optimization cancelled. Original media is playing.";
    }
    this.current?.resources.abort(); this.publish();
  };
  dispose = () => {
    this.cancel(); this.references.clear();
    this.previews.forEach((lease, id) => {
      lease.release(); const source = this.store.get(id); if (source) this.store.dropDerived(id, proxyKey(source));
    });
    this.previews.clear(); this.jobs.clear(); this.publish();
  };
  private schedule() {
    if (this.current || this.timer || this.paused || ![...this.jobs.values()].some(job => job.status === "queued")) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.next(); }, this.idleMs);
  }
  private async next() {
    if (this.current || this.paused) return;
    const job = [...this.jobs.values()].find(job => job.status === "queued" && this.references.has(job.sourceId));
    if (!job) return;
    const source = this.store.get(job.sourceId);
    if (!source) { this.jobs.delete(job.sourceId); this.publish(); this.schedule(); return; }
    const resources = new ExportResources();
    this.current = { sourceId: job.sourceId, resources };
    let lease: SourceLease | undefined;
    job.status = "running"; job.attempts++; this.publish();
    const timeout = setTimeout(() => resources.abort(new Error("Preview optimization timed out.")), 45_000);
    try {
      lease = this.store.acquire(source.sourceId, "preview-optimization");
      const key = proxyKey(source);
      let derived = this.store.derivedFor(source.sourceId, key);
      if (!derived) derived = await this.run(source, key, resources);
      resources.signal.throwIfAborted();
      if (!this.references.has(source.sourceId)) return;
      const used = [...this.previews.keys()].reduce((sum, id) => {
        const original = this.store.get(id);
        return sum + (original ? this.store.derivedFor(id, proxyKey(original))?.bytes.size ?? 0 : 0);
      }, 0);
      const metadata = derived.metadata;
      if (derived.mimeType !== "video/mp4" || derived.bytes.type !== "video/mp4" || !derived.bytes.size || derived.key !== key || !metadata ||
        ![metadata.width, metadata.height, metadata.duration, metadata.fps].every(value => Number.isFinite(value) && value > 0) ||
        Math.max(metadata.width, metadata.height) > 720 || metadata.rotation !== 0 || metadata.hasAudio || metadata.fps > 30.01)
        throw new Error("Invalid preview cache entry.");
      if (used + derived.bytes.size > this.budget) throw new Error("Preview cache is full. Original media remains available.");
      // Publish a preview only after all work that produced it has closed.
      await resources.close();
      resources.signal.throwIfAborted();
      if (!this.references.has(source.sourceId)) return;
      this.store.attachDerived(source.sourceId, derived);
      this.previews.get(source.sourceId)?.release();
      this.previews.set(source.sourceId, this.store.acquireDerived(source.sourceId, key));
      job.status = "ready"; delete job.error;
    } catch (error) {
      this.previews.get(source.sourceId)?.release(); this.previews.delete(source.sourceId);
      this.store.dropDerived(source.sourceId, proxyKey(source));
      if (resources.signal.aborted && resources.signal.reason?.name === "AbortError") {
        if (job.status === "running") job.status = "queued";
      } else {
        job.failures++;
        job.status = job.failures < 2 ? "queued" : "failed";
        job.error = `${String(error)} Original media is playing.`;
      }
    } finally {
      clearTimeout(timeout);
      try { await resources.close(); }
      catch (error) { job.status = "failed"; job.error = `Preview cleanup failed: ${String(error)}`; }
      finally { lease?.release(); this.current = null; }
      this.publish(); this.schedule();
    }
  }
  async idle(timeoutMs = 60_000) {
    const started = Date.now();
    while (this.current || this.timer || this.state.some(job => job.status === "queued")) {
      if (Date.now() - started > timeoutMs) throw new Error("Preview optimization is still pending.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
