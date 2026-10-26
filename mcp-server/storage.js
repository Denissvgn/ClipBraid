import { open, mkdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { insertEntry } from "./lib.js";

export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_BYTES = 256 * 1024;
/** Bounded descriptor reads also reject symlink redirection of allow-listed files. */
export async function readBounded(file, maxBytes, tail = false) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file.");
    if (!tail && stat.size > maxBytes) throw new Error("Diagnostic file exceeds its read limit.");
    const start = tail ? Math.max(0, stat.size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, mtimeMs: stat.mtimeMs, truncated: start > 0 };
  } catch (error) {
    if (error.code === "ENOENT") return { text: "", mtimeMs: null, truncated: false };
    throw error;
  } finally { await handle?.close(); }
}
export async function readJournal(file) {
  return (await readBounded(file, MAX_JOURNAL_BYTES)).text || "# ClipBraid development journal\n\n---\n";
}

/** An exclusive lock covers read/modify/rename across clients and server processes. */
export async function appendJournal(file, title, body, timeZone = "Europe/Moscow") {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`, temp = `${file}.${randomUUID()}.tmp`, deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Journal writer is busy; retry after it finishes or recover the abandoned local lock.");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const contents = insertEntry(await readJournal(file), title, body, new Date(), timeZone);
    if (Buffer.byteLength(contents) > MAX_JOURNAL_BYTES) throw new Error("Journal exceeds its size limit; archive local history before appending.");
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true, force: true }); }
}
