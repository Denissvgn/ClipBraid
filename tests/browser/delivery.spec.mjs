import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";
test("verified browser output reports download initiation with job/build event identity", async ({page},info)=>{
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"draft",exact:true}).click();
  const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();
  const output=await ready;await output.saveAs(info.outputPath("delivered.mp4"));expect(await output.failure()).toBeNull();
  await expect(page.locator('[data-delivery-outcome="download-started"]')).toBeVisible();
  const state=await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent));
  expect(state.events.map(event=>event.type)).toEqual(expect.arrayContaining(["rendered","muxed","verified","delivery-started","download-started"]));
  expect(state.events.every(event=>event.jobId===state.jobId&&event.buildId===state.buildId)).toBe(true);
  expect(state.buildId).toMatch(/^[a-f0-9]{64}:test$/);
  expect(state.events.some(event=>event.type==="host-accepted")).toBe(false);
  await info.attach("delivery-events",{body:JSON.stringify(state.events),contentType:"application/json"});
});
test("host cancellation, unknown acknowledgement and acceptance remain distinct",async({page})=>{
  await page.addInitScript(()=>{window.saveMode="cancel";window.Flow={save:async()=>window.saveMode==="cancel"?{cancelled:true}:window.saveMode==="unknown"?undefined:{accepted:true}};});
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"draft",exact:true}).click();
  for(const [mode,type]of [["cancel","cancelled"],["unknown","unknown"],["accept","host-accepted"]]){
    await page.evaluate(mode=>{window.saveMode=mode},mode);
    await page.getByRole("button",{name:"Export video",exact:true}).click();
    await expect.poll(()=>page.locator("#export-evidence").evaluate((el,type)=>{const state=JSON.parse(el.textContent);return !state.active&&state.events.some(event=>event.type===type)},type)).toBe(true);
    if(type==="host-accepted")await expect(page.locator('[data-delivery-outcome="host-accepted"]')).toBeVisible();
  }
});
