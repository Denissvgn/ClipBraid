import { useCallback, useEffect, useRef, useState } from "react";
import { RecoveryStore, type RecoveryData, type RecoveryUI } from "../services/recovery";
import type { ProjectSnapshot } from "../services/project";
import type { MediaSourceStore, SourceAsset, SourceLease } from "../services/mediaSources";
interface Payload { snapshot: ProjectSnapshot; ui: RecoveryUI; sources: SourceAsset[]; leases: SourceLease[]; sequence: number; epoch: number }
export function useProjectRecovery(store: MediaSourceStore, snapshot: ProjectSnapshot, ui: RecoveryUI,
  isPlaying: boolean, onRestore: (data: RecoveryData) => Promise<boolean>) {
  const database = useRef<RecoveryStore | null>(null);
  if (!database.current) database.current = new RecoveryStore();
  const recovery = database.current;
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState<RecoveryData | null>(null);
  const [status, setStatus] = useState("loading");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [usage, setUsage] = useState({ bytes: 0, sources: 0, revisions: 0 });
  const [quota, setQuota] = useState<number | undefined>();
  const sequence = useRef(0), epoch = useRef(0), writing = useRef(false);
  const queued = useRef<Payload | null>(null);
  const committed = useRef<{ snapshot: ProjectSnapshot; ui: RecoveryUI } | null>(null);
  const release = (payload: Payload) => payload.leases.forEach(lease => lease.release());
  const report = (error: unknown) => {
    setStatus("error");
    setMessage(`${String(error)} Use Save project for a separate file. The last committed local revision was not replaced.`);
  };
  const refreshUsage = useCallback(async () => {
    const current = epoch.current;
    try {
      const value = await recovery.usage();
      if (epoch.current === current) setUsage(value);
      const estimate = await navigator.storage?.estimate?.();
      if (epoch.current === current) setQuota(estimate?.quota);
    } catch { /* Saving/recovery has its own error boundary; estimates are optional. */ }
  }, [recovery]);
  const initialize = useCallback(async () => {
    const current = epoch.current;
    setReady(false); setStatus("loading");
    try {
      const data = await recovery.latest();
      if (current !== epoch.current) return;
      setAvailable(data); setRevision(data?.record.revision ?? 0);
      setReady(!data); setStatus(data ? "choice" : "unsaved"); setMessage("");
      void refreshUsage();
    } catch (error) {
      if (current !== epoch.current) return;
      setStatus("unavailable"); setMessage(`Local autosave is unavailable: ${String(error)}. Save project downloads a separate file.`);
    }
  }, [recovery, refreshUsage]);
  useEffect(() => {
    void initialize();
    return () => {
      epoch.current++; recovery.close();
      if (queued.current) { release(queued.current); queued.current = null; }
    };
  }, [initialize, recovery]);
  const write = async (first: Payload) => {
    if (writing.current) {
      if (queued.current) release(queued.current);
      queued.current = first; return;
    }
    writing.current = true;
    let payload: Payload | null = first;
    while (payload) {
      const active = payload;
      if (active.epoch !== epoch.current) { release(active); break; }
      setStatus("saving");
      try {
        const result = await recovery.commit(active.snapshot, active.sources, active.ui);
        if (active.epoch === epoch.current) {
          committed.current = { snapshot: active.snapshot, ui: active.ui };
          setRevision(result.revision);
          if (active.sequence === sequence.current) { setStatus("saved"); setMessage(""); }
          else setStatus("unsaved");
          void refreshUsage();
        }
      } catch (error) {
        if (active.epoch === epoch.current && active.sequence === sequence.current) report(error);
      } finally { release(active); }
      payload = queued.current; queued.current = null;
    }
    writing.current = false;
  };
  useEffect(() => {
    if (!ready || available || isPlaying) return;
    const current = ++sequence.current;
    setStatus("unsaved");
    const timer = setTimeout(() => {
      const leases: SourceLease[] = [];
      try {
        const ids = new Set([...snapshot.mediaAssets, ...snapshot.audioTracks].map(item => item.sourceId));
        leases.push(...store.acquireAll(ids, "local-autosave"));
        const sources = [...ids].map(id => {
          const source = store.get(id); if (!source) throw new Error("Missing local original."); return source;
        });
        void write({ snapshot, ui, sources, leases, sequence: current, epoch: epoch.current });
      } catch (error) { leases.forEach(lease => lease.release()); report(error); }
    }, 750);
    return () => clearTimeout(timer);
  }, [ready, available, isPlaying, snapshot, ui, store]);
  const restore = async () => {
    if (!available) return;
    setStatus("restoring");
    if (await onRestore(available)) {
      setAvailable(null); setReady(true); setStatus("unsaved"); setMessage("");
    } else { setStatus("error"); setMessage("Could not restore the local draft. The current project is unchanged."); }
  };
  const continueCurrent = () => { setAvailable(null); setReady(true); setStatus("unsaved"); setMessage(""); };
  const cleanOlder = async () => {
    if (writing.current) return;
    const sources = [...new Set([...snapshot.mediaAssets, ...snapshot.audioTracks].map(item => item.sourceId))]
      .map(id => store.get(id)).filter((source): source is SourceAsset => !!source);
    try { await recovery.trim(sources); await refreshUsage(); }
    catch (error) { report(error); }
  };
  const visibleStatus = status === "saved" && (committed.current?.snapshot !== snapshot || committed.current?.ui !== ui) ? "unsaved" : status;
  return { status: visibleStatus, message, revision, usage, quota, available, restore, continueCurrent, cleanOlder, retry: initialize };
}
