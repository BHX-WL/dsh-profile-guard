// watch: the guard watch auto-snapshot assistant. watchProfile listens for
// package.json / pnpm-lock.yaml changes under the profile, debounces them, and
// snapshots when the manifest hash differs from the newest recorded snapshot.
//
// DSH_HOME is the dsh DATA ROOT (holds profiles/ and guards/ directly), so
// tests point it at a temp dir and never touch the real ~/.dsh. fs.watch
// events arrive asynchronously after a write, so every test waits past the
// debounce + a delivery margin and close()s its handle in a finally to avoid
// leaking watchers / hanging the runner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchProfile } from "../lib/watch.js";
import { createSnapshot, listSnapshots } from "../lib/snapshot.js";

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
}

function makeProfile(home, profile, deps = {}, bundles = []) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, dsh: { profile: { bundles } } }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"); // real profiles carry a lockfile
  return dir;
}

const manifestOf = (home, profile) => {
  const dir = join(home, "profiles", profile);
  return {
    write(deps, bundles) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, dsh: { profile: { bundles } } }));
    },
  };
};

test("watch snapshots when package.json changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-w-"));
  try {
    await withHome(home, async () => {
      makeProfile(home, "web", {}, []);
      const mf = manifestOf(home, "web");
      const w = watchProfile("web", { debounceMs: 50 });
      try {
        await settle(150); // let the watchers attach before the first write
        mf.write({ x: "1" }, ["x"]);
        await settle(700); // event delivery + debounce + snapshot write
        const snaps = listSnapshots("web");
        assert.ok(snaps.length >= 1, "expected at least one auto snapshot");
        assert.equal(snaps[0].reason, "auto (watch)");
        assert.equal(snaps[0].healthy, false);
      } finally { w.close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("watch does not snapshot when the manifest content is unchanged", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-w-"));
  try {
    await withHome(home, async () => {
      makeProfile(home, "web", { a: "1" }, ["x"]);
      const mf = manifestOf(home, "web");
      await createSnapshot("web", { reason: "initial", healthy: false }); // baseline
      const w = watchProfile("web", { debounceMs: 50 });
      try {
        await settle(150);
        mf.write({ a: "1" }, ["x"]); // same deps + bundles -> same hash
        await settle(700);
        const snaps = listSnapshots("web");
        assert.equal(snaps.length, 1, "unchanged manifest must not add a snapshot");
        assert.equal(snaps[0].reason, "initial");
      } finally { w.close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("watch debounces rapid changes into a single snapshot of the last state", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-w-"));
  try {
    await withHome(home, async () => {
      makeProfile(home, "web", {}, []);
      const mf = manifestOf(home, "web");
      const w = watchProfile("web", { debounceMs: 120 });
      try {
        await settle(150);
        mf.write({ a: "1" }, ["a"]);
        await settle(40);
        mf.write({ a: "1", b: "2" }, ["a", "b"]);
        await settle(800); // well past debounce + delivery
        const snaps = listSnapshots("web");
        assert.equal(snaps.length, 1, "rapid changes should coalesce into one snapshot");
        assert.deepEqual(snaps[0].bundles, ["a", "b"]);
      } finally { w.close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("watch tolerates a profile without pnpm-lock.yaml", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-w-"));
  try {
    await withHome(home, async () => {
      // fixture that omits the lockfile (fresh profile state)
      const dir = join(home, "profiles", "web");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
      const w = watchProfile("web", { debounceMs: 50 }); // must not throw ENOENT
      try {
        await settle(150);
        writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { y: "2" }, dsh: { profile: { bundles: ["y"] } } }));
        await settle(700);
        const snaps = listSnapshots("web");
        assert.ok(snaps.length >= 1, "expected a snapshot even without a lockfile");
      } finally { w.close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
