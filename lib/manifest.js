import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function readManifest(dir) {
  try {
    const raw = readFileSync(join(dir, "package.json"), "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

export function writeManifest(dir, json) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(json, null, 2) + "\n", "utf8");
}

export function manifestHash(json) {
  const core =
    JSON.stringify(json?.dependencies ?? {}) +
    JSON.stringify(json?.dsh?.profile?.bundles ?? []);
  return createHash("sha256").update(core).digest("hex").slice(0, 16);
}

export function depsOf(json) {
  return Object.keys(json?.dependencies ?? {}).sort();
}

export function bundlesOf(json) {
  return Array.isArray(json?.dsh?.profile?.bundles) ? [...json.dsh.profile.bundles] : [];
}

export function existsProfile(dir) {
  return existsSync(join(dir, "package.json"));
}
