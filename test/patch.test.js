// test/patch.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainInsertPatch, declaresClientOnly, canHotMountByShape, readPatch } from "../lib/patch.js";

test("plain insert patch with id/name rows is hot-mountable", () => {
  const p = "- insert:\n  id: 'better-edit'\n  name: 'dsh-better-edit'\n- insert:\n  id: x\n  name: y\n";
  assert.equal(isPlainInsertPatch(p), true);
});
test("patch with config/expression rows is not plain insert", () => {
  const p = "- insert:\n  name: x\n- config:\n  foo: bar\n";
  assert.equal(isPlainInsertPatch(p), false);
});
test("patch with disable row is not plain insert", () => {
  const p = "- insert:\n  name: x\n- disable: something\n";
  assert.equal(isPlainInsertPatch(p), false);
});
test("empty/null patch is not hot-mountable by insert", () => {
  assert.equal(isPlainInsertPatch(""), false);
  assert.equal(isPlainInsertPatch(null), false);
  assert.equal(isPlainInsertPatch("# only comments\n"), false);
});
test("insert block with stray content rows is not plain insert", () => {
  assert.equal(isPlainInsertPatch("- insert:\n  id: x\n  123: v\n"), false);
  assert.equal(isPlainInsertPatch('- insert:\n  id: x\n  "bundle": v\n'), false);
  assert.equal(isPlainInsertPatch("- insert:\n  id: x\n  &anch foo\n"), false);
});
test("insert marker without id/name rows is not plain insert", () => {
  assert.equal(isPlainInsertPatch("- insert:\n"), false);
  assert.equal(isPlainInsertPatch("- insert:\n# note only\n"), false);
});
test("client-only package (dsh.client, no dsh.bundle) is hot-mountable by shim", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "some-ui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-ui", dsh: { client: {} } }));
    assert.equal(declaresClientOnly(dir), true);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("declaresClientOnly is false when dsh.bundle present or nothing declared", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const b1 = join(h, "node_modules", "b1");
    const b2 = join(h, "node_modules", "b2");
    mkdirSync(b1, { recursive: true });
    mkdirSync(b2, { recursive: true });
    writeFileSync(join(b1, "package.json"), JSON.stringify({ name: "b1", dsh: { bundle: { patch: true } } }));
    writeFileSync(join(b2, "package.json"), JSON.stringify({ name: "b2" }));
    assert.equal(declaresClientOnly(b1), false);
    assert.equal(declaresClientOnly(b2), false);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("readPatch returns patch text or null when missing", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "p");
    mkdirSync(dir, { recursive: true });
    assert.equal(readPatch(h, "p"), null);
    const txt = "- insert:\n  name: p\n";
    writeFileSync(join(dir, "cordis.patch.yml"), txt);
    assert.equal(readPatch(h, "p"), txt);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("canHotMountByShape ok via insert when patch is plain insert", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  name: p\n");
    assert.deepEqual(canHotMountByShape(h, "p"), { ok: true, via: "insert" });
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("canHotMountByShape ok via client-shim and false with reasons otherwise", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const c = join(h, "node_modules", "c");
    const none = join(h, "node_modules", "none");
    const bad = join(h, "node_modules", "bad");
    mkdirSync(c, { recursive: true });
    mkdirSync(none, { recursive: true });
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(c, "package.json"), JSON.stringify({ name: "c", dsh: { client: {} } }));
    writeFileSync(join(none, "package.json"), JSON.stringify({ name: "none" }));
    writeFileSync(join(bad, "package.json"), JSON.stringify({ name: "bad" }));
    writeFileSync(join(bad, "cordis.patch.yml"), "- insert:\n  name: x\n- config:\n  foo: bar\n");
    assert.deepEqual(canHotMountByShape(h, "c"), { ok: true, via: "client-shim" });
    assert.deepEqual(canHotMountByShape(h, "none"), { ok: false, reason: "no bundle patch and no dsh.client surface — nothing to hot-mount" });
    assert.deepEqual(canHotMountByShape(h, "bad"), { ok: false, reason: "bundle patch is not plain inserts (config/expression rows); hot-mount only supports plain inserts — restart required" });
  } finally { rmSync(h, { recursive: true, force: true }); }
});
