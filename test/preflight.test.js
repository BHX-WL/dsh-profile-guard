import test from "node:test";
import assert from "node:assert/strict";
import { checkManifest } from "../lib/preflight.js";

const base = { name: "pkg-x", version: "1.0.0", dependencies: {} };
const corePkgs = ["dsh-tools", "cosmokit"];
const hostVersion = "0.1.2-rc.1";

test("clean manifest passes", () => {
  const r = checkManifest({ ...base, dependencies: { diff: "^5.0.0" } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, true);
  assert.equal(r.verdicts.length, 0);
});

test("core shadow in prod dependencies fails and is forceable", () => {
  const r = checkManifest({ ...base, dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, false);
  const v = r.verdicts.find((x) => x.code === "core-shadow");
  assert.ok(v);
  assert.equal(v.forceable, true);
});

test("host engines mismatch fails and is not forceable", () => {
  const r = checkManifest({ ...base, dsh: { engines: { dsh: ">=1.0.0" } } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, false);
  const v = r.verdicts.find((x) => x.code === "host-incompatible");
  assert.ok(v);
  assert.equal(v.forceable, false);
});

test("no engines declaration passes (absence of claim is not a verdict)", () => {
  const r = checkManifest(base, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, true);
});

test("dup insert id against installed patches fails", () => {
  const r = checkManifest(
    { ...base, dsh: { bundle: { patch: "./cordis.patch.yml" } } },
    { hostVersion, corePackages: corePkgs, candidatePatchText: "- insert:\n  name: better-edit\n", installedInsertIds: ["better-edit"] }
  );
  assert.equal(r.ok, false);
  assert.ok(r.verdicts.find((x) => x.code === "dup-insert-id"));
});

test("devDependencies core is ignored (pnpm hoists prod only)", () => {
  const r = checkManifest({ ...base, devDependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, true);
});

// --- range coverage beyond the brief's 6 verbatim cases (task constraint) ---
// The pure judgement must cover ^ ~ >= > < <= exact and || branches, treat an
// unparseable range or host version as "no claim" (open pass), and never block
// on a missing host version.
const admits = (range, host) =>
  checkManifest({ ...base, dsh: { engines: { dsh: range } } }, { hostVersion: host, corePackages: corePkgs }).ok;

test("range operators exact > >= < <= ^ ~ admit and reject correctly", () => {
  assert.equal(admits("1.2.3", "1.2.3"), true);
  assert.equal(admits("1.2.3", "1.2.4"), false);
  assert.equal(admits(">1.2.3", "1.2.4"), true);
  assert.equal(admits(">1.2.3", "1.2.3"), false);
  assert.equal(admits(">=1.0.0", "1.0.0"), true);
  assert.equal(admits(">=1.0.0", "0.9.0"), false);
  assert.equal(admits("<2.0.0", "1.9.9"), true);
  assert.equal(admits("<2.0.0", "2.0.0"), false);
  assert.equal(admits("<=2.0.0", "2.0.0"), true);
  assert.equal(admits("<=2.0.0", "2.0.1"), false);
  assert.equal(admits("^1.2.3", "1.9.0"), true);
  assert.equal(admits("^1.2.3", "2.0.0"), false);
  assert.equal(admits("^0.2.3", "0.2.9"), true);
  assert.equal(admits("^0.2.3", "0.1.0"), false);
  assert.equal(admits("~1.2.3", "1.2.9"), true);
  assert.equal(admits("~1.2.3", "1.3.0"), false);
});

test("range || branches admit when any alternative matches", () => {
  assert.equal(admits(">=3.0.0 || 1.0.0", "1.0.0"), true);
  assert.equal(admits(">=3.0.0 || 1.0.0", "2.5.0"), false);
  assert.equal(admits(">=3.0.0 || <1.0.0", "0.5.0"), true);
});

test("unparseable range or host version is an open pass, not a verdict", () => {
  assert.equal(admits("banana-version", "1.0.0"), true);
  assert.equal(admits(">=1.0.0", "not-a-version"), true);
  assert.equal(admits(">=1.0.0", undefined), true);
});

test("bundle patch with no candidate text warns patch-unverified but does not block", () => {
  const r = checkManifest(
    { ...base, dsh: { bundle: { patch: "./cordis.patch.yml" } } },
    { hostVersion, corePackages: corePkgs, installedInsertIds: ["other-insert"] }
  );
  assert.equal(r.ok, true);
  const v = r.verdicts.find((x) => x.code === "patch-unverified");
  assert.ok(v);
  assert.equal(v.severity, "warn");
});

test("incomplete range forms are an open pass, never a false rejection (fix r1)", () => {
  assert.equal(admits("0.1.x", "0.1.2-rc.1"), true);
  assert.equal(admits("1.2", "0.1.2"), true);
  assert.equal(admits("1.0.0 - 2.0.0", "1.5.0"), true);
});

test("caret 0.x enforces the minor and patch upper bounds (fix r1)", () => {
  assert.equal(admits("^0.2.3", "0.3.0"), false);
  assert.equal(admits("^0.2.3", "0.2.4"), true);
  assert.equal(admits("^0.0.3", "0.0.4"), false);
  assert.equal(admits("^0.0.3", "0.0.3"), true);
  assert.equal(admits("^0.0.3", "0.0.2"), false);
});
