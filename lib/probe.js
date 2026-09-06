import http from "node:http";
export function probeBase(baseUrl, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(baseUrl, (res) => {
      let d = ""; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 65536) { req.destroy(); } else { d += c; } });
      res.on("end", () => { res.resume(); resolve(d.includes("__DSH_BOOT__") || (res.statusCode === 401 && d.includes("authentic"))); });
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}
export async function isHostHealthy(baseUrl = "http://127.0.0.1:3080", timeoutMs = 800) { return probeBase(baseUrl, timeoutMs); }
export async function waitHostReady(baseUrl, deadlineMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) { if (await isHostHealthy(baseUrl, 800)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
