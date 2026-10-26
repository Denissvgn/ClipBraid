import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft, saveDraft } from "./helpers.mjs";
test("asset failure offers inspection, hides technical chatter and has copyable job identity", async ({page}, info) => {
  await openEditor(page);
  await loadDraft(page, draft([await asset("corrupt.mp4", { id: "broken", name: "Broken holiday clip" })]));
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Couldn’t export this video" })).toBeVisible();
  await expect(page.locator(".export-message")).toContainText("Broken holiday clip");
  await expect(page.getByRole("button", { name: "Inspect clip" })).toBeVisible();
  const inspect = await page.getByRole("button", { name: "Inspect clip" }).boundingBox();
  expect(inspect.y + inspect.height).toBeLessThan(page.viewportSize().height);
  await expect(page.locator(".export-log")).not.toBeVisible();
  await page.screenshot({path:info.outputPath("asset-recovery.png")});
  await page.getByText("Technical details", {exact:true}).click();
  const report = JSON.parse(await page.getByRole("textbox", { name: "Copyable job diagnostics" }).inputValue());
  expect(report.jobId).toBeTruthy(); expect(report.buildId).toMatch(/^[a-f0-9]{64}:test$/);
  expect(JSON.stringify(report)).not.toContain("holiday");
  await page.getByRole("button", { name: "Inspect clip" }).click();
  await expect(page.getByRole("button", { name: "Close clip settings" })).toBeFocused();
});
test("an unacknowledged save warns about duplicates and retry produces a separate job", async ({page}, info) => {
  await page.addInitScript(() => { window.acceptSave = false; window.Flow = { save: async () => window.acceptSave ? true : undefined }; });
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await page.getByRole("button", {name:"draft",exact:true}).click();
  await page.getByRole("button", {name:"Export video",exact:true}).click();
  await expect(page.locator(".export-message")).toContainText("Check your downloads or host files");
  const retry = await page.getByRole("button", { name: "Retry export", exact:true }).boundingBox();
  expect(retry.y + retry.height).toBeLessThan(page.viewportSize().height);
  const old = await page.locator("#export-evidence").evaluate(el => JSON.parse(el.textContent).jobId);
  await page.screenshot({path:info.outputPath("unknown-delivery.png")});
  await page.evaluate(() => { window.acceptSave = true; });
  await page.getByRole("button", {name:"Retry export",exact:true}).click();
  await expect(page.locator('[data-delivery-outcome="host-accepted"]')).toBeVisible();
  expect(await page.locator("#export-evidence").evaluate(el => JSON.parse(el.textContent).jobId)).not.toBe(old);
});
test("an invalid project offers recovery guidance while retaining the current edit", async ({page}) => {
  await openEditor(page); await loadDraft(page, draft([await asset("landscape-red.png")]));
  await page.locator('input[accept=".json"]').setInputFiles({name:"invalid.json",mimeType:"application/json",buffer:Buffer.from("{invalid")});
  await expect(page.locator(".source-notice[role='alert']")).toContainText("Your current project is still available");
  await expect(page.locator(".source-notice[role='alert']")).toContainText("reload and choose Restore local revision when offered");
  await expect(page.getByRole("button", {name:"Export video",exact:true})).toBeEnabled();
  await loadDraft(page, draft([await asset("landscape-red.png")]));
  await expect(page.locator('[data-media-category="project"]')).toHaveCount(0);
});
test("dismissing a cleanup failure preserves the reload action and copyable outcome until recovery",async({page})=>{
  await page.addInitScript(()=>{
    window.failCleanup=sessionStorage.getItem("cleanup-repaired")!=="true";
    const Native=window.Worker;window.Worker=function(...args){const worker=new Native(...args),stop=worker.terminate.bind(worker);
      worker.terminate=()=>{stop();if(window.failCleanup)throw new Error("injected cleanup failure")};return worker};window.Worker.prototype=Native.prototype;
    const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==="clipbraid.export-diagnostics.v1")throw new DOMException("blocked","QuotaExceededError");return set.call(this,key,value)};
  });
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await expect(page.locator(".export-message")).toContainText("cleanup has not finished");
  await page.getByRole("button",{name:"Back to editing",exact:true}).click();
  await expect(page.getByText("Export is blocked because media cleanup failed. Save your project, then reload this page before another export.",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeDisabled();
  await page.getByTitle("Diagnostics",{exact:true}).click();await page.getByRole("button",{name:"Export history",exact:true}).click();
  await page.locator('details[data-diagnostic-outcome="failed"] > summary').click();
  expect(JSON.parse(await page.getByRole("textbox",{name:"Current job diagnostics",exact:true}).inputValue()).warnings).toContain("cleanup-incomplete");
  await page.getByRole("button",{name:"Close diagnostics",exact:true}).click();
  const backup=await saveDraft(page);await page.evaluate(()=>sessionStorage.setItem("cleanup-repaired","true"));
  await openEditor(page);await loadDraft(page,backup);await page.getByRole("button",{name:"draft",exact:true}).click();
  const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();expect(await(await ready).failure()).toBeNull();
  await expect(page.locator('[data-delivery-outcome="download-started"]')).toBeVisible();
});

