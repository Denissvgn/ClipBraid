import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, loadDelivery } from "../source-probes.mjs";
const {estimateExport}=loadModule("services/timeline.ts");
test("profile estimates include bitrate, duration, container and base64 without fixed MB claims",()=>{
  const draft=estimateExport("draft",600);assert.equal(draft.videoBitrate,500000);assert.equal(draft.audioBitrate,192000);
  assert.ok(draft.estimatedMiB>49.5&&draft.estimatedMiB<53);assert.ok(draft.base64MiB>draft.estimatedMiB);
  assert.ok(estimateExport("high",600).estimatedBytes>estimateExport("standard",600).estimatedBytes);
  assert.ok(estimateExport("draft",1).estimatedBytes<estimateExport("draft",2).estimatedBytes);
});
test("actual raw and base64 limits are checked independently and host caps cannot raise safety limits",()=>{
  const fake={capabilities:{maxSaveBytes:10,maxBase64Chars:12}};
  const {assertVideoSize,videoDeliveryLimits}=loadDelivery({Flow:fake,isHostedFlow:()=>true});
  assert.doesNotThrow(()=>assertVideoSize(9,12));assert.throws(()=>assertVideoSize(10,16),error=>error.category==="size-limit");
  assert.throws(()=>assertVideoSize(11,12),error=>error.category==="size-limit");
  fake.capabilities.maxSaveBytes=1e12;assert.equal(videoDeliveryLimits().bytes,96*1048576);
  fake.capabilities.maxSaveBytes=-1;assert.throws(videoDeliveryLimits,error=>error.category==="unsupported");
});
