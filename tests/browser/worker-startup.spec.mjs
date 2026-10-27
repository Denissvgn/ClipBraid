import { test, expect } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import { openEditor } from "./helpers.mjs";
import { openProbe } from "./fixtures.mjs";

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

test("unmounting the editor stops its boot worker and a StrictMode remount starts cleanly", async ({ page, context }) => {
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.bootWorkers = [];
    window.Worker = function (...args) {
      const worker = new NativeWorker(...args), terminate = worker.terminate.bind(worker);
      worker.stopped = false;
      worker.terminate = () => { worker.stopped = true; terminate(); };
      window.bootWorkers.push(worker);
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
  });
  // Install the same real-core routes, then use a separate root we can unmount.
  await openEditor(page);
  const probe = await openProbe(context);
  await probe.route("https://**/*", route => coreResponse(route, new URL(route.request().url()).pathname.split("/").at(-1)));
  await probe.evaluate(() => {
    const { React, createRoot, App } = window.testRuntime;
    const host = document.createElement("div"); document.body.append(host);
    window.editorRoot = createRoot(host);
    window.editorRoot.render(React.createElement(React.StrictMode, null, React.createElement(App)));
  });
  await expect(probe.locator('[data-editor-status="READY"]')).toBeAttached();
  expect(await probe.evaluate(() => window.bootWorkers.filter(worker => !worker.stopped).length)).toBe(1);
  await probe.evaluate(() => window.editorRoot.unmount());
  await expect.poll(() => probe.evaluate(() => window.bootWorkers.every(worker => worker.stopped))).toBe(true);
  await probe.evaluate(() => {
    const { React, createRoot, App } = window.testRuntime;
    const host = document.createElement("div"); document.body.append(host);
    window.editorRoot = createRoot(host);
    window.editorRoot.render(React.createElement(React.StrictMode, null, React.createElement(App)));
  });
  await expect(probe.locator('[data-editor-status="READY"]')).toBeAttached();
  expect(await probe.evaluate(() => window.bootWorkers.filter(worker => !worker.stopped).length)).toBe(1);
  await probe.evaluate(() => window.editorRoot.unmount());
});
