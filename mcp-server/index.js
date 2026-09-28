#!/usr/bin/env node
// ClipBraid MCP server: journal + system state for agents. stdio transport.
// Run: `npm run mcp`. Read-only except journal_append.
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseJournal, insertEntry, LOG_NAMES, LOG_ALLOWLIST } from './lib.js';
import { TOOLS } from './tools.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL = path.join(ROOT, 'reports', 'development', 'JOURNAL.md');
async function readJournal() {
  try { return await readFile(JOURNAL, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return '# ClipBraid development journal\n\n---\n'; throw error; }
}
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
async function git(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: ROOT, timeout: 15000 });
    return stdout.trim();
  } catch (e) { return `error: ${e.message.slice(0, 200)}`; }
}

const server = new Server({ name: 'clipbraid-journal', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'journal_read') {
    const md = await readJournal();
    let entries = parseJournal(md);
    if (args.query) {
      const q = String(args.query).toLowerCase();
      entries = entries.filter((e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q));
    }
    return text(JSON.stringify(entries.slice(0, Math.min(Number(args.limit ?? 5), 50)), null, 2));
  }
  if (name === 'journal_append') {
    const md = await readJournal();
    await mkdir(path.dirname(JOURNAL), { recursive: true });
    await writeFile(JOURNAL, insertEntry(md, String(args.title), String(args.body)), 'utf8');
    return text(`appended entry "${args.title}"`);
  }
  if (name === 'project_state') {
    const [head, status, branch] = await Promise.all([
      git(['log', '--oneline', '-5']), git(['status', '--short']), git(['branch', '--show-current']),
    ]);
    let tsc = 'clean';
    try { await execFileAsync('npx', ['tsc', '--noEmit'], { cwd: ROOT, timeout: 120000 }); }
    catch (e) { tsc = String(e.stdout ?? e.message).slice(0, 500); }
    const mtime = async (p) => (await stat(p).catch(() => null))?.mtime?.toISOString() ?? 'missing';
    let preview = 'unknown';
    try {
      const r = await fetch('http://localhost:4173/', { signal: AbortSignal.timeout(8000) });
      preview = `HTTP ${r.status}`;
    } catch (e) { preview = `down: ${String(e.cause ?? e.message).slice(0, 80)}`; }
    return text(JSON.stringify({
      branch, head: head.split('\n'), dirty: status || '(clean)', tsc,
      appTsxMtime: await mtime(path.join(ROOT, 'App.tsx')),
      distMtime: await mtime(path.join(ROOT, 'dist', 'index.html')),
      preview4173: preview,
    }, null, 2));
  }
  const file = LOG_NAMES[args.name];
  if ((name === 'export_logs' || name === 'e2e_status') && file && LOG_ALLOWLIST.has(file)) {
    const logText = await readFile(file, 'utf8').catch(() => '');
    if (!logText) return text(`log "${args.name}" is empty or missing`);
    if (name === 'export_logs') {
      const n = Math.min(Number(args.lines ?? 20), 100);
      return text(logText.trim().split('\n').slice(-n).join('\n'));
    }
    const threadLines = logText.split('\n').filter((l) => /Thread \d/.test(l));
    const done = logText.includes('Final payload') || logText.includes('EXPORT COMPLETE');
    const failed = logText.includes('Master Export Failed') || logText.includes('EXPORT FAILED');
    const stalled = logText.includes('STALL');
    return text(JSON.stringify({
      log: args.name,
      verdict: done ? 'COMPLETE' : failed ? 'FAILED' : stalled ? 'STALLED' : 'RUNNING',
      lastProgress: threadLines.slice(-4),
      pageErrors: /PAGEERRORS:\s*(\[.*\])/.exec(logText)?.[1] ?? 'n/a',
    }, null, 2));
  }
  if (name === 'export_logs' || name === 'e2e_status') {
    return err(`unknown log "${args.name}" \u2014 use: ${Object.keys(LOG_NAMES).join(' | ')}`);
  }
  return err(`unknown tool "${name}"`);
});
await server.connect(new StdioServerTransport());
