// rollback: restore a profile from a healthy snapshot, backing up the current
// (bad) state under <data root>/guards/<profile>/crash/<ts>/ first. DSH_HOME is
// the dsh DATA ROOT (holds profiles/ and guards/ directly), so tests point it at
// a temp dir, never the real ~/.dsh. Every call passes { autoRestart: false,
// stopPort: false } — a real rollback must never kill the live host or spawn a
// real one from a unit test.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshot } from "../lib/snapshot.js";
import { rollbackToSnapshot, restartErrorOf } from "../lib/rollback.js";

function makeHome() { return mkdtempSync(join(tmpdir(), "guard-r-")); }
function makeProfile(home, profile, manifest) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}
async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
}

test("rollback restores manifest from healthy snapshot", async () => {
  const h = makeHome();
  try {
    const good = { dependencies: { a: "1" }, dsh: { profile: { bundles: ["a"] } } };
    makeProfile(h, "web", good);
    await withHome(h, async () => {
      const snap = await createSnapshot("web", { reason: "before bad", healthy: true });
      const bad = { dependencies: { a: "1", evil: "1" }, dsh: { profile: { bundles: ["a", "evil"] } } };
      writeFileSync(join(h, "profiles", "web", "package.json"), JSON.stringify(bad));
      const r = await rollbackToSnapshot("web", snap.id, { autoRestart: false, stopPort: false });
      assert.equal(r.ok, true);
      const after = JSON.parse(readFileSync(join(h, "profiles", "web", "package.json"), "utf8"));
      assert.deepEqual(after.dependencies, { a: "1" });
      assert.ok(!("evil" in after.dependencies));
      assert.ok(!r.restarted);
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("rollback backs up current bad state under crash/", async () => {
  const h = makeHome();
  try {
    makeProfile(h, "web", { dependencies: {}, dsh: { profile: { bundles: [] } } });
    await withHome(h, async () => {
      const snap = await createSnapshot("web", { reason: "x", healthy: true });
      const bad = { dependencies: { evil: "1" }, dsh: { profile: { bundles: ["evil"] } } };
      writeFileSync(join(h, "profiles", "web", "package.json"), JSON.stringify(bad));
      const r = await rollbackToSnapshot("web", snap.id, { autoRestart: false, stopPort: false });
      assert.equal(r.ok, true);
      const crashRoot = join(h, "guards", "web", "crash");
      const entries = readdirSync(crashRoot);
      assert.ok(entries.length >= 1, "expected at least one crash backup dir");
      const dirs = entries.filter((n) => {
        try { return readdirSync(join(crashRoot, n)).includes("package.json.bad"); } catch { return false; }
      });
      assert.ok(dirs.length >= 1, "expected package.json.bad inside a crash backup");
      const backup = JSON.parse(readFileSync(join(crashRoot, dirs[0], "package.json.bad"), "utf8"));
      assert.ok("evil" in backup.dependencies);
      assert.ok(r.file && r.file.length > 0);
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("rollback refuses a snapshot that is not healthy", async () => {
  const h = makeHome();
  try {
    makeProfile(h, "web", { dependencies: { a: "1" }, dsh: { profile: { bundles: ["a"] } } });
    await withHome(h, async () => {
      const snap = await createSnapshot("web", { reason: "pending", healthy: false });
      writeFileSync(join(h, "profiles", "web", "package.json"), JSON.stringify({ dependencies: { evil: "1" }, dsh: { profile: { bundles: ["evil"] } } }));
      const r = await rollbackToSnapshot("web", snap.id, { autoRestart: false, stopPort: false });
      assert.equal(r.ok, false);
      assert.equal(r.restored, false);
      assert.match(r.error, /non-healthy/);
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("restartErrorOf reports an explicit reason when no host log tail exists", () => {
  const fallback = "host did not become ready within 45000ms";
  assert.equal(restartErrorOf(""), fallback);
  assert.equal(restartErrorOf("   "), fallback);
  assert.equal(restartErrorOf(null), fallback);
  assert.equal(restartErrorOf("Error: plugin tree failed to load"), "Error: plugin tree failed to load");
});

test("rollback carries crashReason into the restore report", async () => {
  const h = makeHome();
  try {
    const good = { dependencies: { a: "1" }, dsh: { profile: { bundles: ["a"] } } };
    makeProfile(h, "web", good);
    await withHome(h, async () => {
      const snap = await createSnapshot("web", { reason: "before bad", healthy: true });
      const bad = { dependencies: { a: "1", evil: "1" }, dsh: { profile: { bundles: ["a", "evil"] } } };
      writeFileSync(join(h, "profiles", "web", "package.json"), JSON.stringify(bad));
      const r = await rollbackToSnapshot("web", snap.id, { autoRestart: false, stopPort: false, crashReason: "Error: plugin tree failed to load\n    at plugin.js:3" });
      assert.equal(r.ok, true);
      assert.match(r.report, /## 崩溃原因/);
      assert.match(r.report, /plugin tree failed to load/);
      const disk = readFileSync(join(h, "guards", "web", "last-report.md"), "utf8");
      assert.match(disk, /plugin tree failed to load/);
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});
