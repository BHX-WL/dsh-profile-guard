// boot: bootOnce is the guard boot entry. It snapshots the profile state as
// pending before the host starts, spawns (or reuses) the dsh host, promotes the
// pending snapshot to healthy on a successful boot, and on a plugin-level boot
// failure rolls the profile back to the latest healthy snapshot with an auto
// restart. All destructive actions are caller-gated so tests can stay fully dry:
//   - spawnHost runs only when opts.spawnHost !== false (tests pass false);
//   - rollback keeps { autoRestart: true, stopPort: true } unless opts.rollback
//     overrides them (tests never reach this branch without healthy snapshots).
import { readManifest, manifestHash } from "./manifest.js";
import { profileDir } from "./paths.js";
import { createSnapshot, listSnapshots, latestHealthy, markHealthy, prune } from "./snapshot.js";
import { isHostHealthy, waitHostReady } from "./probe.js";
import { spawnHost, hostLogTail } from "./host.js";
import { rollbackToSnapshot } from "./rollback.js";

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

  // spawn the host unless the caller disabled it (tests supply their own server)
  if (opts.spawnHost !== false) {
    const child = spawnHost(profile, ["--no-open", ...extraArgs], {});
    child.unref();
  }

  const ready = opts.waitReady === false ? false : await waitHostReady(baseUrl, opts.waitReadyMs ?? 45000);
  if (ready) {
    if (snapId) { try { markHealthy(profile, snapId); } catch {} }
    prune(profile);
    return { ok: true, snapshotId: snapId };
  }

  // boot failed: decide rollback from the host log tail
  const log = hostLogTail(opts.logFile ?? null);
  const isPluginFailure = /plugin tree failed|host preparation failed|Cannot find module|SyntaxError/i.test(log || "");
  if (isPluginFailure && lastHealthy && snapId && snapId !== lastHealthy) {
    const rb = await rollbackToSnapshot(profile, lastHealthy, { autoRestart: true, stopPort: true, ...(opts.rollback || {}) });
    return { ok: rb.ok, rolledBack: true, restarted: rb.restarted, error: rb.restartError, snapshotId: lastHealthy, report: rb.report };
  }
  // No healthy snapshot (or no plugin-failure signal): leave the pending record
  // in place for the next boot / report — never loop a rollback.
  return { ok: false, error: "host did not become ready", snapshotId: snapId };
}
