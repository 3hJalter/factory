import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runProcess, windowsDescendants } from "../src/index.ts";

const node = process.execPath;

test("đọc stdout, stderr và mã thoát", async () => {
  const r = await runProcess(node, ["-e", "process.stdout.write('ra'); process.stderr.write('lỗi'); process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "ra");
  assert.equal(r.stderr, "lỗi");
  assert.equal(r.timedOut, false);
});

test("stdin mặc định rỗng và đã đóng", async () => {
  const r = await runProcess(node, ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('len='+d.length))"], {
    timeoutMs: 5000,
  });
  assert.equal(r.stdout.trim(), "len=0");
  assert.equal(r.timedOut, false);
});

test("lệnh không có trên máy trả về ENOENT", async () => {
  const r = await runProcess("lenh-khong-ton-tai-xyz", ["--version"]);
  assert.equal(r.spawnError?.code, "ENOENT");
  assert.equal(r.code, null);
});

test("không treo khi tiến trình cháu còn giữ ống stdout, và dọn tiến trình cháu", async () => {
  // Tiến trình cha bật một tiến trình cháu ngủ 30 giây, cháu thừa hưởng stdout, rồi cha thoát ngay.
  const parent = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log('chau=' + c.pid);
    process.exit(0);
  `;
  const started = Date.now();
  const r = await runProcess(node, ["-e", parent], { timeoutMs: 20_000 });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0);
  assert.ok(elapsed < 5000, `mất ${elapsed} ms, lẽ ra phải xong ngay`);
  assert.equal(r.cleanedUp, 1, `dọn ${r.cleanedUp} tiến trình sau ${r.durationMs} ms; stderr: ${r.stderr}`);

  const pid = Number(/chau=(\d+)/.exec(r.stdout)?.[1]);
  assert.ok(pid > 0);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(isAlive(pid), false, "tiến trình cháu phải bị dọn");
});

/** Tiến trình zombie (đã chết, chờ init thu dọn) tính là đã chết; một số container không thu dọn zombie. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

test("Windows: liệt kê được tiến trình con của một tiến trình đang chạy", { skip: process.platform !== "win32" }, async () => {
  const { spawn } = await import("node:child_process");
  const started = Date.now();
  const parent = spawn(node, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' }); setTimeout(()=>{}, 30000)"], { stdio: "ignore" });
  try {
    await new Promise((res) => setTimeout(res, 1500));
    const t0 = Date.now();
    const { pids, error } = await windowsDescendants(parent.pid!, started);
    assert.equal(error, undefined);
    assert.equal(pids.length, 1, `tìm thấy ${JSON.stringify(pids)} sau ${Date.now() - t0} ms`);
  } finally {
    spawnSync("taskkill", ["/PID", String(parent.pid), "/T", "/F"]);
  }
});

test("quá thời gian thì kill cả cây và báo timedOut", async () => {
  const r = await runProcess(node, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});

test("huỷ bằng AbortSignal", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runProcess(node, ["-e", "setTimeout(()=>{}, 60000)"], { signal: ac.signal });
  assert.equal(r.cancelled, true);
});

test("gọi lại theo từng đoạn đầu ra", async () => {
  const chunks: string[] = [];
  await runProcess(node, ["-e", "console.log('a'); console.log('b')"], { onStdout: (c) => chunks.push(c) });
  assert.equal(chunks.join(""), "a\nb\n");
});
