// Shared pure logic: journal parse/insert + log allow-list.
const HEADING_RE = /^##\s+(.*)$/;

export function parseJournal(markdown) {
  const entries = [];
  let current = null;
  const body = [];
  const flush = () => {
    if (current) {
      current.body = body.join('\n').trim();
      entries.push(current);
    }
    body.length = 0;
  };
  for (const line of markdown.split('\n')) {
    const h = line.match(HEADING_RE);
    if (h) {
      flush();
      current = { title: h[1].trim(), body: '' };
    } else if (current) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

export function insertEntry(markdown, title, body) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  const entry = `\n## ${stamp} UTC+3 \u2014 ${String(title).slice(0, 120)}\n\n${String(body).trim()}\n`;
  const idx = markdown.indexOf('---\n');
  if (idx === -1) return markdown + entry;
  return markdown.slice(0, idx + 4) + entry + markdown.slice(idx + 4);
}

export const LOG_NAMES = {
  verify: '/tmp/e2e_verify.txt',
  draft: '/tmp/e2e_draft.txt',
  draft2: '/tmp/e2e_draft2.txt',
  mon: '/tmp/e2e_mon.txt',
  out: '/tmp/e2e_out.txt',
};

export const LOG_ALLOWLIST = new Set(Object.values(LOG_NAMES));
