import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
export function sourceIdentity(root = process.cwd()) {
  const sha = data => createHash("sha256").update(data).digest("hex");
  let paths;
  try { paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean); }
  catch {
    const directories = new Set(["components", "services", "scripts", "tests", "types", "mcp-server", ".github"]);
    const walk = (relative = "") => readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return relative || directories.has(entry.name) ? walk(path) : [];
      return entry.isFile() ? [path] : [];
    });
    paths = walk();
  }
  const inputs = [...new Set(paths)].filter(path => /\.(tsx?|m?js|css|html|json|ya?ml)$/.test(path) || [".node-version", ".npmrc"].includes(path))
    .filter(path => !path.startsWith("test-data/")).sort().map(path => ({ path, sha256: sha(readFileSync(join(root, path))) }));
  return { inputs, sha256: sha(JSON.stringify(inputs)) };
}
