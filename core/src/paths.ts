import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  /** Gốc các worktree nhà máy tạo ra (mốc chuẩn, task). */
  worktrees: string;
  /** Pack cài trên máy, mỗi pack một thư mục có `pack.yaml`. */
  packs: string;
}

export function factoryPaths(home: string = factoryHome(), env: NodeJS.ProcessEnv = process.env): FactoryPaths {
  return {
    home,
    db: join(home, "factory.db"),
    logs: join(home, "logs"),
    runs: join(home, "runs"),
    serverState: join(home, "server.json"),
    worktrees: worktreeRoot(home, env),
    packs: env.FACTORY_PACKS ?? join(home, "packs"),
  };
}

/**
 * Worktree nằm ở đường dẫn ngắn vì Windows giới hạn 260 ký tự (giao-thuc-runner.md):
 * `C:\f` trên Windows khi dùng thư mục mặc định, còn lại là `<home>/worktrees`.
 * Đặt `FACTORY_WORKTREES` để dời chỗ.
 */
export function worktreeRoot(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.FACTORY_WORKTREES) return env.FACTORY_WORKTREES;
  if (platform === "win32" && !env.FACTORY_HOME) return "C:\\f";
  return join(home, "worktrees");
}

/**
 * Dạng chuẩn của một đường dẫn tuyệt đối, để so sánh với đường dẫn git trả về: bỏ symlink,
 * và trên Windows đổi tên ngắn 8.3 (`RUNNER~1`) và hoa thường theo đúng tên trên đĩa.
 * Thư mục chưa có thì chuẩn hoá thư mục cha gần nhất đang có.
 */
export function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}
