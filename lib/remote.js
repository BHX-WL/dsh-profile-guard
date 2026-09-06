import { readFile } from "node:fs/promises";

// Remote entry for the dsh web UI (④ 手机远程). Pure helpers: every input is
// injected (log text, tailscale IP, port, verify status), nothing here reads
// the real host or the network. Zero cordis imports, zero third-party deps.
//
// host-last.log appends one announce line per "dsh web" start, e.g.
//   dsh web: http://127.0.0.1:3080/?token=XXX (LAN: http://192.168.1.50:3080/?token=XXX ...)
// and keeps history, so the CURRENT process token is the LAST line that
// matches the localhost announce shape (legacy token-less announce lines must
// be skipped, not treated as a match).

const TOKEN_RE = /[A-Za-z0-9_-]+/;
const LAN_URL_RE = /\((?:LAN|lan): http:\/\/([^\s:]+):\d+\/\?token=/;

function announceRe(port) {
  return new RegExp(`dsh web: http://127\\.0\\.0\\.1:${port}/\\?token=(${TOKEN_RE.source})`);
}

// Read the host log text, or null when the file is missing/unreadable.
export async function readHostLog(logPath) {
  if (!logPath || typeof logPath !== "string") return null;
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return null;
  }
}

// Extract { token, lanUrl? } from the LAST announce line matching the given
// port (default 3080); null when no announce line carries a token.
export function extractAnnounce(text, port = 3080) {
  if (typeof text !== "string" || text.length === 0) return null;
  const tokenRe = announceRe(port);
  let token = null;
  let line = null;
  for (const row of text.split(/\r?\n/)) {
    const m = tokenRe.exec(row);
    if (m) {
      token = m[1];
      line = row;
    }
  }
  if (token === null) return null;
  const result = { token };
  const lan = line ? LAN_URL_RE.exec(line) : null;
  if (lan) result.lanUrl = `http://${lan[1]}:${port}/?token=${token}`;
  return result;
}

// Build the phone-usable remote info from injected inputs only.
//   verify(url) -> status code (303/200 valid); verify === false is an
//   explicit "stale" marker; verify omitted means no check was possible, so
//   the result is ok with verified:false (construct-only, never claims valid).
// Result: { ok, url, token, verified, tailscaleUrl?, lanUrl?, error? }
export async function buildRemoteInfo({ logText, tailscaleIp, port = 3080, verify } = {}) {
  const ann = extractAnnounce(logText, port);
  const token = ann ? ann.token : null;
  if (!token) return { ok: false, error: "no announce token found" };

  const tailscaleUrl = tailscaleIp
    ? `http://${tailscaleIp}:${port}/?token=${token}`
    : undefined;
  const lanUrl = ann.lanUrl;
  const url = tailscaleUrl || lanUrl;
  if (!url) {
    return {
      ok: false,
      token,
      tailscaleUrl,
      lanUrl,
      error: "no reachable address (no tailscale IP and no LAN announce)",
    };
  }

  const checked = typeof verify === "function" || verify === false;
  let status = null;
  if (typeof verify === "function") {
    try {
      status = await verify(url);
    } catch {
      status = null; // verification network failure: treat as not verified
    }
  } else if (verify === false) {
    status = 401; // explicit stale marker behaves like a failed check
  }
  const verified = checked && (status === 303 || status === 200);
  if (!verified) {
    if (!checked) {
      // no verification source injected: hand over the URL, never claim valid
      return { ok: true, url, token, verified: false, tailscaleUrl, lanUrl };
    }
    return {
      ok: false,
      url,
      token,
      verified: false,
      tailscaleUrl,
      lanUrl,
      error: "token stale (host restarted?)",
    };
  }
  return { ok: true, url, token, verified: true, tailscaleUrl, lanUrl };
}
