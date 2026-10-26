// Tool schemas shared by index.js (single source of truth for the API).
export const TOOLS = [
  {
    name: 'journal_read',
    description: 'Read the local ClipBraid development journal (newest first). Optional text filter and entry limit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 512, description: 'Free-text filter over title + body' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max entries (default 5)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'journal_append',
    description: 'Append one dated entry to the ignored local reports/development/JOURNAL.md. Title is a short summary; body is markdown bullets.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120, description: 'One-line entry title (date prefix added automatically)' },
        body: { type: 'string', minLength: 1, maxLength: 16384, description: 'Markdown body; use ### or deeper for subheadings' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_state',
    description: 'Git HEAD/status, one shared bounded typecheck, source hash vs the recorded build, timestamps and preview reachability. Artifact integrity is a separate check.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'export_logs',
    description: 'Tail a known export/e2e log file (allow-listed paths only).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['latest', 'verify', 'draft', 'draft2', 'mon', 'out'], description: 'latest is the bounded current job summary; other names are developer log aliases' },
        lines: { type: 'integer', minimum: 1, maximum: 100, description: 'Tail line count (default 20)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'e2e_status',
    description: 'Structured job outcome, heartbeat and stale/aborted state from a bounded, allow-listed export log. Delivery acknowledgement is not device storage proof.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['latest', 'verify', 'draft', 'draft2', 'mon', 'out'], description: 'Allow-listed job summary or log alias' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

/** @param {string} name @param {unknown} raw */
export function validateArguments(name, raw) {
  const tool = TOOLS.find(tool => tool.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Arguments must be an object.');
  const args = /** @type {Record<string, any>} */ (raw);
  const schema = tool.inputSchema;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('Unknown argument.');
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw new Error(`Missing ${key}.`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)
        throw new Error(`${key} must be an integer from ${rule.minimum} to ${rule.maximum}.`);
    } else if (typeof value !== 'string' || value.length > (rule.maxLength ?? 160) || value.trim().length < (rule.minLength ?? 0))
      throw new Error(`Invalid ${key} string.`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Unknown ${key}.`);
  }
  if (name === 'journal_append' && (/[\r\n\u2028\u2029\x00-\x1f\x7f]/.test(args.title) || /^[ \t]{0,3}#{1,2}(?:\s|$)/m.test(args.body) || args.body.includes('\0')))
    throw new Error('Use a one-line title and ### or deeper body headings.');
  return args;
}
