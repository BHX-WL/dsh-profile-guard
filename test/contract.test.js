import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as contract from "../lib/contract.js";

test("defaults match the shipped host contract", () => {
  assert.equal(contract.hostBootMarker(), "__DSH_BOOT__");
  assert.equal(contract.hostAuthMarker(), "authentic");
  assert.deepEqual(contract.pluginFailureTexts(), ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"]);
  assert.equal(contract.noOpenFlag(), "--no-open");
});

test("env overrides take effect", () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_GUARD_BOOT_MARKER = "NEW_MARKER";
    process.env.DSH_GUARD_FAIL_TEXT = "boom;kaboom";
    process.env.DSH_GUARD_NO_OPEN = "--headless";
    assert.equal(contract.hostBootMarker(), "NEW_MARKER");
    assert.deepEqual(contract.pluginFailureTexts(), ["boom", "kaboom"]);
    assert.equal(contract.noOpenFlag(), "--headless");
  } finally {
    for (const k of Object.keys(saved)) process.env[k] = saved[k];
    // also delete keys this test added: --test-isolation=none shares one process across
    // files, and a leaked DSH_GUARD_* override would break probe/boot default tests.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});

test("no lib file imports a @deepseek-ai runtime package (zero runtime coupling)", () => {
  const libDir = join(fileURLToPath(new URL("..", import.meta.url)), "lib");
  const offenders = [];
  for (const f of readdirSync(libDir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(libDir, f), "utf8");
    for (const m of src.matchAll(/from ["']([^"']+)["']/g)) {
      if (m[1].startsWith("@deepseek-ai/") || m[1].startsWith("cordis")) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("checkHostContract reports mismatches without throwing", () => {
  const r = contract.checkHostContract({ bootMarker: "NOPE" });
  assert.ok(Array.isArray(r));
  assert.ok(r.some((x) => x.name === "C2-boot-marker" && x.ok === false && x.observed === "NOPE"));
});
