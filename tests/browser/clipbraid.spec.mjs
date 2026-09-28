import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";

test("parallel audio import and original-sound choices survive save and reload", async ({
  page,
}) => {
  await openEditor(page);
  await loadDraft(
    page,
    draft([
      await asset("bars-fractional-av.mp4", { id: "video-one", duration: 0.5 }),
      await asset("landscape-red.png", {
        id: "photo",
        startTime: 0.5,
        duration: 0.5,
      }),
      await asset("bars-fractional-av.mp4", {
        id: "video-two",
        startTime: 1,
        duration: 0.5,
      }),
    ]),
  );
  const tone = await readFile("tests/fixtures/tone-impulses.wav");
  await page.locator('input[accept="audio/*"]').setInputFiles([
    { name: "music.wav", mimeType: "audio/wav", buffer: tone },
    { name: "narration.wav", mimeType: "audio/wav", buffer: tone },
  ]);
  await expect(page.locator("[data-audio-track]")).toHaveCount(2);
  const rows = await page
    .locator("[data-audio-track]")
    .evaluateAll((elements) =>
      elements.map((el) => el.getBoundingClientRect().top),
    );
  expect(rows[1]).toBeGreaterThan(rows[0]);
  const audioSwitch = page.getByRole("switch", {
    name: "Original video sound",
    exact: true,
  });
  await expect(audioSwitch).toBeChecked();
  await audioSwitch.click();
  await expect(audioSwitch).not.toBeChecked();
  const saved = await saveDraft(page);
  expect(saved.audioTracks.map((track) => track.startTime)).toEqual([0, 0]);
  expect(saved.audioTracks.map((track) => track.name)).toEqual([
    "music.wav",
    "narration.wav",
  ]);
  expect(
    saved.mediaAssets
      .filter((clip) => clip.type === "video")
      .every((clip) => clip.muted),
  ).toBe(true);
  await loadDraft(page, saved);
  await expect(
    page.getByRole("switch", { name: "Original video sound", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Edit bars-fractional-av.mp4", exact: true })
    .first()
    .click();
  await page
    .getByRole("switch", { name: "Original clip sound", exact: true })
    .click();
  const individual = await saveDraft(page);
  expect(
    individual.mediaAssets.find((clip) => clip.id === "video-one").muted,
  ).toBe(false);
  expect(
    individual.mediaAssets.find((clip) => clip.id === "video-two").muted,
  ).toBe(true);
  expect(individual.audioTracks).toEqual(saved.audioTracks);
});

test("onboarding and diagnostics support keyboard dismissal without playing the project", async ({
  page,
}) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  await page.getByRole("button", { name: "About ClipBraid" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start editing" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play preview", exact: true }),
  ).toBeVisible();
  await page.getByTitle("Diagnostics", { exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test('brand surfaces do not tint the actual contained-video matte', async ({ page }) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset('portrait-blue.png')]));
  await expect(page.locator('.preview-frame img')).toBeVisible();
  await page.locator('.preview-frame img').evaluate(image => image.decode());
  const screenshot = await page.locator('.preview-frame').screenshot();
  const pixels = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return { edge: [...ctx.getImageData(5, Math.floor(canvas.height / 2), 1, 1).data], center: [...ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data] };
  }, screenshot.toString('base64'));
  expect(pixels.edge).toEqual([0, 0, 0, 255]);
  expect(pixels.center).toEqual([0, 0, 255, 255]);
});
