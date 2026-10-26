import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../source-probes.mjs";
const { createJobReport, sanitizeReport, DiagnosticHistory, DIAGNOSTIC_KEY } = loadModule("services/diagnostics.ts");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const state = n => ({ jobId:id(n),buildId:"a".repeat(64)+":test",phase:"failed",active:false,progress:30,cleanupComplete:true,
  startedAt:"2026-10-26T12:00:00.000Z",updatedAt:"2026-10-26T12:00:02.000Z",endedAt:"2026-10-26T12:00:02.000Z",
  input:{fingerprint:"b".repeat(64),clips:1,audioTracks:1,duration:1,quality:"draft",aspectRatio:"16:9",fitMode:"contain",name:"secret-user"},
  error:"/home/secret-user/holiday.mp4",failure:{category:"asset",assetId:"secret-user"},logs:["data:video/mp4;base64,AAAA"],
  phaseResults:[],phaseTimingsMs:{preparing:2000},events:[{type:"failed",at:"2026-10-26T12:00:02.000Z",elapsedMs:2000,detail:{path:"C:\\secret-user\\holiday.mp4",base64:"AAAA"}}],
  diagnostics:[{operation:"/home/secret-user",frameIndex:2,ownedResources:0,clipId:"secret-user",base64:"AAAA"}] });
test("job summaries allow only bounded machine evidence and preserve negative terminal outcomes", () => {
  const report = createJobReport(state(1)), text = JSON.stringify(report);
  assert.doesNotMatch(text,/secret-user|holiday|base64|AAAA|home/);
  assert.equal(report.outcome,"failed"); assert.equal(report.input.fingerprint,"b".repeat(64)); assert.equal(report.timingsMs.preparing,2000);
  assert.deepEqual(report.resources,[{ownedResources:0,frameIndex:2}]);
  assert.equal(createJobReport({...state(1),phase:"idle"}),null,"dismissing an error must not overwrite its stored failure");
  const dirty = {...report,resources:Array(1000).fill({base64:"secret",waitMs:10}),events:Array(1000).fill(report.events[0]),warnings:["/home/secret-user","cleanup-incomplete"]};
  const clean = sanitizeReport(dirty); assert.equal(clean.resources.length,32); assert.equal(clean.events.length,80);
  assert.deepEqual(clean.warnings,["cleanup-incomplete"]);
  assert.equal(sanitizeReport({...dirty,jobId:"private@example.test"}),null);
});
test("diagnostic history survives reload, keeps ten jobs, and preserves prior bytes on quota failure", () => {
  let text = null, full = false;
  const storage = {getItem:key=>{assert.equal(key,DIAGNOSTIC_KEY);return text},setItem:(_,value)=>{if(full)throw new DOMException("full","QuotaExceededError");text=value},removeItem:()=>{text=null}};
  const history = new DiagnosticHistory(storage);
  for(let n=0;n<12;n++)history.record(createJobReport(state(n)));
  const reloaded = new DiagnosticHistory(storage).read(); assert.equal(reloaded.length,10); assert.equal(reloaded[0].jobId,id(11));
  const before = text; full = true;
  assert.throws(()=>history.record(createJobReport(state(12))),/full/); assert.equal(text,before);
  history.clear(); assert.deepEqual(history.read(),[]);
  text='[';assert.throws(()=>history.read());
});
