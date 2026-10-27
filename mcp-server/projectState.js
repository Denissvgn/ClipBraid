import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { sourceIdentity } from "../scripts/source-identity.mjs";
import { readBounded, MAX_LOG_BYTES } from "./storage.js";

/** Concurrent status requests share one bounded typecheck in this server. */
export function createProjectState(root, execute = promisify(execFile), request = fetch, identity = sourceIdentity) {
  let pending = null;
  async function inspect() {
    const before = identity(root).sha256;
    const git = async args => {
      try { return (await execute("git", args, { cwd: root, timeout: 15000, maxBuffer: 256 * 1024 })).stdout.trim(); }
      catch (error) { return `error: ${String(error.message).slice(0, 200)}`; }
    };
    const [head, status, branch] = await Promise.all([git(["log", "--oneline", "-5"]), git(["status", "--short"]), git(["branch", "--show-current"])]);
    let tsc = "clean", typecheckStatus = "passed";
    try { await execute(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"], { cwd: root, timeout: 120000, maxBuffer: 256 * 1024 }); }
    catch (error) { tsc = `error: ${String(error.stdout || error.stderr || error.message).slice(0, 500)}`; typecheckStatus = "failed"; }
    const current = identity(root).sha256;
    if (before !== current) { tsc = "Source inputs changed during typecheck; request a fresh check."; typecheckStatus = "stale"; }
    let build;
    try {
      const value = JSON.parse((await readBounded(path.join(root, "reports/build-artifacts.json"), MAX_LOG_BYTES, false, root)).text);
      const matches = value.source?.inputsSha256 === current && value.buildId === `${current}:production`;
      build = { buildId: typeof value.buildId === "string" ? value.buildId : null, sourceMatches: matches, artifactsVerified: false,
        scope: "Recorded build source only; use artifact/served-build checks for output integrity." };
    } catch { build = { buildId: null, sourceMatches: false, artifactsVerified: false, scope: "No readable build manifest." }; }
    const mtime = async file => (await stat(file).catch(() => null))?.mtime?.toISOString() ?? "missing";
    let preview = "unknown";
    try { preview = `HTTP ${(await request("http://localhost:4173/", { signal: AbortSignal.timeout(8000) })).status}`; }
    catch (error) { preview = `down: ${String(error.cause ?? error.message).slice(0, 80)}`; }
    return { branch, head: head.split("\n"), dirty: status || "(clean)", tsc, typecheckStatus, sourceInputsSha256: current, build,
      appTsxMtime: await mtime(path.join(root, "App.tsx")), distMtime: await mtime(path.join(root, "dist/index.html")), preview4173: preview };
  }
  return () => {
    if (!pending) pending = inspect().finally(() => { pending = null; });
    return pending;
  };
}
