// Snapshot core: an install-crash insurance record of a profile's healthy
// state, stored host-side under <data root>/guards/<profile>/<id>/ so a
// profile reset can never reach it. Each snapshot holds a package.json copy
// (deps + bundles), sentinel.json (top-level @deepseek-ai listing, core-shadow
// guard) and meta.json (id/createdAt/reason/dshVersion/healthy/hash).
//
// Write atomicity: content is staged in <id>.tmp and renamed into place, so a
// half-written snapshot never appears under a final id.
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
  copyFileSync, renameSync,
} from "node:fs";
import { join } from "node:path";
import { readManifest, manifestHash, depsOf, bundlesOf } from "./manifest.js";
import { guardsDir, profileDir } from "./paths.js";
import { listNodeModulesDeepseekAi } from "./sentinel.js";

function dshVersion() {
  return process.env.DSH_GUARD_DSH_VERSION || "unknown";
}
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function idOf(nowStr, hash) {
  return `${nowStr}-${hash.slice(0, 8)}`;
}

export async function createSnapshot(profile, { reason = "", healthy = false } = {}) {
  const dir = profileDir(profile);
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`guard: no package.json at ${dir}`);
  const hash = manifestHash(manifest);
  const ts = now();
  const id = idOf(ts, hash);
  const snapDir = join(guardsDir(profile), id);
  // Same-id snapshot already recorded (same second, same manifest hash):
  // return it untouched so an existing healthy flag or reason survives, and a
  // failed rename can never destroy an earlier snapshot.
  const existing = readMeta(snapDir);
  if (existing) return { id, dir: snapDir, healthy: existing.healthy === true };
  const tmpDir = snapDir + ".tmp";
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  copyFileSync(join(dir, "package.json"), join(tmpDir, "package.json"));
  writeFileSync(join(tmpDir, "sentinel.json"), JSON.stringify(listNodeModulesDeepseekAi(dir), null, 2));
  writeFileSync(join(tmpDir, "meta.json"), JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    reason,
    dshVersion: dshVersion(),
    healthy,
    hash,
    deps: depsOf(manifest),
    bundles: bundlesOf(manifest),
  }, null, 2));
  rmSync(snapDir, { recursive: true, force: true });
  mkdirSync(guardsDir(profile), { recursive: true });
  // rename across the same volume; fall back to copy when a rename is refused
  try {
    renameSync(tmpDir, snapDir);
  } catch {
    copyRecursive(tmpDir, snapDir);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { id, dir: snapDir, healthy };
}

function copyRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyRecursive(s, d);
    else copyFileSync(s, d);
  }
}

function readMeta(snapDir) {
  try {
    return JSON.parse(readFileSync(join(snapDir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export function listSnapshots(profile) {
  const root = guardsDir(profile);
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  return names
    .filter((n) => !n.endsWith(".tmp") && n !== "crash")
    .map((n) => {
      const dir = join(root, n);
      const meta = readMeta(dir);
      if (!meta) return { id: n, dir, broken: true, createdAt: "" };
      return {
        id: n, dir, createdAt: meta.createdAt, reason: meta.reason,
        healthy: meta.healthy, hash: meta.hash, deps: meta.deps,
        bundles: meta.bundles, broken: false,
      };
    })
    .filter((s) => s.broken === false || s.createdAt !== "")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function latestHealthy(profile) {
  const s = listSnapshots(profile).find((x) => x.healthy);
  return s ? s.id : null;
}

export function snapshotDirOf(profile, id) {
  return join(guardsDir(profile), id);
}

export function markHealthy(profile, id) {
  const dir = snapshotDirOf(profile, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`guard: snapshot ${id} missing meta`);
  meta.healthy = true;
  meta.promotedAt = new Date().toISOString();
  // Atomic rewrite, same pattern as createSnapshot: stage then rename (a file
  // rename replaces an existing target on Windows), so a crash mid-write can
  // never leave meta.json half-updated.
  const metaPath = join(dir, "meta.json");
  const tmpPath = join(dir, ".meta.tmp");
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2));
  try {
    renameSync(tmpPath, metaPath);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
}

export function prune(profile, keep = Number(process.env.DSH_GUARD_KEEP || 5)) {
  const snaps = listSnapshots(profile);
  for (const s of snaps.slice(keep)) {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

export { guardsDir };
