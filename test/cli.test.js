// cli: the `guard` command surface, exercised through real child processes
// (node lib/cli.js) so argv parsing, stdout/stderr and exit codes are all
// asserted end to end.
//
// Safety (controller ruling): every test points DSH_HOME at a throwaway temp
// dir that IS the dsh data root, so the profile lives at <tmp>/profiles/web
// and no test touches the real ~/.dsh. Only local / read-only subcommands are
// integration-tested here (snapshot / list / show / check / help / unknown).
// boot and restore are deliberately NOT integration-tested: their destructive
// paths (spawn the host, stop port 3080) are covered dry by test/boot.test.js
// and test/rollback.test.js through spawnHost:false / stopPort:false, and the
// CLI layer has no injection point to keep them dry.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPostInstallVerify, runPostAddHotMount } from "../lib/cli.js";
import { marketBaseUrl, marketOrigin } from "../lib/contract.js";
import { profileDir } from "../lib/paths.js";

const CLI = join(process.cwd(), "lib", "cli.js");

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, cwd: process.cwd(), timeout: 30000 },
      (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function makeProfile(home, profile) {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
}

test("snapshot then list shows one entry", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-"));
  try {
    makeProfile(h, "web");
    const env = { DSH_HOME: h };
    const s = await run(["snapshot", "--profile", "web", "--reason", "cli test"], env);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /snapshot .+ created/);
    const l = await run(["list", "--profile", "web"], env);
    assert.equal(l.code, 0, l.stderr);
    assert.match(l.stdout, /web/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("check reports healthy", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-"));
  try {
    makeProfile(h, "web");
    const c = await run(["check", "--profile", "web"], { DSH_HOME: h });
    assert.equal(c.code, 0, c.stderr);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("unknown command exits 2 with usage", async () => {
  const r = await run(["bogus"], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/i);
});

test("help exits 0 and prints usage", async () => {
  const r = await run(["--help"], {});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /usage: guard/);
});

test("show prints details for an existing snapshot", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-"));
  try {
    makeProfile(h, "web");
    const env = { DSH_HOME: h };
    const s = await run(["snapshot", "--profile", "web", "--reason", "cli test"], env);
    assert.equal(s.code, 0, s.stderr);
    const m = s.stdout.match(/snapshot (.+) created/);
    assert.ok(m, "expected a snapshot id in: " + s.stdout);
    const id = m[1].trim();
    const sh = await run(["show", "--profile", "web", id], env);
    assert.equal(sh.code, 0, sh.stderr);
    assert.match(sh.stdout, new RegExp(id));
    assert.match(sh.stdout, /hash:/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("show of an unknown id exits 1", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-"));
  try {
    makeProfile(h, "web");
    const sh = await run(["show", "--profile", "web", "does-not-exist"], { DSH_HOME: h });
    assert.equal(sh.code, 1);
    assert.match(sh.stderr, /not found/i);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("restore without an id exits 2 with usage (no rollback attempted)", async () => {
  // Dry guard: exits before rollbackToSnapshot, so nothing on 3080 is touched.
  const r = await run(["restore"], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: guard restore/i);
});

test("snapshot of a missing profile exits 1 with an error", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-"));
  try {
    const r = await run(["snapshot", "--profile", "web"], { DSH_HOME: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /guard error/i);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("preflight rejects a core-shadow package with exit 1", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-pf-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  name: existing\n");
    // serve a fake registry manifest with a core-shadow dep
    const srv = createServer((req, res) => {
      if (req.url === "/evil-pkg/latest") { res.end(JSON.stringify({ name: "evil-pkg", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["preflight", "evil-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /core-shadow|shadows the host/i);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("preflight --force passes a core-shadow package with warning", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-pf2-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/evil-pkg/latest") { res.end(JSON.stringify({ name: "evil-pkg", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["preflight", "evil-pkg", "--force", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h });
      assert.equal(r.code, 0);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("preflight without pkg exits 2", async () => {
  const r = await run(["preflight"], {});
  assert.equal(r.code, 2);
});

test("preflight surfaces a patch-unverified warning on stderr", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-pw-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n  name: existing\n");
    const srv = createServer((req, res) => {
      if (req.url === "/patchy-pkg/latest") { res.end(JSON.stringify({ name: "patchy-pkg", version: "1.0.0", dependencies: {}, dsh: { bundle: { patch: "patches/plugin.yml" } } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["preflight", "patchy-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /warning/i);
      assert.match(r.stderr, /could not verify/i);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("preflight --force does not override a host-incompatible engine", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-fs-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/needy-pkg/latest") { res.end(JSON.stringify({ name: "needy-pkg", version: "1.0.0", dependencies: {}, dsh: { engines: { dsh: ">=99.0.0" } } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      // Pins force strictness: an engine claim the local host cannot meet is a
      // non-forceable verdict, so --force must still refuse. Depends on the real
      // dsh host being resolvable (0.1.2-rc.1 here, far below >=99.0.0); on a
      // hostless machine the engines claim is an open pass and this cannot fire.
      const r = await run(["preflight", "needy-pkg", "--force", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /host-incompatible|declares dsh engine/i);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("install runs preflight and snapshot but does not spawn in dry mode", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-in-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/good-pkg/latest") { res.end(JSON.stringify({ name: "good-pkg", version: "1.0.0", dependencies: { diff: "^5.0.0" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["install", "good-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h, DSH_GUARD_DRY_INSTALL: "1" });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /dry/i);
      // a snapshot was created
      const snaps = readdirSync(join(h, "guards", "web")).filter((n) => n !== "crash");
      assert.ok(snaps.length >= 1);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("install rejects a core-shadow package before snapshotting", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-in2-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/evil-pkg/latest") { res.end(JSON.stringify({ name: "evil-pkg", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["install", "evil-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h, DSH_GUARD_DRY_INSTALL: "1" });
      assert.equal(r.code, 1);
      const guards = join(h, "guards", "web");
      const snaps = fs.existsSync(guards) ? readdirSync(guards).filter((n) => n !== "crash") : [];
      assert.equal(snaps.length, 0); // refused before any snapshot
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});
// --- install post-install verification: forced-restart sequencing (dry) ---
// runPostInstallVerify is production-only from the CLI's perspective (the dry
// gate stops install before the spawn), so these unit tests drive its three
// seams (isHealthy/stopHost/boot) with fakes — no real host is ever probed,
// stopped or spawned. They pin the review round-1 fix: install must force a
// restart of an already-running host so the just-installed plugin actually
// boots (or auto-rolls back), never a bootOnce alreadyRunning no-op.

test("install verification stops a running host before booting it", async () => {
  let up = true;
  const calls = [];
  const r = await runPostInstallVerify({
    profile: "web",
    settleMs: 1000,
    isHealthy: async () => up,
    stopHost: async () => { calls.push("stop"); up = false; return { killed: [1234], errors: [] }; },
    boot: async () => { calls.push("boot"); return { ok: true, snapshotId: "s1" }; },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, ["stop", "boot"]); // host was up -> stop first, then real boot
});

test("install verification boots directly when the host is already down", async () => {
  const calls = [];
  const r = await runPostInstallVerify({
    profile: "web",
    isHealthy: async () => false,
    stopHost: async () => { calls.push("stop"); return { killed: [], errors: [] }; },
    boot: async () => { calls.push("boot"); return { ok: true, snapshotId: "s2" }; },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, ["boot"]); // host down -> no stop, bootOnce starts it
});

test("install verification fails when a running host cannot be stopped", async () => {
  let booted = false;
  const r = await runPostInstallVerify({
    profile: "web",
    isHealthy: async () => true,
    stopHost: async () => ({ killed: [], errors: [{ stage: "netstat", error: "boom" }] }),
    boot: async () => { booted = true; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.stopFailed, true);
  assert.equal(booted, false); // never reports ok against a host that was not restarted
  assert.match(r.error, /netstat/);
});

test("install verification fails when a stopped host does not go down", async () => {
  const r = await runPostInstallVerify({
    profile: "web",
    settleMs: 50,
    isHealthy: async () => true, // host never goes down
    stopHost: async () => ({ killed: [1234], errors: [] }),
    boot: async () => { throw new Error("must not boot while the old host is still up"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.stopFailed, true);
  assert.match(r.error, /did not stop/);
});

// I1 (final review): a post-install boot verification that ended in bootOnce's
// auto-rollback must surface as a FAILED install (exit 1) with a rollback
// message — never as "install ok", even when bootRollbackResult reports
// ok:true (the host is back up on the healthy snapshot, but the just-installed
// plugin did NOT stick). postInstallOutcome is the pure decision the install
// branch applies; the helper lives in cli.js so the branch stays untestable
// (production-only spawn) while the decision is pinned.
test("postInstallOutcome treats a rolled-back boot verification as install failure", async () => {
  const { postInstallOutcome } = await import("../lib/cli.js");
  // host recovered on the healthy snapshot (ok:true) but the plugin was removed -> still exit 1
  const rolled = postInstallOutcome({ ok: true, rolledBack: true, snapshotId: "S9" });
  assert.equal(rolled.exitCode, 1);
  assert.match(rolled.message, /rolled back to healthy snapshot S9/);
  assert.match(rolled.message, /plugin removed/);
  // rolled back AND the host failed to recover -> exit 1 with the reason
  const broke = postInstallOutcome({ ok: false, rolledBack: true, snapshotId: "S9", error: "restart failed" });
  assert.equal(broke.exitCode, 1);
  assert.match(broke.message, /did not recover/);
  assert.match(broke.message, /restart failed/);
  // a clean verification (plugin booted, no rollback) stays an install ok
  const clean = postInstallOutcome({ ok: true, snapshotId: "s1" });
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.message, null);
  // verification failed without a rollback (no healthy snapshot) -> exit 1, no rollback claim
  const failed = postInstallOutcome({ ok: false, error: "host did not become ready" });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.message, /host did not become ready/);
});


// S1 (final review, regression): a registry fetch leaves undici handles that
// need to wind down before the CLI exits. On Windows a direct process.exit()
// in that window trips a libuv fail-fast abort ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING) ... exit 0xC0000409", reproduced 3/3
// against the real npmmirror registry on the pre-fix CLI). The local keep-alive
// server below keeps the connection open after the response — the same
// lifecycle as a real registry round trip — and the child CLI must still exit
// 0 (ok) / 1 (refused) cleanly with no libuv assertion on stderr. This pins
// the natural-exit rule for the network commands.
test("preflight after a real keep-alive registry fetch exits 0 cleanly (S1 regression)", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-s1-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      // keep-alive server: respond then LEAVE the connection open, exactly like
      // a real registry's idle keep-alive socket after the manifest response.
      if (req.url === "/keep-pkg/latest") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: "keep-pkg", version: "1.0.0", dependencies: { diff: "^5.0.0" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    srv.keepAliveTimeout = 120000; // do not reap the connection while the child runs
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r0 = await run(["preflight", "keep-pkg", "--profile", "web", "--registry", "http://127.0.0.1:" + port], { DSH_HOME: h });
      assert.equal(r0.code, 0, "ok path: expected exit 0, stderr=" + r0.stderr);
      assert.match(r0.stdout, /preflight ok/);
      assert.doesNotMatch(r0.stderr, /Assertion failed|libuv|0xC0000409/);
      // refused path (core-shadow, no --force) must also exit 1 cleanly
      const srv2 = createServer((req, res) => {
        if (req.url === "/evil2/latest") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: "evil2", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
        else { res.statusCode = 404; res.end("{}"); }
      });
      srv2.keepAliveTimeout = 120000;
      await new Promise((r) => srv2.listen(0, r)); const port2 = srv2.address().port;
      try {
        const r1 = await run(["preflight", "evil2", "--profile", "web", "--registry", "http://127.0.0.1:" + port2], { DSH_HOME: h });
        assert.equal(r1.code, 1, "refused path: expected exit 1, stderr=" + r1.stderr);
        assert.match(r1.stderr, /preflight refused|shadows the host/i);
        assert.doesNotMatch(r1.stderr, /Assertion failed|libuv|0xC0000409/);
      } finally { srv2.close(); }
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// I2 (final review): `guard check` carries the host-contract probe (design
// §11.5-2). The probe result must NEVER drive the check exit code — contract
// drift is a warning, profile health decides 0/1. With no live-host
// observation site attached yet (observedContract() returns {}), a healthy
// profile produces no contract warning and exits 0; an unhealthy profile still
// exits 1 with no contract line either way (the mismatch path itself is pinned
// by test/contract.test.js).
test("check wires the contract probe without changing the health exit code (I2)", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-i2-")); try {
    // healthy profile -> exit 0, no contract warning on stderr
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const ok = await run(["check", "--profile", "web"], { DSH_HOME: h });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /profile web: healthy/);
    assert.doesNotMatch(ok.stderr, /host contract/);
    // unhealthy profile (unresolvable bundle) -> exit 1, still no contract line
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ["ghost-pkg"] } } }));
    const bad = await run(["check", "--profile", "web"], { DSH_HOME: h });
    assert.equal(bad.code, 1, bad.stderr);
    assert.match(bad.stdout, /profile web:/);
    assert.doesNotMatch(bad.stderr, /host contract/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// --- install post-add hot-mount wiring (task 4, dry through seams) ---
// The production install branch spawns the real dsh bin + boots a real host,
// so the CLI tests never reach it (DSH_GUARD_DRY_INSTALL=1 stops install
// before the spawn). Exactly like runPostInstallVerify, the post-add hot-mount
// flow therefore lives in an exported helper whose seams (canHotMount / mount /
// verify, plus out/err writers) let the whole decision sequence be driven dry:
// no patch is read from a real profile, no market POST is made, no host is
// booted. The wires under test: shape-ok -> tryHotMount ok -> "install ok
// (hot-mounted ...)" with NO restart verify; shape unsupported or a degraded
// toggle -> printed reason -> restart verify (runPostInstallVerify) as the
// fallback; DSH_GUARD_DRY_HOTMOUNT=1 -> "[dry] would hot-mount" and no POST.

function capture() {
  const buf = [];
  return { buf, writer: (s) => { buf.push(s); }, text: () => buf.join("") };
}

const HOTPKG = "hotplug-pkg";

test("install hot-mounts a shape-ok package after add and skips restart verify", async () => {
  const out = capture(); const err = capture();
  let mountCalls = 0, verifyCalls = 0, shapeArgs = null;
  const r = await runPostAddHotMount({
    profile: "web", pkg: HOTPKG, snapshotId: "S1",
    canHotMount: async (pd, pkg) => { shapeArgs = { pd, pkg }; return { ok: true, via: "insert" }; },
    mount: async (pkg, opts) => { mountCalls++; assert.equal(pkg, HOTPKG); assert.equal(opts.baseUrl, marketBaseUrl()); assert.equal(opts.origin, marketOrigin()); return { ok: true, state: "live", degraded: false }; },
    verify: async () => { verifyCalls++; return { ok: true, snapshotId: "v1" }; },
    out: out.writer, err: err.writer,
  });
  assert.equal(r.kind, "hot-mounted", JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(shapeArgs.pkg, HOTPKG);
  assert.equal(shapeArgs.pd, profileDir("web"));
  assert.equal(mountCalls, 1);
  assert.equal(verifyCalls, 0); // no restart verification on a live hot-mount
  assert.ok(out.text().includes("install ok (hot-mounted " + HOTPKG + ", snapshot S1)"), out.text());
  assert.equal(err.text(), "");
});

test("install falls back to restart verify when the hot-mount is degraded", async () => {
  const out = capture(); const err = capture();
  let mountCalls = 0, verifyArgs = null;
  const r = await runPostAddHotMount({
    profile: "web", pkg: HOTPKG, snapshotId: "S2",
    canHotMount: async () => ({ ok: true, via: "insert" }),
    mount: async () => { mountCalls++; return { ok: false, degraded: true, reason: "market toggle HTTP 502 for " + HOTPKG }; },
    verify: async (o) => { verifyArgs = o; return { ok: true, snapshotId: "v2" }; },
    out: out.writer, err: err.writer,
  });
  assert.equal(r.kind, "verify-ok", JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(mountCalls, 1);
  assert.deepEqual(verifyArgs, { profile: "web" }); // the runPostInstallVerify call shape
  assert.ok(err.text().includes("hot-mount failed (market toggle HTTP 502 for hotplug-pkg); falling back to restart verification"), err.text());
  assert.ok(out.text().includes("install ok (snapshot S2)"), out.text());
});

test("install skips hot-mount and verifies when the package shape is unsupported", async () => {
  const out = capture(); const err = capture();
  let mountCalls = 0, verifyCalls = 0;
  const r = await runPostAddHotMount({
    profile: "web", pkg: HOTPKG, snapshotId: "S3",
    canHotMount: async () => ({ ok: false, reason: "bundle patch is not plain inserts; hot-mount only supports plain inserts - restart required" }),
    mount: async () => { mountCalls++; return { ok: true }; },
    verify: async () => { verifyCalls++; return { ok: true, snapshotId: "v3" }; },
    out: out.writer, err: err.writer,
  });
  assert.equal(r.kind, "verify-ok", JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(mountCalls, 0); // never POST when the shape cannot hot-mount
  assert.equal(verifyCalls, 1);
  assert.ok(err.text().includes("hot-mount unavailable (bundle patch is not plain inserts"), err.text());
  assert.ok(err.text().includes("falling back to restart verification"), err.text());
  assert.ok(out.text().includes("install ok (snapshot S3)"), out.text());
});

test("DSH_GUARD_DRY_HOTMOUNT=1 prints would-hot-mount and never POSTs", async () => {
  const out = capture(); const err = capture();
  let mountCalls = 0, verifyCalls = 0;
  const r = await runPostAddHotMount({
    profile: "web", pkg: HOTPKG, snapshotId: "S4",
    env: { DSH_GUARD_DRY_HOTMOUNT: "1" },
    canHotMount: async () => ({ ok: true, via: "insert" }),
    mount: async () => { mountCalls++; return { ok: true, state: "live" }; },
    verify: async () => { verifyCalls++; return { ok: true, snapshotId: "v4" }; },
    out: out.writer, err: err.writer,
  });
  assert.equal(r.kind, "verify-ok", JSON.stringify(r)); // dry gate never claims a live mount
  assert.equal(r.exitCode, 0);
  assert.equal(mountCalls, 0); // no real market POST under the dry gate
  assert.equal(verifyCalls, 1); // the plugin was really added -> restart verify still runs
  assert.ok(out.text().includes("[dry] would hot-mount hotplug-pkg"), out.text());
  assert.ok(out.text().includes("install ok (snapshot S4)"), out.text());
});

test("a failed fallback verification surfaces as exit 1 with the outcome message", async () => {
  const out = capture(); const err = capture();
  const r = await runPostAddHotMount({
    profile: "web", pkg: HOTPKG, snapshotId: "S5",
    canHotMount: async () => ({ ok: true, via: "insert" }),
    mount: async () => ({ ok: false, degraded: true, reason: "market toggle request failed for " + HOTPKG + ": ECONNREFUSED" }),
    verify: async () => ({ ok: false, error: "host did not become ready" }),
    out: out.writer, err: err.writer,
  });
  assert.equal(r.kind, "verify-failed", JSON.stringify(r));
  assert.equal(r.exitCode, 1);
  assert.ok(err.text().includes("hot-mount failed (market toggle request failed for hotplug-pkg: ECONNREFUSED); falling back to restart verification"), err.text());
  assert.ok(err.text().includes("install ok but boot verification failed: host did not become ready"), err.text());
});

// --- guard hotmount command (task 5, manual activation trigger) ---
// A standalone `guard hotmount <pkg>` command - the manual counterpart to the
// install-branch wiring in runPostAddHotMount: shape gate (canHotMountByShape)
// then a real market toggle POST (tryHotMount). Exit contract: 0 hot-mounted /
// 1 degraded, shape-refused or not-installed / 2 usage error. The real command
// runs in a child process like every other CLI test; the market base/origin are
// pointed at a LOCAL stub toggle server through the same env overrides
// (DSH_GUARD_MARKET_BASE / DSH_GUARD_MARKET_ORIGIN) that contract.js reads in
// production - no test ever POSTs to the real 3080. tryHotMount's own response
// matrix is already pinned by test/mount.test.js (T3); here the CLI-level
// contract (exit codes, streams, gate order, dry gate) is what is asserted.
const HOTCLI_PKG = "hotcli-pkg";
function writeInstalledPackage(home, profile, pkg, patchText) {
  const dir = join(home, "profiles", profile, "node_modules", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg }));
  if (patchText !== null) writeFileSync(join(dir, "cordis.patch.yml"), patchText);
}
function toggleStub(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, () => resolve(srv));
  });
}

test("hotmount without a package exits 2 with usage", async () => {
  const r = await run(["hotmount"], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: guard hotmount <pkg>/);
});

test("hotmount reports a not-installed package with exit 1 and the reason", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-hm-")); try {
    makeProfile(h, "web");
    // nothing under node_modules/<pkg> -> readPatch null and no package.json
    const r = await run(["hotmount", "ghost-pkg", "--profile", "web"], { DSH_HOME: h });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /not installed/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("hotmount refuses a non-plain-insert patch with exit 1 and the shape reason", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-hm-")); try {
    makeProfile(h, "web");
    // patch carries a config row -> shape gate refuses BEFORE any market POST
    writeInstalledPackage(h, "web", HOTCLI_PKG, "- insert:\n  name: x\n- config:\n  foo: bar\n");
    const r = await run(["hotmount", HOTCLI_PKG, "--profile", "web"], { DSH_HOME: h });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /hot-mount unavailable|plain inserts|restart required/i);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("hotmount dry gate prints would-hot-mount, exits 0 and never POSTs", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-hm-")); try {
    makeProfile(h, "web");
    writeInstalledPackage(h, "web", HOTCLI_PKG, "- insert:\n  name: " + HOTCLI_PKG + "\n");
    let hits = 0;
    const srv = await toggleStub((req, res) => { hits++; res.statusCode = 500; res.end("{}"); });
    const port = srv.address().port;
    try {
      const r = await run(["hotmount", HOTCLI_PKG, "--profile", "web"], {
        DSH_HOME: h,
        DSH_GUARD_DRY_HOTMOUNT: "1",
        DSH_GUARD_MARKET_BASE: "http://127.0.0.1:" + port,
        DSH_GUARD_MARKET_ORIGIN: "http://127.0.0.1:" + port,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /\[dry\] would hot-mount hotcli-pkg/);
      assert.equal(hits, 0); // the dry gate must never POST to the market
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("hotmount mounts a shape-ok installed package and exits 0", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-hm-")); try {
    makeProfile(h, "web");
    writeInstalledPackage(h, "web", HOTCLI_PKG, "- insert:\n  id: " + HOTCLI_PKG + "\n  name: " + HOTCLI_PKG + "\n");
    let method = null, url = null, reqBody = null;
    const srv = await toggleStub((req, res) => {
      method = req.method; url = req.url;
      let b = "";
      req.on("data", (ch) => { b += ch; });
      req.on("end", () => {
        reqBody = b;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, name: HOTCLI_PKG, enabled: true, activation: { [HOTCLI_PKG]: { state: "live", hot: true } } }));
      });
    });
    const port = srv.address().port;
    try {
      const r = await run(["hotmount", HOTCLI_PKG, "--profile", "web"], {
        DSH_HOME: h,
        DSH_GUARD_MARKET_BASE: "http://127.0.0.1:" + port,
        DSH_GUARD_MARKET_ORIGIN: "http://127.0.0.1:" + port,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /hot-mounted hotcli-pkg/);
      assert.equal(method, "POST");
      assert.equal(url, "/dsh-market/toggle");
      assert.equal(JSON.parse(reqBody).name, HOTCLI_PKG);
      assert.equal(JSON.parse(reqBody).enabled, true);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("hotmount degraded market toggle exits 1 with the reason", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-hm-")); try {
    makeProfile(h, "web");
    writeInstalledPackage(h, "web", HOTCLI_PKG, "- insert:\n  name: " + HOTCLI_PKG + "\n");
    const srv = await toggleStub((req, res) => {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "market busy" }));
    });
    const port = srv.address().port;
    try {
      const r = await run(["hotmount", HOTCLI_PKG, "--profile", "web"], {
        DSH_HOME: h,
        DSH_GUARD_MARKET_BASE: "http://127.0.0.1:" + port,
        DSH_GUARD_MARKET_ORIGIN: "http://127.0.0.1:" + port,
      });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /hot-mount failed/);
      assert.match(r.stderr, /502/);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// --- guard remote command (task 2, phone-usable URL from host-last.log) ---
// Real child process like every other CLI test; the log path, port and tailscale
// binary are all env-pointed at LOCAL fixtures/stubs so no test touches the real
// host-last.log, a real tailscale, or port 3080:
//   - DSH_GUARD_HOST_LOG -> a throwaway fixture log file in the temp dir
//   - DSH_GUARD_PORT     -> the local stub server's port (announce + verify)
//   - DSH_GUARD_TAILSCALE_CMD -> a nonexistent binary, so the real tailscale is
//     never spawned (the degrade-to-LAN path is exercised via its failure)
// Human output must desensitise the token to its first 6 chars + "...": the URL
// line masks the token inside the query too (printing a full-token URL while a
// masked token line sat next to it would make the masking theatre).
const REMOTE_LOG = (port, token) => [
  "[dsh-desktop] 2026-09-07T10:00:00 boot ok",
  "dsh web: http://127.0.0.1:" + port + "/", // legacy token-less announce line
  "dsh web: http://127.0.0.1:" + port + "/?token=OLDtok_1 (LAN: http://127.0.0.1:" + port + "/?token=OLDtok_1)",
  "dsh web: http://127.0.0.1:" + port + "/?token=" + token + " (LAN: http://127.0.0.1:" + port + "/?token=" + token + ")",
].join("\n") + "\n";
const REMOTE_TOKEN = "TokTes_Remote_1234567890"; // 6-prefix: TokTes
const NO_TAILSCALE = "no-such-tailscale-binary-xyz";

function remoteStub(statusCode) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => { res.statusCode = statusCode; res.end(statusCode === 401 ? "dsh web authentication required" : ""); });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("remote prints a desensitised phone URL and verified status (human)", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rm-")); const srv = await remoteStub(303);
  const port = srv.address().port; const log = join(h, "host-last.log");
  try {
    writeFileSync(log, REMOTE_LOG(port, REMOTE_TOKEN));
    const r = await run(["remote", "--lan"], { DSH_GUARD_HOST_LOG: log, DSH_GUARD_PORT: String(port) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("guard: phone URL: http://127.0.0.1:" + port + "/?token=TokTes..."), r.stdout);
    assert.ok(r.stdout.includes("guard: token: TokTes..."), r.stdout);
    assert.ok(r.stdout.includes("guard: at: "), "human output has time line");
    assert.match(r.stdout, /verified: yes/);
    assert.ok(!r.stdout.includes(REMOTE_TOKEN), "full token must not leak in human mode: " + r.stdout);
  } finally { srv.close(); rmSync(h, { recursive: true, force: true }); }
});

test("remote --json includes the full token, URLs and log file", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rmj-")); const srv = await remoteStub(303);
  const port = srv.address().port; const log = join(h, "host-last.log");
  try {
    writeFileSync(log, REMOTE_LOG(port, REMOTE_TOKEN));
    const r = await run(["remote", "--lan", "--json"], { DSH_GUARD_HOST_LOG: log, DSH_GUARD_PORT: String(port) });
    assert.equal(r.code, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.ok, true);
    assert.equal(o.verified, true);
    assert.equal(o.token, REMOTE_TOKEN);
    assert.equal(o.url, "http://127.0.0.1:" + port + "/?token=" + REMOTE_TOKEN);
    assert.equal(o.lanUrl, o.url);
    assert.equal(o.tailscaleUrl, undefined);
    assert.equal(o.logFile, log);
    assert.equal(typeof o.at, "string");
  } finally { srv.close(); rmSync(h, { recursive: true, force: true }); }
});

test("remote --show-token prints the full token", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rmt-")); const srv = await remoteStub(303);
  const port = srv.address().port; const log = join(h, "host-last.log");
  try {
    writeFileSync(log, REMOTE_LOG(port, REMOTE_TOKEN));
    const r = await run(["remote", "--lan", "--show-token"], { DSH_GUARD_HOST_LOG: log, DSH_GUARD_PORT: String(port) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(REMOTE_TOKEN), r.stdout);
    assert.ok(r.stdout.includes("http://127.0.0.1:" + port + "/?token=" + REMOTE_TOKEN), r.stdout);
  } finally { srv.close(); rmSync(h, { recursive: true, force: true }); }
});

test("remote degrades to the LAN URL when the tailscale probe fails", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rmd-")); const srv = await remoteStub(303);
  const port = srv.address().port; const log = join(h, "host-last.log");
  try {
    writeFileSync(log, REMOTE_LOG(port, REMOTE_TOKEN));
    const r = await run(["remote"], { DSH_GUARD_HOST_LOG: log, DSH_GUARD_PORT: String(port), DSH_GUARD_TAILSCALE_CMD: NO_TAILSCALE });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /tailscale/i); // degrade must not be silent
    assert.ok(r.stdout.includes("http://127.0.0.1:" + port + "/?token=TokTes..."), r.stdout);
  } finally { srv.close(); rmSync(h, { recursive: true, force: true }); }
});

test("remote exits 1 with a stale-token hint when verification returns 401", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rms-")); const srv = await remoteStub(401);
  const port = srv.address().port; const log = join(h, "host-last.log");
  try {
    writeFileSync(log, REMOTE_LOG(port, REMOTE_TOKEN));
    const r = await run(["remote", "--lan"], { DSH_GUARD_HOST_LOG: log, DSH_GUARD_PORT: String(port) });
    assert.equal(r.code, 1, "stderr=" + r.stderr);
    assert.match(r.stderr, /stale|restarted/i);
  } finally { srv.close(); rmSync(h, { recursive: true, force: true }); }
});

test("remote exits 1 when the host log is missing", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rml-"));
  try {
    const r = await run(["remote"], { DSH_GUARD_HOST_LOG: join(h, "no-such-host-last.log"), DSH_GUARD_PORT: "3080", DSH_GUARD_TAILSCALE_CMD: NO_TAILSCALE });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /host log not found/i);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("remote --json missing host log exits 1 with a parseable error object", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-rmlj-"));
  try {
    const r = await run(["remote", "--json"], { DSH_GUARD_HOST_LOG: join(h, "no-such-host-last.log"), DSH_GUARD_PORT: "3080", DSH_GUARD_TAILSCALE_CMD: NO_TAILSCALE });
    assert.equal(r.code, 1);
    const o = JSON.parse(r.stdout);
    assert.equal(o.ok, false);
    assert.match(o.error, /host log not found/i);
    assert.equal(o.logFile, join(h, "no-such-host-last.log"));
  } finally { rmSync(h, { recursive: true, force: true }); }
});

