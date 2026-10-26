import { test,expect } from "./harness.mjs";
import { asset,draft } from "./fixtures.mjs";
import { openEditor,loadDraft } from "./helpers.mjs";
test("repeated-source transition/tail renders reuse bounded decoder streams in both plans",async({page},info)=>{
  test.setTimeout(120000);await openEditor(page);
  const source=await asset("rate-24.mp4",{hasAudio:false,sourceFps:24});
  const clips=[{...source,id:"first"},await asset("landscape-red.png",{id:"bridge",startTime:.75,duration:.5,transitionDuration:.25}),{...source,id:"tail",startTime:1,transitionDuration:.25}];
  const evidence=[];
  for(const single of [false,true])for(let repeat=0;repeat<3;repeat++){
    await loadDraft(page,draft(clips));await page.getByRole("button",{name:"draft",exact:true}).click();
    await page.getByRole("checkbox",{name:"Compatibility render (one encoder)",exact:true}).setChecked(single);
    const ready=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();expect(await(await ready).failure()).toBeNull();
    await expect(page.getByRole("button",{name:"Export video",exact:true})).toBeEnabled();
    const state=await page.locator("#export-evidence").evaluate(el=>JSON.parse(el.textContent));
    const counts=[0,1].map(segment=>Math.max(0,...state.diagnostics.filter(point=>point.segment===segment).map(point=>point.decodersCreated??0)));
    for(const segment of single?[0]:[0,1])expect(counts[segment]).toBeGreaterThan(0);
    expect(state.phaseResults.find(result=>result.phase==="preparing"&&result.profile).profile.frames).toBe(48);
    expect(state.result.videoBytes).toBeGreaterThan(0);
    evidence.push({single,repeat,counts});
    await info.attach(`decoder-bound-${single}-${repeat}`,{body:JSON.stringify(evidence.at(-1)),contentType:"application/json"});
    expect(counts.reduce((a,b)=>a+b,0)).toBeLessThanOrEqual(4);
  }
});
