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

test("delivery serializes only the returned byte view and reports the received size",async({page})=>{
  await page.addInitScript(()=>{
    const Native=window.Worker;
    window.Worker=function(...args){
      const worker=new Native(...args),post=worker.postMessage.bind(worker),reads=new Set();
      worker.postMessage=(message,...rest)=>{if(message.type==="READ_FILE"&&message.data.path==="master.mp4")reads.add(message.id);return post(message,...rest)};
      worker.addEventListener("message",event=>{
        if(event.data.type!=="READ_FILE"||!reads.delete(event.data.id))return;
        const original=event.data.data,padded=new Uint8Array(original.length+74);padded.set(original,37);
        window.expectedMaster=[...original];event.stopImmediatePropagation();
        queueMicrotask(()=>worker.dispatchEvent(new MessageEvent("message",{data:{...event.data,data:new Uint8Array(padded.buffer,37,original.length)}})));
      },{capture:true});return worker;
    };window.Worker.prototype=Native.prototype;
  });
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  await page.getByRole("button",{name:"draft",exact:true}).click();
  const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();
  const stream=await(await ready).createReadStream(),parts=[];for await(const part of stream)parts.push(part);
  const received=Buffer.concat(parts);
  expect(received).toEqual(Buffer.from(await page.evaluate(()=>window.expectedMaster)));
  await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeEnabled();
  expect(await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent).result.videoBytes)).toBe(received.length);
});
