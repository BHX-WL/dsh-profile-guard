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
import { bootOnce } from "../lib/boot.js";
import { listSnapshots } from "../lib/snapshot.js";

async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
}
function makeProfile(home, profile) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
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
