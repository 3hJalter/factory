import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thư mục dữ liệu của nhà máy (SQLite, log, thư mục Run, file trạng thái server).
 * Không bao giờ nằm trong repo của dự án.
 *
 * - `FACTORY_HOME` nếu được đặt (dùng cho test và khi muốn dời chỗ).
 * - Windows: `%APPDATA%\factory`.
 * - Nơi khác: `$XDG_DATA_HOME/factory` hoặc `~/.local/share/factory`.
 */
export function factoryHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.FACTORY_HOME) return env.FACTORY_HOME;
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "factory");
  }
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "factory");
}

export interface FactoryPaths {
  home: string;
  db: string;
  logs: string;
  runs: string;
  /** Thông tin server đang chạy: pid, cổng, thời điểm bật. */
  serverState: string;
}

export function factoryPaths(home: string = factoryHome()): FactoryPaths {
  return {
    home,
    db: join(home, "factory.db"),
    logs: join(home, "logs"),
    runs: join(home, "runs"),
    serverState: join(home, "server.json"),
  };
}
