import { test, expect } from "./harness.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
import { asset, draft } from "./fixtures.mjs";

const sha = (base64) =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

const setRange = (page, selector, value) =>
  page.locator(selector).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

test("repeated sources share one runtime original while clip edits stay independent", async ({
  page,
}, info) => {
  await openEditor(page);
  const a = await asset("bars-fractional-av.mp4", {
    id: "clip-a",
    duration: 0.5,
    trimStart: 0.1,
    trimEnd: 0.4,
  });
  const b = {
    ...a,
    id: "clip-b",
    startTime: 0.5,
    trimStart: 0.25,
    trimEnd: 0.25,
  };
  await loadDraft(page, draft([a, b]));
  // One shared source (one object URL) backs both clip instances.
  const urls = await page
    .locator("video")
    .evaluateAll((videos) => videos.map((video) => video.src));
  expect(urls).toHaveLength(2);
  expect(urls[0]).toBe(urls[1]);
  // Independent trims and original bytes survive an edit and save round trip.
  await page
    .getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true })
    .first()
    .click();
  await setRange(page, "#trim-start", "0.15");
  const saved = await saveDraft(page);
  const original = (
    await readFile("tests/fixtures/bars-fractional-av.mp4")
  ).toString("base64");
  const clipA = saved.mediaAssets.find((c) => c.id === "clip-a");
  const clipB = saved.mediaAssets.find((c) => c.id === "clip-b");
  expect(clipA).toMatchObject({ trimStart: 0.15, trimEnd: 0.4 });
  expect(clipA.duration).toBeCloseTo(0.45, 6);
  expect(clipB).toMatchObject({ trimStart: 0.25, trimEnd: 0.25, duration: 0.5 });
  for (const clip of saved.mediaAssets) expect(sha(clip.base64)).toBe(sha(original));
  await info.attach("source-reuse.json", {
    body: JSON.stringify(
      {
        sharedUrl: urls[0] === urls[1],
        independentTrims: saved.mediaAssets.map((c) => ({
          id: c.id,
          trimStart: c.trimStart,
          trimEnd: c.trimEnd,
        })),
        checksums: saved.mediaAssets.map((c) => sha(c.base64)),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("an active export keeps its media through project replacement and deletion", async ({
  page,
}, info) => {
  await openEditor(page);
  const clip = await asset("bars-fractional-av.mp4", {
    duration: 0.5,
    trimEnd: 0.501,
    muted: true,
  });
  await loadDraft(page, draft([clip]));
  const oldUrls = await page
    .locator("video")
    .evaluateAll((videos) => videos.map((video) => video.src));
  expect(oldUrls).toHaveLength(1);
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  // Replace the project while the export job is running; its media must live.
  await loadDraft(
    page,
    draft([await asset("landscape-red.png", { id: "photo", duration: 2 })]),
  );
  const retained = await page.evaluate(async (urls) => {
    const results = [];
    for (const url of urls) {
      try {
        results.push((await fetch(url)).ok);
      } catch {
        results.push(false);
      }
    }
    return results;
  }, oldUrls);
  await info.attach("retained-during-export.json", {
    body: JSON.stringify({ retained }, null, 2),
    contentType: "application/json",
  });
  expect(retained).toEqual([true]);
  const download = await ready;
  await download.saveAs(info.outputPath("replaced-during-export.mp4"));
  expect(await download.failure()).toBeNull();
});
