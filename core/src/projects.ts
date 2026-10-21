import { MAIN_SURFACE, validateProjectConfig, withImplicitMain, type ProjectConfig } from "./config.ts";
import type { Db } from "./db.ts";

/** Dự án, khu vực, tiến độ onboarding và kết quả lệnh trong SQLite. */

export interface ProjectRow {
  id: string;
  name: string;
  repoPath: string;
  githubRepo: string | null;
  baseBranch: string | null;
  config: ProjectConfig;
  createdAt: string;
}

export interface SurfaceRow {
  id: string;
  kind: string;
  location: string;
  pack: string | null;
  commands: Record<string, string>;
  implicit: boolean;
  paused: boolean;
}

export type OnboardingStatus = "running" | "waiting_you" | "done" | "failed";

export interface OnboardingRow {
  id: number;
  projectId: string;
  surfaceId: string | null;
  step: string;
  status: OnboardingStatus;
  data: Record<string, unknown>;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface CommandResultInput {
  projectId: string;
  surfaceId: string;
  purpose: "baseline" | "doctor";
  command: string;
  run: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface CommandResultRow extends CommandResultInput {
  id: number;
  ranAt: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function insertProject(
  db: Db,
  p: { id: string; name: string; repoPath: string; githubRepo?: string | null; baseBranch?: string | null; config: ProjectConfig },
): void {
  db.prepare("INSERT INTO project (id, name, repo_path, github_repo, base_branch, config) VALUES (?, ?, ?, ?, ?, ?)").run(
    p.id,
    p.name,
    p.repoPath,
    p.githubRepo ?? null,
    p.baseBranch ?? null,
    JSON.stringify(p.config),
  );
  syncSurfaces(db, p.id, p.config);
}

export function getProject(db: Db, id: string): ProjectRow | undefined {
  const row = db.prepare("SELECT * FROM project WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toProject(row) : undefined;
}

export function findProjectByPath(db: Db, repoPath: string): ProjectRow | undefined {
  const rows = db.prepare("SELECT * FROM project").all() as Record<string, unknown>[];
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const hit = rows.find((r) => norm(String(r.repo_path)) === norm(repoPath));
  return hit ? toProject(hit) : undefined;
}

export function listProjects(db: Db): ProjectRow[] {
  return (db.prepare("SELECT * FROM project ORDER BY name").all() as Record<string, unknown>[]).map(toProject);
}

export function updateProject(db: Db, id: string, patch: { githubRepo?: string | null; config?: ProjectConfig }): void {
  if (patch.githubRepo !== undefined) {
    db.prepare(`UPDATE project SET github_repo = ?, updated_at = ${NOW} WHERE id = ?`).run(patch.githubRepo, id);
  }
  if (patch.config !== undefined) {
    db.prepare(`UPDATE project SET config = ?, updated_at = ${NOW} WHERE id = ?`).run(JSON.stringify(patch.config), id);
    syncSurfaces(db, id, patch.config);
  }
}

export function deleteProject(db: Db, id: string): void {
  db.prepare("DELETE FROM project WHERE id = ?").run(id);
}

/** Bảng `surface` là bản sao của `config.surfaces` (cộng khu vực ngầm `main`) để truy vấn nhanh. */
function syncSurfaces(db: Db, projectId: string, config: ProjectConfig): void {
  const surfaces = withImplicitMain(config);
  const upsert = db.prepare(
    `INSERT INTO surface (project_id, id, kind, location, pack_name, commands, implicit)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, id) DO UPDATE SET kind = excluded.kind, location = excluded.location,
       pack_name = excluded.pack_name, commands = excluded.commands, implicit = excluded.implicit`,
  );
  for (const s of surfaces) {
    upsert.run(projectId, s.id, s.kind, s.location, s.pack ?? null, JSON.stringify(s.commands ?? {}), s.implicit ? 1 : 0);
  }
  const keep = new Set(surfaces.map((s) => s.id));
  const existing = db.prepare("SELECT id FROM surface WHERE project_id = ?").all(projectId) as { id: string }[];
  // Task gắn với khu vực bị bỏ khỏi cấu hình chuyển sang khu vực `main` để không mất task.
  const move = db.prepare("UPDATE OR IGNORE task_surface SET surface_id = ? WHERE project_id = ? AND surface_id = ?");
  const unlink = db.prepare("DELETE FROM task_surface WHERE project_id = ? AND surface_id = ?");
  const del = db.prepare("DELETE FROM surface WHERE project_id = ? AND id = ?");
  for (const { id } of existing) {
    if (keep.has(id) || id === MAIN_SURFACE) continue;
    move.run(MAIN_SURFACE, projectId, id);
    unlink.run(projectId, id);
    del.run(projectId, id);
  }
}

export function listSurfaces(db: Db, projectId: string): SurfaceRow[] {
  const rows = db
    .prepare("SELECT * FROM surface WHERE project_id = ? ORDER BY implicit DESC, id")
    .all(projectId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    location: String(r.location),
    pack: (r.pack_name as string | null) ?? null,
    commands: JSON.parse(String(r.commands)) as Record<string, string>,
    implicit: r.implicit === 1,
    paused: r.paused === 1,
  }));
}

function toProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    repoPath: String(r.repo_path),
    githubRepo: (r.github_repo as string | null) ?? null,
    baseBranch: (r.base_branch as string | null) ?? null,
    config: validateProjectConfig(JSON.parse(String(r.config))),
    createdAt: String(r.created_at),
  };
}

