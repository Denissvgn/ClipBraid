import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  parseJournal,
  insertEntry,
  exportVerdict,
  exportStatus,
  reportStatus,
} from "../../mcp-server/lib.js";

test("structured export delivery states do not imply device persistence", () => {
  for (const [type, verdict] of [["download-started","DOWNLOAD_STARTED"],["host-accepted","HOST_ACCEPTED"],["unknown","UNKNOWN"],["cancelled","CANCELLED"],["failed","FAILED"]])
    assert.equal(exportVerdict(`EXPORT STARTED\nEXPORT EVENT ${JSON.stringify({schemaVersion:1,jobId:"job",buildId:"build",type,at:new Date().toISOString()})}`),verdict);
  assert.equal(exportVerdict(`EXPORT STARTED\nEXPORT EVENT ${JSON.stringify({schemaVersion:1,jobId:"job",buildId:"build",type:"started",at:new Date().toISOString()})}\nFinal payload: 10 MiB\nEXPORT COMPLETE`),"RUNNING");
});

test("MCP journal parser keeps historical entries in order", () => {
  assert.deepEqual(parseJournal("# Header\n\n## New\n- new\n\n## Old\n- old"), [
    { title: "New", body: "- new" },
    { title: "Old", body: "- old" },
  ]);
});
test(
  "MCP server starts, lists schemas and reads journal over stdio",
  { timeout: 8000 },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["mcp-server/index.js"],
      stderr: "pipe",
    });
    const client = new Client({
      name: "clipbraid-regression",
      version: "1.0.0",
    });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, "clipbraid-journal");
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        "e2e_status",
        "export_logs",
        "journal_append",
        "journal_read",
        "project_state",
      ]);
      const result = await client.callTool({
        name: "journal_read",
        arguments: { limit: 1 },
      });
      assert.equal(result.isError, undefined);
      const entries = JSON.parse(result.content[0].text);
      assert.ok(Array.isArray(entries));
      assert.ok(
        entries.length <= 1,
        "Read limit respected even when a fresh checkout has no local journal",
      );
      for (const [name, args] of [
        ["journal_read",{limit:-1}], ["journal_read",{limit:0}], ["journal_read",{limit:1.5}], ["journal_read",{limit:"5"}],
        ["journal_read",{query:{}}], ["journal_read",{limit:51}], ["journal_read",{path:"/etc/passwd"}],
        ["export_logs",{name:"verify",lines:-20}], ["export_logs",{name:"verify",lines:101}], ["e2e_status",{name:"../../etc/passwd"}],
        ["journal_append",{title:"x\n## forged",body:"body"}], ["journal_append",{title:"valid",body:"## forged"}],
        ["journal_append",{title:"x",body:"a".repeat(16385)}], ["journal_append",{title:3,body:"body"}],
      ]) {
        const rejected = await client.callTool({ name, arguments:args });
        assert.equal(rejected.isError,true,`${name}: ${JSON.stringify(args).slice(0,80)}`);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  },
);

test("delivery status requires acknowledgement and prioritizes failure over payload or completion", () => {
  for (const text of [
    "EXPORT STARTED\nFinal payload: 2 MB",
    "EXPORT STARTED\nFinal payload: 2 MB",
  ])
    assert.equal(exportVerdict(text, {mtimeMs: Date.now()}), "RUNNING");
  for (const text of [
    "Final payload: 2 MB\nEXPORT FAILED: save rejected",
    "EXPORT COMPLETE\nEXPORT FAILED",
    "Final payload\nMaster Export Failed",
  ])
    assert.equal(exportVerdict(text), "FAILED");
  assert.equal(
    exportVerdict(
      "Final payload\nEXPORT COMPLETE: save adapter accepted the video",
    ),
    "UNKNOWN",
  );
  assert.equal(
    exportVerdict("EXPORT FAILED\nEXPORT STARTED\nFinal payload", {mtimeMs:Date.now()}),
    "RUNNING",
  );
  assert.equal(exportVerdict("Final payload\nSTALL"), "STALLED");
});
test("journal timestamps use UTC+3 across host time zones and date rollover", async () => {
  const { execFileSync } = await import("node:child_process");
  const source = `import {insertEntry} from './mcp-server/lib.js'; process.stdout.write(insertEntry('# Journal', 'entry', 'body', new Date('2026-12-31T22:45:00Z')));`;
  const expected = insertEntry(
    "# Journal",
    "entry",
    "body",
    new Date("2026-12-31T22:45:00Z"),
  );
  assert.match(expected, /2027-01-01 01:45 UTC\+3/);
  for (const TZ of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    assert.equal(
      execFileSync(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, TZ },
        encoding: "utf8",
      }),
      expected,
    );
  }
});