test("a failed earlier source is not blamed on a replacement with the same clip ID",async({page})=>{
  await page.addInitScript(()=>{
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message,...rest){
      if(message.snapshot&&!window.preflightHeld){window.preflightHeld=true;window.releaseEarlierPreflight=()=>post.call(this,message,...rest);return}
      return post.call(this,message,...rest);
    };
  });
  await openEditor(page);await loadDraft(page,draft([await asset("corrupt.mp4",{id:"shared",name:"Earlier broken clip"})]));
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await page.waitForFunction(()=>window.releaseEarlierPreflight);
  await loadDraft(page,draft([await asset("landscape-red.png",{id:"shared",name:"Replacement clip"})]));
  await page.evaluate(()=>window.releaseEarlierPreflight());
  await expect(page.locator(".export-message")).toContainText("Earlier broken clip");
  await expect(page.locator(".export-message")).not.toContainText("Replacement clip");
  await expect(page.getByRole("button",{name:"Inspect clip",exact:true})).toHaveCount(0);
  await expect(page.locator(".export-message")).toContainText("current project");
  const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Retry export",exact:true}).click();
  expect(await(await ready).failure()).toBeNull();
});

test("a corrupt audio track offers audio recovery and a reachable removal control",async({page})=>{
  await openEditor(page);
  await loadDraft(page,draft([await asset("landscape-red.png")],[{id:"broken-sound",mediaId:"sound",name:"Broken audio",mimeType:"audio/wav",base64:"YmFk",startTime:0,duration:1}]));
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await expect(page.locator(".export-message")).toContainText("audio track");
  await expect(page.locator(".export-message")).not.toContainText("clip’s trim");
  await page.getByRole("button",{name:"Inspect audio track",exact:true}).click();
  const remove=page.getByRole("button",{name:"Remove Broken audio",exact:true});await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");await expect(page.locator('[data-audio-track]')).toHaveCount(0);
  await page.getByRole("button",{name:"draft",exact:true}).click();
  const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();
  expect(await(await ready).failure()).toBeNull();
});

for(const kind of ["video","audio"])test(`a ${kind} decode failure after preflight retains source-specific recovery`,async({page})=>{
  const worker=kind==="video"?"render":"audio";
  await page.route(`**/services/${worker}.worker.ts*`,async route=>{
    const response=await route.fetch(),body=await response.text();
    await route.fulfill({response,body:body+`\n${kind==="video"?"VideoDecoder":"AudioDecoder"}.prototype.decode=function(){throw new Error("injected late source decode failure")};\n`});
  });
  await openEditor(page);
  const name=kind==="video"?"Late visual failure":"Late sound failure";
  const media=kind==="video"?[await asset("rate-24.mp4",{id:"late-visual",name})]:[await asset("landscape-red.png")];
  const audio=kind==="audio"?[{id:"late-audio",mediaId:"sound",name,mimeType:"audio/mp4",base64:(await asset("bars-fractional-av.mp4")).base64,startTime:0,duration:1}]:[];
  await loadDraft(page,draft(media,audio));
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await expect(page.locator(".export-message")).toContainText(name);
  await expect(page.getByRole("button",{name:kind==="video"?"Inspect clip":"Inspect audio track",exact:true})).toBeVisible();
  const report=JSON.parse(await page.locator("#export-diagnostic-report").textContent());
  expect(report.category).toBe("asset");expect(JSON.stringify(report)).not.toContain(name);
});
