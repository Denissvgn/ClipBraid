import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";
for (const fault of ["capacity", "incompatible"]) test(`parallel ${fault} falls back after cleanup and delivers a valid single stream`, async ({ page }, info) => {
  const replacement = await asset("silent-video.mp4");
  await page.addInitScript(({ fault, base64 }) => {
    const NativeWorker = window.Worker;
    window.failedPlans = 0;
    window.Worker = function (...args) {
      const worker = new NativeWorker(...args), post = worker.postMessage.bind(worker);
      let second = false, replaced = false;
      worker.addEventListener("message", event => {
        if (fault !== "incompatible" || !second || replaced || event.data.type !== "result") return;
        replaced = true; event.stopImmediatePropagation(); window.failedPlans++;
        queueMicrotask(() => worker.dispatchEvent(new MessageEvent("message", { data: { ...event.data,
          bytes: Uint8Array.from(atob(base64), c => c.charCodeAt(0)) } })));
      }, { capture: true });
      worker.postMessage = (message, ...rest) => {
        second = message.type === "render" && message.settings.frameStart > 0;
        if (fault === "capacity" && second) {
          window.failedPlans++;
          queueMicrotask(() => worker.dispatchEvent(new MessageEvent("message", { data: { jobId: message.jobId, type: "error", error: "Insufficient encoder capacity" } })));
          return;
        }
        return post(message, ...rest);
      };
      return worker;
    }; window.Worker.prototype = NativeWorker.prototype;
  }, { fault, base64: replacement.base64 });
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download"); await page.getByRole("button", { name: "Export video", exact: true }).click();
  const received = await ready; await received.saveAs(info.outputPath("fallback.mp4")); expect(await received.failure()).toBeNull();
  await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
  const result = await page.evaluate(() => window.__clipbraidE2E.exportState().phaseResults.find(result => result.phase === "rendering"));
  expect(result.plan).toBe("single"); expect(result.attempts).toBe(2); expect(result.segments).toHaveLength(1);
  expect(await page.evaluate(() => window.failedPlans)).toBe(1);
});
test("explicit compatibility plan encodes only one globally partitioned stream", async ({ page }) => {
  await openEditor(page); await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  await page.getByRole("checkbox", { name: "Compatibility render (one encoder)", exact: true }).check();
  await page.getByRole("button", { name: "draft", exact: true }).click();
  const ready = page.waitForEvent("download"); await page.getByRole("button", { name: "Export video", exact: true }).click();
  expect(await (await ready).failure()).toBeNull();
  await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__clipbraidE2E.exportState().phaseResults.find(result => result.phase === "rendering").plan)).toBe("single");
});
