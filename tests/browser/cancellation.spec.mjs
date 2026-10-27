import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";

async function faultEditor(page) {
  await page.addInitScript(() => {
    window.exportFault = null; window.faultReached = false; window.workerLedger = []; window.audioDecoderLedger = [];
    const NativeWorker = window.Worker;
    window.Worker = function (...args) {
      const worker = new NativeWorker(...args);
      worker.taskURL = String(args[0]);
      worker.wasTerminated = false;
      const terminate = worker.terminate.bind(worker), post = worker.postMessage.bind(worker);
      worker.terminate = () => { worker.wasTerminated = true; terminate(); };
      worker.postMessage = (message, ...rest) => {
        if (window.exportFault === "mux" && message.type === "EXEC") { window.faultReached = true; return; }
        return post(message, ...rest);
      };
      window.workerLedger.push(worker); return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
    const NativeDecoder = window.AudioDecoder;
    window.AudioDecoder = new Proxy(NativeDecoder, { construct(target, args) {
      const decoder = Reflect.construct(target, args); window.audioDecoderLedger.push(decoder); return decoder;
    } });
    const decode = NativeDecoder.prototype.decode, flush = NativeDecoder.prototype.flush;
    NativeDecoder.prototype.decode = function (...args) {
      if (window.exportFault === "mix") { window.faultReached = true; return; }
      return decode.apply(this, args);
    };
    NativeDecoder.prototype.flush = function (...args) {
      if (window.exportFault === "mix") return new Promise(() => {});
      return flush.apply(this, args);
    };
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      if (window.exportFault === "save" && blob.type === "video/mp4") { window.faultReached = true; return; }
      return read.call(this, blob);
    };
  });
  let fault = null;
  await page.route("**/services/*.worker.ts*", async route => {
    const response = await route.fetch();
    let body = await response.text();
    if (fault === "decode" && route.request().url().includes("render.worker")) body += "\nVideoDecoder.prototype.decode = function() {}; VideoDecoder.prototype.flush = function() { return new Promise(() => {}); };\n";
    if (fault === "encode" && route.request().url().includes("render.worker")) body += "\nVideoEncoder.prototype.flush = function() { return new Promise(() => {}); };\n";
    if (fault === "mix" && route.request().url().includes("audio.worker"))
      body += "\nAudioDecoder.prototype.decode = function() {}; AudioDecoder.prototype.flush = function() { return new Promise(() => {}); };\n";
    await route.fulfill({ response, body });
  });
  await openEditor(page);
  await loadDraft(page, draft([await asset("bars-fractional-av.mp4")]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  return async mode => { fault = mode; await page.evaluate(mode => { window.exportFault = mode; window.faultReached = false; }, mode); };
}
async function healthyExport(page) {
  const received = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  expect(await (await received).failure()).toBeNull();
  await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
}

test("real decode, encode, mix, mux and save cancellation drains owners before healthy retries", async ({ page }, info) => {
  test.setTimeout(120_000);
  const setFault = await faultEditor(page);
  const observations = [];
  for (const mode of ["decode", "encode", "mix", "mux", "save"]) {
    await setFault(mode);
    await page.getByRole("button", { name: "Export video", exact: true }).click();
    if (mode === "decode" || mode === "encode") {
      await page.waitForFunction(message => window.__clipbraidE2E.exportState().logs.some(line => line.includes(message)),
        mode === "decode" ? "Decoding visual media" : "Finalizing visual stream");
    } else if (mode === "mix") {
      await page.waitForFunction(() => window.__clipbraidE2E.exportState().logs.some(line => line.includes("Decoding audio samples")));
    } else await page.waitForFunction(() => window.faultReached);
    const requested = Date.now();
    await page.getByRole("button", { name: "Cancel export", exact: true }).press("Enter");
    await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled();
    const result = await page.evaluate(() => ({ state: window.__clipbraidE2E.exportState(),
      workersStopped: window.workerLedger.every(worker => worker.wasTerminated),
      audioClosed: window.audioDecoderLedger.every(decoder => decoder.state === "closed") }));
    expect(result.state.phase).toBe("cancelled");
    expect(result.state.cleanupComplete).toBe(true);
    expect(result.workersStopped).toBe(true);
    expect(result.audioClosed).toBe(true);
    expect(Date.now() - requested).toBeLessThan(5000);
    observations.push({ mode, cleanupMs: Date.now() - requested, ...result });
    await setFault(null);
    await healthyExport(page);
  }
  await info.attach("cancellation-matrix", { body: JSON.stringify(observations), contentType: "application/json" });
});

test("a stalled native encoder hits its deadline, terminates and permits retry", async ({ page }) => {
  const setFault = await faultEditor(page);
  await setFault("encode");
  await page.evaluate(() => window.__clipbraidE2E.exportDeadlines({ stages: { rendering: 2000 } }));
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();
  expect(await page.evaluate(() => window.workerLedger.every(worker => worker.wasTerminated))).toBe(true);
  expect(await page.evaluate(() => window.__clipbraidE2E.exportState().error)).toMatch(/timed out/);
  await setFault(null);
  await page.evaluate(() => window.__clipbraidE2E.exportDeadlines({}));
  await healthyExport(page);
});

test("completed exports terminate their mux worker without waiting for filesystem cleanup replies", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.Worker; window.cleanupWorkers = []; window.blockedDeletes = 0;
    window.Worker = function (...args) {
      const worker = new Native(...args), post = worker.postMessage.bind(worker), stop = worker.terminate.bind(worker);
      worker.stopped = false;
      worker.terminate = () => { worker.stopped = true; stop(); };
      worker.postMessage = (message, ...rest) => {
        if (message.type === "DELETE_FILE") { window.blockedDeletes++; return; }
        return post(message, ...rest);
      };
      window.cleanupWorkers.push(worker); return worker;
    };
    window.Worker.prototype = Native.prototype;
  });
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await page.getByRole("button", { name: "draft", exact: true }).click();
  for (let cycle = 0; cycle < 2; cycle++) {
    const received = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export video", exact: true }).click();
    expect(await (await received).failure()).toBeNull();
    await expect(page.getByRole("button", { name: "Export video", exact: true })).toBeEnabled({ timeout: 5000 });
    expect(await page.evaluate(() => window.cleanupWorkers.every(worker => worker.stopped))).toBe(true);
  }
  expect(await page.evaluate(() => window.blockedDeletes)).toBe(0);
});
