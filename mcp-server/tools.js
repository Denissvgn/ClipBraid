// Tool schemas shared by index.js (single source of truth for the API).
export const TOOLS = [
  {
    name: 'journal_read',
    description: 'Read the local ClipBraid development journal (newest first). Optional text filter and entry limit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text filter over title + body' },
        limit: { type: 'number', description: 'Max entries (default 5)' },
      },
    },
  },
  {
    name: 'journal_append',
    description: 'Append one dated entry to the ignored local reports/development/JOURNAL.md. Title is a short summary; body is markdown bullets.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Entry title (date prefix added automatically)' },
        body: { type: 'string', description: 'Markdown body: what changed, ran, measured' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'project_state',
    description: 'Git HEAD + status, typecheck result, dist freshness vs sources, preview-server reachability.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_logs',
    description: 'Tail a known export/e2e log file (allow-listed paths only).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Log name: verify | draft | draft2 | mon | out' },
        lines: { type: 'number', description: 'Tail line count (default 20, max 100)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'e2e_status',
    description: 'Parse Thread progress lines + completion/failure markers out of an export/e2e log.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Log name: verify | draft | draft2 | mon | out' },
      },
      required: ['name'],
    },
  },
];
