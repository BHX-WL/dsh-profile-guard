import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardsDir, profileDir } from "../lib/paths.js";

// dshHome() is the dsh DATA ROOT: when the dsh runtime sets DSH_HOME it
// already points at the directory that holds profiles/ and guards/
// (e.g. C:/Users/<name>/.dsh); when unset we fall back to <home>/.dsh.
function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("DSH_HOME set is used directly as the data root", () => {
  const root = join(tmpdir(), "guard-dsh-root");
  withEnv("DSH_HOME", root, () => {
    assert.equal(profileDir("web"), join(root, "profiles", "web"));
    assert.equal(guardsDir("web"), join(root, "guards", "web"));
  });
});

test("without DSH_HOME paths nest under <home>/.dsh", () => {
  withEnv("DSH_HOME", undefined, () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    assert.equal(profileDir("web"), join(home, ".dsh", "profiles", "web"));
    assert.equal(guardsDir("web"), join(home, ".dsh", "guards", "web"));
  });
});
