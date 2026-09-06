import { join } from "node:path";
// Host contract constants, centralized and env-overridable (design §11.5).
// The guard is host-external and imports no @deepseek-ai runtime; these are
// the disk/CLI contract points that a breaking official update could change.
// Each getter reads its env override first, so adapting to a new host release
// never requires a code change.
const envStr = (key, dflt) => {
  const v = process.env[key];
  return typeof v === "string" && v.trim() !== "" ? v : dflt;
};

export function hostBootMarker() { return envStr("DSH_GUARD_BOOT_MARKER", "__DSH_BOOT__"); }         // C2 online marker
export function hostAuthMarker() { return envStr("DSH_GUARD_AUTH_MARKER", "authentic"); }           // C2 401 marker
export function noOpenFlag() { return envStr("DSH_GUARD_NO_OPEN", "--no-open"); }                    // C1 host launch arg
// C5 boot-failure detection texts: the shipped host failure wording. Kept as
// the fallback when DSH_GUARD_FAIL_TEXT is unset OR parses to nothing.
const DEFAULT_FAIL_TEXTS = ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"];
export function pluginFailureTexts() {
  const raw = envStr("DSH_GUARD_FAIL_TEXT", "");
  if (raw) {
    const texts = raw.split(";").map((s) => s.trim()).filter(Boolean);
    // An override that parses to an empty list (e.g. DSH_GUARD_FAIL_TEXT=";;")
    // must NOT be honoured: isPluginFailure builds RegExp(texts.join("|")) and
    // an empty alternation matches every log line, arming a rollback on any
    // boot (M1). Fall back to the defaults so an empty override stays inert.
    if (texts.length) return texts;
  }
  return DEFAULT_FAIL_TEXTS;
}
export function pluginSubcommand() { return "plugin"; }                                              // C1 dsh plugin shape
export function profileFlag() { return "--profile"; }                                                // C1
export function addCommand() { return "add"; }                                                       // C1

// Market hot-mount toggle bridge (design §6): the guard triggers the host's
// in-market hot-mount via POST <baseUrl><togglePath>, so the route path, base
// URL and Origin are contract points a market upgrade could move. Same envStr
// pattern as the getters above: adapt via env, never a code change.
export function marketTogglePath() { return envStr("DSH_GUARD_MARKET_TOGGLE_PATH", "/dsh-market/toggle"); }     // market toggle route
export function marketBaseUrl() {
  // Strip any trailing slash so base+togglePath never doubles one.
  return envStr("DSH_GUARD_MARKET_BASE", "http://127.0.0.1:3080").replace(/\/+$/, "");
}
// Origin must byte-match the baseUrl host:port — the market sameOrigin gate
// compares them literally (localhost != 127.0.0.1 would 403, spike). Deriving
// the default from marketBaseUrl() keeps the pair in lockstep when only
// DSH_GUARD_MARKET_BASE is overridden.
export function marketOrigin() { return envStr("DSH_GUARD_MARKET_ORIGIN", marketBaseUrl()); }

// Remote phone-access contract (remote design §5): where the host latest-announce
// log lives and which port the host binds. Same envStr pattern — adapt via env,
// never a code change. APPDATA may be absent (non-Windows): the joined default is
// still returned and readHostLog simply nulls on the missing file later.
export function hostLogPath() { return envStr("DSH_GUARD_HOST_LOG", join(process.env.APPDATA || "", "dsh-desktop", "host-last.log")); }
export function remotePort() {
  const n = Number(envStr("DSH_GUARD_PORT", "3080"));
  // A blank or non-numeric override falls back to 3080 (envStr already filters blank).
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 3080;
}

/** Probe-style contract report: each entry { name, ok, observed, expected? }.
 *  Host-structure reads that fail to match surface here as warnings, never crashes. */
export function checkHostContract(observed = {}) {
  const out = [];
  const probe = (name, got, expected) => out.push({ name, ok: got === expected, observed: got, ...(expected !== undefined ? { expected } : {}) });
  probe("C2-boot-marker", observed.bootMarker ?? hostBootMarker(), hostBootMarker());
  probe("C2-auth-marker", observed.authMarker ?? hostAuthMarker(), hostAuthMarker());
  // C5: absent observed input means "no claim", the same reading the C2 probes
  // apply via ?? expected — never a spurious drift from an empty observed
  // string (guard check used to warn on every run; I2). Only a real observed
  // fail-text set/fragment produces a comparison.
  const observedFail = Array.isArray(observed.failTexts)
    ? observed.failTexts.join("|")
    : (typeof observed.failText === "string" ? observed.failText : pluginFailureTexts().join("|"));
  probe("C5-fail-texts", observedFail, pluginFailureTexts().join("|"));
  return out;
}
