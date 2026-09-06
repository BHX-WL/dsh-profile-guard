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
test("client-only package (dsh.client, no dsh.bundle) is hot-mountable by shim", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "some-ui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-ui", dsh: { client: {} } }));
    assert.equal(declaresClientOnly(dir), true);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("canHotMountByShape returns ok for insert, false+reason otherwise", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  name: p\n");
    const ok = canHotMountByShape(h, "p");
    assert.equal(ok.ok, true);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
