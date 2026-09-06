import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { guardsDir, profileDir } from "../lib/paths.js";

// Base used by lib/paths.js dshHome(): DSH_HOME overrides, else the OS home.
function dshBase() {
  return process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME;
}

test("guardsDir nests under dsh home guards", () => {
  assert.equal(guardsDir("web"), join(dshBase(), ".dsh", "guards", "web"));
});

test("profileDir nests under profiles", () => {
  assert.equal(profileDir("web"), join(dshBase(), ".dsh", "profiles", "web"));
});
