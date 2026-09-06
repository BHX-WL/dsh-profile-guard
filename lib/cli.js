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
//
// Safety: boot and restore call the real destructive paths (spawn the dsh host,
// stop port 3080) exactly as a human-run recovery command must — this file has
// no injection point, so they are never integration-tested here; their dry
// equivalents live in test/boot.test.js / test/rollback.test.js. install's
// real spawn/boot half is production-only the same way: the dry env stops it
// after preflight + snapshot, so the CLI tests exercise install fully dry.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootOnce } from "./boot.js";
import { staticCheck, readPatchInsertIds } from "./check.js";
import * as contract from "./contract.js";
import { resolve as resolveCorePackages, staticList } from "./core-packages.js";
import { resolveDshBin, stopHostByPort } from "./host.js";
import { profileDir } from "./paths.js";
import { checkManifest } from "./preflight.js";
import { isHostHealthy } from "./probe.js";
import { fetchManifest } from "./registry.js";
import { rollbackToSnapshot } from "./rollback.js";
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
  watch     watch profile changes and snapshot automatically
  help      show this help
`;

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
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
        process.exit(1);
      }
      process.stdout.write(`guard: preflight ok for ${pkg} (host ${r.hostVersion ?? "unknown"})\n`);
      process.exit(0);
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
        process.exit(1);
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
        process.exit(0);
      }
      // --- production only from here (tests never pass the dry gate) ---
      const bin = resolveDshBin();
      if (!bin) {
        process.stderr.write("guard: install aborted - could not locate the global dsh bin (is @deepseek-ai/dsh installed?)\n");
        process.exit(1);
      }
      const res = await runDshPluginAdd(bin, args);
      if (!res.ok) {
        process.stderr.write(`guard: install failed: ${res.error}\n`);
        process.stderr.write("guard: the profile may be partially modified - run `guard restore <latest>` to roll back\n");
        process.exit(1);
      }
      if (!noBoot) {
        // Post-install verification with a forced restart (runPostInstallVerify):
        // bootOnce alone would treat an already-running host as a no-op and
        // never boot the new plugin, so the helper stops a running host first,
        // then bootOnce restarts + verifies for real — a plugin-level boot
        // failure auto-rolls back to the latest healthy snapshot (task-1
        // rollback); install surfaces that as a failure with the rollback note.
        const b = await runPostInstallVerify({ profile });
        if (!b.ok) {
          const detail = b.rolledBack ? ` (rolled back to ${b.snapshotId ?? "-"})` : "";
          fail(`install ok but boot verification failed: ${b.error || "unknown"}${detail}`, 1);
        }
      }
      process.stdout.write(`install ok (snapshot ${snap.id})${noBoot ? " (boot verification skipped)" : ""}\n`);
      process.exit(0);
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
    process.exit(1);
  });
}
