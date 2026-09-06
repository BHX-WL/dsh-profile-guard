import { join } from "node:path";

// dshHome() is the dsh DATA ROOT: the directory that already contains
// profiles/ and guards/. The dsh runtime sets DSH_HOME to it
// (e.g. C:/Users/<name>/.dsh); when unset we fall back to <home>/.dsh.
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME;
  return join(home, ".dsh");
}

// Healthy-profile snapshots live outside the profile, under ~/.dsh/guards.
export function guardsDir(profile) {
  return join(dshHome(), "guards", profile);
}

export function profileDir(profile) {
  return join(dshHome(), "profiles", profile);
}

export function crashDir(profile) {
  return join(guardsDir(profile), "crash");
}

export function dshInstallDir() {
  // resolution anchor: this file lives in <install>/node_modules/dsh-profile-guard/lib
  return null; // real global dsh resolution lands in lib/host.js (later task)
}
