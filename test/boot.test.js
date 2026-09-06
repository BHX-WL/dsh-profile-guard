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
    });
  } finally { rmSync(h, { recursive: true, force: true }); }
});
