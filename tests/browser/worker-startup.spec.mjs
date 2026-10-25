import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { openEditor } from "./helpers.mjs";

const coreResponse = async (route, name) => route.fulfill({
  body: await readFile(`node_modules/@ffmpeg/core/dist/umd/${name}`),
  contentType: name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
  headers: { "access-control-allow-origin": "*" },
});

test("offline initialization shows a recoverable error and real core retry succeeds", async ({ page }) => {
  let offline = true;
  await page.route("https://**/*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (offline || !["ffmpeg-core.js", "ffmpeg-core.wasm"].includes(name))
      return route.fulfill({ status: 503, body: "offline" });
    await coreResponse(route, name);
  });
  await page.goto("/?e2e=1");
  await page.getByRole("button", { name: "Start editing" }).click();
  await expect(page.locator('[data-editor-status="FATAL ERROR"]')).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry media tools", exact: true });
  await expect(retry).toBeVisible();
  offline = false;
  await retry.press("Enter");
  await expect(page.locator('[data-editor-status="READY"]')).toBeVisible();
  await expect(retry).toHaveCount(0);
});

test("a self-hosted pinned core starts without CDN requests", async ({ page }, info) => {
  await page.addInitScript(() => { window.CLIPBRAID_FFMPEG_CORE_BASE_URL = "/test-core"; });
  const requests = [];
  page.on("request", request => { if (request.url().includes("ffmpeg-core.")) requests.push(request.url()); });
  await page.route("**/test-core/*", route => coreResponse(route, new URL(route.request().url()).pathname.split("/").at(-1)));
  await openEditor(page);
  expect(requests).toHaveLength(2);
  expect(requests.every(url => url.startsWith("http://127.0.0.1:4175/test-core/"))).toBe(true);
  await info.attach("self-hosted-core", { body: JSON.stringify(requests), contentType: "application/json" });
});
