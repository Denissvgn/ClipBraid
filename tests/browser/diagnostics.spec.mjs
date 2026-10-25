import { test, expect } from "./harness.mjs";
import { asset,draft } from "./fixtures.mjs";
import { openEditor,loadDraft } from "./helpers.mjs";
test("render diagnostics retain requested source times, waits and native resource counts",async({page},info)=>{
  await openEditor(page);await loadDraft(page,draft([await asset("rate-24.mp4",{id:"traced",hasAudio:false})]));
  await page.getByRole("checkbox",{name:"Compatibility render (one encoder)",exact:true}).check();
  await page.getByRole("button",{name:"draft",exact:true}).click();
  const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();expect(await(await ready).failure()).toBeNull();
  await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeEnabled();
  const state=await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent));
  expect(state.diagnostics.some(point=>point.clipId==="traced"&&Number.isFinite(point.sourceTime)&&point.operation==="decode-request")).toBe(true);
  expect(Math.max(...state.diagnostics.map(point=>point.decodersCreated??0))).toBeGreaterThan(0);
  expect(state.diagnostics.every(point=>Number.isFinite(point.ownedResources)&&Number.isFinite(point.sourceLeases))).toBe(true);
  await info.attach("render-diagnostics",{body:JSON.stringify(state.diagnostics),contentType:"application/json"});
});
