#!/usr/bin/env node
// cli: the `guard` command surface. Thin wiring over the lib modules — no logic
// of its own beyond argv parsing and exit codes.
//
// Exit-code contract (controller ruling):
//   boot 0 ok / 1 failed (already-running is a success: prints, exits 0)
//   snapshot 0, list 0, check 0 healthy / 1 unhealthy
//   show 0 found / 1 not found (missing <id> is a usage error -> 2)
//   restore 0 / 1 failed / 2 usage error   watch failure 1, help 0, unknown 2
//   preflight 0 ok / 1 refused / 2 usage error   (--force overrides the core-shadow check only)
//   install 0 ok / 1 failed or refused / 2 usage error   (DSH_GUARD_DRY_INSTALL=1 stops before any install)
//     hot-mount ok -> 0 without restart; DSH_GUARD_DRY_HOTMOUNT=1 prints would-hot-mount, never POSTs
//   hotmount <pkg> 0 hot-mounted / 1 degraded, shape-refused or not installed / 2 usage error
//     (manual trigger: shape gate then market toggle; no restart fallback, no host spawn)
//   remote 0 usable / 1 unavailable (missing log / stale token / no announce / no address)
//
// Safety: boot and restore call the real destructive paths (spawn the dsh host,
// stop port 3080) exactly as a human-run recovery command must — this file has
// no injection point, so they are never integration-tested here; their dry
// equivalents live in test/boot.test.js / test/rollback.test.js. install's
// real spawn/boot half is production-only the same way: the dry env stops it
// after preflight + snapshot, so the CLI tests exercise install fully dry.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootOnce } from "./boot.js";
import { staticCheck, readPatchInsertIds } from "./check.js";
import * as contract from "./contract.js";
import { resolve as resolveCorePackages, staticList } from "./core-packages.js";
import { resolveDshBin, stopHostByPort } from "./host.js";
import { tryHotMount } from "./mount.js";
import { canHotMountByShape, readPatch } from "./patch.js";
import { profileDir } from "./paths.js";
import { checkManifest } from "./preflight.js";
import { fetchStatus, isHostHealthy } from "./probe.js";
import { fetchManifest } from "./registry.js";
import { rollbackToSnapshot } from "./rollback.js";
import { readHostLog, buildRemoteInfo } from "./remote.js";
import { createSnapshot, listSnapshots } from "./snapshot.js";

const USAGE = `usage: guard <command> [--profile <name>] [options]

commands:
  boot      start the dsh host with an automatic snapshot + rollback guard
  snapshot  create a snapshot of the current profile state
  list      list snapshots
  show <id> show snapshot details
  restore <id>  roll back to a snapshot
  check     run a read-only health check on the profile
  preflight <pkg>  check a package against the host before installing
  install <pkg>    preflight-gated install (snapshot + plugin add + boot verify)
  hotmount <pkg>   hot-mount an installed plugin without a restart (plain-insert patches only)
  remote    print the phone-usable URL for the running dsh web host
  watch     watch profile changes and snapshot automatically
  help      show this help
`;

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

// Exit mechanics for the network commands (S1, final review round): a direct
// process.exit() right after a real registry fetch races undici's handle
// teardown and trips a Windows libuv fail-fast abort ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c, line 94", exit
// 0xC0000409 — reproduced 3/3 against the real npmmirror registry). So:
//   - commands that just ran a registry fetch (preflight; install up to the
//     host spawn) exit through settleExit(code): the exit is natural — the
//     loop drains the fetch handles and Node exits with exitCode — and an
//     unref'd deadline force-exits only if some other handle keeps the loop
//     alive past the settle window (it never delays a clean drain);
//   - commands that spawned a long-running host (boot/restore/install verify)
//     must keep force-exiting (process.exit / fail): the host child's pipes
//     would hold a natural exit open forever. Their network work settled long
//     before, so a force exit there is safe.
function settleExit(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(process.exitCode), 400).unref();
}

// Pull --profile out of anywhere in argv; everything else stays in rest.
function parse(argv) {
  const profile = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : "web";
  const rest = argv.filter((a, i) => !(a === "--profile" || argv[i - 1] === "--profile"));
  return { profile, rest };
}

function optionValue(rest, name, fallback) {
  const i = rest.indexOf(name);
  return i !== -1 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
}

