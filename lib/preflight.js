// Pure preflight verdict layer (design §5): given an already-fetched candidate
// manifest plus injected host facts, decide whether installing it is safe.
// No network, no disk reads — every input arrives through the options object,
// so the whole judgement matrix is unit-testable.
import { staticList } from "./core-packages.js";

// Version range check without a semver dependency: accept "x.y.z", "x.y.z-rc.n",
// ">=x.y.z", "x.y.z || x.y.z2". We only need "does the declared range admit the
// host version" — implement the common prefix/rangeset cases and treat anything
// unparseable as "no claim" (pass). Host version unreadable → unknown → pass.
function rangeAdmits(range, hostVersion) {
  if (!range || !hostVersion) return true;
  const hostParts = hostVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!hostParts) return true; // unparseable host version → no verdict
  const [_, hmaj, hmin, hpat] = hostParts.map((x, i) => (i === 0 ? x : Number(x)));
  // split on || and pass if any alternative admits
  for (const alt of String(range).split("||").map((s) => s.trim())) {
    if (altAdmits(alt, hmaj, hmin, hpat)) return true;
  }
  return false;
}
function altAdmits(alt, hmaj, hmin, hpat) {
  // The alternative must be a complete, judgeable spec: optional operator and
  // "v" prefix, then a full x.y.z triple, anchored at both ends. A partial
  // match ("0.1.x", "1.2", "1.0.0 - 2.0.0", prerelease suffixes) is a range
  // form we cannot faithfully judge, so it opens (passes) instead of being
  // half-parsed into a false rejection (review r1).
  const m = alt.match(/^([<>=~^]*)\s*v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true; // unparseable alternative → treat as open
  const op = m[1] || "";
  const maj = Number(m[2]); const min = Number(m[3]); const pat = Number(m[4]);
  const cmp = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
  const cMaj = cmp(hmaj, maj); const cMin = cMaj !== 0 ? cMaj : cmp(hmin, min); const cPatch = cMin !== 0 ? cMin : cmp(hpat, pat);
  const c = cPatch;
  if (op === ">=") return c >= 0; if (op === ">") return c > 0; if (op === "<") return c < 0; if (op === "<=") return c <= 0;
  if (op === "^") {
    // caret upper bound follows the major: ^1.x := <2.0.0 (major equality);
    // ^0.min.pat := <0.(min+1).0 → same minor required; ^0.0.pat := exact
    // 0.0.pat (next release would be 0.0.pat+1) → patch must equal (review r1).
    if (hmaj !== maj || c < 0) return false;
    if (hmaj > 0) return true;
    if (min === 0) return hmin === 0 && hpat === pat;
    return hmin === min;
  }
  if (op === "~") return hmaj === maj && hmin === min && c >= 0;
  return c === 0; // exact
}

function patchInsertIds(patchText) {
  const ids = []; let inInsert = false;
  for (const line of String(patchText || "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^- insert:\s*$/.test(t)) { inInsert = true; continue; }
    if (!inInsert) continue;
    const m = /^name:\s*['"]?(@?[A-Za-z0-9._/-]+)['"]?\s*$/.exec(t);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export function checkManifest(manifest, { hostVersion, corePackages = staticList(), installedInsertIds = [], candidatePatchText } = {}) {
  const verdicts = [];
  const deps = Object.keys(manifest?.dependencies ?? {});
  const coreDeps = deps.filter((d) => d.startsWith("@deepseek-ai/") && corePackages.includes(d.slice("@deepseek-ai/".length)));
  if (coreDeps.length) {
    verdicts.push({ code: "core-shadow", severity: "error", forceable: true, message: `prod dependency ${coreDeps.join(", ")} shadows the host @deepseek-ai namespace (tool-lens incident shape) — refusing` });
  }
  const engine = manifest?.dsh?.engines?.dsh ?? manifest?.engines?.dsh;
  if (engine && !rangeAdmits(engine, hostVersion)) {
    verdicts.push({ code: "host-incompatible", severity: "error", forceable: false, message: `declares dsh engine ${engine}; host is ${hostVersion || "unknown"}` });
  }
  if (manifest?.dsh?.bundle?.patch && installedInsertIds.length) {
    // candidate patch content is unavailable offline; when provided (downloaded),
    // compare its insert ids against installed ones. Otherwise warn-only (no block).
    if (candidatePatchText !== undefined) {
      const cand = patchInsertIds(candidatePatchText);
      const dup = cand.filter((id) => installedInsertIds.includes(id));
      if (dup.length) verdicts.push({ code: "dup-insert-id", severity: "error", forceable: false, message: `insert id(s) ${dup.join(", ")} already mounted by an installed plugin` });
    } else {
      verdicts.push({ code: "patch-unverified", severity: "warn", forceable: true, message: "declares a bundle patch; could not verify insert-id collisions offline" });
    }
  }
  return { ok: verdicts.every((v) => v.severity !== "error"), verdicts };
}
