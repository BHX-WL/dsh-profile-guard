import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDshBin, stopHostByPort } from "../lib/host.js";

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
