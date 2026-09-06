// watch: the guard watch auto-snapshot assistant (guard watch). watchProfile
// listens for change events on the profile's package.json and pnpm-lock.yaml,
// debounces them, and — when the current manifest hash differs from the newest
// recorded snapshot — records a new snapshot (reason "auto (watch)") so a
// subsequent install crash can be rolled back to this just-before state.
//
// Watchers are non-persistent and the returned { close() } handle lets an
// embedder (the CLI, a test) release them; the CLI holds the process resident.
// Files that do not exist are skipped (a fresh profile may not have a lockfile
// yet): package.json is the real trigger — manifestHash covers its deps and
// bundles — so a missing lockfile only drops a redundant trigger.
import { watch, existsSync } from "node:fs";
import { join } from "node:path";
import { readManifest, manifestHash } from "./manifest.js";
import { profileDir } from "./paths.js";
import { createSnapshot, listSnapshots } from "./snapshot.js";

export function watchProfile(profile, { debounceMs = 2000 } = {}) {
  const dir = profileDir(profile);
  let timer = null;
  const onChange = async () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const m = readManifest(dir);
        if (!m) return;
        const snaps = listSnapshots(profile);
        if (!snaps.length || snaps[0].hash !== manifestHash(m)) {
          await createSnapshot(profile, { reason: "auto (watch)", healthy: false });
          process.stdout.write(`[guard watch] snapshot created for ${profile}\n`);
        }
      } catch (e) { process.stderr.write("[guard watch] error: " + (e?.message || e) + "\n"); }
    }, debounceMs);
  };
  const files = ["package.json", "pnpm-lock.yaml"].filter((f) => existsSync(join(dir, f)));
  const watchers = files.map((f) => watch(join(dir, f), { persistent: false }, onChange));
  process.stdout.write(`[guard watch] watching ${profile}\n`);
  return { close: () => { clearTimeout(timer); for (const w of watchers) w.close(); } };
}
