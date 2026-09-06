import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticList, fromHost, resolve } from "../lib/core-packages.js";

test("staticList is non-empty and includes dsh-tools", () => {
  const l = staticList();
  assert.ok(l.includes("dsh-tools"));
  assert.ok(l.includes("cosmokit"));
});

test("fromHost reads top-level @deepseek-ai dirs of a dsh install", () => {
  const h = mkdtempSync(join(tmpdir(), "core-h-"));
  try {
    const fake = join(h, "node_modules", "@deepseek-ai");
    mkdirSync(join(fake, "dsh-tools"), { recursive: true });
    mkdirSync(join(fake, "cosmokit"), { recursive: true });
    mkdirSync(join(fake, "some-plugin"), { recursive: true }); // non-core still listed? design: only dirs, filter dotfiles
    const l = fromHost(h);
    assert.ok(l.includes("dsh-tools"));
    assert.ok(l.includes("some-plugin")); // host namespace listing is authoritative
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("resolve falls back to static when host dir missing", () => {
  const l = resolve("C:/nonexistent-dsh-install");
  assert.ok(l.includes("dsh-tools"));
});
