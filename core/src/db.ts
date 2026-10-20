import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BLOCKED_REASONS,
  CORE_TASK_KINDS,
  EXECUTORS,
  SURFACE_KINDS,
  TASK_KIND_SOURCES,
  TASK_ORIGINS,
  TASK_STATUSES,
  TEST_MODES,
} from "./model.ts";

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

/**
 * Mỗi phần tử là một migration, chạy đúng một lần theo thứ tự.
 * Không sửa migration đã phát hành; thêm migration mới ở cuối.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE project (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    repo_path     TEXT NOT NULL,              -- thư mục repo chính trên máy
    github_repo   TEXT,                       -- owner/name
    default_model TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Một nơi làm việc của dự án. Mỗi dự án luôn có mặt ngầm 'main' (gốc repo chính).
  CREATE TABLE surface (
    project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    id           TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN (${list(SURFACE_KINDS)})),
    location     TEXT NOT NULL,
    pack_name    TEXT,
    pack_version TEXT,
    commands     TEXT NOT NULL DEFAULT '{}',  -- JSON: { check, test, ... }
    options      TEXT NOT NULL DEFAULT '{}',  -- JSON
    links        TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ to, via }], chỉ để gợi ý task nối tiếp
    implicit     INTEGER NOT NULL DEFAULT 0,  -- 1 với mặt 'main'
    paused       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, id)
  );

  -- project_id = '' là loại task dùng chung (lõi); còn lại là loại của pack hoặc dự án.
  CREATE TABLE task_kind (
    project_id  TEXT NOT NULL DEFAULT '',
    key         TEXT NOT NULL,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN (${list(TASK_KIND_SOURCES)})),
    config_path TEXT,
    paused      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, key)
  );

  CREATE TABLE task (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${list(TASK_STATUSES)})),
    blocked_reason  TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN (${list(BLOCKED_REASONS)})),
    stuck_reason    TEXT,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    parent_id       INTEGER REFERENCES task(id),
    pipeline_run_id TEXT,
    origin          TEXT NOT NULL DEFAULT 'user' CHECK (origin IN (${list(TASK_ORIGINS)})),
    priority        INTEGER NOT NULL DEFAULT 0,
    executor        TEXT NOT NULL DEFAULT 'auto' CHECK (executor IN (${list(EXECUTORS)})),
    agent           TEXT,
    test_mode       TEXT CHECK (test_mode IS NULL OR test_mode IN (${list(TEST_MODES)})),
    github_issue    INTEGER,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL))
  );
  CREATE INDEX task_project_status ON task(project_id, status);

  CREATE TABLE task_surface (
    task_id    INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    surface_id TEXT NOT NULL,
    PRIMARY KEY (task_id, surface_id),
    FOREIGN KEY (project_id, surface_id) REFERENCES surface(project_id, id)
  );

  CREATE TABLE task_dependency (
    task_id    INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    depends_on INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on),
    CHECK (task_id <> depends_on)
  );

  CREATE TABLE run (
    id             TEXT PRIMARY KEY,
    task_id        INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    task_kind      TEXT NOT NULL,
    surface_ids    TEXT NOT NULL DEFAULT '[]', -- JSON
    agent          TEXT NOT NULL,
    model          TEXT,
    engram_session TEXT,
    started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at       TEXT,
    tokens_in      INTEGER NOT NULL DEFAULT 0,
    tokens_out     INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL,
    exit           TEXT,                       -- RunResult.status (giao-thuc-runner.md mục 2)
    summary        TEXT,
    log_path       TEXT,
    commit_sha     TEXT
  );
  CREATE INDEX run_task ON run(task_id);

  -- Nhật ký chỉ ghi thêm: mọi thay đổi trạng thái và sự kiện để tính thời gian, đẩy lên UI.
  CREATE TABLE event (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    project_id TEXT,
    task_id    INTEGER,
    run_id     TEXT,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}'      -- JSON
  );
  CREATE INDEX event_task ON event(task_id, id);
  `,
  // M2: tạo dự án và thêm khu vực (luong-onboarding.md mục 6).
  `
  ALTER TABLE project ADD COLUMN base_branch TEXT;
  ALTER TABLE project ADD COLUMN config TEXT NOT NULL DEFAULT '{}';  -- JSON ProjectConfig nhà máy đang dùng

  -- Một bản ghi cho phần A của mỗi dự án (surface_id NULL) và một bản cho mỗi lần thêm khu vực.
  CREATE TABLE onboarding (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    surface_id TEXT,
    step       TEXT NOT NULL,                 -- A1..A4, B1..B9
    status     TEXT NOT NULL CHECK (status IN ('running', 'waiting_you', 'done', 'failed')),
    data       TEXT NOT NULL DEFAULT '{}',    -- JSON: phát hiện, cổng đang chờ, kết quả
    error      TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX onboarding_project ON onboarding(project_id, surface_id, id);

  -- Kết quả chạy lệnh chuẩn của khu vực (mốc chuẩn B7, hoặc kiểm từ factory doctor).
  CREATE TABLE command_result (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    surface_id TEXT NOT NULL,
    purpose    TEXT NOT NULL CHECK (purpose IN ('baseline', 'doctor')),
    command    TEXT NOT NULL,                 -- provision | check | test
    run        TEXT NOT NULL,                 -- dòng lệnh đã chạy
    ok         INTEGER NOT NULL,
    exit_code  INTEGER,
    timed_out  INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    output     TEXT NOT NULL DEFAULT '',      -- phần cuối đầu ra
    ran_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX command_result_surface ON command_result(project_id, surface_id, id);
  `,
  // M3: task, bình luận và đồng bộ với GitHub Issues (may-trang-thai-ticket.md mục 8).
  `
  ALTER TABLE task ADD COLUMN gate TEXT;                          -- cổng đang chờ ở proposed / waiting_*
  ALTER TABLE task ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;   -- 1: có thay đổi chưa đẩy lên Issue
  ALTER TABLE task ADD COLUMN issue_updated_at TEXT;              -- updated_at của Issue ở lần đồng bộ cuối
  ALTER TABLE task ADD COLUMN synced_at TEXT;
  CREATE UNIQUE INDEX task_issue ON task(project_id, github_issue) WHERE github_issue IS NOT NULL;

  CREATE TABLE task_comment (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    github_id  INTEGER UNIQUE,                 -- NULL khi chưa đẩy lên Issue
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX task_comment_task ON task_comment(task_id, id);

  -- Mốc đồng bộ Issues của từng dự án.
  CREATE TABLE issue_sync (
    project_id     TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
    issues_since   TEXT,
    comments_since TEXT,
    last_ok_at     TEXT,
    last_error     TEXT
  );

  -- Cài đặt chung của nhà máy, VD công tắc tạm dừng toàn bộ.
  CREATE TABLE setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export type Db = DatabaseSync;

/** Mở (hoặc tạo) cơ sở dữ liệu và chạy các migration còn thiếu. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function migrate(db: Db): void {
  const current = schemaVersion(db);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  seedCoreTaskKinds(db);
}

function seedCoreTaskKinds(db: Db): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO task_kind (project_id, key, name, source) VALUES ('', ?, ?, 'core')",
  );
  for (const kind of CORE_TASK_KINDS) insert.run(kind.key, kind.name);
}
