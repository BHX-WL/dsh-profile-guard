// Sentinel: list top-level dirs under a profile's node_modules/@deepseek-ai.
// Core-shadow sentinel for the tool-lens incident: a stale npm copy of
// @deepseek-ai packages inside profile node_modules would shadow host core.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNodeModulesDeepseekAi } from "../lib/sentinel.js";

// DSH_HOME is the dsh DATA ROOT (holds profiles/ and guards/ directly).
function makeProfile(home, profile, deps, bundles) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, dsh: { profile: { bundles } } }));
  return dir;
}

test("sentinel lists top-level @deepseek-ai dirs", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-h-"));
  try {
    const dir = makeProfile(home, "web", { a: "1" }, []);
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "cordis"), { recursive: true });
    assert.deepEqual(listNodeModulesDeepseekAi(dir), ["cordis", "dsh-tools"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
