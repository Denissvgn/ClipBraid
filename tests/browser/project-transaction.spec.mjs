import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
import { asset, draft } from "./fixtures.mjs";

const uploadDraft = (page, value) =>
  page.locator('input[accept=".json"]').setInputFiles({
    name: "transaction.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });

const ledger = (page) =>
  page.evaluate(() => ({
    created: [...window.__d04.created],
    revoked: [...window.__d04.revoked],
  }));

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function installMediaFaults(page) {
  await page.addInitScript(() => {
    const state = {
      created: [],
      revoked: [],
      digestsUntilFailure: 0,
      failFileRead: false,
      failAudioProbe: false,
      audioProbePatched: false,
    };
    window.__d04 = state;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      // Ignore project-download URLs: this ledger covers source media only.
      if (/^(image|video|audio)\//.test(blob.type)) state.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (state.created.includes(url)) state.revoked.push(url);
      return revoke(url);
    };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => {
      if (state.digestsUntilFailure > 0) {
        state.digestsUntilFailure -= 1;
        if (state.digestsUntilFailure === 0)
          return Promise.reject(new Error("injected staging digest failure"));
      }
      return digest(...args);
    };
    const text = Blob.prototype.text;
    Blob.prototype.text = function (...args) {
      if (state.failFileRead) {
        state.failFileRead = false;
        return Promise.reject(new Error("injected project file read failure"));
      }
      return text.apply(this, args);
    };
    const src = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "src",
    );
    if (src?.get && src?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        enumerable: src.enumerable,
        get() {
          return src.get.call(this);
        },
        set(value) {
          if (
            state.failAudioProbe &&
            this.localName === "audio" &&
            !this.isConnected
          ) {
            state.failAudioProbe = false;
            setTimeout(() => this.dispatchEvent(new Event("error")), 0);
            return;
          }
          src.set.call(this, value);
        },
      });
      state.audioProbePatched = true;
    }
  });
}

