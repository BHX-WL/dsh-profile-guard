// report: buildRestoreReport renders the Chinese restore report with secrets
// sanitized (token/authorization/cookie/password/secret/key=... -> ***);
// saveRestoreReport writes restore-report-<ts>.md and last-report.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRestoreReport, saveRestoreReport } from "../lib/report.js";

const before = { dependencies: { a: "1", evil: "1" }, dsh: { profile: { bundles: ["a", "evil"] } } };
const after = { dependencies: { a: "1" }, dsh: { profile: { bundles: ["a"] } } };

test("buildRestoreReport includes profile snapshot and before/after bundles", () => {
  const md = buildRestoreReport({
    profile: "web",
    reason: "auto-rollback after boot failure",
    before, after,
    snapshotId: "20260906-120000-abcdef12",
    check: { ok: true, problems: [], summary: "healthy" },
  });
  assert.ok(md.startsWith("# dsh-profile-guard 恢复报告"));
  assert.match(md, /- Profile：web/);
  assert.match(md, /- 回滚到快照：20260906-120000-abcdef12/);
  assert.match(md, /- 恢复前 bundles：a、evil/);
  assert.match(md, /- 恢复后 bundles：a/);
  assert.match(md, /- 自动重启：未执行/);
});

test("buildRestoreReport sanitizes secrets in crash reason and restart error", () => {
  const crashReason = "plugin pull failed: token=ghp_abc123 secret=xyz789&ref=1";
  const md = buildRestoreReport({
    profile: "web", reason: "r", before, after,
    crashReason,
    restarted: false,
    restartError: "dsh exited: authorization=hf_secRet99 password=pw123",
  });
  assert.ok(!md.includes("ghp_abc123"), "crash token leaked");
  assert.ok(!md.includes("xyz789"), "crash secret leaked");
  assert.ok(!md.includes("hf_secRet99"), "restart authorization leaked");
  assert.ok(!md.includes("pw123"), "restart password leaked");
  assert.match(md, /token=\*\*\*/);
  assert.match(md, /secret=\*\*\*/);
  assert.match(md, /authorization=\*\*\*/);
  assert.match(md, /password=\*\*\*/);
});

test("buildRestoreReport lists health-check problems when present", () => {
  const md = buildRestoreReport({
    profile: "web", reason: "r", before, after,
    check: { ok: false, problems: [{ severity: "error", message: "bundle ghost cannot resolve" }], summary: "x" },
  });
  assert.match(md, /## 健康检查问题/);
  assert.match(md, /- \[error\] bundle ghost cannot resolve/);
});


test("buildRestoreReport renders restart verification and second-rollback fields", () => {
  const md = buildRestoreReport({
    profile: "web", reason: "r", before, after,
    snapshotId: "20260906-120000-abcdef12",
    restarted: true,
    externallyReset: true,
    hashOk: false,
    check: null,
  });
  assert.match(md, /- 自动重启：成功/);
  assert.match(md, /- 快照 hash 复核：未通过（与快照不一致）/);
  assert.match(md, /二次回滚/);
});

test("saveRestoreReport writes timestamped file and last-report.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-rep-"));
  try {
    const nested = join(dir, "sub", "reports");
    const md = "# dsh-profile-guard 恢复报告\n- x\n";
    const file = saveRestoreReport(nested, md);
    assert.ok(file.startsWith(join(nested, "restore-report-")), file);
    assert.ok(file.endsWith(".md"), file);
    assert.equal(readFileSync(file, "utf8"), md);
    assert.equal(readFileSync(join(nested, "last-report.md"), "utf8"), md);
    assert.equal(existsSync(join(nested, "restore-report-nope.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
