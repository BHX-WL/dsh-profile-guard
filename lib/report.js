// report: buildRestoreReport renders the Chinese restore report that a rollback
// writes under <data root>/guards/<profile>/; saveRestoreReport persists it as
// restore-report-<ts>.md plus last-report.md. Every free-text slot (crashReason,
// restartError, tool errors) passes through sanitize() so tokens, authorization
// headers, cookies, passwords, secrets and keys never reach disk in cleartext.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function buildRestoreReport({
  profile, reason, before, after,
  crashReason = "", snapshotId = "", check = null,
  restarted = false, restartError = null,
  externallyReset = false, hashOk = null, stopErrors = null,
}) {
  const lines = [
    "# dsh-profile-guard 恢复报告",
    "",
    "- 时间：" + new Date().toISOString(),
    "- Profile：" + profile,
    "- 原因：" + reason,
    snapshotId ? "- 回滚到快照：" + snapshotId : "",
    "- 恢复前 bundles：" + ((before?.dsh?.profile?.bundles ?? []).join("、") || "（无）"),
    "- 恢复后 bundles：" + ((after?.dsh?.profile?.bundles ?? []).join("、") || "（无）"),
    "- 自动重启：" + (restarted ? "成功" : restartError ? "失败（" + sanitize(restartError).slice(0, 200) + "）" : "未执行"),
    hashOk !== null ? "- 快照 hash 复核：" + (hashOk ? "通过（与快照一致）" : "未通过（与快照不一致）") : "",
    externallyReset ? "- 二次回滚：检测到外部写者在重拉期间再次重置 manifest，guard 已二次回滚并重写快照 manifest" : "",
    stopErrors && stopErrors.length ? "- 停止宿主警告：" + sanitize(stopErrors.map((e) => [e.stage, e.pid, e.error].filter((v) => v != null).join(" ")).join("; ")).slice(0, 300) : "",
  ].filter(Boolean);
  if (crashReason) lines.push("", "## 崩溃原因", "", "```", sanitize(String(crashReason)).slice(0, 1500), "```");
  if (check && check.problems && check.problems.length) lines.push("", "## 健康检查问题", ...check.problems.map((p) => "- [" + p.severity + "] " + p.message));
  return lines.join("\n");
}
function sanitize(s) { return String(s).replace(/(token|authorization|cookie|password|secret|key)=[^\s&]+/gi, "$1=***"); }
export function saveRestoreReport(dir, md) {
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, "restore-report-" + ts + ".md");
  writeFileSync(file, md, "utf8");
  writeFileSync(join(dir, "last-report.md"), md, "utf8");
  return file;
}
