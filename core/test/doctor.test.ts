import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDoctor, parseVersion, runDoctor, versionAtLeast, type Exec, type ProcessResult } from "../src/index.ts";

const result = (over: Partial<ProcessResult>): ProcessResult => ({
  code: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  stdout: "",
  stderr: "",
  durationMs: 1,
  cleanedUp: 0,
  ...over,
});
const enoent = () => result({ code: null, spawnError: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });

function fakeExec(table: Record<string, ProcessResult>): Exec {
  return async (command, args) => table[`${command} ${args.join(" ")}`] ?? enoent();
}

test("đọc số phiên bản", () => {
  assert.equal(parseVersion("git version 2.43.0.windows.1"), "2.43.0");
  assert.equal(parseVersion("codex-cli 0.159.3"), "0.159.3");
  assert.equal(parseVersion("không có số"), undefined);
  assert.ok(versionAtLeast("22.18.0", [22, 18, 0]));
  assert.ok(versionAtLeast("23.0.0", [22, 18, 0]));
  assert.ok(!versionAtLeast("22.17.9", [22, 18, 0]));
});

test("máy đủ công cụ thì ok", async () => {
  const report = await runDoctor(
    fakeExec({
      "git --version": result({ stdout: "git version 2.47.1.windows.1" }),
      "gh --version": result({ stdout: "gh version 2.89.0 (2026-09-01)" }),
      "gh auth status": result({}),
      "claude --version": result({ stdout: "2.1.296 (Claude Code)" }),
      "codex --version": result({ stdout: "codex-cli 0.159.3" }),
      "codex login status": result({ stdout: "Logged in using ChatGPT" }),
    }),
    "22.18.0",
  );
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((c) => [c.id, c.status, c.version]),
    [
      ["node", "ok", "22.18.0"],
      ["git", "ok", "2.47.1"],
      ["gh", "ok", "2.89.0"],
      ["claude", "ok", "2.1.296"],
      ["codex", "ok", "0.159.3"],
    ],
  );
});

test("thiếu git hoặc Node cũ thì không ok", async () => {
  const report = await runDoctor(fakeExec({ "claude --version": result({ stdout: "2.1.0" }) }), "20.11.0");
  assert.equal(report.ok, false);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId.node?.status, "error");
  assert.equal(byId.git?.status, "missing");
  assert.ok(byId.git?.fix);
  assert.match(formatDoctor(report), /✗ Git: Chưa cài trên máy\./);
});

test("chưa đăng nhập gh hoặc codex là cảnh báo, chưa chặn", async () => {
  const report = await runDoctor(
    fakeExec({
      "git --version": result({ stdout: "git version 2.47.1" }),
      "gh --version": result({ stdout: "gh version 2.89.0" }),
      "gh auth status": result({ code: 1, stderr: "not logged in" }),
      "codex --version": result({ stdout: "codex-cli 0.159.3" }),
      "codex login status": result({ code: 1 }),
    }),
    "22.18.0",
  );
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId.gh?.status, "warn");
  assert.equal(byId.codex?.status, "warn");
  assert.equal(byId.claude?.status, "missing");
  assert.equal(report.ok, true);
});

test("không có agent nào thì không ok", async () => {
  const report = await runDoctor(
    fakeExec({
      "git --version": result({ stdout: "git version 2.47.1" }),
      "gh --version": result({ stdout: "gh version 2.89.0" }),
      "gh auth status": result({}),
    }),
    "22.18.0",
  );
  assert.equal(report.ok, false);
  assert.match(report.checks.find((c) => c.id === "claude")?.detail ?? "", /Cần ít nhất một agent/);
});
