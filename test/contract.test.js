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

test("an empty DSH_GUARD_FAIL_TEXT override falls back to the default texts (M1: no empty boot regex)", () => {
  const saved = { ...process.env };
  try {
    // env override present but parsing to an empty list must not yield []:
    // isPluginFailure builds RegExp(texts.join("|")) from this and an empty
    // alternation would match every boot log (arming rollback on anything).
    process.env.DSH_GUARD_FAIL_TEXT = ";;";
    assert.deepEqual(contract.pluginFailureTexts(), ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"]);
    process.env.DSH_GUARD_FAIL_TEXT = ";  ; ";
    assert.deepEqual(contract.pluginFailureTexts(), ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"]);
  } finally {
    for (const k of Object.keys(saved)) process.env[k] = saved[k];
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});

test("checkHostContract reports no drift when nothing was observed (C5 must not warn on absent input)", () => {
  // No observed input means "no claim": every probe compares the contract to
  // itself and must come back ok — C2 does this via ?? expected; C5 must not
  // fall back to an empty observed string (that produced a spurious
  // C5-fail-texts warning on every `guard check`, I2).
  const r = contract.checkHostContract();
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 3);
  for (const c of r) assert.equal(c.ok, true, JSON.stringify(c));
});

test("checkHostContract reports C5 drift when observed fail texts differ", () => {
  const r = contract.checkHostContract({ failTexts: ["new failure wording"] });
  assert.ok(r.some((x) => x.name === "C5-fail-texts" && x.ok === false && x.observed === "new failure wording"));
});

test("market bridge contract defaults derive from one base string", () => {
  assert.equal(contract.marketTogglePath(), "/dsh-market/toggle");
  assert.equal(contract.marketBaseUrl(), "http://127.0.0.1:3080");
  // Spike: the market sameOrigin gate compares the Origin host byte-for-byte
  // with the request host (localhost != 127.0.0.1 would 403), so the default
  // Origin must come from the SAME string as marketBaseUrl().
  assert.equal(contract.marketOrigin(), contract.marketBaseUrl());
  assert.equal(contract.marketOrigin(), "http://127.0.0.1:3080");
  assert.ok(!contract.marketBaseUrl().endsWith("/"));
});

test("market bridge env overrides take effect; baseUrl trailing slashes are stripped", () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_GUARD_MARKET_BASE = "http://127.0.0.1:9999///";
    process.env.DSH_GUARD_MARKET_TOGGLE_PATH = "/custom/toggle";
    // no explicit ORIGIN override -> Origin follows the overridden baseUrl
    assert.equal(contract.marketBaseUrl(), "http://127.0.0.1:9999");
    assert.equal(contract.marketTogglePath(), "/custom/toggle");
    assert.equal(contract.marketOrigin(), contract.marketBaseUrl());
    // an explicit ORIGIN override wins over the derived default
    process.env.DSH_GUARD_MARKET_ORIGIN = "http://localhost:9999";
    assert.equal(contract.marketOrigin(), "http://localhost:9999");
  } finally {
    for (const k of Object.keys(saved)) process.env[k] = saved[k];
    // also delete keys this test added: --test-isolation=none shares one process
    // across files, and a leaked DSH_GUARD_* override would break default tests.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
