// Shared pure logic: journal parse/insert + log allow-list.
const HEADING_RE = /^##\s+(.*)$/;

export function parseJournal(markdown) {
  const entries = [];
  let current = null;
  const body = [];
  const flush = () => {
    if (current) {
      current.body = body.join("\n").trim();
      entries.push(current);
    }
    body.length = 0;
  };
  for (const line of markdown.split("\n")) {
    const h = line.match(HEADING_RE);
    if (h) {
      flush();
      current = { title: h[1].trim(), body: "" };
    } else if (current) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

export function insertEntry(markdown, title, body, now = new Date()) {
  const stamp = new Date(now.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const entry = `\n## ${stamp} UTC+3 \u2014 ${String(title).slice(0, 120)}\n\n${String(body).trim()}\n`;
  const idx = markdown.indexOf("---\n");
  if (idx === -1) return markdown + entry;
  return markdown.slice(0, idx + 4) + entry + markdown.slice(idx + 4);
}

export const LOG_NAMES = {
  verify: "/tmp/e2e_verify.txt",
  draft: "/tmp/e2e_draft.txt",
  draft2: "/tmp/e2e_draft2.txt",
  mon: "/tmp/e2e_mon.txt",
  out: "/tmp/e2e_out.txt",
};

export const LOG_ALLOWLIST = new Set(Object.values(LOG_NAMES));

// Terminal save acknowledgement is required. Encoder output alone is not delivery.
export function exportVerdict(logText) {
  const start = logText.lastIndexOf("EXPORT STARTED");
  const run = start < 0 ? logText : logText.slice(start);
  if (
    /Master Export Failed|EXPORT FAILED|Export failed|Save rejected/.test(run)
  )
    return "FAILED";
  if (run.includes("STALL")) return "STALLED";
  if (run.includes("EXPORT COMPLETE")) return "COMPLETE";
  return "RUNNING";
}
