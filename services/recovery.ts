import { validateProjectMetadata, type ProjectSnapshot } from "./project";
import { sourceChecksum, type SourceAsset } from "./mediaSources";
import { normalizeProjectFilename } from "./projectNames";
export const RECOVERY_DATABASE = "clipbraid-local-projects";
const MAX_BYTES = 128 * 1024 * 1024;
interface Reference { sourceId: string; key: string; sha256: string; mimeType: string; byteLength: number }
export interface RecoveryUI { exportQuality: "draft" | "standard" | "high"; zoom: number; showSafeZones: boolean; isTheaterMode: boolean; projectFilename?: string }
export interface LocalRevision {
  revision: number; formatVersion: 1 | 2; savedAt: number; snapshot: ProjectSnapshot;
  references: Reference[]; ui: RecoveryUI;
}
interface StoredAsset { key: string; bytes: Blob; sha256: string; mimeType: string; byteLength: number }
export interface RecoveryData { record: LocalRevision; sources: (StoredAsset & { sourceId: string })[] }
const keyFor = (asset: Pick<SourceAsset, "sha256" | "mimeType">) => `${asset.sha256}:${asset.mimeType}`;

function validateUI(ui: RecoveryUI): RecoveryUI {
  if (!ui || !["draft", "standard", "high"].includes(ui.exportQuality) ||
    !Number.isFinite(ui.zoom) || ui.zoom < 16 || ui.zoom > 100 ||
    typeof ui.showSafeZones !== "boolean" || typeof ui.isTheaterMode !== "boolean")
    throw new Error("Invalid local editor settings.");
  if (ui.projectFilename !== undefined && normalizeProjectFilename(ui.projectFilename) !== ui.projectFilename)
    throw new Error("Invalid local project filename.");
  return { exportQuality: ui.exportQuality, zoom: ui.zoom, showSafeZones: ui.showSafeZones, isTheaterMode: ui.isTheaterMode,
    ...(ui.projectFilename ? { projectFilename: ui.projectFilename } : {}) };
}

