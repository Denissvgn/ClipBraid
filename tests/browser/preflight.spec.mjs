import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";
test("preflight identifies a failing asset and forbids omission or out-of-source edits", async ({ page }) => {
  await openEditor(page); let downloads = 0; page.on("download", () => downloads++);
  for (const bad of [await asset("corrupt.mp4", { id: "bad", name: "broken clip" }),
    await asset("bars-fractional-av.mp4", { id: "range", name: "outside source", duration: 2, originalDuration: 2 })]) {
    await loadDraft(page, draft([await asset("landscape-red.png"), bad]));
    await page.getByRole("button", { name: "Export video", exact: true }).click();
    await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();
    await expect(page.locator(".export-message")).toContainText(bad.name);
    expect(downloads).toBe(0);
  }
});
test("actual inventories permit muted and silent video and record source timing", async ({ page }, info) => {
  await openEditor(page);
  const silent = await asset("silent-video.mp4", { hasAudio: true, sourceFps: 24 });
  await loadDraft(page, draft([silent]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  expect(await (await ready).failure()).toBeNull();
  await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
  const inventory = await page.evaluate(() => window.__clipbraidE2E.exportState().phaseResults.find(result => result.phase === "preparing").assets);
  expect(inventory[0].video).toMatchObject({ width: 160, height: 90, fps: 24, firstTimestamp: 0 });
  expect(inventory[0].audio).toBeUndefined();
  await info.attach("asset-inventory", { body: JSON.stringify(inventory), contentType: "application/json" });
});
