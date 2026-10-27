import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const directories = new Set(["components", "services", "scripts", "tests", "types", "mcp-server", ".github", "assets", "licenses", "guides"]);
const publicGuides = new Set(["guides/using-clipbraid.md", "guides/support.md", "guides/upgrading.md"]);
const rootInputs = new Set([".node-version", ".npmrc", ".gitignore", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]);
const git = (root, args) => execFileSync("git", args, {encoding:"utf8",cwd:root,timeout:5000,maxBuffer:4*1024*1024,stdio:["ignore","pipe","ignore"]});
function hasRepository(root) {
  if (!existsSync(join(root,".git"))) return false;
  if (realpathSync(git(root,["rev-parse","--show-toplevel"]).trim()) !== realpathSync(root))
    throw new Error("Source root does not match its Git repository.");
  return true;
}
export function repositoryState(root = process.cwd()) {
  return hasRepository(root) ? {commit:git(root,["rev-parse","HEAD"]).trim(),dirty:!!git(root,["status","--porcelain"]).trim()}
    : {commit:null,dirty:null};
}
export function sourceIdentity(root = process.cwd()) {
  root = resolve(root);
  const sha = data => createHash("sha256").update(data).digest("hex");
  let paths;
  if (hasRepository(root)) paths = git(root,["ls-files","--cached","--others","--exclude-standard","-z"]).split("\0").filter(Boolean);
  else {
    const walk = (relative = "") => readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() && (relative || directories.has(entry.name))) throw new Error(`Source input symlink rejected: ${path}`);
      if (entry.isDirectory()) return relative || directories.has(entry.name) ? walk(path) : [];
      return entry.isFile() ? [path] : [];
    });
    paths = walk();
  }
  const inputs = [...new Set(paths)].filter(path => !path.includes("/") || directories.has(path.split("/")[0]))
    .filter(path => /\.(?:[cm]?tsx?|[cm]?jsx?|css|html|json|ya?ml|py)$/.test(path) || rootInputs.has(path) || publicGuides.has(path)
      || path.startsWith("assets/") || path.startsWith("licenses/") || (path.startsWith("tests/fixtures/") && !/\.(?:md|mdx)$/i.test(path)))
    .sort().flatMap(path => {
      const file=join(root,path);let stat;
      try {stat=lstatSync(file)} catch(error) {if(error.code==='ENOENT')return [];throw error}
      if(stat.isSymbolicLink())throw new Error(`Source input symlink rejected: ${path}`);
      return stat.isFile()?[{path,sha256:sha(readFileSync(file))}]:[];
    });
  return { inputs, sha256: sha(JSON.stringify(inputs)) };
}