/** One atomic head/revision/Blob commit; failed transactions preserve the old head. */
export class RecoveryStore {
  private opening: Promise<IDBDatabase> | null = null;
  private generation = 0;
  private expectedRevision: number | null = null;
  private transactions = new Set<IDBTransaction>();
  private abortReasons = new WeakMap<IDBTransaction, Error>();
  constructor(private name = RECOVERY_DATABASE, private version = 2) {}
  private database(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    const generation = this.generation;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => fail(new Error("Local storage did not open. Save a project file instead.")), 3000);
      let request: IDBOpenDBRequest;
      try { request = indexedDB.open(this.name, this.version); }
      catch (error) { fail(error); return; }
      request.onblocked = () => fail(new Error("Local storage is blocked by another tab. Close that tab or save a project file."));
      request.onerror = () => fail(request.error ?? new Error("Local storage is unavailable."));
      request.onupgradeneeded = () => {
        if (settled || generation !== this.generation) { request.transaction!.abort(); return; }
        try {
          for (const name of ["revisions", "assets", "meta"])
            if (!request.result.objectStoreNames.contains(name))
              request.result.createObjectStore(name, { keyPath: name === "revisions" ? "revision" : "key" });
          if (this.version >= 2) {
            const revisions = request.transaction!.objectStore("revisions");
            if (!revisions.indexNames.contains("savedAt")) revisions.createIndex("savedAt", "savedAt");
          }
        } catch (error) { request.transaction!.abort(); fail(error); }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled || generation !== this.generation) { db.close(); fail(new DOMException("Storage closed", "AbortError")); return; }
        settled = true; clearTimeout(timer);
        db.onversionchange = () => { db.close(); if (this.opening === pending) this.opening = null; };
        resolve(db);
      };
    });
    this.opening = pending;
    void pending.catch(() => { if (this.opening === pending) this.opening = null; });
    return pending;
  }
  private transaction<T>(db: IDBDatabase, mode: IDBTransactionMode,
    work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["revisions", "assets", "meta"], mode,
        mode === "readwrite" ? { durability: "strict" } : undefined);
      this.transactions.add(tx);
      let value: T;
      tx.oncomplete = () => { this.transactions.delete(tx); resolve(value); };
      tx.onabort = () => { this.transactions.delete(tx); reject(this.abortReasons.get(tx) ?? tx.error ?? new Error("Local draft write was aborted; the previous revision remains available.")); };
      tx.onerror = event => {
        const error = (event.target as IDBRequest)?.error;
        if (error && !this.abortReasons.has(tx)) this.abortReasons.set(tx, error);
      }; // Abort is the single rejection boundary.
      try { work(tx, result => { value = result; }); }
      catch (error) { try { tx.abort(); } catch {} this.transactions.delete(tx); reject(error); }
    });
  }
  private guarded(tx: IDBTransaction, work: () => void) {
    return () => {
      try { work(); }
      catch (cause) {
        this.abortReasons.set(tx, cause instanceof Error ? cause : new Error(String(cause)));
        try { tx.abort(); } catch {}
      }
    };
  }
  private conflict(tx: IDBTransaction) {
    this.abortReasons.set(tx, new Error("The local draft changed in another tab. Save a project file or reload before replacing that revision."));
    tx.abort();
  }
  async latest(): Promise<RecoveryData | null> {
    const generation = this.generation, db = await this.database();
    const data = await this.transaction<RecoveryData | null>(db, "readonly", (tx, result) => {
      const head = tx.objectStore("meta").get("head");
      head.onsuccess = this.guarded(tx, () => {
        if (!head.result) { result(null); return; }
        const revision = tx.objectStore("revisions").get(head.result.revision);
        revision.onsuccess = this.guarded(tx, () => {
          const record = revision.result as LocalRevision;
          if (!record || !Array.isArray(record.references)) { tx.abort(); return; }
          const sources: RecoveryData["sources"] = [];
          result({ record, sources });
          for (const reference of record.references) {
            const asset = tx.objectStore("assets").get(reference.key);
            asset.onsuccess = this.guarded(tx, () => { sources.push({ ...asset.result, sourceId: reference.sourceId }); });
          }
        });
      });
    });
    if (generation !== this.generation) throw new DOMException("Storage closed", "AbortError");
    if (!data) { this.expectedRevision = 0; return null; }
    if (![1, 2].includes(data.record.formatVersion) || !Number.isSafeInteger(data.record.revision) || data.record.revision < 1 ||
      !Number.isSafeInteger(data.record.savedAt) || data.record.savedAt < 0)
      throw new Error("This local draft version is unsupported.");
    data.record.snapshot = validateProjectMetadata(data.record.snapshot);
    data.record.ui = validateUI(data.record.ui);
    const references = new Map(data.record.references.map(reference => [reference.sourceId, reference]));
    const sizes = new Map<string, number>();
    for (const reference of data.record.references) {
      if (typeof reference.sourceId !== "string" || !reference.sourceId ||
        typeof reference.mimeType !== "string" || !reference.mimeType.trim() ||
        !/^[0-9a-f]{64}$/.test(reference.sha256) || reference.key !== keyFor(reference) ||
        !Number.isSafeInteger(reference.byteLength) || reference.byteLength <= 0 || reference.byteLength > MAX_BYTES)
        throw new Error("Invalid local source reference.");
      sizes.set(reference.key, reference.byteLength);
    }
    if (references.size !== data.record.references.length || [...sizes.values()].reduce((sum, size) => sum + size, 0) > MAX_BYTES)
      throw new Error("Local original inventory exceeds the supported limit.");
    for (const asset of data.sources) {
      const reference = references.get(asset.sourceId)!;
      if (!(asset.bytes instanceof Blob) || asset.bytes.size !== reference.byteLength || asset.byteLength !== reference.byteLength ||
        asset.sha256 !== reference.sha256 || asset.key !== reference.key || asset.mimeType !== reference.mimeType ||
        keyFor(asset) !== asset.key || await sourceChecksum(asset.bytes) !== reference.sha256)
        throw new Error("A local original is missing or damaged. Save the current project separately.");
    }
    for (const item of [...data.record.snapshot.mediaAssets, ...data.record.snapshot.audioTracks])
      if (!references.has(item.sourceId)) throw new Error("Local draft references missing media.");
    if (generation !== this.generation) throw new DOMException("Storage closed", "AbortError");
    this.expectedRevision = data.record.revision;
    return data;
  }
  async commit(snapshot: ProjectSnapshot, sources: SourceAsset[], ui: RecoveryUI): Promise<{ revision: number; bytes: number }> {
    const clean = validateProjectMetadata(snapshot), settings = validateUI(ui);
    if (this.expectedRevision === null) throw new Error("Local recovery has not been initialized.");
    const references = sources.map(source => ({ sourceId: source.sourceId, key: keyFor(source), sha256: source.sha256,
      mimeType: source.mimeType, byteLength: source.byteLength }));
    const byId = new Map(sources.map(source => [source.sourceId, source]));
    for (const item of [...clean.mediaAssets, ...clean.audioTracks]) if (!byId.has(item.sourceId)) throw new Error("Missing local original.");
    const unique = new Map(sources.map(source => [keyFor(source), source]));
    if (byId.size !== sources.length || sources.some(source => !(source.bytes instanceof Blob) || source.bytes.size !== source.byteLength || !/^[0-9a-f]{64}$/.test(source.sha256)))
      throw new Error("Invalid local original metadata.");
    if ([...unique.values()].reduce((sum, source) => sum + source.bytes.size, 0) > MAX_BYTES)
      throw new Error("Local draft exceeds 128 MiB. Download a project file to keep this work.");
    const generation = this.generation, expected = this.expectedRevision, db = await this.database();
    const result = await this.transaction<{ revision: number; bytes: number }>(db, "readwrite", (tx, done) => {
      const meta = tx.objectStore("meta"), revisions = tx.objectStore("revisions"), assets = tx.objectStore("assets");
      const head = meta.get("head");
      head.onsuccess = this.guarded(tx, () => {
        if ((head.result?.revision ?? 0) !== expected) { this.conflict(tx); return; }
        const revision = expected + 1;
        for (const [key, source] of unique) assets.put({ key, bytes: source.bytes, sha256: source.sha256,
          mimeType: source.mimeType, byteLength: source.byteLength });
        revisions.put({ revision, formatVersion: 2, savedAt: Date.now(), snapshot: clean, references, ui: settings });
        meta.put({ key: "head", revision });
        const all = revisions.getAll();
        all.onsuccess = this.guarded(tx, () => {
          let retained = (all.result as LocalRevision[]).sort((a, b) => b.revision - a.revision).slice(0, 2);
          const referenced = (values: LocalRevision[]) => new Map(values.flatMap(value => value.references.map(reference => [reference.key, reference.byteLength] as const)));
          if ([...referenced(retained).values()].reduce((sum, bytes) => sum + bytes, 0) > MAX_BYTES) retained = retained.slice(0, 1);
          const kept = new Set(retained.map(value => value.revision)), keys = referenced(retained);
          for (const value of all.result as LocalRevision[]) if (!kept.has(value.revision)) revisions.delete(value.revision);
          const oldKeys = assets.getAllKeys();
          oldKeys.onsuccess = this.guarded(tx, () => {
            for (const key of oldKeys.result) if (!keys.has(String(key))) assets.delete(key);
            done({ revision, bytes: [...keys.values()].reduce((sum, bytes) => sum + bytes, 0) });
          });
        });
      });
    });
    if (generation !== this.generation) throw new DOMException("Storage closed", "AbortError");
    this.expectedRevision = result.revision;
    return result;
  }
  async trim(protectedSources: SourceAsset[]): Promise<void> {
    const db = await this.database();
    await this.transaction<void>(db, "readwrite", (tx, done) => {
      const revisions = tx.objectStore("revisions"), assets = tx.objectStore("assets"), head = tx.objectStore("meta").get("head");
      head.onsuccess = this.guarded(tx, () => {
        if ((head.result?.revision ?? 0) !== this.expectedRevision) { this.conflict(tx); return; }
        const all = revisions.getAll();
        all.onsuccess = this.guarded(tx, () => {
          const keep = new Set(protectedSources.map(keyFor));
          for (const record of all.result as LocalRevision[]) {
            if (record.revision !== this.expectedRevision) revisions.delete(record.revision);
            else record.references.forEach(reference => keep.add(reference.key));
          }
          const keys = assets.getAllKeys();
          keys.onsuccess = this.guarded(tx, () => {
            keys.result.forEach(key => { if (!keep.has(String(key))) assets.delete(key); }); done();
          });
        });
      });
    });
  }
  async usage(): Promise<{ bytes: number; sources: number; revisions: number }> {
    const db = await this.database();
    return this.transaction(db, "readonly", (tx, done) => {
      const values = tx.objectStore("assets").getAll(), count = tx.objectStore("revisions").count();
      count.onsuccess = this.guarded(tx, () => done({ bytes: (values.result as StoredAsset[]).reduce((sum, asset) => sum + asset.byteLength, 0), sources: values.result.length, revisions: count.result }));
    });
  }
  close() {
    this.generation++;
    for (const tx of this.transactions) try { tx.abort(); } catch {}
    const pending = this.opening; this.opening = null;
    void pending?.then(db => db.close(), () => {});
  }
}
