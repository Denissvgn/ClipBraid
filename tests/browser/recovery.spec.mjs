import { test, expect } from "./harness.mjs";
import { asset, draft, openProbe } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";

const savedLocally = page => expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
async function inspectLocal(probe) {
  return probe.evaluate(async () => {
    const store = new window.testRuntime.RecoveryStore();
    try { const data = await store.latest(); return { record: data?.record,
      hashes: data?.sources.map(source => source.sha256), usage: await store.usage() }; }
    finally { store.close(); }
  });
}

test("acknowledged local revisions restore edits, settings and original hashes after forced reload", async ({ page, context }) => {
  await openEditor(page);
  const source = await asset("bars-fractional-av.mp4", { duration: 0.5, trimStart: 0.1, trimEnd: 0.4 });
  await loadDraft(page, { ...draft([source]), currentTime: 0.3, fitMode: "cover", aspectRatio: "1:1" });
  await page.getByRole("button", { name: "draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true }).click();
  await page.getByLabel("Look", { exact: true }).selectOption("warm");
  await page.getByRole("button", { name: "Close clip settings" }).click();
  await savedLocally(page);
  const before = await saveDraft(page), probe = await openProbe(context), persisted = await inspectLocal(probe);
  expect(persisted.record.snapshot.mediaAssets[0]).toMatchObject({ filter: "warm", trimStart: 0.1, duration: 0.5 });
  expect(persisted.usage.sources).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "Start editing" }).click();
  await page.getByRole("button", { name: "Restore local revision", exact: true }).click();
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
  const restored = await saveDraft(page);
  expect(restored).toEqual(before);
  await expect(page.getByRole("button", { name: "draft", exact: true })).toHaveAttribute("aria-pressed", "true");
  await savedLocally(page);
  expect((await inspectLocal(probe)).hashes).toEqual(persisted.hashes);
});

test("quota failure leaves the previous revision recoverable and cleanup retains current originals", async ({ page, context }) => {
  await page.addInitScript(() => {
    window.failLocalQuota = false;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failLocalQuota && this.name === "revisions") throw new DOMException("Injected exhausted quota", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await savedLocally(page);
  const probe = await openProbe(context), before = await inspectLocal(probe);
  await page.evaluate(() => { window.failLocalQuota = true; });
  await page.getByRole("button", { name: "Edit landscape-red.png", exact: true }).click();
  await page.getByLabel("Look", { exact: true }).selectOption("grayscale");
  // Stage a new Blob before the injected failure; the native transaction must roll it back.
  await page.locator('input[accept="audio/*"]').setInputFiles("tests/fixtures/tone-impulses.wav");
  await expect(page.locator('[data-autosave-status="error"]')).toBeVisible();
  const failed = await inspectLocal(probe);
  expect(failed.record.revision).toBe(before.record.revision);
  expect(failed.record.snapshot).toEqual(before.record.snapshot);
  expect(failed.usage.sources).toBe(before.usage.sources);
  expect((await saveDraft(page)).mediaAssets[0].filter).toBe("grayscale");
  await page.evaluate(() => { window.failLocalQuota = false; });
  await page.getByLabel("Look", { exact: true }).selectOption("sepia");
  await page.getByRole("button", { name: "Close clip settings" }).click();
  await savedLocally(page);
  await page.getByRole("button", { name: "Remove older local revisions", exact: true }).click();
  await expect.poll(async () => (await inspectLocal(probe)).usage.revisions).toBe(1);
  const after = await inspectLocal(probe);
  expect(after.hashes).toEqual(expect.arrayContaining(before.hashes));
  expect(after.usage.sources).toBe(2);
  expect(after.record.snapshot.mediaAssets[0].filter).toBe("sepia");
});

test("unavailable persistence is visible and preserves manual project saving", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Private storage blocked", "SecurityError"); } }));
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await expect(page.locator('[data-autosave-status="unavailable"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry local storage", exact: true })).toBeVisible();
  expect((await saveDraft(page)).mediaAssets).toHaveLength(1);
});

test("an unacknowledged project download stays failed and keeps a recoverable local revision", async ({ page }) => {
  await page.addInitScript(() => { window.Flow = { download: async () => false }; });
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await savedLocally(page);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.locator('[data-editor-status="SAVE ERROR"]')).toBeVisible();
  await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
});

test("schema upgrade abort rolls back and concurrent writers cannot overwrite a committed head", async ({ context }) => {
  const page = await openProbe(context);
  const result = await page.evaluate(async () => {
    const { RecoveryStore } = window.testRuntime;
    const name = `recovery-upgrade-${crypto.randomUUID()}`;
    const first = new RecoveryStore(name, 1);
    const snapshot = { mediaAssets: [], audioTracks: [], aspectRatio: "16:9", fitMode: "contain", transitionDuration: 0.5, currentTime: 0 };
    const ui = { exportQuality: "draft", zoom: 40, showSafeZones: false, isTheaterMode: false };
    await first.latest(); await first.commit(snapshot, [], ui); first.close();
    // Preserve a real format-1 record while exercising the storage schema upgrade.
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction("revisions", "readwrite"), store = tx.objectStore("revisions"), read = store.get(1);
        read.onsuccess = () => store.put({ ...read.result, formatVersion: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    const create = IDBObjectStore.prototype.createIndex;
    IDBObjectStore.prototype.createIndex = function () { throw new Error("injected schema migration fault"); };
    const upgrading = new RecoveryStore(name, 2);
    let migration;
    try { await upgrading.latest(); } catch (error) { migration = String(error); }
    finally { upgrading.close(); IDBObjectStore.prototype.createIndex = create; }
    const old = new RecoveryStore(name, 1);
    const previous = await old.latest(); old.close();
    const a = new RecoveryStore(name, 2), b = new RecoveryStore(name, 2);
    await a.latest(); await b.latest();
    await a.commit({ ...snapshot, currentTime: 0.5 }, [], ui);
    let conflict;
    try { await b.commit({ ...snapshot, currentTime: 0.8 }, [], ui); } catch (error) { conflict = String(error); }
    const committed = await a.latest(); a.close(); b.close();
    return { migration, previous: previous.record.revision, previousFormat: previous.record.formatVersion,
      currentFormat: committed.record.formatVersion, conflict, playhead: committed.record.snapshot.currentTime };
  });
  expect(result.migration).toContain("injected schema migration fault");
  expect(result.previous).toBe(1);
  expect(result.previousFormat).toBe(1); expect(result.currentFormat).toBe(2);
  expect(result.conflict).toContain("another tab");
  expect(result.playhead).toBe(0.5);
});
