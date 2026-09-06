// mount: tryHotMount over the market toggle bridge (design §6, spike
// 2026-09-06). Every case runs against a local http stub server simulating the
// toggle response matrix - never the real 3080 market. tryHotMount must never
// throw: each failure path returns { ok:false, degraded:true, reason } so the
// caller can fall back to restart verification.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tryHotMount } from "../lib/mount.js";
import { marketTogglePath } from "../lib/contract.js";

const PKG = "dsh-demo-pkg";
const json = (res, body) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};
const start = (handler) =>
  new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, () => resolve(srv));
  });
const baseUrlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("toggle live response (200) reports ok with state live, not degraded", async () => {
  const srv = await start((req, res) =>
    json(res, { ok: true, name: PKG, enabled: true, activation: { [PKG]: { state: "live", hot: true } } }),
  );
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, true);
    assert.equal(r.state, "live");
    assert.equal(r.degraded, false);
    assert.equal(r.reason, undefined);
  } finally { srv.close(); }
});

test("toggle restart state degrades with a restart reason", async () => {
  const srv = await start((req, res) =>
    json(res, { ok: true, name: PKG, activation: { [PKG]: { state: "restart", reasons: ["needs restart"] } } }),
  );
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.state, "restart");
    assert.match(r.reason, /restart/);
  } finally { srv.close(); }
});

test("toggle 200 without an activation entry for the package degrades", async () => {
  // ok:true but the response carries no activation verdict for this package:
  // the market response shape changed, so the hot mount cannot be confirmed.
  const srv = await start((req, res) => json(res, { ok: true, name: PKG, activation: { "some-other-pkg": { state: "live" } } }));
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /activation|entry/i);
  } finally { srv.close(); }
});

test("toggle 200 with ok:false degrades and surfaces the market reason", async () => {
  // hotMount itself failed/refused (setPluginEnabled ok=false): the market
  // returns ok:false with a reason - degrade and pass that reason through so
  // the user sees why the restart fallback happened.
  const srv = await start((req, res) => json(res, { ok: false, name: PKG, reason: "only plain-insert patches can hot-mount" }));
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.state, undefined);
    assert.match(r.reason, /only plain-insert patches can hot-mount/);
  } finally { srv.close(); }
});

test("toggle 403 (untrusted origin) degrades", async () => {
  const srv = await start((req, res) => {
    res.statusCode = 403;
    json(res, { error: "untrusted origin" });
  });
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /403|untrusted/i);
  } finally { srv.close(); }
});

test("toggle 404 (route moved) degrades", async () => {
  const srv = await start((req, res) => { res.statusCode = 404; res.end("not found"); });
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /404/);
  } finally { srv.close(); }
});

test("toggle non-JSON body degrades", async () => {
  const srv = await start((req, res) => { res.setHeader("content-type", "text/plain"); res.end("everything fine, no json here"); });
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /json|parse/i);
  } finally { srv.close(); }
});

test("toggle request that stalls degrades with a timeout reason (no throw)", async () => {
  const srv = await start(() => { /* accept, never respond */ });
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /timeout|timed out/i);
  } finally { srv.close(); }
});

test("toggle network failure (connection refused) degrades without throwing", async () => {
  const srv = await start(() => {});
  const baseUrl = baseUrlOf(srv);
  await new Promise((r) => srv.close(r)); // port now refuses connections
  const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /ECONNREFUSED|request failed/i);
});

test("tryHotMount posts the exact toggle request (method, path, body, Origin)", async () => {
  let seen = null;
  const srv = await start((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        origin: req.headers.origin,
        contentType: req.headers["content-type"],
        host: req.headers.host,
        body,
      };
      json(res, { ok: true, name: PKG, activation: { [PKG]: { state: "live" } } });
    });
  });
  const baseUrl = baseUrlOf(srv);
  try {
    const r = await tryHotMount(PKG, { baseUrl, origin: baseUrl, timeoutMs: 3000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(seen, "server never received the request");
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, marketTogglePath());
    // Origin must byte-match the baseUrl host string (spike: localhost != 127.0.0.1 -> 403)
    assert.equal(seen.origin, baseUrl);
    assert.equal(seen.contentType, "application/json");
    assert.deepEqual(JSON.parse(seen.body), { name: PKG, enabled: true });
    // Host header is derived by fetch from the URL, never set explicitly
    assert.equal(seen.host, `127.0.0.1:${srv.address().port}`);
  } finally { srv.close(); }
});
