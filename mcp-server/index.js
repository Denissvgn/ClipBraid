#!/usr/bin/env node
// ClipBraid MCP server: journal + system state for agents. stdio transport.
// Run: `npm run mcp`. Read-only except journal_append.
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { appendJournal, readJournal, readBounded, MAX_LOG_BYTES } from "./storage.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL = path.join(ROOT, "reports", "development", "JOURNAL.md");
const TIME_ZONE = process.env.CLIPBRAID_TIME_ZONE || "Europe/Moscow";
new Intl.DateTimeFormat("en", { timeZone: TIME_ZONE }); // Reject invalid configuration before accepting writes.
const text = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });
async function git(args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: ROOT,
      timeout: 15000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    return `error: ${e.message.slice(0, 200)}`;
  }
}

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
    const md = await readJournal(JOURNAL);
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
    await appendJournal(JOURNAL, args.title, args.body, TIME_ZONE);
    return text(`appended entry "${args.title}"`);
  }
  if (name === "project_state") {
    const [head, status, branch] = await Promise.all([
      git(["log", "--oneline", "-5"]),
      git(["status", "--short"]),
      git(["branch", "--show-current"]),
    ]);
    let tsc = "clean";
    try {
      await execFileAsync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], {
        cwd: ROOT,
        timeout: 120000,
        maxBuffer: 256 * 1024,
      });
    } catch (e) {
      tsc = String(e.stdout ?? e.message).slice(0, 500);
    }
    const mtime = async (p) =>
      (await stat(p).catch(() => null))?.mtime?.toISOString() ?? "missing";
    let preview = "unknown";
    try {
      const r = await fetch("http://localhost:4173/", {
        signal: AbortSignal.timeout(8000),
      });
      preview = `HTTP ${r.status}`;
    } catch (e) {
      preview = `down: ${String(e.cause ?? e.message).slice(0, 80)}`;
    }
    return text(
      JSON.stringify(
        {
          branch,
          head: head.split("\n"),
          dirty: status || "(clean)",
          tsc,
          appTsxMtime: await mtime(path.join(ROOT, "App.tsx")),
          distMtime: await mtime(path.join(ROOT, "dist", "index.html")),
          preview4173: preview,
        },
        null,
        2,
      ),
    );
  }
  const file = LOG_NAMES[args.name];
  if (
    (name === "export_logs" || name === "e2e_status") &&
    file &&
    LOG_ALLOWLIST.has(file)
  ) {
    let result = await readBounded(path.resolve(ROOT, file), MAX_LOG_BYTES, args.name !== "latest"), legacyFallback = false;
    if (!result.text && LEGACY_LOG_NAMES[args.name]) {
      result = await readBounded(LEGACY_LOG_NAMES[args.name], MAX_LOG_BYTES, true); legacyFallback = true;
    }
    const { text: logText, mtimeMs, truncated } = result;
    if (name === "export_logs") {
      return text(logText ? logText.trim().split("\n").slice(-(args.lines ?? 20)).join("\n") : "Log is empty or missing.");
    }
    const threadLines = logText.split("\n").filter((l) => /Thread \d/.test(l));
    return text(
      JSON.stringify(
        {
          log: args.name,
          ...(args.name === "latest" ? reportStatus(logText ? JSON.parse(logText) : null) : exportStatus(logText, { mtimeMs })),
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
