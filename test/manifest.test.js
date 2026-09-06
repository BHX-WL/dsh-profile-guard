import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest, manifestHash, depsOf, bundlesOf } from "../lib/manifest.js";

const fixture = { name: "p", private: true, dependencies: { a: "^1.0.0", b: "2.0.0" }, dsh: { profile: { bundles: ["x", "y"] } } };
test("write then read round-trips and strips BOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-m-"));
  try {
    writeFileSync(join(dir, "package.json"), "\uFEFF" + JSON.stringify(fixture));
    assert.deepEqual(readManifest(dir), fixture);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("writeManifest writes 2-space indented JSON with trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-m-"));
  try {
    writeManifest(dir, fixture);
    const raw = readFileSync(join(dir, "package.json"), "utf8");
    assert.equal(raw, JSON.stringify(fixture, null, 2) + "\n");
    assert.deepEqual(readManifest(dir), fixture);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("readManifest returns null for missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-m-"));
  try { assert.equal(readManifest(dir), null); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("manifestHash changes when deps or bundles change", () => {
  const h1 = manifestHash(fixture);
  const h2 = manifestHash({ ...fixture, dependencies: { a: "^1.0.0" } });
  assert.notEqual(h1, h2);
});
test("depsOf and bundlesOf extract sorted lists", () => {
  assert.deepEqual(depsOf(fixture), ["a", "b"]);
  assert.deepEqual(bundlesOf(fixture), ["x", "y"]);
});
