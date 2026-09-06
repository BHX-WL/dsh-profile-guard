import { join } from "node:path";

// Base home dir: DSH_HOME overrides, otherwise the OS home. Guard data
// nests under <home>/.dsh so it survives profile resets (HOME/DSH_HOME
// compatible, like the dsh CLI itself).
export function dshHome() {
  return process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME;
}

// Healthy-profile snapshots live outside the profile, under ~/.dsh/guards.
export function guardsDir(profile) {
  return join(dshHome(), ".dsh", "guards", profile);
}

export function profileDir(profile) {
  return join(dshHome(), ".dsh", "profiles", profile);
}

export function crashDir(profile) {
  return join(guardsDir(profile), "crash");
}

export function dshInstallDir() {
  // resolution anchor: this file lives in <install>/node_modules/dsh-profile-guard/lib
  return null; // real global dsh resolution lands in lib/host.js (later task)
}
