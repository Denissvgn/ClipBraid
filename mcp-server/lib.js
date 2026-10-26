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

export function insertEntry(markdown, title, body, now = new Date(), timeZone = "Europe/Moscow") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).formatToParts(now);
  const part = type => parts.find(value => value.type === type)?.value;
  const stamp = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${part("timeZoneName").replace("GMT", "UTC")}`;
  const entry = `\n## ${stamp} \u2014 ${title}\n\n${body.trim()}\n`;
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

// Negative terminal outcomes outrank late acknowledgements; a heartbeat is required for RUNNING.
export function exportStatus(logText, { mtimeMs = null, nowMs = Date.now(), maxIdleMs = 45_000, aborted = false } = {}) {
  const marker = logText.lastIndexOf("EXPORT STARTED");
  let run = marker < 0 ? logText : logText.slice(marker);
  const startedLine = run.lastIndexOf('"type":"started"');
  if (startedLine >= 0) run = run.slice(run.lastIndexOf("\n", startedLine) + 1);
  const events = run.split("\n").flatMap(line => {
    const index = line.indexOf("EXPORT EVENT ");
    if (index < 0) return [];
    try { const event = JSON.parse(line.slice(index + 13)); return event.schemaVersion === 1 &&
      typeof event.jobId === "string" && event.jobId.length <= 160 && typeof event.buildId === "string" && event.buildId.length <= 160 ? [event] : []; }
    catch { return []; }
  });
  const last = events.at(-1), jobId = events.findLast(event => event.type === "started")?.jobId ?? last?.jobId ?? null;
  const current = events.filter(event => event.jobId === jobId);
  const heartbeatMs = Math.max(...current.map(event => Date.parse(event.at)).filter(Number.isFinite), mtimeMs ?? 0) || null;
  const stale = heartbeatMs === null || nowMs - heartbeatMs > maxIdleMs || heartbeatMs > nowMs + 5000;
  const failure = current.findLast(event => event.type === "failed");
  const cancelled = current.findLast(event => event.type === "cancelled");
  const unknown = current.findLast(event => event.type === "unknown");
  const delivered = current.findLast(event => ["download-started", "host-accepted"].includes(event.type));
  const terminal = failure ?? cancelled ?? unknown ?? delivered;
  const verdict = failure ? "FAILED" : cancelled ? "CANCELLED" : unknown ? "UNKNOWN"
    : /Master Export Failed|EXPORT FAILED|EXPORT STOPPED|Export failed|Save rejected/i.test(run) ? "FAILED" : delivered?.type === "download-started" ? "DOWNLOAD_STARTED"
    : delivered?.type === "host-accepted" ? "HOST_ACCEPTED" : aborted || /RUN ABORTED/.test(run) ? "ABORTED"
    : run.includes("STALL") ? "STALLED" : stale || (!current.length && !run.includes("EXPORT STARTED")) ? "UNKNOWN" : "RUNNING";
  return { verdict, jobId, buildId: current.at(-1)?.buildId ?? null,
    heartbeatAt: heartbeatMs === null ? null : new Date(heartbeatMs).toISOString(), stale,
    terminalAt: terminal?.at ?? null, source: current.length ? "structured" : "legacy",
    reason: verdict === "UNKNOWN" ? (stale ? "No recent heartbeat; the run may have stopped." : "No trustworthy terminal delivery outcome.") : null };
}
export function exportVerdict(logText, options = {}) { return exportStatus(logText, options).verdict; }
