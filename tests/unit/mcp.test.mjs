import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  parseJournal,
  insertEntry,
  exportVerdict,
} from "../../mcp-server/lib.js";

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
    } finally {
      await client.close();
      await transport.close();
    }
  },
);

test("delivery status requires acknowledgement and prioritizes failure over payload or completion", () => {
  for (const text of [
    "Final payload: 2 MB",
    "EXPORT STARTED\nFinal payload: 2 MB",
  ])
    assert.equal(exportVerdict(text), "RUNNING");
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
    "COMPLETE",
  );
  assert.equal(
    exportVerdict("EXPORT FAILED\nEXPORT STARTED\nFinal payload"),
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
