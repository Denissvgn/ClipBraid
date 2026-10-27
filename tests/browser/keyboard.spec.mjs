import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";

test("keyboard selection, editing, seeking and dialogs retain focus without editor shortcuts", async ({ page }) => {
  await openEditor(page);
  const open = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open project", exact: true }).focus();
  await page.keyboard.press("Enter");
  await (await open).setFiles({ name: "keyboard.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(draft([await asset("bars-fractional-av.mp4")]))) });
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
  const clip = page.getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true });
  await clip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close clip settings" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Relink original video", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Look", { exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByLabel("Look", { exact: true })).toHaveValue("warm");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close clip settings" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(clip).toBeFocused();
  const recorder = page.getByText("Record voice-over", { exact: true });
  await recorder.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play preview", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Playhead time", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).focus();
  await page.keyboard.press("Enter");
  const stream = await (await saved).createReadStream(), parts = [];
  for await (const part of stream) parts.push(part);
  expect(JSON.parse(Buffer.concat(parts).toString()).currentTime).toBeGreaterThan(0);
  for (const name of ["About ClipBraid", "Details"]) {
    const opener = page.getByRole("button", { name, exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
  }
  await page.getByRole("button", { name: "draft", exact: true }).focus();
  await page.keyboard.press("Space");
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await (await exported).failure()).toBeNull();
});

test("browser accessibility tree names every exposed control", async ({ page, context }, info) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  const session = await context.newCDPSession(page);
  const tree = await session.send("Accessibility.getFullAXTree");
  const controls = tree.nodes.filter(node => !node.ignored && ["button", "slider", "switch", "combobox", "progressbar"].includes(node.role?.value));
  expect(controls.length).toBeGreaterThan(15);
  expect(controls.filter(node => !node.name?.value).map(node => node.role.value)).toEqual([]);
  await info.attach("accessible-controls", { body: JSON.stringify(controls.map(node => ({ role: node.role.value, name: node.name.value }))), contentType: "application/json" });
});

test("selecting a clip from expanded preview exposes and focuses its settings", async ({ page }) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("landscape-red.png")]));
  const clip = page.getByRole("button", { name: "Edit landscape-red.png", exact: true });
  // Cover a new selection and reselecting an already selected clip.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "Expand preview", exact: true }).click();
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await clip.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary", { name: "Clip settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close clip settings", exact: true })).toBeFocused();
  }
  await page.getByRole("button", { name: "Close clip settings", exact: true }).click();
  await expect(clip).toBeFocused();
  await loadDraft(page, draft([await asset("corrupt.mp4")]));
  await page.getByRole("button", { name: "Expand preview", exact: true }).click();
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  await page.getByRole("button", { name: "Inspect clip", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Close clip settings", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add visuals", exact: true })).toBeFocused();
});
