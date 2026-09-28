import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

// Serve the exact locked FFmpeg core bytes. This replaces only CDN transport;
// workers, WASM, decode, encode, mux and save adapters still run for real.
export async function openEditor(page) {
  await page.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    const match =
      /^\/@ffmpeg\/core@0\.12\.6\/dist\/umd\/(ffmpeg-core\.(js|wasm))$/.exec(
        url.pathname,
      );
    if (url.hostname === "unpkg.com" && match) {
      await route.fulfill({
        body: await readFile(`node_modules/@ffmpeg/core/dist/umd/${match[1]}`),
        contentType:
          match[2] === "wasm" ? "application/wasm" : "text/javascript",
        headers: { "access-control-allow-origin": "*" },
      });
    } else if (url.hostname === "fonts.googleapis.com") {
      await route.fulfill({ body: "", contentType: "text/css" });
    } else await route.abort();
  });
  await page.goto("/?e2e=1");
  await page.getByRole("button", { name: "Start editing" }).click();
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
}
export async function saveDraft(page) {
  const downloadReady = page.waitForEvent("download");
  await page.getByTitle("Save Project", { exact: true }).click();
  const download = await downloadReady;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function loadDraft(page, draft) {
  await page.locator('input[accept=".json"]').setInputFiles({
    name: "synthetic.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(draft)),
  });
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
}
