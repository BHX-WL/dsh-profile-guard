// boot: bootOnce main flow, tested fully dry. DSH_HOME is the dsh DATA ROOT
// (holds profiles/ and guards/ directly), so tests point it at a temp dir and
// never touch the real ~/.dsh or the real 3080 host. A local http server fakes
// the healthy host (probe marker __DSH_BOOT__) and every call passes
// { spawnHost: false } so bootOnce never spawns a real dsh bin.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { bootOnce, isPluginFailure, bootRollbackResult } from "../lib/boot.js";
import { listSnapshots, createSnapshot } from "../lib/snapshot.js";
import { readManifest } from "../lib/manifest.js";
import { profileDir } from "../lib/paths.js";

async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
}
function makeProfile(home, profile, manifest) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest ?? { dependencies: {}, dsh: { profile: { bundles: [] } } }));
}

test("bootOnce returns alreadyRunning when a healthy host is online (no spawn, no snapshot)", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-"));
  try {
    makeProfile(h, "web");
    const srv = createServer((req, res) => { res.end("__DSH_BOOT__"); });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    try {
      await withHome(h, async () => {
        const r = await bootOnce("web", [], { baseUrl: `http://127.0.0.1:${port}`, spawnHost: false });
        assert.equal(r.ok, true);
        assert.equal(r.alreadyRunning, true);
        // fast path: healthy before anything is spawned or snapshotted
        assert.equal(listSnapshots("web").length, 0);
      });
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("bootOnce creates a pending snapshot and promotes it healthy when the host comes up", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-"));
  try {
    makeProfile(h, "web");
    let healthy = false;
    const srv = createServer((req, res) => { res.end(healthy ? "__DSH_BOOT__" : ""); });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    const flip = setTimeout(() => { healthy = true; }, 500); // host appears mid-boot
    try {
      await withHome(h, async () => {
        const r = await bootOnce("web", [], { baseUrl: `http://127.0.0.1:${port}`, spawnHost: false, waitReadyMs: 6000 });
        assert.equal(r.ok, true);
        assert.ok(r.snapshotId, "expected a snapshot id");
        const snaps = listSnapshots("web");
        assert.equal(snaps.length, 1);
        assert.equal(snaps[0].id, r.snapshotId);
        assert.equal(snaps[0].healthy, true); // promoted on successful boot
      });
    } finally { clearTimeout(flip); srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("bootOnce with no healthy host and no snapshot reports failure without rollback loop", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-"));
  try {
    makeProfile(h, "web");
    await withHome(h, async () => {
      const r = await bootOnce("web", [], { baseUrl: "http://127.0.0.1:1", spawnHost: false, waitReady: false });
      assert.equal(r.ok, false);
      assert.equal(r.rolledBack, undefined); // no healthy snapshot -> nothing to roll back to
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("isPluginFailure flags plugin/install errors but not port conflicts", () => {
  assert.equal(isPluginFailure("Error: plugin tree failed to load"), true);
  assert.equal(isPluginFailure("Cannot find module 'x'"), true);
  assert.equal(isPluginFailure("SyntaxError: Unexpected token"), true);
  assert.equal(isPluginFailure("EADDRINUSE: address already in use :::3080"), false); // design: port conflict is not a rollback reason
  assert.equal(isPluginFailure(""), false);
  assert.equal(isPluginFailure(null), false);
});

test("bootRollbackResult folds hashOk into ok and keeps the earliest error", () => {
  const plain = bootRollbackResult("S1", { ok: true, restarted: true, restartError: null, hashOk: true, externallyReset: false, report: "rep" });
  assert.equal(plain.ok, true);
  assert.equal(plain.rolledBack, true);
  assert.equal(plain.snapshotId, "S1");
  assert.equal(plain.error, null);
  assert.equal(plain.report, "rep");
  // external writer reset the manifest again during re-pull -> restore did not survive
  const reset = bootRollbackResult("S1", { ok: true, restarted: true, hashOk: false, externallyReset: true, report: "r2" });
  assert.equal(reset.ok, false);
  assert.equal(reset.hashOk, false);
  assert.equal(reset.externallyReset, true);
  // early rollback failure carries error, not restartError
  const early = bootRollbackResult("S1", { ok: false, error: "snapshot S1 missing" });
  assert.equal(early.ok, false);
  assert.equal(early.error, "snapshot S1 missing");
});

test("bootRollbackResult requires a successful restart on the boot path", () => {
  // Boot semantics: after a rollback the host must actually be back up. A
  // restored-but-not-running host is a boot failure, whatever the restore did.
  // (b) restart was attempted and failed -> the restart error is the reason
  const failedUp = bootRollbackResult("S1", { ok: true, restarted: false, restartError: "host did not become ready within 45000ms", hashOk: null, report: "rep" }, { requireRestart: true });
  assert.equal(failedUp.ok, false);
  assert.match(failedUp.error, /host did not become ready/);
  assert.equal(failedUp.restarted, false);
  assert.equal(failedUp.report, "rep");
  // (a) restart was skipped (static check did not pass) -> explicit fallback reason
  const skipped = bootRollbackResult("S1", { ok: true, restarted: false, restartError: null, hashOk: null });
  assert.equal(skipped.ok, false);
  assert.match(skipped.error, /restored but host did not restart/);
  // restart waived (autoRestart:false dry rollback) -> restored without a host up is a success
  const waived = bootRollbackResult("S1", { ok: true, restarted: false, restartError: null, hashOk: null }, { requireRestart: false });
  assert.equal(waived.ok, true);
  assert.equal(waived.error, null);
});

test("bootOnce rolls back to the latest healthy snapshot on a plugin-failure log (dry)", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-"));
  try {
    const good = { dependencies: {}, dsh: { profile: { bundles: [] } } };
    const bad = { dependencies: { evil: "1" }, dsh: { profile: { bundles: ["evil"] } } };
    makeProfile(h, "web", good);
    await withHome(h, async () => {
      const snap = await createSnapshot("web", { reason: "last good", healthy: true });
      writeFileSync(join(h, "profiles", "web", "package.json"), JSON.stringify(bad));
      // inject a host boot log with a plugin-failure marker (production writes it via spawnHost)
      const logDir = join(h, "guards", "web", "crash");
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, "boot-fake.log");
      writeFileSync(logFile, "host output...\nError: plugin tree failed to load\n");
      const r = await bootOnce("web", [], {
        baseUrl: "http://127.0.0.1:1",
        spawnHost: false,
        waitReady: false,
        logFile,
        rollback: { autoRestart: false, stopPort: false }, // stay dry: never spawn/kill a real host
      });
      assert.equal(r.ok, true); // restore ok, no re-pull reset (hashOk null) -> ok
      assert.equal(r.rolledBack, true);
      assert.equal(r.snapshotId, snap.id);
      assert.deepEqual(readManifest(profileDir("web")), good); // manifest restored from snapshot
      // the drained boot log is carried into the restore report as the crash reason (incidental #3)
      assert.match(r.report, /## 崩溃原因/);
      assert.match(r.report, /plugin tree failed to load/);
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("bootOnce reports failure when the restored manifest fails the static check (restart skipped, dry)", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-"));
  try {
    // Healthy snapshot whose bundle cannot resolve: restoring it restores the
    // manifest, then the rollback's static check fails and the restart is
    // skipped — under boot semantics that is a boot failure (the host is not
    // running again), never a "boot ok".
    const good = { dependencies: { ghost: "1" }, dsh: { profile: { bundles: ["ghost"] } } };
    const bad = { dependencies: { evil: "1" }, dsh: { profile: { bundles: ["evil"] } } };
    makeProfile(h, "web", good);
    await withHome(h, async () => {
      const snap = await createSnapshot("web", { reason: "healthy but unresolvable", healthy: true });
      writeFileSync(join(h, "profiles", "web", "package.json"), JSON.stringify(bad));
      const logDir = join(h, "guards", "web", "crash");
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, "boot-fake2.log");
      writeFileSync(logFile, "Error: plugin tree failed to load\n");
      const r = await bootOnce("web", [], {
        baseUrl: "http://127.0.0.1:1",
        spawnHost: false,
        waitReady: false,
        logFile,
        rollback: { stopPort: false }, // autoRestart stays true (boot contract); no real spawn because the check fails
      });
      assert.equal(r.ok, false); // restored but host not restarted -> boot failed
      assert.equal(r.rolledBack, true);
      assert.equal(r.restarted, false);
      assert.match(r.error, /restored but host did not restart/);
      assert.equal(r.snapshotId, snap.id);
      assert.deepEqual(readManifest(profileDir("web")), good); // manifest was restored from the snapshot
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});