// ───────── Onboarding ─────────

export function startOnboarding(
  db: Db,
  o: { projectId: string; surfaceId?: string | null; step: string; status?: OnboardingStatus; data?: Record<string, unknown> },
): number {
  const r = db
    .prepare("INSERT INTO onboarding (project_id, surface_id, step, status, data) VALUES (?, ?, ?, ?, ?)")
    .run(o.projectId, o.surfaceId ?? null, o.step, o.status ?? "running", JSON.stringify(o.data ?? {}));
  return Number(r.lastInsertRowid);
}

/** Đổi bước, trạng thái; `data` được gộp nông vào dữ liệu cũ. */
export function updateOnboarding(
  db: Db,
  id: number,
  patch: { step?: string; status?: OnboardingStatus; data?: Record<string, unknown>; error?: string | null },
): OnboardingRow {
  const current = getOnboarding(db, id);
  if (!current) throw new Error(`Không có onboarding ${id}`);
  const data = patch.data ? { ...current.data, ...patch.data } : current.data;
  db.prepare(`UPDATE onboarding SET step = ?, status = ?, data = ?, error = ?, updated_at = ${NOW} WHERE id = ?`).run(
    patch.step ?? current.step,
    patch.status ?? current.status,
    JSON.stringify(data),
    patch.error === undefined ? current.error : patch.error,
    id,
  );
  return getOnboarding(db, id)!;
}

export function getOnboarding(db: Db, id: number): OnboardingRow | undefined {
  const r = db.prepare("SELECT * FROM onboarding WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toOnboarding(r) : undefined;
}

/** Bản ghi mới nhất của phần A (`surfaceId` null) hoặc của một khu vực. */
export function latestOnboarding(db: Db, projectId: string, surfaceId: string | null = null): OnboardingRow | undefined {
  const r = (
    surfaceId === null
      ? db.prepare("SELECT * FROM onboarding WHERE project_id = ? AND surface_id IS NULL ORDER BY id DESC LIMIT 1").get(projectId)
      : db.prepare("SELECT * FROM onboarding WHERE project_id = ? AND surface_id = ? ORDER BY id DESC LIMIT 1").get(projectId, surfaceId)
  ) as Record<string, unknown> | undefined;
  return r ? toOnboarding(r) : undefined;
}

/** Số mục onboarding đang chờ bạn (đếm vào Hộp duyệt). */
export function countOnboardingWaiting(db: Db): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM onboarding o
        WHERE o.status = 'waiting_you'
          AND o.id = (SELECT MAX(id) FROM onboarding x WHERE x.project_id = o.project_id AND x.surface_id IS o.surface_id)`,
    )
    .get() as { n: number };
  return r.n;
}

function toOnboarding(r: Record<string, unknown>): OnboardingRow {
  return {
    id: Number(r.id),
    projectId: String(r.project_id),
    surfaceId: (r.surface_id as string | null) ?? null,
    step: String(r.step),
    status: r.status as OnboardingStatus,
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
    error: (r.error as string | null) ?? null,
    startedAt: String(r.started_at),
    updatedAt: String(r.updated_at),
  };
}

// ───────── Kết quả lệnh ─────────

export function insertCommandResult(db: Db, c: CommandResultInput): number {
  const r = db
    .prepare(
      `INSERT INTO command_result (project_id, surface_id, purpose, command, run, ok, exit_code, timed_out, duration_ms, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.projectId, c.surfaceId, c.purpose, c.command, c.run, c.ok ? 1 : 0, c.exitCode, c.timedOut ? 1 : 0, c.durationMs, c.output);
  return Number(r.lastInsertRowid);
}

/** Lần chạy gần nhất của mỗi lệnh (theo mục đích) của một khu vực. */
export function latestCommandResults(db: Db, projectId: string, surfaceId: string, purpose: "baseline" | "doctor"): CommandResultRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM command_result c
        WHERE project_id = ? AND surface_id = ? AND purpose = ?
          AND id = (SELECT MAX(id) FROM command_result x
                     WHERE x.project_id = c.project_id AND x.surface_id = c.surface_id AND x.purpose = c.purpose AND x.command = c.command)
        ORDER BY id`,
    )
    .all(projectId, surfaceId, purpose) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: String(r.project_id),
    surfaceId: String(r.surface_id),
    purpose: r.purpose as "baseline" | "doctor",
    command: String(r.command),
    run: String(r.run),
    ok: r.ok === 1,
    exitCode: (r.exit_code as number | null) ?? null,
    timedOut: r.timed_out === 1,
    durationMs: Number(r.duration_ms),
    output: String(r.output),
    ranAt: String(r.ran_at),
  }));
}
