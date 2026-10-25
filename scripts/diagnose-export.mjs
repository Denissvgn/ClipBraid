import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
const [input, folder, quality = "draft", plan = "auto", timeout = "420000"] = process.argv.slice(2);
if (!input || !folder) throw new Error("Usage: diagnose-export.mjs input.json ignored-output-dir [quality] [auto|single] [timeout-ms]");
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage(), resources = [], errors = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("response", async response => { if (response.request().resourceType() === "script") try {
  const bytes = await response.body(); resources.push({ url: response.url(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
} catch {} });
let download;
page.on("download", value => { download = value; });
try {
  await page.route("https://**/*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (["ffmpeg-core.js", "ffmpeg-core.wasm"].includes(name)) await route.fulfill({ body: await readFile(`node_modules/@ffmpeg/core/dist/umd/${name}`), contentType: name.endsWith("wasm") ? "application/wasm" : "text/javascript", headers: { "access-control-allow-origin": "*" } });
    else await route.abort();
  });
  await page.goto("http://127.0.0.1:4181"); await page.getByRole("button", { name: "Start editing" }).click();
  await page.locator('input[accept=".json"]').setInputFiles(input);
  await page.getByRole("button", { name: quality, exact: true }).click();
  if (plan === "single") await page.getByRole("checkbox", { name: "Compatibility render (one encoder)", exact: true }).check();
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const started = Date.now(), trace = []; let state;
  while (Date.now() - started < Number(timeout)) {
    await page.waitForTimeout(1000);
    state = await page.locator("#export-evidence").evaluate(element => JSON.parse(element.textContent));
    trace.push({ wallMs: Date.now() - started, ...state });
    await writeFile(`${folder}/trace.json`, JSON.stringify(trace));
    if (!state.active) break;
  }
  if (state?.active) {
    await page.getByRole("button", { name: "Cancel export", exact: true }).click();
    await page.waitForTimeout(1500);
  }
  let received = null;
  if (download) {
    await download.saveAs(`${folder}/output.mp4`); const bytes = await readFile(`${folder}/output.mp4`);
    received = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), failure: await download.failure() };
  }
  const result = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    environment: { node: process.version, browser: browser.version(), os: `${os.platform()} ${os.release()} ${os.arch()}`, acceleration: "unqualified" },
    buildId: await page.locator(".editor-app").getAttribute("data-build-id"), inputSha256: createHash("sha256").update(await readFile(input)).digest("hex"),
    quality, plan, timeoutMs: Number(timeout), state, errors, received, servedResources: resources };
  await writeFile(`${folder}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ phase: state?.phase, error: state?.error, wallMs: Date.now()-started, received, buildId: result.buildId }));
} finally { await browser.close(); }
