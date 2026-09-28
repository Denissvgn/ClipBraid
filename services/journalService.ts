/**
 * Journal service — two surfaces, one module:
 *
 * 1. SYSTEM EVENTS (live): append-only ring buffer of what THIS app instance
 *    does — imports, probes, normalizations, exports, saves, errors. The
 *    viewer subscribes and live-updates. Survives across exports within the
 *    session; cleared on reload (history belongs in the dev log).
 * 2. DEV LOG (development only): the local reports/development/JOURNAL.md — the cross-session
 *    handoff diary. Read-only at runtime; agents append via MCP.
 */

export type SystemEventKind =
  | 'import' | 'probe' | 'normalize' | 'export' | 'save' | 'error' | 'info';

export interface SystemEvent {
  /** ms since performance.timeOrigin (monotonic, session-relative). */
  at: number;
  /** Wall-clock HH:MM:SS for display. */
  clock: string;
  kind: SystemEventKind;
  msg: string;
}

const MAX_EVENTS = 300;
const events: SystemEvent[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(l => l());
}

/** Append one system event; oldest entries fall off past MAX_EVENTS. */
export function logEvent(kind: SystemEventKind, msg: string): void {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  events.push({
    at: performance.now(),
    clock: `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
    kind,
    msg: msg.slice(0, 300),
  });
  while (events.length > MAX_EVENTS) events.shift();
  emit();
}

/** Snapshot (newest last; viewer reverses for newest-first display). */
export function getEvents(): SystemEvent[] {
  return [...events];
}

/** Subscribe to new events; returns an unsubscribe function. */
export function subscribeEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface JournalEntry {
  /** Raw `## ` heading line, e.g. "2026-09-21 21:45 UTC+3 — title". */
  title: string;
  /** ISO-ish date prefix parsed from the heading (`YYYY-MM-DD HH:MM`), or ''. */
  date: string;
  /** Markdown body lines (without the heading). */
  body: string;
}

const HEADING_RE = /^##\s+(.*)$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/;

export function parseJournal(markdown: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  let current: JournalEntry | null = null;
  const body: string[] = [];
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
      const title = h[1].trim();
      current = { title, date: title.match(DATE_RE)?.[1] ?? '', body: '' };
    } else if (current) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

/** Newest-first (file order) filter by free text over title + body. */
export function filterJournal(entries: JournalEntry[], query: string): JournalEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(e =>
    e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q));
}
