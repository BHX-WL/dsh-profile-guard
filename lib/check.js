// check: static health check of a profile, read-only (guard check). Returns
// { ok, problems, summary }: a profile is healthy when its manifest parses, no
// insert id repeats in cordis.patch.yml, every declared bundle resolves to a
// package that declares dsh.bundle.patch, and node_modules/@deepseek-ai holds
// no copy of a host core package that would shadow the injected core.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "./manifest.js";
import { profileDir } from "./paths.js";
import { listNodeModulesDeepseekAi } from "./sentinel.js";

const CORE_NAMES = new Set(["dsh-tools", "cordis", "schemastery", "dsh-util-values", "cosmokit", "dsh-client-runtime"]);

export function staticCheck(profile) {
  const dir = profileDir(profile);
  const problems = [];
  const manifest = readManifest(dir);
  if (!manifest) { problems.push({ severity: "error", code: "no-manifest", message: `package.json missing at ${dir}` }); return { ok: false, problems, summary: "no manifest" }; }
  // 1) insert ids in cordis.patch.yml
  const patchPath = join(dir, "cordis.patch.yml");
  if (existsSync(patchPath)) {
    const seen = new Set();
    let inInsert = false;
    for (const line of readFileSync(patchPath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (/^- insert:\s*$/.test(t)) { inInsert = true; continue; }
      if (inInsert && /^name:\s*['"]?([^'"]+)['"]?\s*$/.test(t)) {
        const name = t.match(/^name:\s*['"]?([^'"]+)['"]?\s*$/)[1];
        if (seen.has(name)) problems.push({ severity: "error", code: "dup-insert-id", message: `duplicate insert id ${name}` });
        seen.add(name); inInsert = false;
      }
    }
  }
  // 2) bundles resolve (package dir exists and declares dsh.bundle.patch)
  for (const b of (manifest.dsh?.profile?.bundles ?? [])) {
    const scoped = b.startsWith("@") ? b.split("/").slice(0, 2).join("/") : b;
    const pkgPath = join(dir, "node_modules", scoped, "package.json");
    let ok = false;
    try { const mp = JSON.parse(readFileSync(pkgPath, "utf8")); ok = !!mp?.dsh?.bundle?.patch; } catch { ok = false; }
    if (!ok) problems.push({ severity: "error", code: "unresolvable-bundle", message: `bundle ${b} cannot resolve or lacks dsh.bundle.patch` });
  }
  // 3) @deepseek-ai core shadowing
  for (const name of listNodeModulesDeepseekAi(dir)) {
    if (CORE_NAMES.has(name)) problems.push({ severity: "error", code: "core-shadow", message: `@deepseek-ai/${name} copy present in profile node_modules (core shadowing)` });
  }
  return { ok: problems.every((p) => p.severity !== "error"), problems, summary: problems.length ? problems.map((p) => p.message).join("; ") : "healthy" };
}
