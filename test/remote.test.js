import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHostLog, extractAnnounce, buildRemoteInfo } from "../lib/remote.js";

// fixture log: several announce generations + history noise; the current
// process token is the LAST line matching "dsh web: http://127.0.0.1:3080/?token="
const LOG_MULTI = [
  "[dsh-desktop] 2026-09-07T10:00:00 boot ok",
  "dsh web: http://127.0.0.1:3080/", // legacy announce line without a token
  "dsh web: http://127.0.0.1:3080/?token=OLDtoken_ABC (LAN: http://192.168.1.10:3080/?token=OLDtoken_ABC)",
  "[dsh-desktop] web UI ready on 127.0.0.1:3080",
  "dsh web: http://127.0.0.1:3080/?token=NEWtoken-XYZ (LAN: http://192.168.1.50:3080/?token=NEWtoken-XYZ)",
].join("\n");

test("extractAnnounce keeps the LAST announce line and skips legacy no-token lines", () => {
  const ann = extractAnnounce(LOG_MULTI);
  assert.equal(ann.token, "NEWtoken-XYZ");
  assert.equal(ann.lanUrl, "http://192.168.1.50:3080/?token=NEWtoken-XYZ");
});

test("extractAnnounce parses the lowercase lan: variant on the same announce line", () => {
  const text =
    "dsh web: http://127.0.0.1:3080/?token=LanToken_1 (lan: http://10.1.2.3:3080/?token=LanToken_1)";
  const ann = extractAnnounce(text);
  assert.equal(ann.token, "LanToken_1");
  assert.equal(ann.lanUrl, "http://10.1.2.3:3080/?token=LanToken_1");
});

test("extractAnnounce returns null when no line carries a 127.0.0.1 token announce", () => {
  const text = [
    "[dsh-desktop] boot ok",
    "dsh web: http://127.0.0.1:3080/", // present but token-less legacy format
    "dsh web: http://192.168.1.9:3080/?token=RemoteOnly_2", // not 127.0.0.1
  ].join("\n");
  assert.equal(extractAnnounce(text), null);
});

test("extractAnnounce returns null for empty or non-string input", () => {
  assert.equal(extractAnnounce(""), null);
  assert.equal(extractAnnounce("\n\n"), null);
  assert.equal(extractAnnounce(undefined), null);
  assert.equal(extractAnnounce(null), null);
});

test("extractAnnounce honours a custom port and ignores other ports", () => {
  const text =
    "dsh web: http://127.0.0.1:9090/?token=PortToken9 (LAN: http://172.16.0.7:9090/?token=PortToken9)";
  const ann = extractAnnounce(text, 9090);
  assert.equal(ann.token, "PortToken9");
  assert.equal(ann.lanUrl, "http://172.16.0.7:9090/?token=PortToken9");
  // default port 3080 does not see the 9090 announce
  assert.equal(extractAnnounce(text), null);
});

test("buildRemoteInfo prefers the tailscale URL and verify 303 marks it verified", async () => {
  const info = await buildRemoteInfo({
    logText: LOG_MULTI,
    tailscaleIp: "100.67.129.65",
    verify: async () => 303,
  });
  assert.equal(info.ok, true);
  assert.equal(info.token, "NEWtoken-XYZ");
  assert.equal(info.url, "http://100.67.129.65:3080/?token=NEWtoken-XYZ");
  assert.equal(info.tailscaleUrl, info.url);
  assert.equal(info.lanUrl, "http://192.168.1.50:3080/?token=NEWtoken-XYZ");
  assert.equal(info.verified, true);
  assert.equal(info.error, undefined);
});

test("buildRemoteInfo verify 401 is not ok and reports the token stale", async () => {
  const info = await buildRemoteInfo({
    logText: LOG_MULTI,
    tailscaleIp: "100.67.129.65",
    verify: async () => 401,
  });
  assert.equal(info.ok, false);
  assert.equal(info.verified, false);
  assert.equal(info.error, "token stale (host restarted?)");
  // the URL is still reported so the caller can see what was rejected
  assert.equal(info.url, "http://100.67.129.65:3080/?token=NEWtoken-XYZ");
  assert.equal(info.token, "NEWtoken-XYZ");
});

test("buildRemoteInfo falls back to the LAN url when no tailscale IP is given", async () => {
  const info = await buildRemoteInfo({
    logText: LOG_MULTI,
    verify: async () => 303,
  });
  assert.equal(info.ok, true);
  assert.equal(info.url, "http://192.168.1.50:3080/?token=NEWtoken-XYZ");
  assert.equal(info.tailscaleUrl, undefined);
  assert.equal(info.lanUrl, info.url);
  assert.equal(info.verified, true);
});

test("buildRemoteInfo fails cleanly when the token or a reachable address is missing", async () => {
  const noToken = await buildRemoteInfo({ logText: "no announce here", verify: async () => 303 });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.error, "no announce token found");
  // announce present but no tailscale IP and no LAN variant: nothing reachable
  const noAddr = await buildRemoteInfo({
    logText: "dsh web: http://127.0.0.1:3080/?token=OnlyTok_1",
    verify: async () => 303,
  });
  assert.equal(noAddr.ok, false);
  assert.match(noAddr.error, /no reachable address/);
  assert.equal(noAddr.token, "OnlyTok_1");
});

test("readHostLog returns the file text, and null for missing or unreadable paths", async () => {
  const file = join(tmpdir(), "guard-remote-test-" + Date.now() + ".log");
  try {
    writeFileSync(file, "hello announce\n");
    assert.equal(await readHostLog(file), "hello announce\n");
    assert.equal(await readHostLog(join(tmpdir(), "no-such-guard-file-xyz.log")), null);
    assert.equal(await readHostLog(tmpdir()), null); // a directory is not readable as text
  } finally {
    rmSync(file, { force: true });
  }
});

// --- T0 minor additions (task-2 wrap-up): pin the verify-variant semantics the
// T0 review asked for, against the frozen buildRemoteInfo contract ---
test("buildRemoteInfo verify === false marks the token stale explicitly", async () => {
  const info = await buildRemoteInfo({ logText: LOG_MULTI, tailscaleIp: "100.67.129.65", verify: false });
  assert.equal(info.ok, false);
  assert.equal(info.verified, false);
  assert.equal(info.error, "token stale (host restarted?)");
  assert.equal(info.url, "http://100.67.129.65:3080/?token=NEWtoken-XYZ"); // URL still reported
});

test("buildRemoteInfo with verify omitted hands over the URL construct-only (ok, verified:false)", async () => {
  const info = await buildRemoteInfo({ logText: LOG_MULTI, tailscaleIp: "100.67.129.65" });
  assert.equal(info.ok, true);
  assert.equal(info.verified, false);
  assert.equal(info.error, undefined);
  assert.equal(info.url, "http://100.67.129.65:3080/?token=NEWtoken-XYZ");
});

test("buildRemoteInfo a throwing verify resolves not-verified (module catch, never propagates)", async () => {
  const info = await buildRemoteInfo({
    logText: LOG_MULTI,
    tailscaleIp: "100.67.129.65",
    verify: async () => { throw new Error("verification exploded"); },
  });
  // The module catches the throw itself (status null -> not verified), so the
  // cli layer never sees it; fetchStatus in cli resolves null on network errors
  // rather than throwing, keeping this path unreachable in production wiring.
  assert.equal(info.ok, false);
  assert.equal(info.verified, false);
  assert.equal(info.error, "token stale (host restarted?)");
});

