import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolveDshBin, stopHostByPort, attachHostLog } from "../lib/host.js";

test("resolveDshBin finds global install", () => {
  // point npmGlobalRoot at a fake npm global layout of the same shape
  const h = mkdtempSync(join(tmpdir(), "guard-host-"));
  try {
    const fake = join(h, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(fake, "lib"), { recursive: true });
    writeFileSync(join(fake, "lib", "bin.js"), "#!/usr/bin/env node\n");
    const bin = resolveDshBin(h);
    assert.equal(bin, join(fake, "lib", "bin.js"));
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("stopHostByPort no-op when nothing matches", async () => {
  const r = await stopHostByPort(59999, { dryRun: true });
  assert.ok(Array.isArray(r.killed));
});

// The sandbox forbids spawning a child with piped stdio (EPERM), so the drain
// wiring is exercised with a fake child shaped exactly like a spawned one
// (stdout/stderr streams + error/close events) — the same object shape
// attachHostLog receives from spawnHost in production.
test("attachHostLog appends child stdout and stderr to the log file", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-host-"));
  try {
    const logFile = join(h, "boot.log");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    attachHostLog(child, logFile);
    child.stdout.write("fake-boot-stdout\n");
    child.stderr.write("fake-boot-stderr\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close"); // fires after the stdio streams end, as on a real child
    await new Promise((r) => setTimeout(r, 150)); // let the write stream flush
    const txt = readFileSync(logFile, "utf8");
    assert.match(txt, /fake-boot-stdout/);
    assert.match(txt, /fake-boot-stderr/);
    // and a second child appends, never truncates
    const child2 = new EventEmitter();
    child2.stdout = new PassThrough();
    child2.stderr = new PassThrough();
    attachHostLog(child2, logFile);
    child2.stdout.write("fake-boot-2\n");
    child2.stdout.end();
    child2.stderr.end();
    child2.emit("close");
    await new Promise((r) => setTimeout(r, 150));
    const txt2 = readFileSync(logFile, "utf8");
    assert.match(txt2, /fake-boot-stdout/);
    assert.match(txt2, /fake-boot-2/);
    // no logFile -> attachHostLog is a no-op that returns the child untouched
    assert.equal(attachHostLog(child2, null), child2);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
