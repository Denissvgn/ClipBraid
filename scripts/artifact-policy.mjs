import { readdir, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// No public-directory passthrough. New binary/icon/font/WASM assets require
// an explicit policy change and license/source inventory review.
const approved = (name) =>
  name === "index.html" ||
  /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(name) ||
  /^assets\/clipbraid-[A-Za-z0-9_-]{8,}\.svg$/.test(name) ||
  /^assets\/(geist|space-grotesk|jetbrains-mono)-(latin|cyrillic)-wght-normal-[A-Za-z0-9_-]{8,}\.woff2$/.test(
    name,
  );
const forbidden = [
  "__clipbraidE2E",
  "ClipBraid — System Journal",
  "Internal implementation backlog",
  "clipbraid-reference-draft",
  "IMPLEMENTATION_BACKLOG.md",
  "/tmp/e2e_",
];
export async function inspectArtifacts(root, expected) {
  const inventory = [];
  async function walk(dir = "") {
    for (const name of await readdir(path.join(root, dir))) {
      const relative = path.posix.join(dir, name);
      const file = path.join(root, relative);
      const st = await lstat(file);
      if (st.isSymbolicLink())
        throw new Error(`Artifact symlink rejected: ${relative}`);
      if (st.isDirectory()) {
        if (relative !== "assets")
          throw new Error(`Unapproved artifact directory: ${relative}`);
        await walk(relative);
        continue;
      }
      if (!st.isFile() || !approved(relative))
        throw new Error(`Unapproved artifact: ${relative}`);
      const bytes = await readFile(file);
      const text = bytes.toString("utf8");
      for (const marker of forbidden)
        if (text.includes(marker))
          throw new Error(`Internal/test content in ${relative}: ${marker}`);
      inventory.push({
        path: relative,
        bytes: bytes.length,
        sha256: sha(bytes),
      });
    }
  }
  await walk();
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  if (
    !inventory.some((x) => x.path === "index.html") ||
    !inventory.some((x) => x.path.endsWith(".js"))
  )
    throw new Error("Missing production entry point");
  if (expected) {
    if (inventory.length !== expected.length)
      throw new Error("Artifact inventory differs from the build allow-list");
    for (const item of inventory) {
      const entry = expected.find((x) => x.path === item.path);
      if (!entry || entry.sha256 !== item.sha256)
        throw new Error(`Unapproved or modified artifact: ${item.path}`);
    }
  }
  return inventory;
}

export function assertProductModules(ids, root) {
  for (const id of ids) {
    const relative = path
      .relative(root, id.split("?")[0])
      .replaceAll("\\", "/");
    if (
      /^(tests|test-data|reports|public|docs|notes|plans|planning|naming|branding|indexes|indexing|context|wiki|\.hallmark|\.agents|\.codex)\//i.test(relative) ||
      /^(JOURNAL|HANDOFF|REVIEW|IMPLEMENTATION_BACKLOG|DESIGN|NAMING|BRANDING|INDEX)\.md$/i.test(relative)
    )
      throw new Error(`Non-product module in production: ${relative}`);
  }
}
