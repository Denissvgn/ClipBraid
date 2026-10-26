import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";

async function contrast(page, pairs) {
  return page.evaluate(pairs => {
    const canvas=document.createElement("canvas");canvas.width=canvas.height=1;const ctx=canvas.getContext("2d");
    const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
    const luminance=color=>rgb(color).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const token=name=>name.includes("(") ? name : getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`);
    return pairs.map(([foreground,background,minimum])=>{
      const a=luminance(token(foreground)),b=luminance(token(background));
      return {foreground,background,minimum,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    });
  },pairs);
}
test("semantic identity colors meet text, essential component and focus contrast targets",async({page},info)=>{
  await openEditor(page);
  const pairs = [
    ...["paper","surface","surface-soft","accent-soft"].flatMap(bg=>["ink","muted","subtle"].map(fg=>[fg,bg,4.5])),
    ["preview-ink","preview",4.5],["preview-muted","preview",4.5],
    ["video-ink","video",4.5],["photo-ink","photo",4.5],["audio-ink","audio",4.5],["audio-alt-ink","audio-alt",4.5],
    ["error","error-soft",4.5],["error","surface",4.5],
    ["accent-ink","accent",4.5],["accent-ink","accent-hover",4.5],
    ...["paper","surface","surface-soft","video","photo","audio","audio-alt"].map(bg=>["rule-strong",bg,3]),
    ...["paper","surface","surface-soft","accent-soft"].map(bg=>["focus",bg,3]),
    ["focus-on-dark","preview",3],["preview-rule","preview",3],
  ];
  const measured=await contrast(page,pairs);
  await info.attach("identity-contrast",{body:JSON.stringify(measured,null,2),contentType:"application/json"});
  expect(measured.filter(pair=>pair.ratio<pair.minimum)).toEqual([]);
  const playhead=page.getByRole("slider",{name:"Playhead time",exact:true});
  await playhead.focus();expect(await playhead.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe("solid");
});
test("the identity and recovery actions remain usable at phone and laptop sizes",async({page},info)=>{
  await page.addInitScript(()=>{window.Flow={save:async()=>undefined}});
  await openEditor(page);await loadDraft(page,draft([await asset("landscape-red.png")]));
  for(const width of [320,375,414,768,1280]){
    await page.setViewportSize({width,height:844});
    await expect(page.getByRole("button",{name:"About ClipBraid",exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:info.outputPath(`identity-${width}.png`)});
  }
  await page.setViewportSize({width:375,height:844});
  await page.getByRole("button",{name:"draft",exact:true}).click();
  await page.getByRole("button",{name:"Export video",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry export",exact:true})).toBeVisible();
  const colors=await page.getByRole("button",{name:"Retry export",exact:true}).evaluate(el=>{
    const style=getComputedStyle(el),parent=getComputedStyle(el.closest(".export-overlay"));
    return {background:style.backgroundColor,foreground:style.color,parent:parent.backgroundColor};
  });
  const measured=await contrast(page,[[colors.background,colors.parent,3],[colors.foreground,colors.background,4.5]]);
  expect(measured.every(pair=>pair.ratio>=pair.minimum)).toBe(true);
  await page.getByText("Technical details",{exact:true}).click();
  const field=page.getByRole("textbox",{name:"Copyable job diagnostics",exact:true});await field.focus();
  expect(await field.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe("solid");
  await page.screenshot({path:info.outputPath("identity-phone-error.png")});
});
