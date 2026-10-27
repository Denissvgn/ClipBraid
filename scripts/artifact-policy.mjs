import { readdir, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  "redvox-reference-draft",
];
/** Run before the bundler clears/writes an output tree, not only afterward. */
export function assertSafeOutputDirectory(root) {
  try {lstatSync(root)} catch(error) {if(error.code==='ENOENT')return;throw error}
  const visit=file=>{
    const stat=lstatSync(file);
    if(stat.isSymbolicLink())throw new Error(`Artifact symlink rejected: ${file}`);
    if(stat.isDirectory())for(const entry of readdirSync(file))visit(path.join(file,entry));
  };
  visit(root);
}
export function assertProductArtifact(name, bytes) {
  if(!approved(name))throw new Error(`Unapproved artifact: ${name}`);
  const text=Buffer.from(bytes).toString('utf8');
  for(const marker of forbidden)if(text.includes(marker))throw new Error(`Internal/test content in ${name}: ${marker}`);
}
export async function inspectArtifacts(root, expected) {
  assertSafeOutputDirectory(root);
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
      assertProductArtifact(relative,bytes);
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
  root=path.resolve(root);
  const own=[];
  for (const id of ids) {
    const plain=id.replace(/^\0+/,"");
    if(/^vite\/(?:modulepreload-polyfill|preload-helper)\.js$/.test(plain)||plain==='commonjsHelpers.js'||plain==='__vite-browser-external')continue;
    const file=plain.split("?")[0];
    if(!path.isAbsolute(file))throw new Error(`Non-product virtual module in production: ${id}`);
    const resolved=existsSync(file)?realpathSync(file):file;
    const relative = path
      .relative(root, resolved)
      .replaceAll("\\", "/");
    if(relative.startsWith('node_modules/'))continue;
    const allowed=/^(?:App\.tsx|main\.tsx|platform\.ts|types\.ts|brand\.json|index\.html|fonts\.css|index\.css|tokens\.css|clipbraid\.css|assets\/clipbraid\.svg|README\.md|THIRD_PARTY_NOTICES\.md)$/.test(relative)
      || /^(?:components|services|types)\/(?!\.)(?!.*\/\.)[^?]+\.(?:[cm]?tsx?|[cm]?jsx?|css)$/.test(relative)
      || /^licenses\/[^/]+\.txt$/.test(relative);
    if (!allowed)
      throw new Error(`Non-product module in production: ${relative}`);
    own.push(relative);
  }
  if(own.length&&existsSync(path.join(root,'.git'))){
    const result=spawnSync('git',['check-ignore','--no-index','-z','--stdin'],{cwd:root,input:own.join('\0')+'\0',encoding:'utf8',timeout:5000});
    if(result.status===0)throw new Error(`Non-product ignored module in production: ${result.stdout.split('\0').filter(Boolean).join(', ')}`);
    if(result.status!==1)throw new Error('Cannot verify production modules against Git ignores.');
  }
}
