// Registry network layer (design §5/§7): fetch npm manifests, guard-external
// and zero-dependency. Default registry is the Tencent mirror npmmirror, which
// is reachable from CN networks; env DSH_GUARD_REGISTRY overrides it. All
// tests run against a local http stub server - never the real registry.

export function defaultRegistry() {
  const v = process.env.DSH_GUARD_REGISTRY;
  return typeof v === "string" && v.trim() !== "" ? v.replace(/\/+$/, "") : "https://registry.npmmirror.com";
}

export function parsePkgSpec(spec) {
  const s = String(spec || "").trim();
  if (!s) throw new Error("guard: invalid empty package spec");
  if (/^(github:|git\+|https?:|file:|link:|\.\.?\/)/.test(s)) throw new Error(`guard: unsupported package spec ${s} (npm registry names only)`);
  let name = s;
  let version;
  const at = s.lastIndexOf("@");
  if (at > 0 && s[at - 1] !== "/") { name = s.slice(0, at); version = s.slice(at + 1); }
  const scoped = name.startsWith("@") ? name.split("/").length === 2 : !name.includes("/");
  if (!scoped) throw new Error(`guard: invalid npm package name ${name}`);
  return version ? { name, version } : { name };
}

function encodePkgName(name) {
  // @scope/name needs the whole thing encoded for a registry path segment
  return name.startsWith("@") ? encodeURIComponent(name) : name;
}

export async function fetchManifest(pkg, { registry = defaultRegistry(), timeoutMs = 10000 } = {}) {
  const { name, version } = typeof pkg === "string" ? parsePkgSpec(pkg) : pkg;
  const base = registry.replace(/\/+$/, "");
  const url = `${base}/${encodePkgName(name)}${version ? "/" + encodeURIComponent(version) : "/latest"}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`guard: registry ${res.status} for ${name}${version ? "@" + version : ""} (${url})`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`guard: registry fetch timed out after ${timeoutMs}ms for ${name} (${url})`);
    if (e.message?.startsWith("guard:")) throw e;
    throw new Error(`guard: registry fetch failed for ${name}: ${e.message}`);
  } finally { clearTimeout(timer); }
}
