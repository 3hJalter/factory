#!/usr/bin/env node
// Lệnh `factory`. Chạy trực tiếp file .ts bằng Node 22.18+ (tự bỏ kiểu TypeScript).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite còn gắn nhãn thử nghiệm; ẩn đúng cảnh báo đó để đầu ra gọn.
const defaultWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  for (const l of defaultWarningListeners) l(w);
});

const binPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(binPath), "..", "..");
const version = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;

const HELP = `factory ${version}

Cách dùng: factory <lệnh> [tuỳ chọn]

  doctor [--json]        Kiểm tra công cụ trên máy (git, Node, gh, Claude Code, Codex)
  start [--port N]       Bật server chạy nền rồi in địa chỉ để mở trên trình duyệt
  stop                   Tắt server đang chạy nền
  status                 Xem server có đang chạy không
  serve [--port N]       Chạy server ngay trong terminal này (Ctrl+C để dừng)
  autostart on|off       Tự bật server khi đăng nhập Windows
  version                In phiên bản
`;

function portArg(args: string[], fallback: number): number {
  const i = args.indexOf("--port");
  const raw = i >= 0 ? args[i + 1] : process.env.FACTORY_PORT;
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Cổng không hợp lệ: ${raw}`);
  return port;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const core = await import("@factory/core");
  const server = await import("@factory/server");

  switch (command) {
    case "doctor": {
      const report = await core.runDoctor();
      console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : core.formatDoctor(report));
      return report.ok ? 0 : 1;
    }
    case "serve":
      await server.serve({ port: portArg(args, server.DEFAULT_PORT), webDir: join(repoRoot, "web", "dist"), version });
      return -1; // giữ tiến trình chạy
    case "start": {
      const status = await server.serverStatus();
      if (status.running) {
        console.log(`Nhà máy đã chạy sẵn ở http://localhost:${status.state.port}`);
        return 0;
      }
      const state = await server.startBackground(binPath, portArg(args, server.DEFAULT_PORT));
      console.log(`Nhà máy đang chạy nền ở http://localhost:${state.port}`);
      return 0;
    }
    case "stop":
      console.log((await server.stopServer()) ? "Đã tắt nhà máy." : "Nhà máy không chạy.");
      return 0;
    case "status": {
      const status = await server.serverStatus();
      console.log(
        status.running
          ? `Đang chạy ở http://localhost:${status.state.port} (pid ${status.state.pid}, bật lúc ${status.state.startedAt}).`
          : "Nhà máy không chạy. Bật bằng `factory start`.",
      );
      return status.running ? 0 : 1;
    }
    case "autostart": {
      const mode = args[0];
      if (mode !== "on" && mode !== "off") {
        console.error("Dùng: factory autostart on|off");
        return 2;
      }
      console.log(await server.setAutostart(mode === "on", binPath));
      return 0;
    }
    case "version":
    case "--version":
      console.log(version);
      return 0;
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return 0;
    default:
      console.error(`Không có lệnh "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
