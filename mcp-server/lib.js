// Shared pure logic: journal parse/insert + log allow-list.
import { sanitizeReport, BUILD_ID } from "../services/reportPolicy.mjs";
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
  if (idx === -1) {
    const heading = /^##\s+/m.exec(markdown);
    if (heading) return markdown.slice(0, heading.index) + entry + markdown.slice(heading.index);
    return markdown + entry;
  }
  return markdown.slice(0, idx + 4) + entry + markdown.slice(idx + 4);
}

export const LOG_NAMES = {
  latest: "reports/diagnostics/latest.json",
  verify: "reports/diagnostics/verify.log",
  draft: "reports/diagnostics/draft.log",
  draft2: "reports/diagnostics/draft2.log",
  mon: "reports/diagnostics/mon.log",
  out: "reports/diagnostics/out.log",
};
// Transitional aliases for existing developer configurations; never the primary location.
export const LEGACY_LOG_NAMES = {
  verify: "/tmp/e2e_verify.txt",
  draft: "/tmp/e2e_draft.txt",
  draft2: "/tmp/e2e_draft2.txt",
  mon: "/tmp/e2e_mon.txt",
  out: "/tmp/e2e_out.txt",
};

export const LOG_ALLOWLIST = new Set([...Object.values(LOG_NAMES), ...Object.values(LEGACY_LOG_NAMES)]);

// Negative terminal outcomes outrank late acknowledgements; a heartbeat is required for RUNNING.
export function exportStatus(logText, { mtimeMs = null, nowMs = Date.now(), maxIdleMs = 45_000, aborted = false } = {}) {
  const lines = logText.split("\n"), prefix = /^(?:\[[^\r\n]*?\]\s*)*/;
  const records = lines.flatMap((line, index) => {
    const match = line.replace(prefix, "").match(/^EXPORT EVENT\s+(\{.*\})\s*$/);
    if (!match) return [];
    try { const event = JSON.parse(match[1]); return event.schemaVersion === 1 &&
      typeof event.jobId === "string" && event.jobId.length > 0 && event.jobId.length <= 160 && typeof event.buildId === "string" && event.buildId.length > 0 && event.buildId.length <= 160
      ? [{ event, index }] : []; }
    catch { return []; }
  });
  const started = records.findLast(record => record.event.type === "started");
  const legacyStart = lines.findLastIndex(line => /^EXPORT STARTED(?:\s|$)/.test(line.replace(prefix, "")));
  const boundary = started?.index ?? Math.max(0, legacyStart), events = records.filter(record => record.index >= boundary).map(record => record.event);
  const jobId = started?.event.jobId ?? events.at(-1)?.jobId ?? null, buildId = started?.event.buildId ?? events.at(-1)?.buildId;
  const current = events.filter(event => event.jobId === jobId && event.buildId === buildId);
  const runLines = lines.slice(boundary).map(line => line.replace(prefix, ""));
  const rawFailure = runLines.some(line => /^(Master Export Failed|EXPORT FAILED|EXPORT STOPPED|Export failed|Save rejected)\b/i.test(line));
  const heartbeatMs = Math.max(...current.map(event => Date.parse(event.at)).filter(Number.isFinite), current.length ? 0 : mtimeMs ?? 0) || null;
  const stale = heartbeatMs === null || nowMs - heartbeatMs > maxIdleMs || heartbeatMs > nowMs + 5000;
  const failure = current.findLast(event => event.type === "failed");
  const cancelled = current.findLast(event => event.type === "cancelled");
  const unknown = current.findLast(event => event.type === "unknown");
  const delivered = current.findLast(event => ["download-started", "host-accepted"].includes(event.type));
  const terminal = failure ?? cancelled ?? unknown ?? delivered;
  const verdict = failure ? "FAILED" : cancelled ? "CANCELLED" : unknown ? "UNKNOWN"
    : rawFailure ? "FAILED" : delivered?.type === "download-started" ? "DOWNLOAD_STARTED"
    : delivered?.type === "host-accepted" ? "HOST_ACCEPTED" : aborted || runLines.some(line => /^RUN ABORTED\b/.test(line)) ? "ABORTED"
    : runLines.some(line => /^STALL\b/.test(line)) ? "STALLED" : stale || (!current.length && legacyStart < 0) ? "UNKNOWN" : "RUNNING";
  return { verdict, jobId, buildId: current.at(-1)?.buildId ?? null,
    heartbeatAt: heartbeatMs === null ? null : new Date(heartbeatMs).toISOString(), stale,
    terminalAt: terminal?.at ?? null, source: current.length ? "structured" : "legacy",
    reason: verdict === "UNKNOWN" ? (stale ? "No recent heartbeat; the run may have stopped." : "No trustworthy terminal delivery outcome.") : null };
}
export function exportVerdict(logText, options = {}) { return exportStatus(logText, options).verdict; }

export function reportStatus(value, nowMs = Date.now()) {
  value = sanitizeReport(value);
  if (!value || !BUILD_ID.test(value.buildId))
    return { verdict: "UNKNOWN", reason: "Invalid or missing job summary.", source: "job-report" };
  const heartbeat = Date.parse(value.updatedAt), stale = !Number.isFinite(heartbeat) || nowMs - heartbeat > 45_000 || heartbeat > nowMs + 5000;
  return { verdict: value.phase === "failed" && (value.outcome !== "unknown" || value.cleanupComplete !== true) ? "FAILED" : value.phase === "cancelled" ? "CANCELLED"
      : value.outcome === "running" ? (stale ? "UNKNOWN" : "RUNNING") : value.outcome.toUpperCase().replaceAll("-", "_"),
    jobId: value.jobId, buildId: typeof value.buildId === "string" && /^[a-f0-9]{64}:(test|production|development)$/.test(value.buildId) ? value.buildId : null,
    heartbeatAt: Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : null, stale, source: "job-report",
    reason: value.outcome === "running" && stale ? "No recent heartbeat; the run may have stopped." : null };
}
