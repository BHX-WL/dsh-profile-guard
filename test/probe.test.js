import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isHostHealthy } from "../lib/probe.js";

test("healthy host has __DSH_BOOT__", async () => {
  const srv = createServer((req, res) => { res.end("<html>__DSH_BOOT__</html>"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await isHostHealthy(`http://127.0.0.1:${port}`), true); }
  finally { srv.close(); }
});
test("auth-locked host (401) counts healthy", async () => {
  const srv = createServer((req, res) => { res.statusCode = 401; res.end("authentication required"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await isHostHealthy(`http://127.0.0.1:${port}`), true); }
  finally { srv.close(); }
});
test("nothing listening is unhealthy", async () => {
  assert.equal(await isHostHealthy("http://127.0.0.1:1", 300), false);
});
