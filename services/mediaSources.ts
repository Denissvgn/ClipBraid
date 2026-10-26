/**
 * Explicit media ownership (D02).
 *
 * A source asset is the immutable original bytes of one imported or restored
 * file. Timeline clips and soundtrack entries are *instances* that reference a
 * source by `sourceId` and keep their own edit state (trims, placement,
 * filters, mute), so repeated use of one source never couples two clips'
 * edits. Optional derived media (proxies, future renders) hang off a source
 * under a settings key and are dropped with it; originals stay authoritative.
 *
 * Every runtime source/derived-media URL is created and revoked through this
 * module. Consumers hold explicit references — `acquire` leases for running
 * jobs and `syncPins` for the live project — and a URL is revoked only when
 * its last reference is gone. Deleting or replacing a project therefore can
 * never revoke media that an active job still needs. Bytes are kept as Blob
 * handles; base64 exists only at serialization/transport boundaries.
 */

export interface SourceAsset {
  sourceId: string;
  /** Never rewritten in place; a changed rendition gets a new revision. */
  revision: number;
  mimeType: string;
  byteLength: number;
  /** SHA-256 of the original bytes; identity and preservation evidence. */
  sha256: string;
  bytes: Blob;
}

export interface SourceLease {
  readonly sourceId: string;
  readonly url: string;
  /** Idempotent; drops one reference held by the acquiring job. */
  release(): void;
}

/**
 * A unit of staging work (D04): imports and project loads stage bytes, probe
 * them and only then publish them to the live project. `commit` hands the
 * transaction's pins to the live project; `rollback` releases exactly the
 * references the transaction added and disposes exactly the sources it staged,
 * so a failure never revokes or leaks media owned by the previous project or
 * by a running job. Rollback is idempotent and never throws; a transaction
 * cannot be reused after either settlement.
 */
export interface SourceTransaction {
  stage(items: { bytes: Blob; mimeType: string }[]): Promise<SourceAsset[]>;
  /** Transaction-scoped probe lease; released on commit and on rollback. */
  acquire(sourceId: string, purpose?: string): SourceLease;
  /** Pre-pin before the state commit; already live-pinned sources are left alone. */
  pin(sourceId: string): void;
  commit(): void;
  rollback(): void;
}

export interface DerivedMedia {
  /** Cache key, e.g. `proxy:720p:30`; combined with the source revision. */
  key: string;
  mimeType: string;
  bytes: Blob;
  metadata?: { width: number; height: number; duration: number; fps: number; rotation: number; hasAudio: boolean };
}
interface DerivedEntry { media: DerivedMedia; url: string | null; refs: number }

export interface UrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

interface Entry {
  asset: SourceAsset;
  url: string | null;
  refs: number;
  disposed: boolean;
  derived: Map<string, DerivedEntry>;
}

const defaultUrlApi: UrlApi = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};
export class MediaSourceStore {
  private entries = new Map<string, Entry>();
  private pinned = new Set<string>();
  private counter = 0;
  private generation = 0;
  private readonly urlApi: UrlApi;

  constructor(urlApi: UrlApi = defaultUrlApi) {
    this.urlApi = urlApi;
  }

  /**
   * Stage immutable originals before anything references them. Identical
   * bytes staged in one batch share one source so repeated clips in a project
   * do not duplicate runtime bytes or URLs. A failure disposes the whole
   * batch; nothing becomes visible half-staged.
   */
  async stage(
    items: { bytes: Blob; mimeType: string }[],
  ): Promise<SourceAsset[]> {
    const generation = this.generation;
    const stagedIds: string[] = [];
    const byChecksum = new Map<string, SourceAsset>();
    try {
      const out: SourceAsset[] = [];
      for (const item of items) {
        if (!item.bytes || item.bytes.size === 0)
          throw new Error("Empty media data.");
        const sha256 = await sourceChecksum(item.bytes);
        if (generation !== this.generation) throw new Error("Media store changed during staging.");
        const shared = byChecksum.get(sha256);
        if (shared) {
          out.push(shared);
          continue;
        }
        const sourceId = `src-${++this.counter}`;
        const asset: SourceAsset = Object.freeze({
          sourceId,
          revision: 1,
          mimeType: item.mimeType,
          byteLength: item.bytes.size,
          sha256,
          bytes: item.bytes,
        });
        this.entries.set(sourceId, {
          asset,
          url: null,
          refs: 0,
          disposed: false,
          derived: new Map(),
        });
        stagedIds.push(sourceId);
        byChecksum.set(sha256, asset);
        out.push(asset);
      }
      return out;
    } catch (error) {
      for (const sourceId of stagedIds) this.remove(sourceId);
      throw error;
    }
  }

