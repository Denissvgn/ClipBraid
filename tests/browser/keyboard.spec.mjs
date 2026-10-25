import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";

test("keyboard selection, editing, seeking and dialogs retain focus without editor shortcuts", async ({ page }) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  const clip = page.getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true });
  await clip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close clip settings" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Look", { exact: true })).toBeFocused();
  await page.getByLabel("Look", { exact: true }).selectOption("warm");
  await page.getByRole("button", { name: "Close clip settings" }).press("Enter");
  await expect(clip).toBeFocused();
  const recorder = page.getByText("Record voice-over", { exact: true });
  await recorder.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play preview", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Playhead time", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  expect((await saveDraft(page)).currentTime).toBeGreaterThan(0);
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
