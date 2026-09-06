import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

// Windows npm global layout: %APPDATA%/npm = C:/Users/<name>/AppData/Roaming/npm.
// bin.js of the installed dsh CLI lives at
// <npmGlobal>/node_modules/@deepseek-ai/dsh/lib/bin.js .
export function resolveDshBin(npmGlobalRoot = process.env.APPDATA ? join(process.env.APPDATA, "npm") : null) {
  const cands = [];
  if (npmGlobalRoot) cands.push(join(npmGlobalRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  cands.push(join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

export function spawnHost(profile, extraArgs = [], { logFile = null } = {}) {
  const bin = resolveDshBin();
  const args = bin ? [bin, "--profile", profile, ...extraArgs] : ["--yes", "@deepseek-ai/dsh", "--profile", profile, ...extraArgs];
  const cmd = bin ? process.execPath : (process.platform === "win32" ? "npx.cmd" : "npx");
  return spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
}

export function hostLogTail(logFile, n = 40) {
  try {
    if (!logFile || !existsSync(logFile)) return "";
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-n).join("\n");
  } catch { return ""; }
}

// Kill the host listening on <port> (default the dsh web host 3080), but ONLY
// processes whose command line carries a dsh marker — never an unrelated
// process squatting on the port. dryRun collects pids without killing.
// Returns { killed, errors }: killed = pids whose taskkill was issued (dryRun:
// matched pids), errors = per-pid / tool failures, so a caller can tell
// "nothing matched" from "the tools failed". One failing pid never aborts the
// rest: each wmic/taskkill runs in its own try/catch.
export async function stopHostByPort(port = 3080, { dryRun = false } = {}) {
  const killed = [];
  const errors = [];
  let out;
  try {
    out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  } catch (e) {
    errors.push({ stage: "netstat", error: e && e.message ? e.message : String(e) });
    return { killed, errors };
  }
  const pids = new Set();
  // netstat -ano line shape: "  TCP    0.0.0.0:3080    0.0.0.0:0    LISTENING    1234"
  const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`);
  for (const line of out.split(/\r?\n/)) {
    if (!/^\s*TCP\b/i.test(line)) continue;
    const m = line.match(re);
    if (m) pids.add(m[1]);
  }
  for (const pid of pids) {
    if (String(pid) === String(process.pid)) continue;
    let cmd;
    try {
      cmd = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], { encoding: "utf8", windowsHide: true });
    } catch (e) {
      errors.push({ pid: String(pid), stage: "commandline", error: e && e.message ? e.message : String(e) });
      continue;
    }
    // wmic may emit UTF-16; strip NULs so the marker test sees real text.
    if (!/dsh|bin\.js|deepseek/i.test(cmd.replace(/\0/g, ""))) continue;
    if (dryRun) { killed.push(pid); continue; }
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      killed.push(pid);
    } catch (e) {
      // e.g. the process exited between netstat and taskkill — record, keep going
      errors.push({ pid: String(pid), stage: "taskkill", error: e && e.message ? e.message : String(e) });
    }
  }
  return { killed, errors };
}
