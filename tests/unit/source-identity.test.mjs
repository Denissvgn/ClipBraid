import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { sourceIdentity } from "../../scripts/source-identity.mjs";
test("source archives without Git receive stable identities without private evidence", () => {
  const root=mkdtempSync('/tmp/clipbraid-source-identity-');
  try {
    writeFileSync(root+'/App.tsx','export const app=1;');mkdirSync(root+'/reports');writeFileSync(root+'/reports/private.json','secret');
    const first=sourceIdentity(root);assert.equal(first.inputs.length,1);
    writeFileSync(root+'/reports/private.json','different');assert.equal(sourceIdentity(root).sha256,first.sha256);
    writeFileSync(root+'/App.tsx','export const app=2;');assert.notEqual(sourceIdentity(root).sha256,first.sha256);
  } finally {rmSync(root,{recursive:true,force:true});}
});