// --- guard remote helpers (design 2026-09-07 §5/§7) ---
// Human-readable output never shows the full launch token: only its first 6
// chars + "..." (the URL query token is masked the same way). --show-token
// opts into the full value; --json carries it for scripts (documented warning).
function maskToken(token) {
  if (typeof token !== "string") return "";
  // First 6 chars + "..."; a token too short to leave any hidden tail is
  // masked harder (never show a whole launch token in human mode).
  if (token.length <= 6) return token.slice(0, Math.max(1, token.length - 3)) + "...";
  return token.slice(0, 6) + "...";
}
function maskUrl(url, token) {
  return typeof url === "string" && typeof token === "string" && token
    ? url.replace(token, maskToken(token))
    : url;
}

// tailscale ip -4 as the Tailscale-IP source for the phone URL. Real spawn in
// production, but every failure (binary missing, tailscaled down, no IPv4
// lease, timeout) resolves null and the caller degrades to the LAN announce —
// never a crash (design §9.1). DSH_GUARD_TAILSCALE_CMD overrides the binary so
// tests point it at a nonexistent command and never touch a real tailscale.
function tailscaleIp4(cmd = process.env.DSH_GUARD_TAILSCALE_CMD || "tailscale", timeoutMs = 4000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ["ip", "-4"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", () => done(null));
    child.on("close", (code) => {
      const ip = out.trim().split(/\s+/)[0] || null;
      done(code === 0 && ip ? ip : null);
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, timeoutMs);
  });
}

// Observed host-contract facts for `guard check` (design §11.5-2): what the
// CLI can genuinely observe of the running host. check is offline and
// read-only, and no live-host probe site is attached yet, so no observation is
// supplied today — checkHostContract then compares the contract to itself and
// reports no drift. The wiring (warn output + exit-code invariance in the
// check branch) is the deliverable of this round; real observations (e.g. the
// boot marker actually served by a host answering on 3080) plug in here as
// probe sites land. The mismatch path itself is pinned in test/contract.test.js.
function observedContract() { return {}; }

// Host facts for the preflight verdict engine: resolve the real global dsh
// install the same way boot/restore do (resolveDshBin), then read its version
// and its core namespace. A missing/unreadable host degrades to version
// 'unknown' + staticList(): the judgement then only enforces what can be
// proven locally (design 11.5 C6 leniency); engine-less candidates still pass.
function hostFacts() {
  const bin = resolveDshBin();
  if (!bin) return { hostVersion: undefined, corePackages: staticList() };
  const dshDir = dirname(dirname(bin)); // .../node_modules/@deepseek-ai/dsh
  let hostVersion;
  try {
    const pj = JSON.parse(readFileSync(join(dshDir, "package.json"), "utf8"));
    hostVersion = typeof pj?.version === "string" ? pj.version : undefined;
  } catch { hostVersion = undefined; }
  return { hostVersion, corePackages: resolveCorePackages(dshDir) };
}

// Shared preflight gate for the preflight and install commands (design §5):
// host facts + one registry manifest fetch + the pure verdict engine, with
// every signal the verdicts produce printed to stderr — warnings on the pass
// and the refuse path alike, errors line by line. ok:false means refused
// (the caller exits 1 without touching the profile); ok:true means clean or
// --force-overridden (the caller prints its own pass summary).
async function preflightOk(pkg, { profile, force, registry }) {
  const { hostVersion, corePackages } = hostFacts();
  const manifest = await fetchManifest(pkg, registry ? { registry } : {});
  const installedInsertIds = readPatchInsertIds(profileDir(profile));
  const { verdicts } = checkManifest(manifest, { hostVersion, corePackages, installedInsertIds });
  for (const v of verdicts.filter((w) => w.severity === "warn")) {
    process.stderr.write(`guard: warning: ${v.message}\n`);
  }
  const errors = verdicts.filter((v) => v.severity === "error");
  if (!errors.length) return { ok: true, hostVersion };
  const hard = errors.filter((v) => !v.forceable);
  if (!force || hard.length) {
    for (const v of errors) process.stderr.write(`guard: ${v.message}\n`);
    return { ok: false, hostVersion, hardRefused: hard.length > 0 };
  }
  for (const v of errors) process.stderr.write(`guard: warning (--force): ${v.message}\n`);
  return { ok: true, hostVersion };
}

// The real install spawn argv: `node <dsh bin> plugin --profile <p> add <pkg>`.
// Built from the central contract constants (C1) so a host CLI rename stays an
// env override away instead of a code change.
function pluginAddArgs(profile, pkg) {
  return [contract.pluginSubcommand(), contract.profileFlag(), profile, contract.addCommand(), pkg];
}

