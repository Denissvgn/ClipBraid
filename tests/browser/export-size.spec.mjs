import {test,expect} from "./harness.mjs";
import {asset,draft} from "./fixtures.mjs";
import {openEditor,loadDraft} from "./helpers.mjs";
test("actual output exceeding a host limit fails before invoking delivery",async({page})=>{
  await page.addInitScript(()=>{window.saveCalls=0;window.Flow={capabilities:{maxSaveBytes:100},save:async()=>{window.saveCalls++;return true}}});
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"draft",exact:true}).click();await page.getByRole("button",{name:"Export video",exact:true}).click();
  await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();
  await expect(page.locator(".export-message")).toContainText("delivery limit");
  expect(await page.evaluate(()=>window.saveCalls)).toBe(0);
  const state=await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent));
  expect(state.events.some(event=>event.type==="delivery-started")).toBe(false);
});
