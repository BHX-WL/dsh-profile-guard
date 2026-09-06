// boot: bootOnce is the guard boot entry. It snapshots the profile state as
// pending before the host starts, spawns (or reuses) the dsh host, promotes the
// pending snapshot to healthy on a successful boot, and on a plugin-level boot
// failure rolls the profile back to the latest healthy snapshot with an auto
// restart. All destructive actions are caller-gated so tests can stay fully dry:
//   - spawnHost runs only when opts.spawnHost !== false (tests pass false);
//   - the host boot log is drained to <guards>/<profile>/crash/boot-<ts>.log so
//     plugin-failure detection sees the real log (spawnHost drains stdout/err);
//   - rollback keeps { autoRestart: true, stopPort: true } unless opts.rollback
//     overrides them (tests never reach this branch without healthy snapshots).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readManifest, manifestHash } from "./manifest.js";
import { profileDir, guardsDir } from "./paths.js";
import { createSnapshot, listSnapshots, latestHealthy, markHealthy, prune } from "./snapshot.js";
import { isHostHealthy, waitHostReady } from "./probe.js";
import { spawnHost, hostLogTail } from "./host.js";
import * as contract from "./contract.js";
import { rollbackToSnapshot } from "./rollback.js";

// A host boot log that shows a plugin/install-level failure is a rollback
// trigger. A port conflict (EADDRINUSE) is not: the host may already be
// starting elsewhere and killing it would be wrong (design section on boot).
export function isPluginFailure(logText) {
  const texts = contract.pluginFailureTexts();
  // regex built per call so an env override (DSH_GUARD_FAIL_TEXT) applies live
  const re = new RegExp(texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  return re.test(String(logText ?? ""));
}

// Assemble the boot result from a rollback outcome. Boot's success contract
// (design §6, restore half-success fix 6e2fb56) is that after a rollback the
// host must be running again: ok requires rb.restarted === true, unless the
// caller explicitly waived the restart (requireRestart:false — the dry tests,
// whose rollback runs with autoRestart:false, never spawn or restart a real
// host). A restored-but-not-running host must surface as a boot failure with
// the real reason: rb.error for an early rollback failure, rb.restartError for
// a restart that failed, and an explicit fallback when the restart was skipped
// (the rollback's static check did not pass). A restored manifest that did not
// survive the re-pull (hashOk false) never reports ok either.
export function bootRollbackResult(lastHealthy, rb, { requireRestart = true } = {}) {
  if (!rb) return { ok: false, rolledBack: true, snapshotId: lastHealthy };
  const restartedOk = requireRestart ? rb.restarted === true : true;
  return {
    ok: !!(rb.ok && restartedOk && rb.hashOk !== false),
    rolledBack: true,
    restarted: rb.restarted,
    error: rb.error ?? rb.restartError ?? (requireRestart && rb.ok && rb.restarted !== true ? "restored but host did not restart (static check or start failure)" : null),
    snapshotId: lastHealthy,
    hashOk: rb.hashOk,
    externallyReset: rb.externallyReset,
    report: rb.report,
  };
}

export async function bootOnce(profile, extraArgs = [], opts = {}) {
  const baseUrl = opts.baseUrl || "http://127.0.0.1:3080";
  const dir = profileDir(profile);
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, error: `no manifest at ${dir}` };
  // already running & healthy -> nothing to do (same probe as dsh-desktop)
  if (await isHostHealthy(baseUrl, opts.probeTimeoutMs ?? 800)) return { ok: true, alreadyRunning: true };

  const snaps = listSnapshots(profile);
  const lastHealthy = latestHealthy(profile);
  // Snapshot the current state as pending before boot so a crash mid-boot
  // leaves a recoverable record. A pending snapshot from an earlier interrupted
  // boot is re-adopted (same manifest hash) and promoted by a successful boot
  // below — settling the crash site without a rollback.
  let snapId = null;
  const lastHash = snaps[0]?.hash;
  if (manifestHash(manifest) !== lastHash || !snaps.length) {
    const created = await createSnapshot(profile, { reason: "guard boot", healthy: false });
    snapId = created.id;
  } else if (snaps.length) {
    snapId = snaps[0].id;
  }

  // spawn the host unless the caller disabled it (tests supply their own server).
  // Production drains the child output into a crash/ boot log so a later
  // plugin-failure check reads real text instead of an empty tail.
  let logFile = null;
  if (opts.spawnHost !== false) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    logFile = join(guardsDir(profile), "crash", `boot-${ts}.log`);
    mkdirSync(join(guardsDir(profile), "crash"), { recursive: true });
    const child = spawnHost(profile, [contract.noOpenFlag(), ...extraArgs], { logFile });
    child.unref();
  } else if (opts.logFile) {
    logFile = opts.logFile; // diagnostic / test injection point
  }

  const ready = opts.waitReady === false ? false : await waitHostReady(baseUrl, opts.waitReadyMs ?? 45000);
  if (ready) {
    if (snapId) { try { markHealthy(profile, snapId); } catch {} }
    prune(profile);
    return { ok: true, snapshotId: snapId };
  }

  // boot failed: decide rollback from the drained host log
  const log = hostLogTail(logFile);
  if (isPluginFailure(log) && lastHealthy && snapId && snapId !== lastHealthy) {
    // Rollback options the boot path always wants: restart the host and stop
    // the broken one first. Tests override both to stay dry (never spawn or
    // kill a real host); an explicit autoRestart:false override also waives
    // the boot contract that the host must come back up (requireRestart).
    const rbOpts = { autoRestart: true, stopPort: true, ...(opts.rollback || {}) };
    // The drained plugin-failure log becomes the restore report's crash reason.
    const rb = await rollbackToSnapshot(profile, lastHealthy, { ...rbOpts, crashReason: log });
    // Boot only succeeds when the rolled-back host is running again: a restore
    // whose restart was skipped or failed is a boot failure (exit 1), the same
    // reading the restore path applies to a half-success (6e2fb56).
    return bootRollbackResult(lastHealthy, rb, { requireRestart: rbOpts.autoRestart !== false });
  }
  // No healthy snapshot (or no plugin-failure signal): leave the pending record
  // in place for the next boot / report — never loop a rollback.
  return { ok: false, error: "host did not become ready", snapshotId: snapId };
}