// Production install runner: spawn the global dsh bin and wait for its exit.
// Reachable only from a real `guard install` — the dry gate short-circuits
// before this, exactly like the destructive boot/restore branches, so no test
// ever installs a package or spawns the host.
function runDshPluginAdd(bin, args) {
  return new Promise((resolve) => {
    let log = "";
    const child = spawn(process.execPath, [bin, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (ch) => { log += ch; });
    child.stderr.on("data", (ch) => { log += ch; });
    child.on("error", (e) => resolve({ ok: false, error: (e && e.message) || String(e), log }));
    child.on("close", (code) => {
      resolve(code === 0
        ? { ok: true, log }
        : { ok: false, error: log.trim() || `dsh plugin add exited with code ${code}`, log });
    });
  });
}

// Post-install boot verification with a forced restart (review round 1/5).
// bootOnce treats an already-running healthy host as a no-op ({ ok: true,
// alreadyRunning: true }) — correct for `guard boot` (a host that is up needs
// nothing), but wrong after `guard install`, whose whole point is to boot the
// JUST-installed plugin and catch a startup crash: on an already-running host
// a "crashes on boot" plugin would never load and install would still print
// ok. So when the host is already up we stop it (task-1 stopHostByPort), wait
// for it to actually go down (so bootOnce cannot fast-path on the dying host
// still answering the probe), and then bootOnce restarts it and verifies for
// real — a plugin-level boot failure auto-rolls back to the latest healthy
// snapshot inside bootOnce (task-1 rollback). When the host is down, bootOnce
// starts it. Production-only from install's perspective: the dry gate stops
// install before the spawn, so the CLI tests never reach it (boot/restore
// ruling). The seams (isHealthy/stopHost/boot) exist so an integration test
// can drive the whole sequencing dry — no host is ever touched.
export async function runPostInstallVerify({ profile, port = 3080, settleMs = 10000, isHealthy, stopHost, boot } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const healthy = isHealthy || (() => isHostHealthy(baseUrl));
  const stopper = stopHost || (() => stopHostByPort(port));
  const booter = boot || (() => bootOnce(profile, [], {}));
  if (await healthy()) {
    const stopped = await stopper();
    // Nothing killed AND a tool failed = the forced restart cannot happen;
    // a killed pid (or a clean "nothing matched" because the host exited
    // between the probe and netstat) means bootOnce below will really restart.
    if (stopped.killed.length === 0 && stopped.errors.length > 0) {
      return {
        ok: false, stopFailed: true, stopErrors: stopped.errors,
        error: "could not stop the running host for boot verification (" +
          stopped.errors.map((e) => `${e.stage}: ${e.error ?? e}`).join("; ") + ")",
      };
    }
    const t0 = Date.now();
    while (Date.now() - t0 < settleMs && (await healthy())) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (await healthy()) {
      return { ok: false, stopFailed: true,
        error: `the running host did not stop within ${settleMs}ms - restart it manually (guard boot) and check the new plugin` };
    }
  }
  return booter();
}
// Decide how `guard install` reports a post-install boot verification (I1,
// final review round). bootOnce's auto-rollback may have restored the profile
// to the latest healthy snapshot because the just-installed plugin crashed the
// boot; bootRollbackResult then reports ok:true (the host is back up on the
// healthy snapshot) — a success for `guard boot`, but for `guard install` the
// plugin did NOT stick. Any rolledBack result is therefore a failed install
// (exit 1) with the rollback spelled out; only a verification with no rollback
// and ok:true stays an install ok. Pure decision, so the (production-only,
// spawn-heavy) install branch stays untestable while the ruling is pinned.
export function postInstallOutcome(b = {}) {
  const bb = b ?? {};
  if (bb.rolledBack) {
    let msg = `install rolled back to healthy snapshot ${bb.snapshotId ?? "-"}; plugin removed`;
    if (bb.ok !== true) msg += ` (host did not recover${bb.error ? ": " + bb.error : ""})`;
    return { exitCode: 1, message: msg };
  }
  if (bb.ok !== true) return { exitCode: 1, message: `install ok but boot verification failed: ${bb.error || "unknown"}` };
  return { exitCode: 0, message: null };
}

// Post-add hot-mount decision (task 4, wiring seam for the install branch):
// after a successful `dsh plugin add`, a package whose shape
// canHotMountByShape accepts (plain-insert patch / client-only) may be
// activated WITHOUT a restart through the market toggle (tryHotMount). Success
// ends install here — "install ok (hot-mounted <pkg>, snapshot <id>)", exit 0,
// and NO restart verification. Every other outcome degrades back to
// runPostInstallVerify, the pre-existing forced-restart verification (stop a
// running host, then bootOnce restarts + verifies for real, with bootOnce's
// auto-rollback) — the fallback path keeps its own outcome message (I1: a
// rolled-back verification is a FAILED install whatever ok says).
// The seams (canHotMount/mount/verify/out/err) default to the real modules and
// process streams, and tests inject fakes for all of them — exactly like
// runPostInstallVerify — so the whole decision sequence runs dry: no patch is
// read for real, no market POST is made, no host is booted. The helper never
// throws and never exits; the install branch applies the exit discipline: a
// natural settleExit for the hot-mount ok (a market fetch must drain — S1)
// and a force exit after a verify that may have spawned a host whose child
// pipes hold the loop open.
// DSH_GUARD_DRY_HOTMOUNT=1 is a second, NARROWER dry gate that sits after the
// real add: it prints what the hot-mount would do ("[dry] would hot-mount
// <pkg>") and skips the real market POST, then still falls back to the restart
// verification — the plugin WAS really added, so a dry gate must never claim a
// live mount. DSH_GUARD_DRY_INSTALL=1 (which stops the install before the add)
// is untouched and short-circuits before this segment.
export async function runPostAddHotMount({
  profile, pkg, snapshotId,
  canHotMount = (pd, name) => canHotMountByShape(pd, name),
  mount = (name, opts) => tryHotMount(name, opts),
  verify = (opts) => runPostInstallVerify(opts),
  env = process.env,
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
} = {}) {
  const fallback = async () => {
    const b = await verify({ profile });
    const outcome = postInstallOutcome(b);
    if (outcome.exitCode !== 0) {
      err(outcome.message + "\n");
      return { kind: "verify-failed", exitCode: outcome.exitCode, message: outcome.message };
    }
    out(`install ok (snapshot ${snapshotId})\n`);
    return { kind: "verify-ok", exitCode: 0 };
  };
  // (a) shape gate: only what canHotMountByShape accepts may hot-mount;
  //     anything else degrades to the restart verification, reason printed.
  let shape;
  try {
    shape = await canHotMount(profileDir(profile), pkg);
  } catch (e) {
    shape = { ok: false, reason: (e && e.message) || String(e) };
  }
  if (!shape || shape.ok !== true) {
    const reason = (shape && shape.reason) || "shape check failed";
    err(`guard: hot-mount unavailable (${reason}); falling back to restart verification\n`);
    return fallback();
  }
  // Dry gate: report the would-be hot-mount, never POST to the market.
  if (env.DSH_GUARD_DRY_HOTMOUNT === "1") {
    out(`[dry] would hot-mount ${pkg}\n`);
    return fallback();
  }
  // (b) tryHotMount against the market toggle; ok:true ends install here.
  let mounted;
  try {
    mounted = await mount(pkg, { baseUrl: contract.marketBaseUrl(), origin: contract.marketOrigin() });
  } catch (e) {
    mounted = { ok: false, degraded: true, reason: (e && e.message) || String(e) };
  }
  if (mounted && mounted.ok === true) {
    out(`install ok (hot-mounted ${pkg}, snapshot ${snapshotId})\n`);
    return { kind: "hot-mounted", exitCode: 0 };
  }
  // (c) degraded toggle: print why, then fall back to the restart verification.
  const reason = (mounted && mounted.reason) || "unknown";
  err(`guard: hot-mount failed (${reason}); falling back to restart verification\n`);
  return fallback();
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const cmd = argv[0];
  const { profile, rest } = parse(argv.slice(1));
  switch (cmd) {
    case "boot": {
      // bootOnce spawns only when spawnHost !== false (default true): a human
      // running `guard boot` wants the real host up, "--" separates dsh args.
      const extra = rest.filter((a) => a !== "--");
      const r = await bootOnce(profile, extra, {});
      if (r.ok) {
        process.stdout.write(r.alreadyRunning ? "host already running (healthy)\n" : `boot ok (snapshot ${r.snapshotId ?? "-"})\n`);
        process.exit(0);
      }
      fail(`boot failed: ${r.error || "unknown"}` + (r.report ? `\nreport: ${r.report}` : ""), 1);
      break;
    }
    case "snapshot": {
      const reason = optionValue(rest, "--reason", "manual");
      const s = await createSnapshot(profile, { reason, healthy: false });
      process.stdout.write(`snapshot ${s.id} created\n`);
      process.exit(0);
      break;
    }
    case "list": {
      const snaps = listSnapshots(profile);
      if (!snaps.length) {
        process.stdout.write(`no snapshots for profile ${profile}\n`);
        process.exit(0);
      }
      process.stdout.write(`snapshots for profile ${profile}:\n`);
      for (const s of snaps) {
        process.stdout.write(`${s.healthy ? "[healthy] " : "[pending] "}${s.id} ${s.createdAt} ${s.reason ? "(" + s.reason + ")" : ""}\n`);
      }
      process.exit(0);
      break;
    }
    case "show": {
      // Show reads from listSnapshots (same source of truth as list): the meta
      // fields id/createdAt/healthy/reason/hash/deps/bundles are all present.
      const id = rest[0];
      if (!id) fail("usage: guard show <id>", 2);
      const snap = listSnapshots(profile).find((s) => s.id === id);
      if (!snap) fail(`guard: snapshot ${id} not found`, 1);
      process.stdout.write(`snapshot ${snap.id}\n`);
      process.stdout.write(`  createdAt: ${snap.createdAt}\n`);
      process.stdout.write(`  healthy: ${snap.healthy ? "true" : "false"}\n`);
      if (snap.reason) process.stdout.write(`  reason: ${snap.reason}\n`);
      process.stdout.write(`  hash: ${snap.hash ?? "-"}\n`);
      process.stdout.write(`  deps: ${(snap.deps ?? []).join(", ") || "(none)"}\n`);
      process.stdout.write(`  bundles: ${(snap.bundles ?? []).join(", ") || "(none)"}\n`);
      process.exit(0);
      break;
    }
    case "restore": {
      // Destructive recovery by design: stopPort stays true here on purpose —
      // restoring while the broken host still owns 3080 would fight the re-pull.
      const id = rest[0];
      if (!id) fail("usage: guard restore <id> [--no-auto-restart]", 2);
      const autoRestart = !rest.includes("--no-auto-restart");
      const r = await rollbackToSnapshot(profile, id, { autoRestart, stopPort: true });
      if (!r.ok) fail(`restore failed: ${r.error || "unknown"}`, 1);
      // Half-success: the manifest was restored but the requested auto-restart
      // did not complete (rollback returns { ok:true, restarted:false,
      // restartError } then) — the same reading bootRollbackResult applies to a
      // restart failure on the boot path (exit 1). Only --no-auto-restart makes
      // a restartless restore a success. Not integration-testable dry at this
      // layer (rollback would really stop port 3080 / spawn the host); the
      // branch is locked by logic review and the exit-contract comment above.
      if (autoRestart && r.restarted !== true) {
        fail(`restored to ${id} but auto-restart failed: ${r.restartError || "unknown"}`, 1);
      }
      process.stdout.write(`restored to ${id} (restarted: ${r.restarted})\n`);
      process.exit(0);
      break;
    }
    case "check": {
      const r = staticCheck(profile);
      // Contract probe (design §11.5-2, I2): compare the observed host-contract
      // facts against the guard's expectations and surface drift as warnings on
      // stderr — never as a profile verdict: the exit code below stays driven
      // by staticCheck alone. observedContract() supplies no observation yet
      // (see its comment), so the probe compares the contract to itself and
      // reports nothing; the mismatch path is pinned by test/contract.test.js
      // (checkHostContract({ bootMarker: "NOPE" })) and future probe sites
      // extend observedContract().
      for (const c of contract.checkHostContract(observedContract())) {
        if (!c.ok) process.stderr.write(`guard: warning: host contract ${c.name} changed: expected ${c.expected}, observed ${c.observed}\n`);
      }
      process.stdout.write(`profile ${profile}: ${r.summary}\n`);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "watch": {
      // lib/watch.js arrives in a later task; a missing module must degrade to
      // a friendly message instead of crashing the whole CLI surface.
      try {
        const mod = await import("./watch.js");
        if (typeof mod.watchProfile !== "function") throw new Error("watch.js does not export watchProfile");
        const w = mod.watchProfile(profile);
        // Resident process: watchProfile returns as soon as its (non-persistent)
        // watchers are attached, so hold the event loop open here and close the
        // watchers on SIGINT/SIGTERM before exiting 0.
        const keepAlive = setInterval(() => {}, 1 << 30);
        await new Promise((resolve) => {
          const stop = () => { clearInterval(keepAlive); w.close(); resolve(); };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        process.exit(0);
      } catch (e) {
        if (e?.code === "ERR_MODULE_NOT_FOUND") fail("guard: watch not yet available (lib/watch.js not implemented)", 1);
        throw e;
      }
      break;
    }
    case "preflight": {
      // Pre-install safety check (design 5), read-only: one registry manifest
      // GET plus local profile/host reads, mapped to exit codes 0 ok (or forced)
      // / 1 refused / 2 usage. The gate itself is shared with install (preflightOk).
      const pkg = rest[0];
      if (!pkg) fail("usage: guard preflight <pkg> [--force] [--registry <url>]", 2);
      const force = rest.includes("--force");
      const registry = optionValue(rest, "--registry", undefined);
      const r = await preflightOk(pkg, { profile, force, registry });
      if (!r.ok) {
        process.stderr.write(r.hardRefused
          ? "guard: preflight refused - some checks cannot be forced\n"
          : "guard: preflight refused (use --force to override the core-shadow check)\n");
        // S1: right after the registry fetch — exit naturally.
        settleExit(1);
        break;
      }
      process.stdout.write(`guard: preflight ok for ${pkg} (host ${r.hostVersion ?? "unknown"})\n`);
      settleExit(0);
      break;
    }
    case "install": {
      // Preflight-gated install closed loop (design §7): refuse before touching
      // the profile, snapshot the current state as pending (reason
      // `preflight install <pkg>`), run the real `dsh plugin add` through the
      // global dsh bin, then boot-verify unless --no-boot — a plugin-level
      // failure after install rolls the profile back to the latest healthy
      // snapshot (bootOnce's task-1 rollback), and the pending snapshot above is
      // always `guard restore`-able.
      // Safety (controller ruling): the real spawn/boot half is production-only.
      // With DSH_GUARD_DRY_INSTALL=1 the command stops after preflight + snapshot
      // and prints the exact spawn it would have run — no test ever installs a
      // package or spawns the host (same dry-gate pattern as boot/restore).
      const pkg = rest[0];
      if (!pkg) fail("usage: guard install <pkg> [--force] [--registry <url>] [--no-boot]", 2);
      const force = rest.includes("--force");
      const registry = optionValue(rest, "--registry", undefined);
      const noBoot = rest.includes("--no-boot");
      const r = await preflightOk(pkg, { profile, force, registry });
      if (!r.ok) {
        // Same refusal path as preflight: exit 1, no snapshot, nothing installed.
        process.stderr.write(r.hardRefused
          ? "guard: preflight refused - some checks cannot be forced\n"
          : "guard: preflight refused (use --force to override the core-shadow check)\n");
        // S1: right after the registry fetch — exit naturally.
        settleExit(1);
        break;
      }
      // Pre-install insurance record: pending until the install + boot verify
      // below prove the profile is still healthy.
      const snap = await createSnapshot(profile, { reason: `preflight install ${pkg}`, healthy: false });
      const args = pluginAddArgs(profile, pkg);
      if (process.env.DSH_GUARD_DRY_INSTALL === "1") {
        // Dry gate: preflight + snapshot already ran above; report the exact
        // spawn production would run and stop. Not reachable in a real install.
        const bin = resolveDshBin();
        const head = bin ? `${process.execPath} ${bin}` : "dsh";
        process.stdout.write(`[dry] would run: ${head} ${args.join(" ")}\n`);
        process.stdout.write(`install dry ok (snapshot ${snap.id})\n`);
        // S1: right after the registry fetch — exit naturally.
        settleExit(0);
        break;
      }
      // --- production only from here (tests never pass the dry gate) ---
      const bin = resolveDshBin();
      if (!bin) {
        process.stderr.write("guard: install aborted - could not locate the global dsh bin (is @deepseek-ai/dsh installed?)\n");
        // S1: no host has been spawned yet and the fetch is recent — natural exit.
        settleExit(1);
        break;
      }
      const res = await runDshPluginAdd(bin, args);
      if (!res.ok) {
        process.stderr.write(`guard: install failed: ${res.error}\n`);
        process.stderr.write("guard: the profile may be partially modified - run `guard restore <latest>` to roll back\n");
        // S1: the plugin-add child has closed and no host is running; the fetch
        // is recent, so prefer a natural exit.
        settleExit(1);
        break;
      }
      if (!noBoot) {
        // Post-add hot-mount (task 4), then — on any fallback — the forced-
        // restart verification (runPostInstallVerify): a plain-insert plugin is
        // activated without a restart via the market toggle when its shape
        // allows it. The fallback keeps its original semantics: bootOnce alone
        // would treat an already-running host as a no-op and never boot the new
        // plugin, so the helper stops a running host first, then bootOnce
        // restarts + verifies for real — a plugin-level boot failure auto-rolls
        // back to the latest healthy snapshot (task-1 rollback). I1 (final
        // review): a rolled-back verification is a FAILED install — the plugin
        // was removed — whatever bootRollbackResult's ok says (the host may
        // have recovered on the healthy snapshot). runPostAddHotMount reports
        // which path ended the install; --no-boot (guarded above) skips
        // hot-mount AND verification by design — the user asked for install
        // only (README).
        const hm = await runPostAddHotMount({ profile, pkg, snapshotId: snap.id });
        if (hm.kind === "hot-mounted") {
          // The market POST happened and no host was spawned: exit naturally
          // (S1) once the fetch handles drain.
          settleExit(0);
          break;
        }
        if (hm.kind === "verify-failed") {
          // The verify path may have stopped and (re)started a real host whose
          // child pipes are still open: force-exit. The preflight fetch settled
          // long before this point, so the S1 force-exit race does not apply
          // here, and the outcome message was already written to stderr by the
          // helper.
          process.exit(hm.exitCode);
          break;
        }
        // verify-ok: the host is up with the new plugin — force-exit for the
        // same pipe reason as above. The helper already printed the ok line.
        process.exit(0);
        break;
      }
      // --no-boot: no host was spawned and nothing keeps the loop alive after
      // the awaited plugin-add child closed — a natural exit is clean (S1).
      process.stdout.write(`install ok (snapshot ${snap.id}) (boot verification skipped)\n`);
      settleExit(0);
      break;
    }
    case "hotmount": {
      // Manual hot-mount trigger (task 5; design open question 1 -> yes): the
      // standalone counterpart to install's post-add hot-mount. Shape gate
      // (canHotMountByShape, local profile read) then a real market toggle POST
      // (tryHotMount). Unlike install there is NO restart fallback - a human
      // driving it by hand sees exactly why the package did not go live, so a
      // degraded toggle or an unsupported shape fails the command (exit 1,
      // reason on stderr). Local pre-fetch paths (usage / not installed / shape
      // refused / dry) exit directly; every path that really POSTed exits
      // through settleExit (S1 - the market fetch handles must drain).
      const pkg = rest[0];
      if (!pkg) fail("usage: guard hotmount <pkg> [--profile <name>]", 2);
      const pd = profileDir(profile);
      // Not-installed reads clearer than the shape gate's generic no-surface
      // reason: no patch file AND no package.json under node_modules means the
      // package is simply not there (nothing to read, nothing to mount).
      if (readPatch(pd, pkg) === null && !existsSync(join(pd, "node_modules", pkg, "package.json"))) {
        fail(`guard: ${pkg} not installed in profile ${profile}`, 1);
      }
      let shape;
      try {
        shape = await canHotMountByShape(pd, pkg);
      } catch (e) {
        fail(`guard: hot-mount shape check failed for ${pkg}: ${(e && e.message) || e}`, 1);
      }
      if (!shape || shape.ok !== true) {
        fail(`guard: hot-mount unavailable for ${pkg}: ${(shape && shape.reason) || "shape check failed"}`, 1);
      }
      if (process.env.DSH_GUARD_DRY_HOTMOUNT === "1") {
        // Dry gate: report the would-be hot-mount, never POST to the market.
        process.stdout.write(`[dry] would hot-mount ${pkg}\n`);
        process.exit(0);
        break;
      }
      let mounted;
      try {
        mounted = await tryHotMount(pkg, { baseUrl: contract.marketBaseUrl(), origin: contract.marketOrigin() });
      } catch (e) {
        // tryHotMount never throws; belt-and-braces so a surprise still reads.
        mounted = { ok: false, degraded: true, reason: (e && e.message) || String(e) };
      }
      if (mounted && mounted.ok === true) {
        process.stdout.write(`hot-mounted ${pkg}\n`);
        // The market POST happened: exit naturally (S1) once fetch handles drain.
        settleExit(0);
        break;
      }
      process.stderr.write(`guard: hot-mount failed for ${pkg}: ${(mounted && mounted.reason) || "unknown"}\n`);
      settleExit(1);
      break;
    }
    case "remote": {
      // Phone-usable URL for the running dsh web host (design 2026-09-07):
      // read host-last.log -> last announce token -> verify 303/200 -> print
      // the Tailscale URL (preferred) or LAN URL. Human output desensitises
      // the token (first 6 + "..."), --json emits the full object for scripts,
      // --show-token reveals the full token, --lan forces LAN-only. exit 0
      // usable / 1 unavailable (missing log, no announce token, stale token,
      // no reachable address). No profile involvement: this is host-external
      // state, so DSH_HOME is irrelevant here.
      const asJson = rest.includes("--json");
      const lanOnly = rest.includes("--lan");
      const showToken = rest.includes("--show-token");
      const logPath = contract.hostLogPath();
      const port = contract.remotePort();
      const logText = await readHostLog(logPath);
      if (logText === null) {
        // Design §5: a missing/unreadable log is a hard error, never a guess.
        // --json keeps stdout machine-parseable on the failure too.
        if (asJson) {
          process.stdout.write(JSON.stringify({ ok: false, error: "host log not found at " + logPath, at: new Date().toISOString(), logFile: logPath }) + "\n");
        } else {
          process.stderr.write(`guard: host log not found at ${logPath} (dsh-desktop not running?)\n`);
        }
        settleExit(1);
        break;
      }
      // Real tailscale spawn, but every failure degrades to the LAN announce
      // (design §9.1); --lan skips the spawn entirely and forces LAN-only.
      let tailscaleIp = null;
      let tailscaleFailed = false;
      if (!lanOnly) {
        tailscaleIp = await tailscaleIp4();
        tailscaleFailed = tailscaleIp === null;
      }
      const info = await buildRemoteInfo({
        logText,
        tailscaleIp,
        port,
        // Frozen contract: verify() must resolve the RAW status code (303/200
        // valid); buildRemoteInfo compares === 303/200 itself (remote.js). A
        // network error resolves null -> not verified -> stale error.
        verify: async (url) => fetchStatus(url),
      });
      // Degrade must not be silent (design §6.2): say when the real tailscale
      // probe failed and we fell back to the announce LAN URL. Only when the
      // fallback actually produced a usable result — a bare failure with no
      // LAN URL is reported by the !info.ok error path below instead.
      if (tailscaleFailed && info.ok) {
        process.stderr.write("guard: tailscale unavailable, using LAN URL\n");
      }
      const at = new Date().toISOString();
      if (asJson) {
        // Full machine-readable shape (design §4), token included on purpose.
        process.stdout.write(JSON.stringify({
          ok: info.ok === true,
          url: info.url,
          tailscaleUrl: info.tailscaleUrl,
          lanUrl: info.lanUrl,
          token: info.token ?? null,
          verified: info.verified === true,
          at,
          logFile: logPath,
          ...(info.error ? { error: info.error } : {}),
        }) + "\n");
        settleExit(info.ok ? 0 : 1);
        break;
      }
      if (!info.ok) {
        process.stderr.write(`guard: remote unavailable: ${info.error || "unknown"}\n`);
        settleExit(1);
        break;
      }
      const shown = showToken ? info.token : maskToken(info.token);
      const shownUrl = showToken ? info.url : maskUrl(info.url, info.token);
      process.stdout.write(`guard: phone URL: ${shownUrl}\n`);
      process.stdout.write(`guard: token: ${shown}\n`);
      process.stdout.write(`guard: verified: ${info.verified ? "yes" : "no"}\n`);
      // S1: a real fetchStatus verification just ran — exit naturally so the
      // http handles drain (same rule as preflight/install/hotmount).
      settleExit(0);
      break;
    }
    default:
      fail(USAGE, 2);
  }
}

// Run only when invoked as the entry script, so the module can be imported
// (e.g. by an alternative verification path) without executing the CLI.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write("guard error: " + (e?.message || e) + "\n");
    // S1: a throw right after a registry fetch (e.g. a 404 from the real
    // registry) must not force-exit while undici is winding down. exitCode plus
    // the unref'd settle deadline exits naturally once the loop drains, and
    // force-exits (bounded, after the settle window) only when a spawned host
    // child keeps the loop alive.
    settleExit(1);
  });
}
