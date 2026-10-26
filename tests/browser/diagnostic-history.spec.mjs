import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";
const key = "clipbraid.export-diagnostics.v1";
const report = page => page.locator("#export-diagnostic-report").evaluate(el=>JSON.parse(el.textContent));
async function history(page) {
  await page.getByTitle("Diagnostics",{exact:true}).click();
  await page.getByRole("button",{name:"Export history",exact:true}).click();
}
test("failed and retried jobs survive reload with private details omitted",async({page},info)=>{
  await openEditor(page); await loadDraft(page,draft([await asset("corrupt.mp4",{name:"Private holiday /home/person/video.mp4"})]));
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await expect(page.locator('[data-editor-status="EXPORT ERROR"]')).toBeVisible();
  const failed = await report(page);
  expect(failed.outcome).toBe("failed"); expect(failed.input.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button",{name:"Back to editing",exact:true}).click();
  await openEditor(page);
  expect(await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent).jobId)).toBeNull();
  await history(page); await page.locator('details[data-diagnostic-outcome="failed"] > summary').click();
  const saved = await page.getByRole("textbox",{name:"Saved job diagnostics",exact:true}).inputValue();
  expect(JSON.parse(saved).jobId).toBe(failed.jobId); expect(saved).not.toMatch(/holiday|person|base64|video.mp4/);
  await page.getByRole("button",{name:"Close diagnostics",exact:true}).click();
  await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"draft",exact:true}).click();
  const ready=page.waitForEvent("download"); await page.getByRole("button",{name:"Export video",exact:true}).click();
  expect(await(await ready).failure()).toBeNull(); await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeEnabled();
  const retried=await report(page); expect(retried.jobId).not.toBe(failed.jobId); expect(retried.outcome).toBe("download-started");
  expect(Object.keys(retried.timingsMs)).toEqual(expect.arrayContaining(["preparing","rendering","muxing","saving","cleaning"]));
  await info.attach("failed-and-retried-private-report",{body:JSON.stringify({failed,retried}),contentType:"application/json"});
  await history(page); await page.getByRole("button",{name:"Clear export history",exact:true}).click();
  await openEditor(page); await history(page); await expect(page.getByText("No saved export summaries.",{exact:true})).toBeVisible();
});
test("a checkpoint left by reload is historical and never resumes as current activity",async({page})=>{
  let block=true;
  await page.route("**/services/render.worker.ts*",async route=>{
    const response=await route.fetch();let body=await response.text();
    if(block)body+='\nVideoEncoder.prototype.flush = function(){return new Promise(()=>{});};\n';
    await route.fulfill({response,body});
  });
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)??"[]").some(report=>report.outcome==="running"),key);
  block=false;await openEditor(page);await history(page);
  await expect(page.getByText(/^Unobserved outcome · /)).toBeVisible();
  await page.getByText(/^Unobserved outcome · /).click();
  await expect(page.getByText("This saved checkpoint has no terminal outcome. It may have stopped or belong to another tab.",{exact:true})).toBeVisible();
  expect(await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent).active)).toBe(false);
  const copied=JSON.parse(await page.getByRole("textbox",{name:"Saved job diagnostics",exact:true}).inputValue());
  expect(copied.outcome).toBe("unknown");
  expect(copied.warnings).toContain("previous-session-unobserved");
});
test("diagnostic storage denial leaves real delivery and current report copying available",async({page})=>{
  await page.addInitScript(key=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(name===key)throw new DOMException("full","QuotaExceededError");return set.call(this,name,value)}},key);
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"draft",exact:true}).click();const ready=page.waitForEvent("download");
  await page.getByRole("button",{name:"Export video",exact:true}).click();expect(await(await ready).failure()).toBeNull();
  await expect(page.locator('[data-delivery-outcome="download-started"]')).toBeVisible();
  await expect(page.locator(".source-notice").filter({hasText:"Diagnostic history could not be saved"})).toBeVisible();
  await history(page);await page.locator('details[data-diagnostic-outcome="download-started"] > summary').click();
  expect(JSON.parse(await page.getByRole("textbox",{name:"Current job diagnostics",exact:true}).inputValue()).outcome).toBe("download-started");
});
