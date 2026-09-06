// lib/mount.js - tryHotMount: the market-toggle HTTP bridge (design §6,
// spike 2026-09-06). The guard lives outside the host and imports no
// @deepseek-ai runtime, so the market's POST <baseUrl><togglePath> route is
// the only activation entry open to it. Three spike constraints shape this
// module: the Origin header MUST be sent (undici fetch never adds one - a
// missing Origin is a 403 "untrusted origin"); Origin must byte-match the
// request URL's host string (localhost != 127.0.0.1 would 403); and the Host
// header is left to fetch's default derivation (explicit Host is harmless but
// unneeded). Every failure path returns { ok:false, degraded:true, reason }
// and this module never throws - the caller falls back to restart
// verification. profileDir is accepted in options for call-site symmetry with
// patch.canHotMountByShape (tasks 4/5); the bridge itself needs only HTTP.
import * as contract from "./contract.js";

// Node fetch wraps network errors as TypeError "fetch failed" whose cause
// chain carries the real code (ECONNREFUSED, ENOTFOUND, ...). Walk the chain
// and surface the first error code - same pattern as lib/registry.js - so a
// refused connection reads differently from a DNS miss.
function networkFailureCode(e) {
  let cur = e;
  const seen = new Set();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === "string" && cur.code !== "") return cur.code;
    cur = cur.cause;
  }
  return (e && e.message) || String(e);
}

// A non-2xx body may still be JSON with an { error } field (403 untrusted
// origin); surface it when it is, otherwise the status alone is the reason.
function errorHint(text) {
  try {
    const b = JSON.parse(text);
    if (b && typeof b.error === "string" && b.error !== "") return ` (${b.error})`;
  } catch { /* non-JSON error body: status alone is enough */ }
  return "";
}

// Single-line preview of an unparseable body, capped so a huge response never
// floods the degraded reason.
function preview(text) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

const degraded = (reason, extra) => ({ ok: false, degraded: true, reason, ...extra });

export async function tryHotMount(pkg, { baseUrl, origin, timeoutMs = 8000 } = {}) {
  const name = typeof pkg === "string" ? pkg : pkg && pkg.name;
  if (typeof name !== "string" || name === "") {
    return degraded("no package name given to hot-mount");
  }
  // marketBaseUrl() already strips trailing slashes; an option-supplied base
  // is normalised the same way so base + togglePath never double a slash.
  const base = String(baseUrl ?? contract.marketBaseUrl()).replace(/\/+$/, "");
  const url = base + contract.marketTogglePath();
  // Origin must come from the same string as the URL being posted to, else a
  // localhost/127.0.0.1 drift 403s at the market sameOrigin gate. Derive it
  // from the effective baseUrl unless the caller overrides it explicitly.
  const originHdr = origin !== undefined
    ? String(origin)
    : String(baseUrl ?? contract.marketOrigin()).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: originHdr },
      body: JSON.stringify({ name, enabled: true }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return degraded(`market toggle HTTP ${res.status}${errorHint(text)} for ${name}`);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return degraded(`market toggle response was not JSON for ${name}: ${preview(text)}`);
    }
    // ok:true is the setPluginEnabled result; activation[name].state is the
    // final verdict across every activation source. Both must read (spike).
    if (body?.ok !== true) {
      return degraded(
        typeof body?.reason === "string" && body.reason !== ""
          ? `market toggle rejected for ${name}: ${body.reason}`
          : `market toggle responded ok:false for ${name}`,
      );
    }
    const entry = body?.activation?.[name];
    if (!entry || typeof entry.state !== "string") {
      return degraded(`market toggle response has no activation entry for ${name} (route or response shape changed)`);
    }
    if (entry.state !== "live") {
      return degraded(`market toggle activation for ${name} is "${entry.state}" - restart still required`, { state: entry.state });
    }
    return { ok: true, state: "live", degraded: false };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return degraded(`market toggle timed out after ${timeoutMs}ms for ${name}`);
    }
    return degraded(`market toggle request failed for ${name}: ${networkFailureCode(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
