import { mkdirSync } from "node:fs";
import { factoryPaths, openDb, recordEvent } from "@factory/core";
import { createApp } from "./app.ts";
import { clearServerState, writeServerState } from "./daemon.ts";

export interface ServeOptions {
  port: number;
  webDir: string;
  version: string;
}

/** Chạy server ở tiến trình hiện tại cho tới khi bị dừng. */
export async function serve(opts: ServeOptions): Promise<void> {
  const paths = factoryPaths();
  mkdirSync(paths.home, { recursive: true });
  const db = openDb(paths.db);
  const app = createApp({ db, version: opts.version, webDir: opts.webDir, port: opts.port });

  try {
    await app.listen();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new Error(`Cổng ${opts.port} đang bị chiếm. Có thể nhà máy đã chạy rồi: thử \`factory status\`.`);
    }
    throw err;
  }

  const startedAt = new Date().toISOString();
  writeServerState({ pid: process.pid, port: opts.port, startedAt, version: opts.version });
  recordEvent(db, { type: "server.started", payload: { port: opts.port, version: opts.version } });
  console.log(`Nhà máy đang chạy ở http://localhost:${opts.port} (dữ liệu: ${paths.home})`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    recordEvent(db, { type: "server.stopped" });
    await app.close();
    db.close();
    clearServerState(process.pid);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
