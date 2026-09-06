import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parsePkgSpec, fetchManifest } from "../lib/registry.js";

test("parsePkgSpec accepts plain, scoped, and versioned specs", () => {
  assert.deepEqual(parsePkgSpec("dsh-better-edit"), { name: "dsh-better-edit" });
  assert.deepEqual(parsePkgSpec("dsh-better-edit@0.6.3"), { name: "dsh-better-edit", version: "0.6.3" });
  assert.deepEqual(parsePkgSpec("@scope/name@1.2.3"), { name: "@scope/name", version: "1.2.3" });
  assert.throws(() => parsePkgSpec("github:owner/repo"), /unsupported/i);
  assert.throws(() => parsePkgSpec(""), /invalid/i);
});

test("fetchManifest returns parsed manifest for latest", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/dsh-better-edit/latest") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "dsh-better-edit", version: "0.6.3", dependencies: { diff: "^5.0.0" } }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const m = await fetchManifest("dsh-better-edit", { registry: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
    assert.equal(m.version, "0.6.3");
    assert.ok(m.dependencies.diff);
  } finally { srv.close(); }
});

test("fetchManifest 404 throws readable error", async () => {
  const srv = createServer((req, res) => { res.statusCode = 404; res.end("{}"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    await assert.rejects(fetchManifest("ghost-pkg", { registry: `http://127.0.0.1:${port}`, timeoutMs: 3000 }), /not found|404|no such/i);
  } finally { srv.close(); }
});

test("fetchManifest times out with readable error", async () => {
  const srv = createServer(() => { /* never respond */ });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    await assert.rejects(fetchManifest("slow-pkg", { registry: `http://127.0.0.1:${port}`, timeoutMs: 300 }), /timeout|timed out/i);
  } finally { srv.close(); }
});
