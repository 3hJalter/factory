import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import spawn from "cross-spawn";

/**
 * Bộ chạy tiến trình chung của lõi.
 *
 * Bài học từ thử nghiệm (thu-nghiem-rui-ro.md mục 3): công cụ như Unity để lại tiến trình con
 * (VBCSCompiler, Gradle daemon) giữ ống stdout. Chờ cả cây tiến trình hoặc chờ ống đóng sẽ treo.
 * Vì vậy:
 * - chỉ chờ đúng tiến trình chính thoát (sự kiện `exit`, không phải `close`);
 * - đọc nốt dữ liệu còn trong ống một chút rồi đóng ống;
 * - dọn các tiến trình con còn sót lại.
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Nội dung đưa vào stdin. Mặc định stdin rỗng và đóng ngay (codex exec cần như vậy). */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Giữ tối đa bấy nhiêu ký tự cuối của mỗi luồng ra. Mặc định 1 MB. */
  maxOutput?: number;
  /** Dọn tiến trình con còn sót sau khi tiến trình chính thoát. Mặc định có. */
  cleanup?: boolean;
  /** Thời gian đọc nốt dữ liệu trong ống sau khi tiến trình chính thoát. Mặc định 300 ms. */
  drainMs?: number;
}

export interface ProcessResult {
  /** Mã thoát; null nếu bị kill hoặc không chạy được. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Lỗi khi không chạy được lệnh (VD ENOENT: không có lệnh trên máy). */
  spawnError?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
  durationMs: number;
  pid?: number;
  /** Số tiến trình con còn sót đã bị dọn. */
  cleanedUp: number;
}

const isWindows = process.platform === "win32";

export async function runProcess(command: string, args: readonly string[] = [], opts: RunOptions = {}): Promise<ProcessResult> {
  const started = Date.now();
  const maxOutput = opts.maxOutput ?? 1_000_000;
  const cleanup = opts.cleanup ?? true;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;

  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Trên Linux/macOS: nhóm tiến trình riêng để dọn được cả cây bằng kill(-pid).
      detached: !isWindows,
    });
  } catch (err) {
    return emptyResult(started, { spawnError: err as NodeJS.ErrnoException });
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = keepTail(stdout + chunk, maxOutput);
    opts.onStdout?.(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = keepTail(stderr + chunk, maxOutput);
    opts.onStderr?.(chunk);
  });
  child.stdin?.on("error", () => {}); // tiến trình thoát trước khi đọc stdin: bỏ qua EPIPE
  child.stdin?.end(opts.input ?? "");

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: NodeJS.ErrnoException }>(
    (resolve) => {
      child.once("error", (err) => resolve({ code: null, signal: null, spawnError: err as NodeJS.ErrnoException }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  const killNow = () => {
    if (child.pid !== undefined) void killTree(child.pid);
  };
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killNow();
      }, opts.timeoutMs)
    : undefined;
  const onAbort = () => {
    cancelled = true;
    killNow();
  };
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = await exited;
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  // Đọc nốt dữ liệu còn trong ống, rồi đóng ống dù cháu chắt còn giữ nó.
  await Promise.race([streamsEnded(child), delay(opts.drainMs ?? 300)]);
  child.stdout?.destroy();
  child.stderr?.destroy();

  let cleanedUp = 0;
  if (cleanup && child.pid !== undefined && !exit.spawnError) {
    cleanedUp = await cleanupLeftovers(child.pid, started);
  }

  return {
    code: exit.code,
    signal: exit.signal,
    timedOut,
    cancelled,
    spawnError: exit.spawnError,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    pid: child.pid,
    cleanedUp,
  };
}

function emptyResult(started: number, extra: Partial<ProcessResult>): ProcessResult {
  return {
    code: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    durationMs: Date.now() - started,
    cleanedUp: 0,
    ...extra,
  };
}

function keepTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function streamsEnded(child: ChildProcess): Promise<void> {
  const ended = (s: NodeJS.ReadableStream | null) =>
    s ? new Promise<void>((resolve) => (s.readable ? s.once("end", () => resolve()) : resolve())) : Promise.resolve();
  return Promise.all([ended(child.stdout), ended(child.stderr)]).then(() => undefined);
}

/** Kill tiến trình và toàn bộ tiến trình con của nó. */
export async function killTree(pid: number): Promise<void> {
  if (isWindows) {
    await runTaskkill(pid);
    return;
  }
  signalGroup(pid, "SIGTERM");
  await delay(1000);
  signalGroup(pid, "SIGKILL");
}

function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupLeftovers(pid: number, startedAt: number): Promise<number> {
  if (isWindows) {
    const leftovers = await windowsDescendants(pid, startedAt);
    for (const p of leftovers) await runTaskkill(p);
    return leftovers.length;
  }
  if (!groupAlive(pid)) return 0;
  // Không biết chính xác số tiến trình trong nhóm mà không đọc /proc; đếm là 1 nhóm.
  signalGroup(pid, "SIGTERM");
  for (let i = 0; i < 10 && groupAlive(pid); i++) await delay(100);
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  return 1;
}

async function runTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    p.once("error", () => resolve());
    p.once("exit", () => resolve());
  });
}

/**
 * Trên Windows, tiến trình mồ côi vẫn giữ ParentProcessId của cha đã thoát.
 * Tìm theo cây từ pid gốc, chỉ lấy tiến trình tạo sau khi lệnh bắt đầu để tránh nhầm pid bị dùng lại.
 */
async function windowsDescendants(rootPid: number, startedAt: number): Promise<number[]> {
  const since = new Date(startedAt - 2000).toISOString();
  const script = [
    `$since = [datetime]::Parse('${since}').ToUniversalTime()`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate",
    `$queue = @(${rootPid}); $found = @()`,
    "while ($queue.Count -gt 0) {",
    "  $p = $queue[0]; $queue = @($queue | Select-Object -Skip 1)",
    "  foreach ($c in $all) {",
    "    if ($c.ParentProcessId -eq $p -and $c.CreationDate.ToUniversalTime() -ge $since -and $found -notcontains $c.ProcessId) {",
    "      $found += $c.ProcessId; $queue += $c.ProcessId",
    "    }",
    "  }",
    "}",
    "$found -join ','",
  ].join("\n");
  // -EncodedCommand (UTF-16LE, base64) tránh mọi vấn đề trích dẫn dòng lệnh của Windows.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = await new Promise<string>((resolve) => {
    let text = "";
    let errText = "";
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => p.kill(), 30_000);
    p.stdout?.setEncoding("utf8");
    p.stdout?.on("data", (d: string) => (text += d));
    p.stderr?.setEncoding("utf8");
    p.stderr?.on("data", (d: string) => (errText += d));
    p.once("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    // Chờ `close` (không phải `exit`) để đọc hết đầu ra; PowerShell không để lại tiến trình con giữ ống.
    p.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) process.stderr.write(`factory: không liệt kê được tiến trình con (powershell thoát ${code}): ${errText.trim()}\n`);
      resolve(text);
    });
  });
  return out
    .trim()
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}
