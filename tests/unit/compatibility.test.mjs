import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModule, loadDiagnostics } from "../source-probes.mjs";
import { LOG_NAMES, LEGACY_LOG_NAMES } from "../../mcp-server/lib.js";
import { TOOLS, validateArguments } from "../../mcp-server/tools.js";
const { normalizeProjectFilename } = loadModule("services/projectNames.ts");
test("chosen filenames retain user wording while unsafe suggestions are bounded basenames",()=>{
  for(const name of ["My RED VOX cut.json","Мой монтаж 🎬.JSON","My.Project.v2.json"])
    assert.equal(normalizeProjectFilename(name),name);
  assert.equal(normalizeProjectFilename("../../Private cut.json"),"Private cut.json");
  assert.equal(normalizeProjectFilename("C:\\drafts\\My:cut.json"),"My_cut.json");
  assert.equal(normalizeProjectFilename("CON.json"),"_CON.json");
  assert.equal(normalizeProjectFilename("movie.mp4"),"movie.mp4.json");
  assert.equal(normalizeProjectFilename(".json"),null);assert.equal(normalizeProjectFilename({name:"bad"}),null);
  const long = normalizeProjectFilename("🎬".repeat(120)+".json");assert.ok(new TextEncoder().encode(long).length<=240);assert.ok(long.endsWith(".json"));
});
test("rebrand preserves package lock identity and the established MCP tool contracts",()=>{
  const pkg=JSON.parse(readFileSync("package.json")),lock=JSON.parse(readFileSync("package-lock.json"));
  assert.equal(pkg.name,lock.name);assert.equal(pkg.name,lock.packages[""].name);
  assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[""].version);
  assert.deepEqual(TOOLS.map(tool=>tool.name).sort(),["e2e_status","export_logs","journal_append","journal_read","project_state"]);
  for(const name of ["verify","draft","draft2","mon","out"]){
    assert.ok(LOG_NAMES[name].startsWith("reports/diagnostics/"));assert.ok(LEGACY_LOG_NAMES[name].startsWith("/tmp/e2e_"));
    assert.equal(validateArguments("e2e_status",{name}).name,name);
  }
  const project=loadModule("services/project.ts"), media=loadModule("services/mediaSources.ts");
  const recovery=loadModule("services/recovery.ts",{"./project":project,"./mediaSources":media,"./projectNames":{normalizeProjectFilename}});
  assert.equal(recovery.RECOVERY_DATABASE,"clipbraid-local-projects");
  assert.equal(loadDiagnostics().DIAGNOSTIC_KEY,"clipbraid.export-diagnostics.v1");
});
