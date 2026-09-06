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
