import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";

test("phone and landscape controls reflow with larger text and unavailable fonts", async ({ page }, info) => {
  await page.route("**/*.woff2", route => route.abort());
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  for (const [width, height] of [[360, 800], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.documentElement.style.fontSize = "32px");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const overflow = await page.locator(".app-header button, .editor-inspector button, .playback-toolbar button, .preview-heading button").evaluateAll(buttons => buttons.filter(button => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && (box.left < 0 || box.right > innerWidth + 1);
    }).map(button => button.textContent.trim()));
    expect(overflow).toEqual([]);
    for (const name of ["Add visuals", "Add audio", "Open project", "Save project", "Export video"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click({ trial: true });
    }
    await page.getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true }).click();
    await page.getByLabel("Trim from start").scrollIntoViewIfNeeded();
    await page.getByLabel("Look", { exact: true }).selectOption("warm");
    await page.getByRole("button", { name: "Close clip settings" }).click();
    await page.getByText("Record voice-over", { exact: true }).click();
    await page.getByRole("button", { name: "Start recording", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await info.attach(`reflow-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
});

for (const [width, height] of [[360, 800], [390, 844]]) {
  test(`complete phone workflow at ${width} pixels`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openEditor(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add visuals", exact: true }).click();
    await (await chooser).setFiles("tests/fixtures/landscape-red.png");
    await page.getByRole("button", { name: "Edit landscape-red.png", exact: true }).click();
    await page.getByLabel("Look", { exact: true }).selectOption("grayscale");
    await page.getByRole("button", { name: "Close clip settings" }).click();
    const saved = await saveDraft(page);
    expect(saved.mediaAssets[0].filter).toBe("grayscale");
    await loadDraft(page, saved);
    await page.getByRole("button", { name: "draft", exact: true }).click();
    const ready = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export video", exact: true }).click();
    const output = await ready;
    await output.saveAs(info.outputPath("phone.mp4"));
    expect(await output.failure()).toBeNull();
  });
}
