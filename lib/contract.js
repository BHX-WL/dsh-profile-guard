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
export function pluginFailureTexts() {                                                               // C5 boot-failure detection
  const raw = envStr("DSH_GUARD_FAIL_TEXT", "");
  if (raw) return raw.split(";").map((s) => s.trim()).filter(Boolean);
  return ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"];
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
  probe("C5-fail-texts", Array.isArray(observed.failTexts) ? observed.failTexts.join("|") : (observed.failText ?? ""), pluginFailureTexts().join("|"));
  return out;
}
