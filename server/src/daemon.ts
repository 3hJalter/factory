import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { factoryPaths, runProcess } from "@factory/core";

export const DEFAULT_PORT = 7319;

export interface ServerState {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export function readServerState(path = factoryPaths().serverState): ServerState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ServerState;
  } catch {
    return undefined;
  }
}

export function writeServerState(state: ServerState, path = factoryPaths().serverState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function clearServerState(pid: number, path = factoryPaths().serverState): void {
  // Chỉ xoá nếu file còn là của tiến trình này (tránh xoá của một server khác vừa bật).
  if (readServerState(path)?.pid === pid) rmSync(path, { force: true });
}

export async function checkHealth(port: number, timeoutMs = 1500): Promise<{ pid: number; version: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return (await res.json()) as { pid: number; version: string };
  } catch {
    return undefined;
  }
}

/** Trạng thái server: đọc file trạng thái rồi hỏi thẳng server. */
export async function serverStatus(): Promise<{ running: false } | { running: true; state: ServerState }> {
  const state = readServerState();
  if (!state) return { running: false };
  const health = await checkHealth(state.port);
  if (!health || health.pid !== state.pid) return { running: false };
  return { running: true, state };
}

/** Bật server chạy nền, tách khỏi terminal hiện tại. */
export async function startBackground(binPath: string, port: number): Promise<ServerState> {
  const paths = factoryPaths();
  mkdirSync(paths.logs, { recursive: true });
  const logFile = join(paths.logs, "server.log");
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [binPath, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await delay(200);
    const state = readServerState();
    if (state && state.pid === child.pid && (await checkHealth(state.port))) return state;
    if (child.exitCode !== null) break;
  }
  throw new Error(`Server không lên được. Xem log: ${logFile}`);
}

export async function stopServer(): Promise<boolean> {
  const state = readServerState();
  if (!state) return false;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    clearServerState(state.pid);
    return false;
  }
  for (let i = 0; i < 25; i++) {
    await delay(200);
    if (!(await checkHealth(state.port, 500))) break;
  }
  clearServerState(state.pid);
  return true;
}

const TASK_NAME = "Factory";

/**
 * Tự bật server khi đăng nhập Windows: một Scheduled Task chạy launcher .vbs để không hiện cửa sổ console.
 */
export async function setAutostart(enable: boolean, binPath: string): Promise<string> {
  if (process.platform !== "win32") {
    return "Tự bật khi đăng nhập hiện chỉ hỗ trợ Windows. Trên máy khác, dùng systemd hoặc launchd để chạy `factory serve`.";
  }
  if (!enable) {
    const r = await runProcess("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    return r.code === 0 ? "Đã tắt tự bật khi đăng nhập." : `Không tắt được: ${(r.stderr || r.stdout).trim()}`;
  }
  const paths = factoryPaths();
  mkdirSync(paths.home, { recursive: true });
  const launcher = join(paths.home, "start-hidden.vbs");
  const quote = (s: string) => `""${s}""`;
  writeFileSync(
    launcher,
    `CreateObject("WScript.Shell").Run "${quote(process.execPath)} ${quote(binPath)} start", 0, False\r\n`,
  );
  const r = await runProcess("schtasks", [
    "/Create",
    "/TN",
    TASK_NAME,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TR",
    `wscript.exe "${launcher}"`,
    "/F",
  ]);
  return r.code === 0
    ? "Đã bật: server tự chạy nền mỗi khi bạn đăng nhập Windows."
    : `Không bật được: ${(r.stderr || r.stdout).trim()}`;
}
