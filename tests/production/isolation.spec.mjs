import { test, expect } from "../browser/harness.mjs";
import { openEditor } from "../browser/helpers.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sourceIdentity } from "../../scripts/source-identity.mjs";

test("the served production candidate matches the source identity and every emitted asset hash", async ({page},info) => {
  const manifest = JSON.parse(await readFile("reports/build-artifacts.json", "utf8"));
  expect(manifest.source.commit).toBe(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim());
  expect(manifest.source.inputsSha256).toBe(sourceIdentity().sha256);
  await openEditor(page);
  expect(await page.locator(".editor-app").getAttribute("data-build-id")).toBe(manifest.buildId);
  for (const file of manifest.files) {
    const response = await page.request.get(`/${file.path}`);
    expect(response.ok(),file.path).toBe(true);
    const bytes = await response.body();
    expect(bytes.length,file.path).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"),file.path).toBe(file.sha256);
  }
  await info.attach("served-production-identity",{body:JSON.stringify(manifest),contentType:"application/json"});
});

test("production query parameters cannot expose automation or development journal", async ({
  page,
}) => {
  await openEditor(page);
  expect(await page.evaluate(() => typeof window.__clipbraidE2E)).toBe(
    "undefined",
  );
  await page.getByTitle("Diagnostics", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "System events", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Dev log", exact: true }),
  ).toHaveCount(0);
  for (const path of [
    "/clipbraid-reference-draft.json",
    "/__fixtures__/reference.json",
    "/tests/probe.html",
  ]) {
    const response = await page.request.get(path);
    // Static SPA servers may fall back to index.html; neither result is fixture data.
    expect(
      (await response.text()).startsWith("<!doctype html>") ||
        response.status() === 404,
    ).toBe(true);
  }
});

test("production favicon resolves to the emitted SVG", async ({ page }) => {
  await openEditor(page);
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toMatch(/^\/assets\/clipbraid-[\w-]+\.svg$/);
  const response = await page.request.get(href);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  expect(await response.text()).toContain("<svg");
});
