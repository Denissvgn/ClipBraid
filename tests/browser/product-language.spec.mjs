import { test, expect } from "./harness.mjs";
import { asset, draft } from "./fixtures.mjs";
import { openEditor, loadDraft } from "./helpers.mjs";
test("project and video actions produce distinct files and explain the delivery boundary",async({page})=>{
  await openEditor(page);await page.getByRole("button",{name:"About ClipBraid",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText("editable JSON file with your media and edits");
  await expect(page.getByRole("dialog")).toContainText("MP4 to watch or share");
  await page.getByRole("button",{name:"Start editing",exact:true}).click();
  await loadDraft(page,draft([await asset("landscape-red.png")]));
  const projectReady=page.waitForEvent("download");await page.getByTitle("Save Project",{exact:true}).click();const project=await projectReady;
  expect(project.suggestedFilename()).toMatch(/\.json$/);const chunks=[];for await(const chunk of await project.createReadStream())chunks.push(chunk);
  const editable=JSON.parse(Buffer.concat(chunks).toString());expect(editable.mediaAssets).toHaveLength(1);expect(editable.schemaVersion).toBe(3);
  await page.getByRole("button",{name:"draft",exact:true}).click();
  const info=page.getByText("Export profile details",{exact:true});
  await expect(page.getByText(/Estimated base64 handoff/)).not.toBeVisible();await info.click();await expect(page.getByText(/Estimated base64 handoff/)).toBeVisible();
  const videoReady=page.waitForEvent("download");await page.getByRole("button",{name:"Export video",exact:true}).click();const video=await videoReady;
  expect(video.suggestedFilename()).toMatch(/\.mp4$/);expect(await video.failure()).toBeNull();
  await expect(page.locator('[data-delivery-outcome="download-started"]')).toContainText("final disk storage is controlled by your browser");
});
