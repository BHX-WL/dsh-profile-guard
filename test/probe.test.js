import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as probe from "../lib/probe.js";

test("healthy host has __DSH_BOOT__", async () => {
  const srv = createServer((req, res) => { res.end("<html>__DSH_BOOT__</html>"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await probe.isHostHealthy(`http://127.0.0.1:${port}`), true); }
  finally { srv.close(); }
});
test("auth-locked host (401) counts healthy", async () => {
  const srv = createServer((req, res) => { res.statusCode = 401; res.end("authentication required"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await probe.isHostHealthy(`http://127.0.0.1:${port}`), true); }
  finally { srv.close(); }
});
test("nothing listening is unhealthy", async () => {
  assert.equal(await probe.isHostHealthy("http://127.0.0.1:1", 300), false);
});

test("server that accepts but never responds is unhealthy (probe timeout)", async () => {
  const srv = createServer(() => { /* accept, never respond */ });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await probe.isHostHealthy(`http://127.0.0.1:${port}`, 200), false); }
  finally { srv.close(); }
});

test("fetchStatus returns the raw statusCode for 200/303/404 (no auto-follow)", async () => {
  const srv = createServer((req, res) => {
    res.statusCode = req.url === "/ok" ? 200 : req.url === "/redirect" ? 303 : 404;
    res.end("probe body");
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await probe.fetchStatus(`${base}/ok`), 200);
    assert.equal(await probe.fetchStatus(`${base}/redirect`), 303);
    assert.equal(await probe.fetchStatus(`${base}/missing`), 404);
  } finally { srv.close(); }
});

test("fetchStatus null on connection refused (network error)", async () => {
  assert.equal(await probe.fetchStatus("http://127.0.0.1:1", 300), null);
});

test("fetchStatus null when the server never responds (timeout)", async () => {
  const srv = createServer(() => { /* accept, never respond */ });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await probe.fetchStatus(`http://127.0.0.1:${port}`, 200), null); }
  finally { srv.close(); }
});
