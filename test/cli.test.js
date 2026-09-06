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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
