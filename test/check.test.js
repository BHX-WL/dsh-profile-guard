// check: static health check (guard check, read-only). A profile is healthy
// when its manifest parses, no insert id repeats in cordis.patch.yml, every
// declared bundle resolves to a package that declares dsh.bundle.patch, and
// node_modules/@deepseek-ai holds no copy of a host core package.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticCheck } from "../lib/check.js";

// DSH_HOME is the dsh DATA ROOT (holds profiles/ and guards/ directly), so a
// profile lives at <home>/profiles/<profile> with no extra .dsh segment.
function makeHome() { return mkdtempSync(join(tmpdir(), "guard-c-")); }
function pkg(dir, obj) { writeFileSync(join(dir, "package.json"), JSON.stringify(obj)); }

function withDshHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

test("clean profile passes", () => {
  const h = makeHome();
  try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: { "dsh-better-edit": "^1.0.0" }, dsh: { profile: { bundles: ["dsh-better-edit"] } } });
    mkdirSync(join(dir, "node_modules", "dsh-better-edit"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dsh-better-edit", "package.json"), JSON.stringify({ dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  name: better-edit\n");
    withDshHome(h, () => {
      const r = staticCheck("web");
      assert.equal(r.ok, true, JSON.stringify(r.problems));
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("bundle that cannot resolve fails", () => {
  const h = makeHome();
  try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: {}, dsh: { profile: { bundles: ["ghost-pkg"] } } });
    withDshHome(h, () => {
      const r = staticCheck("web");
      assert.equal(r.ok, false);
      assert.ok(r.problems.some((p) => p.code === "unresolvable-bundle"));
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("core shadowing in node_modules/@deepseek-ai flagged", () => {
  const h = makeHome();
  try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: {}, dsh: { profile: { bundles: [] } } });
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
    withDshHome(h, () => {
      const r = staticCheck("web");
      assert.ok(r.problems.some((p) => p.code === "core-shadow"));
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("duplicate insert ids flagged", () => {
  const h = makeHome();
  try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: {}, dsh: { profile: { bundles: [] } } });
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  name: dup\n- insert:\n  name: dup\n");
    withDshHome(h, () => {
      const r = staticCheck("web");
      assert.ok(r.problems.some((p) => p.code === "dup-insert-id"));
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});
