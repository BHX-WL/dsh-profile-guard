#!/usr/bin/env node
// cli: the `guard` command surface. Thin wiring over the lib modules — no logic
// of its own beyond argv parsing and exit codes.
//
// Exit-code contract (controller ruling):
//   boot 0 ok / 1 failed (already-running is a success: prints, exits 0)
//   snapshot 0, list 0, check 0 healthy / 1 unhealthy
//   show 0 found / 1 not found (missing <id> is a usage error -> 2)
//   restore 0 / 1 failed / 2 usage error   watch failure 1, help 0, unknown 2
//
// Safety: boot and restore call the real destructive paths (spawn the dsh host,
// stop port 3080) exactly as a human-run recovery command must — this file has
// no injection point, so they are never integration-tested here; their dry
// equivalents live in test/boot.test.js / test/rollback.test.js.
import { pathToFileURL } from "node:url";
import { createSnapshot, listSnapshots } from "./snapshot.js";
import { staticCheck } from "./check.js";
import { bootOnce } from "./boot.js";
import { rollbackToSnapshot } from "./rollback.js";

const USAGE = `usage: guard <command> [--profile <name>] [options]

commands:
  boot      start the dsh host with an automatic snapshot + rollback guard
  snapshot  create a snapshot of the current profile state
  list      list snapshots
  show <id> show snapshot details
  restore <id>  roll back to a snapshot
  check     run a read-only health check on the profile
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
      const r = await rollbackToSnapshot(profile, id, { autoRestart: !rest.includes("--no-auto-restart"), stopPort: true });
      if (r.ok) {
        process.stdout.write(`restored to ${id} (restarted: ${r.restarted})\n`);
        process.exit(0);
      }
      fail(`restore failed: ${r.error || "unknown"}`, 1);
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
        await mod.watchProfile(profile);
        process.exit(0);
      } catch (e) {
        if (e?.code === "ERR_MODULE_NOT_FOUND") fail("guard: watch not yet available (lib/watch.js not implemented)", 1);
        throw e;
      }
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
