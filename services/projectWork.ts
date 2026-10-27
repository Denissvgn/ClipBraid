import type { MediaSourceStore, SourceTransaction } from "./mediaSources";

export interface ProjectWorkUnit {
  tx: SourceTransaction;
  signal: AbortSignal;
  isCurrent(): boolean;
  check(): void;
  commit(): void;
  cancel(reason?: unknown): void;
  finish(): void;
}
interface PendingWork {
  revision: number; load: number | null; tx: SourceTransaction; controller: AbortController;
  finished: boolean; committed: boolean; done: Promise<void>; resolve(): void;
}
/** Latest load wins; edits/probes belong to the workspace in which they started.
 * Export/save leases are intentionally independent of these staging operations. */
export class ProjectWork {
  private revision = 0;
  private load = 0;
  private pending = new Set<PendingWork>();
  constructor(private store: Pick<MediaSourceStore, "beginTransaction">) {}
  private cancel(work: PendingWork, reason: unknown = new DOMException("Project changed", "AbortError")) {
    if (work.finished || work.controller.signal.aborted) return;
    work.controller.abort(reason);
    work.tx.rollback();
  }
  beginLoad = () => this.begin(true);
  beginEdit = () => this.begin(false);
  private begin(load: boolean): ProjectWorkUnit {
    if (load) {
      this.load++;
      for (const work of this.pending) if (work.load !== null) this.cancel(work);
    }
    let resolve!: () => void;
    const work: PendingWork = { revision: this.revision, load: load ? this.load : null, tx: this.store.beginTransaction(),
      controller: new AbortController(), finished: false, committed: false, done: new Promise(done => { resolve = done; }), resolve: () => resolve() };
    const isCurrent = () => !work.finished && work.revision === this.revision && (work.load === null || work.load === this.load);
    const check = () => {
      work.controller.signal.throwIfAborted();
      if (!isCurrent()) throw new DOMException("Project changed", "AbortError");
    };
    this.pending.add(work);
    return { tx: work.tx, signal: work.controller.signal, isCurrent, check,
      cancel: reason => this.cancel(work, reason),
      commit: () => {
        check(); if (work.committed) throw new Error("Project work already committed.");
        work.tx.commit(); work.committed = true;
        if (load) {
          work.revision = ++this.revision;
          for (const other of this.pending) if (other !== work) this.cancel(other);
        }
      },
      finish: () => {
        if (work.finished) return;
        work.tx.rollback(); work.finished = true; this.pending.delete(work); work.resolve();
      } };
  }
  invalidate = () => {
    this.revision++; this.load++;
    for (const work of this.pending) this.cancel(work);
  };
  get busy() { return [...this.pending].some(work => !work.finished && !work.committed && !work.controller.signal.aborted); }
  idle = async () => { while (this.pending.size) await Promise.allSettled([...this.pending].map(work => work.done)); };
}
