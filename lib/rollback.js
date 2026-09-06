// rollback: rollbackToSnapshot restores a profile to a healthy snapshot when a
// plugin install broke the host boot. Flow: read the snapshot meta -> back the
// current (bad) state up under <data root>/guards/<profile>/crash/<ts>/ -> stop
// the host only when stopPort is set -> copy the snapshot package.json back ->
// reconcile bundles to the restored dependencies -> static check -> optionally
// restart and re-verify the snapshot survived the re-pull (spike hardening: an
// external writer may reset the manifest during boot, then guard rolls back a
// second time and records it in the report).
import { mkdirSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { profileDir, guardsDir, crashDir } from "./paths.js";
import { readManifest, writeManifest, manifestHash } from "./manifest.js";
import { snapshotDirOf } from "./snapshot.js";
import { staticCheck } from "./check.js";
import { spawnHost, stopHostByPort, hostLogTail } from "./host.js";
import { waitHostReady } from "./probe.js";
import { buildRestoreReport, saveRestoreReport } from "./report.js";

export async function rollbackToSnapshot(profile, snapshotId, { autoRestart = true, stopPort = true } = {}) {
  const dir = profileDir(profile);
  const snapDir = snapshotDirOf(profile, snapshotId);
  const metaPath = join(snapDir, "meta.json");
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch {}
  if (!meta) return { ok: false, restored: false, error: "snapshot " + snapshotId + " missing" };
  if (!meta.healthy) return { ok: false, restored: false, error: "refusing to roll back to a non-healthy snapshot" };
  const before = readManifest(dir);
  // 1) back up current (bad) state under crash/<ts>/
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const cdir = join(crashDir(profile), ts);
  mkdirSync(cdir, { recursive: true });
  if (existsSync(join(dir, "package.json"))) copyFileSync(join(dir, "package.json"), join(cdir, "package.json.bad"));
  if (existsSync(join(snapDir, "sentinel.json"))) copyFileSync(join(snapDir, "sentinel.json"), join(cdir, "sentinel.snapshot.json"));
  // 2) stop the host ONLY when the caller allows it — tests and dry restores pass
  //    stopPort: false so a unit test can never kill the live host on 3080.
  let stopErrors = null;
  if (stopPort) {
    const stopRes = await stopHostByPort(3080);
    if (stopRes && stopRes.errors && stopRes.errors.length) stopErrors = stopRes.errors;
  }
  // 3) restore the manifest from the snapshot
  copyFileSync(join(snapDir, "package.json"), join(dir, "package.json"));
  const after = readManifest(dir);
  if (!after) return { ok: false, restored: false, error: "snapshot package.json unreadable" };
  // 4) reconcile: keep only bundles whose dependency is present (mirror reconcilePlugins)
  const deps = new Set(Object.keys(after.dependencies ?? {}));
  after.dsh = after.dsh ?? {};
  after.dsh.profile = after.dsh.profile ?? {};
  after.dsh.profile.bundles = (after.dsh.profile.bundles ?? []).filter((b) => deps.has(b));
  writeManifest(dir, after);
  const check = staticCheck(profile);
  // 5) optional auto restart; afterwards verify the manifest hash still matches the
  //    snapshot (an external writer may reset it while the host re-pulls).
  let restartError = null;
  let restarted = false;
  let externallyReset = false;
  let hashOk = null;
  if (autoRestart && check.ok) {
    const child = spawnHost(profile, ["--no-open"], {});
    child.unref();
    restarted = await waitHostReady("http://127.0.0.1:3080", 45000);
    if (!restarted) {
      restartError = hostLogTail(null);
    } else {
      hashOk = manifestHash(readManifest(dir)) === meta.hash;
      if (!hashOk) {
        // external writer reset the manifest again during re-pull: roll back once more
        // from the same snapshot and re-verify; do not fight the writer in a loop.
        copyFileSync(join(snapDir, "package.json"), join(dir, "package.json"));
        const again = readManifest(dir);
        if (again) {
          const d2 = new Set(Object.keys(again.dependencies ?? {}));
          again.dsh = again.dsh ?? {};
          again.dsh.profile = again.dsh.profile ?? {};
          again.dsh.profile.bundles = (again.dsh.profile.bundles ?? []).filter((b) => d2.has(b));
          writeManifest(dir, again);
          hashOk = manifestHash(readManifest(dir)) === meta.hash;
        }
        externallyReset = true;
      }
    }
  }
  const report = buildRestoreReport({ profile, reason: "auto-rollback after boot failure", before, after, snapshotId, check, restarted, restartError, externallyReset, hashOk, stopErrors });
  const file = saveRestoreReport(guardsDir(profile), report);
  return { ok: true, restored: true, restarted, restartError, externallyReset, hashOk, report, file };
}
