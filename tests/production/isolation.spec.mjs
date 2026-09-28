import { test, expect } from '../browser/harness.mjs';
import { openEditor } from '../browser/helpers.mjs';

test('production query parameters cannot expose automation or development journal',async({page})=>{
  await openEditor(page);
  expect(await page.evaluate(()=>typeof window.__clipbraidE2E)).toBe('undefined');
  await page.getByTitle('Diagnostics',{exact:true}).click();
  await expect(page.getByRole('button',{name:'System events',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Dev log',exact:true})).toHaveCount(0);
  for(const path of ['/clipbraid-reference-draft.json','/__fixtures__/reference.json','/tests/probe.html']){
    const response=await page.request.get(path);
    // Static SPA servers may fall back to index.html; neither result is fixture data.
    expect((await response.text()).startsWith('<!doctype html>')||response.status()===404).toBe(true);
  }
});