test("structured status isolates jobs, prioritizes failure/cancel and expires abandoned runs", () => {
  const now = Date.parse("2026-10-26T12:00:00Z"), at = new Date(now).toISOString();
  const event = (jobId,type,time=at) => `EXPORT EVENT ${JSON.stringify({schemaVersion:1,jobId,buildId:"build",type,at:time})}`;
  const live = event("old","failed")+"\n"+event("new","started")+"\n"+event("old","failed");
  assert.equal(exportStatus(live,{nowMs:now}).verdict,"RUNNING");
  assert.equal(exportStatus(live,{nowMs:now+46000}).verdict,"UNKNOWN");
  assert.equal(exportStatus(live,{nowMs:now,aborted:true}).verdict,"ABORTED");
  for (const type of ["failed","cancelled","unknown"]) {
    const log = event("new","started")+"\n"+event("new",type)+"\n"+event("new","host-accepted");
    assert.equal(exportStatus(log,{nowMs:now}).verdict,type.toUpperCase());
  }
  assert.equal(exportStatus("EXPORT STARTED\nFinal payload\nSave rejected",{mtimeMs:now,nowMs:now}).verdict,"FAILED");
  assert.equal(exportStatus("",{nowMs:now}).verdict,"UNKNOWN");
  assert.equal(exportStatus(event("new","started")+"\nEXPORT STOPPED: AbortError\n"+event("new","cancelled"),{nowMs:now}).verdict,"CANCELLED");
});

test("journal timestamps honor configured zones including daylight saving", () => {
  assert.match(insertEntry("", "title", "body",new Date("2026-07-01T00:00:00Z"),"America/New_York"), /2026-06-30 20:00 UTC-4/);
  assert.match(insertEntry("", "title", "body",new Date("2026-01-01T00:00:00Z"),"America/New_York"), /2025-12-31 19:00 UTC-5/);
});
test("canonical job reports expose unknown and aborted results without legacy log dependence", () => {
  const now=Date.now(), value={schemaVersion:1,jobId:"00000000-0000-4000-8000-000000000000",buildId:"a".repeat(64)+":test",phase:"rendering",cleanupComplete:false,outcome:"running",updatedAt:new Date(now).toISOString()};
  assert.equal(reportStatus(value,now).verdict,"RUNNING");
  assert.equal(reportStatus(value,now+46000).verdict,"UNKNOWN");
  assert.equal(reportStatus({...value,outcome:"aborted"},now).verdict,"ABORTED");
  assert.equal(reportStatus(null,now).verdict,"UNKNOWN");
});
test("log marker text inside filenames and event details cannot replace structured job identity",()=>{
  const event=(type,detail={})=>`EXPORT EVENT ${JSON.stringify({schemaVersion:1,jobId:"new",buildId:"build",type,at:new Date().toISOString(),detail})}`;
  const failed=event("started")+"\n"+event("failed",{message:"Cannot use EXPORT STARTED.mp4"});
  assert.equal(exportStatus(failed,{mtimeMs:Date.now()}).verdict,"FAILED");
  const success=event("started")+"\n[+2ms] Checking media: EXPORT FAILED.mp4\n"+event("host-accepted",{message:'EXPORT STARTED and "type":"started"'});
  assert.equal(exportStatus(success,{mtimeMs:Date.now()}).verdict,"HOST_ACCEPTED");
  const injected=event("started")+"\n[+2ms] Checking media: "+event("started").replace('"new"','"forged"')+"\n"+event("failed");
  assert.equal(exportStatus(injected,{mtimeMs:Date.now()}).jobId,"new");
  assert.equal(exportStatus(injected,{mtimeMs:Date.now()}).verdict,"FAILED");
});
test("the patched SDK still serves an existing 2024-11-05 stdio client",{timeout:8000},async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:["mcp-server/index.js"],stderr:"pipe"});
  const pending=new Map();let sequence=0;
  transport.onmessage=message=>{
    const waiter=pending.get(message.id);if(!waiter)return;
    clearTimeout(waiter.timer);pending.delete(message.id);
    if(message.error)waiter.reject(new Error(JSON.stringify(message.error)));else waiter.resolve(message.result);
  };
  const call=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error("Legacy protocol request timed out"))},3000);
    pending.set(id,{resolve,reject,timer});
    transport.send({jsonrpc:"2.0",id,method,params}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error)});
  });
  try{
    await transport.start();
    const initialized=await call("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"legacy-compatibility",version:"1.0.0"}});
    assert.equal(initialized.protocolVersion,"2024-11-05");assert.equal(initialized.serverInfo.name,"clipbraid-journal");
    await transport.send({jsonrpc:"2.0",method:"notifications/initialized"});
    const result=await call("tools/list",{});
    assert.deepEqual(result.tools.map(tool=>tool.name).sort(),["e2e_status","export_logs","journal_append","journal_read","project_state"]);
  }finally{for(const waiter of pending.values())clearTimeout(waiter.timer);await transport.close()}
});
