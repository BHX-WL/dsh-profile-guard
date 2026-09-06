// Snapshot core: create/list/promote/prune snapshots under
// <data root>/guards/<profile>/<id>/ with package.json + sentinel.json + meta.json.
// DSH_HOME is the dsh DATA ROOT (holds profiles/ and guards/ directly), so
// tests point it at a temp dir and never touch the real ~/.dsh.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshot, listSnapshots, latestHealthy, markHealthy, prune } from "../lib/snapshot.js";

async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
}

function makeProfile(home, profile, deps, bundles) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, dsh: { profile: { bundles } } }));
  return dir;
}

// Snapshot ids are YYYYMMDD-HHmmss-<hash8>: two snapshots of the same manifest
// taken within one second would collide, so space creations across the boundary.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

test("createSnapshot stores manifest sentinel and meta; list newest first", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-h-"));
  try {
    const dir = makeProfile(home, "web", { a: "1" }, ["x"]);
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "bad"), { recursive: true });
    await withHome(home, async () => {
      await createSnapshot("web", { reason: "test", healthy: false });
      await nextSecond();
      await createSnapshot("web", { reason: "test2", healthy: true });
      const snaps = listSnapshots("web");
      assert.equal(snaps.length, 2);
      assert.equal(snaps[0].healthy, true); // newest first
      const s0 = snaps[0];
      assert.ok(existsSync(join(s0.dir, "package.json")));
      assert.ok(existsSync(join(s0.dir, "sentinel.json")));
      assert.deepEqual(JSON.parse(readFileSync(join(s0.dir, "sentinel.json"), "utf8")), ["bad"]);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("latestHealthy returns most recent healthy; markHealthy promotes; prune keeps N", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-h-"));
  try {
    makeProfile(home, "web", { a: "1" }, ["x"]);
    await withHome(home, async () => {
      const a = await createSnapshot("web", { reason: "a", healthy: false });
      await nextSecond();
      const b = await createSnapshot("web", { reason: "b", healthy: false });
      assert.equal(latestHealthy("web"), null);
      await markHealthy("web", a.id);
      assert.equal(latestHealthy("web"), a.id);
      await prune("web", 1);
      assert.equal(listSnapshots("web").length, 1);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
