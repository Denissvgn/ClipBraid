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

test("keeping the current project cancels an in-flight local restore", async ({ page }) => {
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await savedLocally(page);
  await page.reload(); await page.getByRole("button", { name: "Start editing" }).click();
  await expect(page.getByRole("button", { name: "Restore local revision", exact: true })).toBeVisible();
  await loadDraft(page, draft([await asset("portrait-blue.png")]));
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let blocked = false;
    crypto.subtle.digest = async (...args) => {
      if (!blocked) {
        blocked = true; window.restoreDigestBlocked = true;
        await new Promise(resolve => { window.releaseRestoreDigest = resolve; });
      }
      return digest(...args);
    };
  });
  await page.getByRole("button", { name: "Restore local revision", exact: true }).click();
  await page.waitForFunction(() => window.restoreDigestBlocked);
  await page.getByRole("button", { name: "Keep current project", exact: true }).click();
  await page.evaluate(() => window.releaseRestoreDigest());
  await expect(page.getByRole("button", { name: "Edit landscape-red.png", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit portrait-blue.png", exact: true })).toBeVisible();
  await savedLocally(page);
  expect((await saveDraft(page)).mediaAssets[0].name).toBe("portrait-blue.png");
  await expect(page.locator('[data-editor-status="LOAD ERROR"]')).toHaveCount(0);
});

test("a rejected local restore stays recoverable without an unhandled rejection", async ({ context }) => {
  const page = await openProbe(context);
  await page.evaluate(async () => {
    const runtime = window.testRuntime;
    const snapshot = { mediaAssets: [], audioTracks: [], aspectRatio: "16:9", fitMode: "contain", transitionDuration: 0.5, currentTime: 0 };
    const ui = { exportQuality: "draft", zoom: 40, showSafeZones: false, isTheaterMode: false };
    const persisted = new runtime.RecoveryStore();
    await persisted.latest(); await persisted.commit(snapshot, [], ui); persisted.close();
    const store = new runtime.MediaSourceStore(), host = document.createElement("div"); document.body.append(host);
    window.recoveryRoot = runtime.createRoot(host);
    function RecoveryView() {
      window.recoveryHook = runtime.useProjectRecovery(store, snapshot, ui, false, async () => { throw new Error("injected restore failure"); });
      return null;
    }
    window.recoveryRoot.render(runtime.React.createElement(RecoveryView));
  });
  try {
    await page.waitForFunction(() => window.recoveryHook?.status === "choice");
    const rejection = await page.evaluate(() => window.recoveryHook.restore().then(() => null, error => String(error)));
    expect(rejection).toBeNull();
    await expect.poll(() => page.evaluate(() => window.recoveryHook.status)).toBe("error");
    expect(await page.evaluate(() => !!window.recoveryHook.available)).toBe(true);
  } finally { await page.evaluate(() => window.recoveryRoot.unmount()); }
});

test("re-reading local recovery ignores an older autosave acknowledgement", async ({ context }) => {
  const page = await openProbe(context);
  await page.evaluate(async () => {
    const runtime = window.testRuntime;
    const snapshot = { mediaAssets: [], audioTracks: [], aspectRatio: "16:9", fitMode: "cover", transitionDuration: 0.5, currentTime: 0 };
    const ui = { exportQuality: "draft", zoom: 40, showSafeZones: false, isTheaterMode: false };
    const persisted = new runtime.RecoveryStore();
    await persisted.latest(); await persisted.commit({ ...snapshot, fitMode: "contain" }, [], ui); persisted.close();
    const commit = runtime.RecoveryStore.prototype.commit;
    window.originalRecoveryCommit = commit;
    let hold = true;
    runtime.RecoveryStore.prototype.commit = async function (...args) {
      const result = await commit.apply(this, args);
      if (hold) {
        hold = false;
        await new Promise(resolve => { window.releaseOldAutosave = resolve; });
        window.oldAutosaveReturned = true;
      }
      return result;
    };
    const store = new runtime.MediaSourceStore(), host = document.createElement("div"); document.body.append(host);
    window.recoveryRoot = runtime.createRoot(host);
    window.recoveryTestSnapshot = snapshot; window.recoveryTestUI = ui;
    function RecoveryView() {
      window.recoveryHook = runtime.useProjectRecovery(store, snapshot, ui, false, async () => false);
      return null;
    }
    window.recoveryRoot.render(runtime.React.createElement(RecoveryView));
  });
  try {
    await page.waitForFunction(() => window.recoveryHook?.status === "choice");
    await page.evaluate(() => window.recoveryHook.continueCurrent());
    await page.waitForFunction(() => !!window.releaseOldAutosave);
    await page.evaluate(async () => {
      const writer = new window.testRuntime.RecoveryStore();
      try {
        await writer.latest();
        await window.originalRecoveryCommit.call(writer, { ...window.recoveryTestSnapshot, aspectRatio: "1:1" }, [], window.recoveryTestUI);
      } finally { writer.close(); }
      await window.recoveryHook.retry();
    });
    await page.waitForFunction(() => window.recoveryHook.status === "choice" && window.recoveryHook.revision === 3);
    await page.evaluate(async () => {
      window.releaseOldAutosave();
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(await page.evaluate(() => ({ status: window.recoveryHook.status, revision: window.recoveryHook.revision }))).toEqual({ status: "choice", revision: 3 });
  } finally {
    await page.evaluate(() => {
      window.releaseOldAutosave?.(); window.recoveryRoot.unmount();
      window.testRuntime.RecoveryStore.prototype.commit = window.originalRecoveryCommit;
    });
  }
});
