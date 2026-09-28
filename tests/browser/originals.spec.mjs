import { test, expect } from "./harness.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { openEditor, saveDraft, loadDraft } from "./helpers.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Originals: oversized video survives import, idle, save and reload with audio", async ({
  page,
}, info) => {
  const original = await readFile("tests/fixtures/oversized-av.mp4");
  await openEditor(page);
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add visuals", exact: true }).click();
  await (await picker).setFiles("tests/fixtures/oversized-av.mp4");
  await expect(page.getByRole("note")).toContainText("Original media retained");
  await expect
    .poll(() =>
      page
        .locator("video")
        .first()
        .evaluate((v) => v.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  const first = await saveDraft(page);
  // Exercise multiple idle turns, including the old 2-second fallback queue.
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__clipbraidE2E.normalizeAll());
  const idle = await saveDraft(page);
  await loadDraft(page, idle);
  const reloaded = await saveDraft(page);
  const snapshots = [first, idle, reloaded];
  for (const draft of snapshots) {
    expect(draft.mediaAssets).toHaveLength(1);
    expect(sha(Buffer.from(draft.mediaAssets[0].base64, "base64"))).toBe(
      sha(original),
    );
    expect(draft.mediaAssets[0]).toMatchObject({
      hasAudio: true,
      sourceWidth: 1600,
      sourceHeight: 900,
      mimeType: "video/mp4",
    });
  }
  await writeFile(
    info.outputPath("preserved.mp4"),
    Buffer.from(reloaded.mediaAssets[0].base64, "base64"),
  );
  await info.attach("preservation.json", {
    body: JSON.stringify(
      {
        sourceSha256: sha(original),
        snapshotSha256: snapshots.map((d) =>
          sha(Buffer.from(d.mediaAssets[0].base64, "base64")),
        ),
        audio: "present; imported source probe plus byte identity",
        delivery: "download-initiated",
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