  get(sourceId: string): SourceAsset | undefined {
    return this.entries.get(sourceId)?.asset;
  }

  bytesFor(sourceId: string): Blob | undefined {
    return this.get(sourceId)?.bytes;
  }

  /**
   * Acquire a job lease. The source URL is created on the first reference and
   * survives `syncPins`, `remove` and `clear` while any lease is open.
   */
  acquire(sourceId: string, purpose = "job"): SourceLease {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.disposed)
      throw new Error(`Unknown media source: ${sourceId}`);
    this.retain(entry);
    let released = false;
    return {
      sourceId,
      url: entry.url!,
      release: () => {
        if (released) return;
        released = true;
        this.release(entry, purpose);
      },
    };
  }
  /** Acquire one lease per unique source for a multi-source job. */
  acquireAll(sourceIds: Iterable<string>, purpose = "job"): SourceLease[] {
    const leases: SourceLease[] = [];
    try {
      for (const sourceId of new Set(sourceIds))
        leases.push(this.acquire(sourceId, purpose));
      return leases;
    } catch (error) {
      for (const lease of leases) lease.release();
      throw error;
    }
  }

  /**
   * Begin an atomic staging unit. Sources are still staged without URLs; the
   * transaction only tracks which sources, pins and probe leases belong to it
   * so settlement can release exactly those, in either direction.
   */
  beginTransaction(): SourceTransaction {
    const staged = new Set<string>();
    const pins = new Set<string>();
    const leases = new Set<SourceLease>();
    let settled = false;
    const releaseLeases = () => {
      for (const lease of leases) lease.release();
      leases.clear();
    };
    return {
      stage: async (items) => {
        if (settled) throw new Error("Source transaction already settled.");
        const assets = await this.stage(items);
        if (settled) {
          for (const asset of assets) if (!this.pinned.has(asset.sourceId)) this.remove(asset.sourceId);
          throw new Error("Source transaction already settled.");
        }
        for (const asset of assets) staged.add(asset.sourceId);
        return assets;
      },
      acquire: (sourceId, purpose = "transaction-probe") => {
        if (settled) throw new Error("Source transaction already settled.");
        const lease = this.acquire(sourceId, purpose);
        leases.add(lease);
        return {
          sourceId: lease.sourceId,
          url: lease.url,
          release: () => {
            leases.delete(lease);
            lease.release();
          },
        };
      },
      pin: (sourceId) => {
        if (settled) throw new Error("Source transaction already settled.");
        // A source the live project already pins is not this transaction's
        // reference: rollback must not drop it, and re-pinning must not add a
        // reference the pin set cannot release.
        if (this.pinned.has(sourceId)) return;
        this.pin(sourceId);
        pins.add(sourceId);
      },
      commit: () => {
        if (settled) throw new Error("Source transaction already settled.");
        settled = true;
        releaseLeases();
        staged.clear();
        pins.clear();
      },
      rollback: () => {
        if (settled) return; // committed work is never rolled back
        settled = true;
        releaseLeases();
        for (const sourceId of pins) {
          if (!this.pinned.delete(sourceId)) continue;
          const entry = this.entries.get(sourceId);
          if (entry) this.release(entry, "transaction-rollback");
        }
        pins.clear();
        for (const sourceId of staged) {
          const entry = this.entries.get(sourceId);
          // Someone else adopted the source: leave its lifecycle to them.
          if (!entry || this.pinned.has(sourceId)) continue;
          this.remove(sourceId);
        }
        staged.clear();
      },
    };
  }

  /** Reference a source on behalf of the live project before commit. */
  pin(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.disposed)
      throw new Error(`Unknown media source: ${sourceId}`);
    // The live project is a *set* of pins: re-pinning adds no reference, so a
    // later syncPins/remove releases exactly one.
    if (this.pinned.has(sourceId)) return;
    this.retain(entry);
    this.pinned.add(sourceId);
  }

  /**
   * Make the pinned set exactly `sourceIds`. New sources are retained before
   * old ones are released so a swap can never drop a URL early. Sources the
   * project no longer references are retired: their URL and bytes are freed
   * with the last reference, which defers to any open job lease.
   */
  syncPins(sourceIds: Iterable<string>): void {
    const target = new Set(sourceIds);
    const acquired: string[] = [];
    try {
      for (const sourceId of target) if (!this.pinned.has(sourceId)) {
        this.pin(sourceId); acquired.push(sourceId);
      }
    } catch (error) {
      for (const sourceId of acquired) {
        this.pinned.delete(sourceId);
        this.release(this.entries.get(sourceId)!, "failed-pin-sync");
      }
      throw error;
    }
    for (const sourceId of [...this.pinned])
      if (!target.has(sourceId)) {
        this.pinned.delete(sourceId);
        const entry = this.entries.get(sourceId);
        if (!entry) continue;
        entry.disposed = true;
        this.release(entry, "pin");
      }
  }

  /**
   * Dispose a source (staging rollback or explicit deletion). The pinned
   * reference is dropped; open leases keep the bytes until their release.
   */
  remove(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (!entry) return;
    const wasPinned = this.pinned.delete(sourceId);
    entry.disposed = true;
    if (wasPinned) this.release(entry, "pin");
    else if (entry.refs === 0) this.purge(entry);
  }

  /** Dispose everything (project teardown); open leases still defer purge. */
  clear(): void {
    this.generation++;
    for (const sourceId of [...this.entries.keys()]) this.remove(sourceId);
    this.pinned.clear();
  }

  urlFor(sourceId: string): string | undefined {
    return this.entries.get(sourceId)?.url ?? undefined;
  }



  /** Optional derived renditions; dropped with their source, never authoritative. */
  attachDerived(sourceId: string, derived: DerivedMedia): void {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.disposed)
      throw new Error(`Unknown media source: ${sourceId}`);
    this.dropDerived(sourceId, derived.key);
    entry.derived.set(derived.key, { media: Object.freeze({ ...derived }), url: null, refs: 0 });
  }

  derivedFor(sourceId: string, key: string): DerivedMedia | undefined {
    return this.entries.get(sourceId)?.derived.get(key)?.media;
  }

  acquireDerived(sourceId: string, key: string): SourceLease {
    const entry = this.entries.get(sourceId);
    const derived = entry?.derived.get(key);
    if (!entry || entry.disposed || !derived) throw new Error("Unknown derived media.");
    this.retain(entry);
    try {
      if (!derived.url) derived.url = this.urlApi.createObjectURL(derived.media.bytes);
      derived.refs++;
    } catch (error) { this.release(entry, "failed-derived-url"); throw error; }
    let released = false;
    return { sourceId, url: derived.url, release: () => {
      if (released) return;
      released = true; derived.refs--;
      if (!derived.refs && derived.url) {
        this.urlApi.revokeObjectURL(derived.url); derived.url = null;
      }
      this.release(entry, "derived");
    } };
  }

  dropDerived(sourceId: string, key?: string): void {
    const entry = this.entries.get(sourceId);
    if (!entry) return;
    for (const [id, derived] of entry.derived) {
      if (key !== undefined && key !== id) continue;
      entry.derived.delete(id);
      if (!derived.refs && derived.url) this.urlApi.revokeObjectURL(derived.url);
    }
  }

  /** Deterministic observability for tests and diagnostics. */
  snapshot() {
    return {
      sources: [...this.entries.values()].map((entry) => ({
        sourceId: entry.asset.sourceId,
        revision: entry.asset.revision,
        mimeType: entry.asset.mimeType,
        byteLength: entry.asset.byteLength,
        sha256: entry.asset.sha256,
        refs: entry.refs,
        disposed: entry.disposed,
        hasUrl: entry.url !== null,
        derived: [...entry.derived.keys()],
      })),
      pinned: [...this.pinned].sort(),
    };
  }

  private retain(entry: Entry): void {
    if (entry.url === null)
      entry.url = this.urlApi.createObjectURL(entry.asset.bytes);
    entry.refs += 1;
  }

  private release(entry: Entry, _purpose: string): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (entry.url !== null) {
      this.urlApi.revokeObjectURL(entry.url);
      entry.url = null;
    }
    if (entry.disposed) this.purge(entry);
  }

  private purge(entry: Entry): void {
    if (entry.url !== null) {
      this.urlApi.revokeObjectURL(entry.url);
      entry.url = null;
    }
    for (const derived of entry.derived.values())
      if (derived.url) this.urlApi.revokeObjectURL(derived.url);
    entry.derived.clear();
    this.entries.delete(entry.asset.sourceId);
    this.pinned.delete(entry.asset.sourceId);
  }
}

export async function sourceChecksum(bytes: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await bytes.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