test("injected project read and staging failures preserve the live project", async ({
  page,
}, info) => {
  await installMediaFaults(page);
  await openEditor(page);
  const original = await asset("bars-fractional-av.mp4", {
    id: "clip-a",
    duration: 0.5,
  });
  const replacement = draft([
    await asset("landscape-red.png", { id: "photo-b", duration: 2 }),
    await asset("bars-fractional-av.mp4", {
      id: "clip-b",
      startTime: 2,
      duration: 0.5,
    }),
  ]);
  await loadDraft(page, draft([original]));
  const oldUrl = await page.locator("video").first().getAttribute("src");
  const beforeProject = await saveDraft(page);
  const before = await ledger(page);

  // A host file read can fail before parsing or transaction creation. It still
  // needs the same visible failure, input reset and live-project preservation.
  await page.evaluate(() => {
    window.__d04.failFileRead = true;
  });
  await uploadDraft(page, replacement);
  await expect(page.locator('[data-editor-status="LOAD ERROR"]')).toBeVisible();
  const readFailed = await ledger(page);
  expect(readFailed).toEqual(before);
  expect(
    await page.evaluate(async (url) => (await fetch(url)).ok, oldUrl),
  ).toBe(true);
  expect(await saveDraft(page)).toEqual(beforeProject);

  // The first replacement source stages successfully; the second read fails.
  await page.evaluate(() => {
    window.__d04.digestsUntilFailure = 2;
  });
  await uploadDraft(page, replacement);
  await expect(page.locator('[data-editor-status="LOAD ERROR"]')).toBeVisible();
  const failed = await ledger(page);
  expect(failed).toEqual(before);
  expect(
    await page.evaluate(async (url) => (await fetch(url)).ok, oldUrl),
  ).toBe(true);
  expect(await saveDraft(page)).toEqual(beforeProject);

  // A retry is not blocked by the failed transaction. The old source is
  // released only after the replacement commits, and both new URLs stay live.
  await uploadDraft(page, replacement);
  await expect(
    page.getByRole("button", { name: "Edit landscape-red.png", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((url) => window.__d04.revoked.includes(url), oldUrl))
    .toBe(true);
  const committed = await ledger(page);
  const live = committed.created.filter((url) => !committed.revoked.includes(url));
  expect(live).toHaveLength(2);
  expect(committed.revoked.filter((url) => url === oldUrl)).toHaveLength(1);
  expect(
    await page.evaluate(async (url) => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    }, oldUrl),
  ).toBe(false);
  expect(
    await page.evaluate(
      async (urls) => Promise.all(urls.map(async (url) => (await fetch(url)).ok)),
      live,
    ),
  ).toEqual([true, true]);
  const current = await saveDraft(page);
  expect(current.mediaAssets.map((clip) => clip.id)).toEqual([
    "photo-b",
    "clip-b",
  ]);
  await info.attach("load-transaction.json", {
    body: JSON.stringify({ before, readFailed, failed, committed, live }, null, 2),
    contentType: "application/json",
  });
});

test("an injected audio-probe failure revokes only transaction-owned import URLs", async ({
  page,
}, info) => {
  await installMediaFaults(page);
  await openEditor(page);
  expect(
    await page.evaluate(() => window.__d04.audioProbePatched),
  ).toBe(true);
  await loadDraft(
    page,
    draft([await asset("landscape-red.png", { id: "photo", duration: 2 })]),
  );
  const beforeProject = await saveDraft(page);
  const before = await ledger(page);
  const oldUrl = before.created[0];
  const tone = await readFile("tests/fixtures/tone-impulses.wav");
  const input = page.locator('input[accept="audio/*"]');

  // The source stages and acquires its probe URL before this failure, unlike
  // the load fault above. Rollback must revoke that URL, not the live image.
  await page.evaluate(() => {
    window.__d04.failAudioProbe = true;
  });
  await input.setInputFiles({
    name: "fault.wav",
    mimeType: "audio/wav",
    buffer: tone,
  });
  await expect(page.locator('[data-editor-status="AUDIO ERROR"]')).toBeVisible();
  const failed = await ledger(page);
  expect(failed.created).toHaveLength(before.created.length + 1);
  const probeUrl = failed.created.at(-1);
  expect(failed.revoked).toEqual([...before.revoked, probeUrl]);
  expect(failed.revoked).not.toContain(oldUrl);
  expect(
    await page.evaluate(async (url) => (await fetch(url)).ok, oldUrl),
  ).toBe(true);
  expect(await saveDraft(page)).toEqual(beforeProject);

  await input.setInputFiles({
    name: "fault.wav",
    mimeType: "audio/wav",
    buffer: tone,
  });
  await expect(page.locator("[data-audio-track]")).toHaveCount(1);
  const current = await saveDraft(page);
  expect(current.audioTracks).toHaveLength(1);
  expect(current.audioTracks[0].name).toBe("fault.wav");
  const committed = await ledger(page);
  const live = committed.created.filter((url) => !committed.revoked.includes(url));
  expect(live).toHaveLength(2);
  expect(live).toContain(oldUrl);
  expect(live).not.toContain(probeUrl);
  expect(
    await page.evaluate(
      async (urls) => Promise.all(urls.map(async (url) => (await fetch(url)).ok)),
      live,
    ),
  ).toEqual([true, true]);
  await info.attach("import-transaction.json", {
    body: JSON.stringify({ before, failed, committed, probeUrl }, null, 2),
    contentType: "application/json",
  });
});

test("single-flight saves keep leased snapshots through project replacement and deletion", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    window.__d04Save = { delay: false, delayedReads: 0 };
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (...args) {
      if (window.__d04Save.delay) {
        window.__d04Save.delayedReads += 1;
        setTimeout(() => read.apply(this, args), 400);
      } else read.apply(this, args);
    };
  });
  await openEditor(page);
  const original = await asset("bars-fractional-av.mp4", {
    id: "clip-a",
    duration: 0.5,
  });
  const replacementClip = await asset("landscape-red.png", {
    id: "photo-b",
    duration: 2,
  });
  await loadDraft(page, draft([original]));
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  const saveButton = page.getByTitle("Save Project", { exact: true });
  const setDelay = (delay) =>
    page.evaluate((value) => {
      window.__d04Save.delay = value;
    }, delay);

  // Start one save, then request another while its source read is suspended.
  // Replacing the project must not change either the snapshot or its bytes.
  await setDelay(true);
  const replacementSave = page.waitForEvent("download");
  await saveButton.click();
  await saveButton.click();
  await page.waitForFunction(() => window.__d04Save.delayedReads > 0);
  await uploadDraft(page, draft([replacementClip]));
  await expect(
    page.getByRole("button", { name: "Edit landscape-red.png", exact: true }),
  ).toBeVisible();
  const savedOriginal = await readDownload(await replacementSave);
  expect(savedOriginal.mediaAssets.map((clip) => clip.id)).toEqual(["clip-a"]);
  expect(savedOriginal.mediaAssets[0].base64).toBe(original.base64);
  expect(downloads).toHaveLength(1); // the overlapping click did not start a save
  await setDelay(false);

  const currentReplacement = await saveDraft(page);
  expect(currentReplacement.mediaAssets.map((clip) => clip.id)).toEqual([
    "photo-b",
  ]);
  expect(downloads).toHaveLength(2);

  // Repeat the race with deletion (an empty replacement). The new project's
  // source is retired by the UI but remains readable until this save finishes.
  const readsBefore = await page.evaluate(
    () => window.__d04Save.delayedReads,
  );
  await setDelay(true);
  const deletionSave = page.waitForEvent("download");
  await saveButton.click();
  await page.waitForFunction(
    (before) => window.__d04Save.delayedReads > before,
    readsBefore,
  );
  await uploadDraft(page, draft([]));
  await expect(page.locator(".preview-empty")).toBeVisible();
  const savedReplacement = await readDownload(await deletionSave);
  expect(savedReplacement.mediaAssets.map((clip) => clip.id)).toEqual([
    "photo-b",
  ]);
  expect(savedReplacement.mediaAssets[0].base64).toBe(replacementClip.base64);
  expect(downloads).toHaveLength(3);
  await setDelay(false);

  const empty = await saveDraft(page);
  expect(empty.mediaAssets).toEqual([]);
  expect(empty.audioTracks).toEqual([]);
  expect(downloads).toHaveLength(4);
  await info.attach("save-transactions.json", {
    body: JSON.stringify(
      {
        overlappingSaveDownloads: 1,
        replacementSnapshot: savedOriginal.mediaAssets.map((clip) => clip.id),
        currentAfterReplacement: currentReplacement.mediaAssets.map(
          (clip) => clip.id,
        ),
        deletionSnapshot: savedReplacement.mediaAssets.map((clip) => clip.id),
        currentAfterDeletion: empty.mediaAssets,
        delayedReads: await page.evaluate(
          () => window.__d04Save.delayedReads,
        ),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("a failed save reports an error, releases leases, and permits a healthy retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__d04SaveFailure = { failNext: false };
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (...args) {
      if (window.__d04SaveFailure.failNext) {
        window.__d04SaveFailure.failNext = false;
        setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      } else read.apply(this, args);
    };
  });
  await openEditor(page);
  await loadDraft(
    page,
    draft([
      await asset("bars-fractional-av.mp4", { id: "clip-a", duration: 0.5 }),
    ]),
  );
  const oldUrl = await page.locator("video").first().getAttribute("src");
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.evaluate(() => {
    window.__d04SaveFailure.failNext = true;
  });
  await page.getByTitle("Save Project", { exact: true }).click();
  await expect(page.locator('[data-editor-status="SAVE ERROR"]')).toBeVisible();
  expect(downloads).toHaveLength(0);

  const retry = await saveDraft(page);
  expect(retry.mediaAssets.map((clip) => clip.id)).toEqual(["clip-a"]);
  expect(downloads).toHaveLength(1);
  await uploadDraft(page, draft([]));
  await expect(page.locator(".preview-empty")).toBeVisible();
  // If either save leaked a lease, deleting the project could not revoke this.
  expect(
    await page.evaluate(async (url) => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    }, oldUrl),
  ).toBe(false);
});
