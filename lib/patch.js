// lib/patch.js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function readPatch(profileDir, pkg) {
  const f = join(profileDir, "node_modules", pkg, "cordis.patch.yml");
  try { if (!existsSync(f)) return null; return readFileSync(f, "utf8"); } catch { return null; }
}

// Row-level check mirroring dshmarket's parseSimplePatch scope: only
// "- insert:" blocks with id/name rows qualify for hot-mount. Config blocks,
// disables, expressions, or any non-insert content row → false. Empty/whitespace
// only → false (nothing to mount). Comments (#) tolerated but empty result → false.
export function isPlainInsertPatch(patchText) {
  if (typeof patchText !== "string" || patchText.trim() === "") return false;
  let sawInsert = false;
  let inInsert = false;
  for (const rawLine of patchText.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (/^- insert:\s*$/.test(t)) { inInsert = true; sawInsert = true; continue; }
    if (inInsert) {
      const m = /^(?:id|name):\s*['"]?(@?[A-Za-z0-9._/-]+)['"]?\s*$/.exec(t);
      if (m) { /* valid insert row */ continue; }
      if (/^- /.test(t) || /^[A-Za-z]/.test(t)) { inInsert = false; return false; } // new block or stray row
      continue;
    }
    return false; // non-insert content row outside a block
  }
  return sawInsert;
}

export function declaresClientOnly(pkgDir) {
  try {
    const m = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return m?.dsh?.client !== undefined && m?.dsh?.bundle === undefined;
  } catch { return false; }
}

export function canHotMountByShape(profileDir, pkg) {
  const patch = readPatch(profileDir, pkg);
  if (patch !== null && isPlainInsertPatch(patch)) return { ok: true, via: "insert" };
  const pkgDir = join(profileDir, "node_modules", pkg);
  if (declaresClientOnly(pkgDir)) return { ok: true, via: "client-shim" };
  if (patch === null) return { ok: false, reason: "no bundle patch and no dsh.client surface — nothing to hot-mount" };
  return { ok: false, reason: "bundle patch is not plain inserts (config/expression rows); hot-mount only supports plain inserts — restart required" };
}
