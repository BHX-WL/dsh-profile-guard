import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Static fallback aligned with host 0.1.2-rc.1 (design §6). fromHost() is the
// authoritative source when a dsh install is found; this list only guarantees
// preflight still works without one (missing host → conservative).
export function staticList() {
  return ["dsh-tools", "dsh-util-values", "cosmokit", "cordis", "schemastery", "dsh-client-runtime", "dsh-agent-presets", "dsh-llm", "dsh-session", "dsh-agent", "dsh-code-runtime", "dsh-host-webserver", "dsh-base", "dsh-web-app", "dsh-headless"];
}

/** Read the host namespace from a dsh install directory (the anchor that
 *  resolveDshBin uses). Returns null when the directory is missing/unreadable
 *  so callers can fall back to staticList(). */
export function fromHost(dshInstallDir) {
  try {
    const dir = join(dshInstallDir, "node_modules", "@deepseek-ai");
    if (!existsSync(dir)) return null;
    return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch { return null; }
}

export function resolve(dshInstallDir) {
  return fromHost(dshInstallDir) ?? staticList();
}
