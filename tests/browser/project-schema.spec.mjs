import { test, expect } from "./harness.mjs";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModule } from "../source-probes.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
import { asset, draft } from "./fixtures.mjs";

const { MAX_PROJECT_BYTES } = loadModule("services/project.ts");

test("an oversized draft is rejected before parsing and keeps the open project", async ({
  page,
}, info) => {
  await openEditor(page);
  const clip = await asset("bars-fractional-av.mp4");
  await loadDraft(page, draft([clip]));
  const before = await saveDraft(page);
  const url = await page.locator("video").first().getAttribute("src");
  const dir = await mkdtemp(join(tmpdir(), "clipbraid-oversize-"));
  try {
    // Sparse file: the byte-size gate must fire before any read/parse, so the
    // content is deliberately not JSON either.
    const path = join(dir, "oversized.json");
    await writeFile(path, "x");
    await truncate(path, MAX_PROJECT_BYTES + 1);
    await page.locator('input[accept=".json"]').setInputFiles(path);
    await expect(
      page.locator('[data-editor-status="LOAD ERROR"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.locator(".diagnostics-list")).toContainText(
      "Project file is too large",
    );
    await expect(page.locator(".diagnostics-list")).toContainText("256 MiB");
    await page.getByRole("button", { name: "Close diagnostics" }).click();
    // No timeline allocation or URL replacement happened.
    expect(await page.evaluate(async (u) => (await fetch(u)).ok, url)).toBe(
      true,
    );
    expect(await saveDraft(page)).toEqual(before);
    await info.attach("oversized-rejection.json", {
      body: JSON.stringify(
        {
          limitBytes: MAX_PROJECT_BYTES,
          offeredBytes: MAX_PROJECT_BYTES + 1,
          projectPreserved: true,
          liveSourceUrlStillFetchable: true,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unversioned legacy draft loads and re-saves as schema version 2", async ({
  page,
}) => {
  await openEditor(page);
  const untitled=page.waitForEvent("download");await saveDraft(page);
  expect((await untitled).suggestedFilename()).toMatch(/^clipbraid_project_.*\.json$/);
  const video = await asset("bars-fractional-av.mp4", {
    id: "clip-a",
    duration: 0.5,
    trimStart: 0.1,
    trimEnd: 0.4,
  });
  const image = await asset("landscape-red.png", {
    id: "clip-b",
    mediaId: "", // legacy empty reference, rebuilt from the clip ID
    startTime: 1,
    duration: 2,
    originalDuration: 2,
  });
  const audio = {
    id: "song",
    mediaId: "",
    name: "tone-impulses.wav",
    mimeType: "audio/wav",
    base64: (await readFile("tests/fixtures/tone-impulses.wav")).toString(
      "base64",
    ),
    startTime: 0.25,
    duration: 1,
  };
  const legacy = {
    ...draft([video, image], [audio]),
    fitMode: "cover",
    transitionDuration: 0.25,
    currentTime: 0.5,
  };
  await page.locator('input[accept=".json"]').setInputFiles({name:"My RED VOX cut.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(legacy))});
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
  const named = page.waitForEvent("download");
  const saved = await saveDraft(page);
  expect((await named).suggestedFilename()).toBe("My RED VOX cut.json");
  expect(saved.schemaVersion).toBe(2);
  expect(saved.currentTime).toBe(0.5);
  expect(saved.fitMode).toBe("cover");
  expect(saved.transitionDuration).toBe(0.25);
  const clipA = saved.mediaAssets.find((clip) => clip.id === "clip-a");
  const clipB = saved.mediaAssets.find((clip) => clip.id === "clip-b");
  expect(clipA.trimStart).toBe(0.1);
  expect(clipA.trimEnd).toBe(0.4);
  expect(clipA.base64).toBe(video.base64);
  expect(clipB.mediaId).toBe("clip-b");
  expect(saved.audioTracks[0]).toMatchObject({
    id: "song",
    mediaId: "song",
    startTime: 0.25,
  });
  await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
  await page.locator('input[accept=".json"]').setInputFiles({name:"Rejected replacement.json",mimeType:"application/json",buffer:Buffer.from("{broken")});
  await expect(page.locator('[data-editor-status="LOAD ERROR"]')).toBeVisible();
  const unchangedName=page.waitForEvent("download");expect(await saveDraft(page)).toEqual(saved);
  expect((await unchangedName).suggestedFilename()).toBe("My RED VOX cut.json");
  await page.reload();await page.getByRole("button",{name:"Start editing",exact:true}).click();
  await page.getByRole("button",{name:"Restore local revision",exact:true}).click();
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
  const recoveredName=page.waitForEvent("download");expect(await saveDraft(page)).toEqual(saved);
  expect((await recoveredName).suggestedFilename()).toBe("My RED VOX cut.json");
});
