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
