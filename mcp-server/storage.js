import { open, mkdir, rename, rm, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { insertEntry } from "./lib.js";

export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_BYTES = 256 * 1024;
/** Trust the supplied root (or OS temp root), never a redirect below it. */
async function regularPath(file, root) {
  file = path.resolve(file);
  const temporary = path.resolve(tmpdir()), relativeTemp = path.relative(temporary, file);
  const underTemp = relativeTemp !== ".." && !relativeTemp.startsWith(".." + path.sep) && !path.isAbsolute(relativeTemp);
  const base = path.resolve(root ?? (underTemp ? temporary : path.parse(file).root));
  const relative = path.relative(base, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Diagnostic path is outside its allowed root.");
  let current = await realpath(base);
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const value = await lstat(current);
      if (value.isSymbolicLink()) throw new Error("Symlink redirection of a diagnostic path is not allowed.");
      if (index < parts.length - 1 ? !value.isDirectory() : !value.isFile()) throw new Error("Expected a regular file and directory path.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}
export const safeFilePath = regularPath;
/** Bounded descriptor reads also reject symlink redirection of allow-listed files. */
export async function readBounded(file, maxBytes, tail = false, root = undefined) {
  let handle;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JOURNAL_BYTES) throw new Error("Invalid diagnostic read limit.");
    file = await regularPath(file, root);
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file.");
    if (!tail && stat.size > maxBytes) throw new Error("Diagnostic file exceeds its read limit.");
    const start = tail ? Math.max(0, stat.size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, start + total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    let text = buffer.subarray(0, total).toString("utf8");
    if (start > 0) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
    return { text, mtimeMs: stat.mtimeMs, truncated: start > 0 };
  } catch (error) {
    if (error.code === "ENOENT") return { text: "", mtimeMs: null, truncated: false };
    throw error;
  } finally { await handle?.close(); }
}
export async function readJournal(file, root = undefined) {
  return (await readBounded(file, MAX_JOURNAL_BYTES, false, root)).text || "# ClipBraid development journal\n\n---\n";
}
export async function readExportLog(file, legacyFile = undefined, root = undefined) {
  const current = await readBounded(file, MAX_LOG_BYTES, true, root);
  if (current.mtimeMs === null && legacyFile) return { ...await readBounded(legacyFile, MAX_LOG_BYTES, true), legacyFallback: true };
  return { ...current, legacyFallback: false };
}

/** An exclusive lock covers read/modify/rename across clients and server processes. */
export async function appendJournal(file, title, body, timeZone = "Europe/Moscow", root = undefined) {
  file = await regularPath(file, root);
  if (root != null) root = await realpath(path.resolve(root));
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
    const contents = insertEntry(await readJournal(file, root), title, body, new Date(), timeZone);
    if (Buffer.byteLength(contents) > MAX_JOURNAL_BYTES) throw new Error("Journal exceeds its size limit; archive local history before appending.");
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true, force: true }); }
}
