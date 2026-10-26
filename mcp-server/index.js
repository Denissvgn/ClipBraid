#!/usr/bin/env node
// ClipBraid MCP server: journal + system state for agents. stdio transport.
// Run: `npm run mcp`. Read-only except journal_append.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  parseJournal,
  exportStatus,
  reportStatus,
  LOG_NAMES,
  LEGACY_LOG_NAMES,
  LOG_ALLOWLIST,
} from "./lib.js";
import { TOOLS, validateArguments } from "./tools.js";
import { appendJournal, readJournal, readBounded, readExportLog, MAX_LOG_BYTES } from "./storage.js";
import { sanitizeReport } from "../services/reportPolicy.mjs";
import { createProjectState } from "./projectState.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL = path.join(ROOT, "reports", "development", "JOURNAL.md");
const TIME_ZONE = process.env.CLIPBRAID_TIME_ZONE || "Europe/Moscow";
new Intl.DateTimeFormat("en", { timeZone: TIME_ZONE }); // Reject invalid configuration before accepting writes.
const text = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });
const projectState = createProjectState(ROOT);

const server = new Server(
  { name: "clipbraid-journal", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
  const { name, arguments: raw = {} } = request.params;
  const args = validateArguments(name, raw);
  if (name === "journal_read") {
    const md = await readJournal(JOURNAL, ROOT);
    let entries = parseJournal(md);
    if (args.query) {
      const q = String(args.query).toLowerCase();
      entries = entries.filter(
        (e) =>
          e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q),
      );
    }
    return text(
      JSON.stringify(
        entries.slice(0, args.limit ?? 5),
        null,
        2,
      ),
    );
  }
  if (name === "journal_append") {
    await appendJournal(JOURNAL, args.title, args.body, TIME_ZONE, ROOT);
    return text(`appended entry "${args.title}"`);
  }
  if (name === "project_state") return text(JSON.stringify(await projectState(), null, 2));
  const file = LOG_NAMES[args.name];
  if (
    (name === "export_logs" || name === "e2e_status") &&
    file &&
    LOG_ALLOWLIST.has(file)
  ) {
    const result = args.name === "latest" ? { ...await readBounded(path.resolve(ROOT, file), MAX_LOG_BYTES, false, ROOT), legacyFallback: false }
      : await readExportLog(path.resolve(ROOT, file), LEGACY_LOG_NAMES[args.name], ROOT);
    const { legacyFallback } = result;
    const { text: logText, mtimeMs, truncated } = result;
    let summary = null;
    if (args.name === "latest") try { summary = sanitizeReport(JSON.parse(logText)); } catch { /* Invalid input is unknown; never return its raw fields. */ }
    if (name === "export_logs") {
      if (args.name === "latest") return summary ? text(JSON.stringify(summary)) : err("Invalid or missing job summary.");
      return text(logText ? logText.trim().split("\n").slice(-(args.lines ?? 20)).join("\n") : "Log is empty or missing.");
    }
    const threadLines = logText.split("\n").filter((l) => /Thread \d/.test(l));
    return text(
      JSON.stringify(
        {
          log: args.name,
          ...(args.name === "latest" ? reportStatus(summary) : exportStatus(logText, { mtimeMs })),
          legacyFallback,
          truncated,
          lastProgress: threadLines.slice(-4),
          pageErrors: /PAGEERRORS:\s*(\[.*\])/.exec(logText)?.[1] ?? "n/a",
        },
        null,
        2,
      ),
    );
  }
  if (name === "export_logs" || name === "e2e_status") {
    return err(
      `unknown log "${args.name}" \u2014 use: ${Object.keys(LOG_NAMES).join(" | ")}`,
    );
  }
  return err(`unknown tool "${name}"`);
  } catch (error) { return err(String(error.message ?? error).slice(0, 500)); }
});
await server.connect(new StdioServerTransport());
