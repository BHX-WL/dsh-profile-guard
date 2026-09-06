// Sentinel: list the top-level directories under a profile's
// node_modules/@deepseek-ai. If a stale npm copy of @deepseek-ai packages
// lands inside the profile node_modules (tool-lens incident), it would shadow
// the host-injected core, so the snapshot records this listing for later
// comparison. Returns [] when the directory does not exist.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function listNodeModulesDeepseekAi(profileDir) {
  const dir = join(profileDir, "node_modules", "@deepseek-ai");
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}
