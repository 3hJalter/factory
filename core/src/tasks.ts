import { MAIN_SURFACE, withImplicitMain, type ProjectConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { CORE_TASK_KINDS, EXECUTORS, type BlockedReason, type TaskStatus } from "./model.ts";
import { getProject } from "./projects.ts";
import { recordEvent } from "./store.ts";

/**
 * Task và máy trạng thái của nó (may-trang-thai-ticket.md mục 2–5).
 * Mọi lần đổi trạng thái đi qua `transition` để được kiểm theo bảng chuyển và ghi lại.
 */

export class TaskError extends Error {}

export const FINAL_STATUSES: readonly TaskStatus[] = ["done", "rejected", "cancelled"];
export const isFinal = (s: TaskStatus) => FINAL_STATUSES.includes(s);

/** Bảng chuyển trạng thái (mục 4). Số trong chú thích là số dòng của bảng. */
const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ["queued", "blocked", "rejected"], // #3, #4
  queued: ["preparing", "waiting_human", "blocked"], // #6, #24, thêm phụ thuộc hoặc tạm dừng
  blocked: ["queued", "done"], // #5, #27
  preparing: ["running", "blocked", "stuck"], // #7, #8, #9
  running: ["waiting_answer", "checking", "stuck", "blocked", "queued"], // #10, #12, #30, Run quota/auth, Run crashed
  waiting_answer: ["running"], // #11
  checking: ["running", "stuck", "waiting_gate", "applying", "done", "blocked", "waiting_human"], // #13–#17, hết hạn mức, task human kiểm đỏ
  waiting_gate: ["applying", "done", "queued", "rejected", "running", "stuck"], // #18–#20, #29
  applying: ["done", "queued", "stuck"], // #21–#23
  waiting_human: ["checking"], // #25
  stuck: ["queued"], // #26
  done: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (to === "cancelled") return !isFinal(from); // #28
  return ALLOWED[from].includes(to);
}

export type TaskGate =
  | "accept_task"
  | "answer_questions"
  | "approve_pr"
  | "approve_surface_change"
  | "approve_plan"
  | "approve_final"
  | "choose_option"
  | "approve_deploy"
  | "approve_change";

export interface TaskRow {
  id: number;
  projectId: string;
  /** `#12` khi đã có Issue, `T-5` khi chưa. */
  ref: string;
  kind: string;
  status: TaskStatus;
  blockedReason: BlockedReason | null;
  stuckReason: string | null;
  gate: TaskGate | null;
  title: string;
  body: string;
  parentId: number | null;
  origin: string;
  executor: string;
  githubIssue: number | null;
  surfaces: string[];
  dependsOn: number[];
  /** Có thay đổi tại chỗ chưa đẩy lên Issue. */
  dirty: boolean;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: number;
  taskId: number;
  githubId: number | null;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskKindInfo {
  key: string;
  name: string;
  source: "core" | "project";
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Loại task dùng được trong dự án: năm loại của lõi cộng `task_kinds.add` trong `.factory/project.yaml`. */
export function taskKinds(config: ProjectConfig): TaskKindInfo[] {
  return [
    ...CORE_TASK_KINDS.map((k) => ({ key: k.key, name: k.name, source: "core" as const })),
    ...(config.task_kinds?.add ?? []).map((k) => ({ key: k.key, name: k.name, source: "project" as const })),
  ];
}

export interface NewTask {
  title: string;
  body?: string;
  kind: string;
  surfaces: string[];
  executor?: string;
  origin?: "user" | "agent" | "links" | "pipeline";
  parentId?: number;
  dependsOn?: number[];
  /** Tạo từ một Issue có sẵn trên GitHub. */
  githubIssue?: number;
  /** Issue lúc nhận về, làm gốc cho lần đồng bộ sau. */
  synced?: unknown;
  /** Issue đã đóng thì task nhận về ở trạng thái kết thúc. */
  closedAs?: "done" | "rejected" | "cancelled";
  /** Issue thiếu label khu vực hoặc loại: vào `proposed` để bạn xác nhận (mục 8). */
  propose?: boolean;
  by?: string;
}

/** #1, #2: tạo task. Task do bạn tạo vào `queued` (hoặc `blocked` nếu còn phụ thuộc); do agent hay lõi gợi ý thì vào `proposed`. */
export function createTask(db: Db, projectId: string, input: NewTask): TaskRow {
  const project = getProject(db, projectId);
  if (!project) throw new TaskError(`Không có dự án ${projectId}`);
  const title = input.title.trim();
  if (!title) throw new TaskError("Task cần tiêu đề");
  validateKindAndSurfaces(project.config, input.kind, input.surfaces);
  const executor = input.executor ?? "auto";
  if (!(EXECUTORS as readonly string[]).includes(executor)) throw new TaskError(`executor không hợp lệ: ${executor}`);
  const origin = input.origin ?? "user";
  const deps = [...new Set(input.dependsOn ?? [])];
  for (const d of deps) mustTask(db, d, projectId);
  if (input.parentId !== undefined) mustTask(db, input.parentId, projectId);

  const proposed = !input.closedAs && (input.propose || origin === "agent" || origin === "links");
  const blocked = !input.closedAs && !proposed && unfinishedDeps(db, deps).length > 0;
  const status: TaskStatus = input.closedAs ?? (proposed ? "proposed" : blocked ? "blocked" : "queued");

  db.exec("BEGIN");
  try {
    const r = db
      .prepare(
        `INSERT INTO task (project_id, kind, status, blocked_reason, title, body, parent_id, origin, executor, gate, github_issue, synced, dirty, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.kind,
        status,
        blocked ? "depends_on" : null,
        title,
        input.body ?? "",
        input.parentId ?? null,
        origin,
        executor,
        proposed ? "accept_task" : null,
        input.githubIssue ?? null,
        input.synced === undefined ? null : JSON.stringify(input.synced),
        input.githubIssue ? 0 : 1,
        input.githubIssue ? new Date().toISOString() : null,
      );
    const id = Number(r.lastInsertRowid);
    setSurfaces(db, id, projectId, input.surfaces);
    const dep = db.prepare("INSERT INTO task_dependency (task_id, depends_on) VALUES (?, ?)");
    for (const d of deps) dep.run(id, d);
    recordEvent(db, { type: "task.transition", projectId, taskId: id, payload: { from: null, to: status, by: input.by ?? origin, reason: "tạo task" } });
    db.exec("COMMIT");
    return getTask(db, id)!;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function validateKindAndSurfaces(config: ProjectConfig, kind: string, surfaces: string[]): void {
  if (!taskKinds(config).some((k) => k.key === kind)) throw new TaskError(`Dự án không có loại task \`${kind}\``);
  if (surfaces.length === 0) throw new TaskError("Task cần ít nhất một khu vực");
  const known = new Set(withImplicitMain(config).map((s) => s.id));
  for (const s of surfaces) if (!known.has(s)) throw new TaskError(`Dự án không có khu vực \`${s}\``);
}

function setSurfaces(db: Db, taskId: number, projectId: string, surfaces: string[]): void {
  db.prepare("DELETE FROM task_surface WHERE task_id = ?").run(taskId);
  const ins = db.prepare("INSERT INTO task_surface (task_id, project_id, surface_id) VALUES (?, ?, ?)");
  for (const s of [...new Set(surfaces)]) ins.run(taskId, projectId, s);
}

export function getTask(db: Db, id: number): TaskRow | undefined {
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toTask(db, row) : undefined;
}

export function findTaskByIssue(db: Db, projectId: string, issue: number): TaskRow | undefined {
  const row = db.prepare("SELECT * FROM task WHERE project_id = ? AND github_issue = ?").get(projectId, issue) as Record<string, unknown> | undefined;
  return row ? toTask(db, row) : undefined;
}

export function listTasks(db: Db, projectId: string): TaskRow[] {
  const rows = db.prepare("SELECT * FROM task WHERE project_id = ? ORDER BY priority DESC, id").all(projectId) as Record<string, unknown>[];
  return rows.map((r) => toTask(db, r));
}

function toTask(db: Db, r: Record<string, unknown>): TaskRow {
  const id = Number(r.id);
  const issue = r.github_issue === null ? null : Number(r.github_issue);
  return {
    id,
    projectId: String(r.project_id),
    ref: issue !== null ? `#${issue}` : `T-${id}`,
    kind: String(r.kind),
    status: r.status as TaskStatus,
    blockedReason: (r.blocked_reason as BlockedReason | null) ?? null,
    stuckReason: (r.stuck_reason as string | null) ?? null,
    gate: (r.gate as TaskGate | null) ?? null,
    title: String(r.title),
    body: String(r.body),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    origin: String(r.origin),
    executor: String(r.executor),
    githubIssue: issue,
    surfaces: (db.prepare("SELECT surface_id FROM task_surface WHERE task_id = ? ORDER BY surface_id").all(id) as { surface_id: string }[]).map((s) => s.surface_id),
    dependsOn: (db.prepare("SELECT depends_on FROM task_dependency WHERE task_id = ? ORDER BY depends_on").all(id) as { depends_on: number }[]).map((d) => Number(d.depends_on)),
    dirty: Number(r.dirty) > 0,
    syncedAt: (r.synced_at as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mustTask(db: Db, id: number, projectId?: string): TaskRow {
  const t = getTask(db, id);
  if (!t || (projectId && t.projectId !== projectId)) throw new TaskError(`Không có task ${id}`);
  return t;
}

function unfinishedDeps(db: Db, deps: number[]): number[] {
  return deps.filter((d) => getTask(db, d)?.status !== "done");
}

export interface TransitionOptions {
  by: string;
  reason?: string;
  blockedReason?: BlockedReason;
  stuckReason?: string;
  gate?: TaskGate | null;
}

/** Đổi trạng thái theo bảng chuyển; ghi sự kiện `task.transition` và đánh dấu cần đẩy lên Issue. */
export function transition(db: Db, id: number, to: TaskStatus, opts: TransitionOptions): TaskRow {
  const task = mustTask(db, id);
  if (!canTransition(task.status, to)) throw new TaskError(`Task ${task.ref} không chuyển được từ ${task.status} sang ${to}`);
  if (to === "blocked" && !opts.blockedReason) throw new TaskError("Chuyển sang blocked cần lý do");
  const gate = opts.gate !== undefined ? opts.gate : to === "proposed" ? "accept_task" : to === "waiting_answer" ? "answer_questions" : null;
  db.prepare(
    `UPDATE task SET status = ?, blocked_reason = ?, stuck_reason = ?, gate = ?, dirty = dirty + 1, updated_at = ${NOW} WHERE id = ?`,
  ).run(to, to === "blocked" ? opts.blockedReason! : null, to === "stuck" ? (opts.stuckReason ?? opts.reason ?? null) : null, gate, id);
  recordEvent(db, {
    type: "task.transition",
    projectId: task.projectId,
    taskId: id,
    payload: { from: task.status, to, by: opts.by, ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.blockedReason ? { blockedReason: opts.blockedReason } : {}) },
  });
  if (isFinal(to)) settleDependents(db, task.projectId, id);
  return getTask(db, id)!;
}

/** Khi một task kết thúc: gỡ chặn task phụ thuộc vào nó (#5) và đóng task cha không có Run (#27). */
function settleDependents(db: Db, projectId: string, id: number): void {
  const dependents = db.prepare("SELECT task_id FROM task_dependency WHERE depends_on = ?").all(id) as { task_id: number }[];
  for (const { task_id } of dependents) {
    const t = getTask(db, Number(task_id));
    if (t?.status === "blocked" && t.blockedReason === "depends_on" && unfinishedDeps(db, t.dependsOn).length === 0) {
      transition(db, t.id, "queued", { by: "core", reason: "các task phụ thuộc đã xong" });
    }
  }
  const self = getTask(db, id);
  if (self?.parentId) {
    const parent = getTask(db, self.parentId);
    const children = db.prepare("SELECT status FROM task WHERE parent_id = ?").all(self.parentId) as { status: TaskStatus }[];
    if (parent?.status === "blocked" && parent.blockedReason === "children" && children.every((c) => isFinal(c.status))) {
      transition(db, parent.id, "done", { by: "core", reason: "mọi task con đã kết thúc" });
    }
  }
  void projectId;
}

// ───────── Hành động của bạn trên task ─────────

export type UserAction = "accept" | "reject" | "cancel" | "resume" | "request_changes";

export const USER_ACTIONS: Record<UserAction, { label: string; from: readonly TaskStatus[] }> = {
  accept: { label: "Nhận", from: ["proposed"] },
  reject: { label: "Không nhận", from: ["proposed", "waiting_gate"] },
  cancel: { label: "Huỷ", from: ["proposed", "queued", "blocked", "preparing", "running", "checking", "applying", "waiting_gate", "waiting_answer", "waiting_human", "stuck"] },
  resume: { label: "Chạy tiếp", from: ["stuck"] },
  request_changes: { label: "Yêu cầu sửa", from: ["waiting_gate"] },
};

export function availableActions(task: TaskRow): UserAction[] {
  return (Object.keys(USER_ACTIONS) as UserAction[]).filter((a) => USER_ACTIONS[a].from.includes(task.status));
}

export function applyUserAction(db: Db, id: number, action: UserAction, opts: { by?: string; comment?: string } = {}): TaskRow {
  const task = mustTask(db, id);
  const by = opts.by ?? "you";
  if (!USER_ACTIONS[action]?.from.includes(task.status)) throw new TaskError(`Không ${USER_ACTIONS[action]?.label.toLowerCase() ?? action} được task ở trạng thái ${task.status}`);
  if (opts.comment?.trim()) addComment(db, id, { author: by, body: opts.comment.trim() });
  switch (action) {
    case "accept":
    case "resume":
    case "request_changes": {
      const waiting = unfinishedDeps(db, task.dependsOn);
      if (action === "accept" && waiting.length > 0) return transition(db, id, "blocked", { by, blockedReason: "depends_on", reason: "bạn nhận task" });
      return transition(db, id, "queued", { by, reason: { accept: "bạn nhận task", resume: "bạn cho chạy tiếp", request_changes: "bạn yêu cầu sửa" }[action] });
    }
    case "reject":
      return transition(db, id, "rejected", { by, reason: task.status === "proposed" ? "bạn không nhận" : "bạn từ chối" });
    case "cancel":
      return transition(db, id, "cancelled", { by, reason: "bạn huỷ" });
  }
}

export interface TaskEdit {
  title?: string;
  body?: string;
  kind?: string;
  surfaces?: string[];
  dependsOn?: number[];
  by?: string;
}

/** Sửa nội dung task. Đổi loại hoặc khu vực chỉ được khi task chưa chạy (`queued`, `blocked`, `proposed`), như mục 8. */
export function editTask(db: Db, id: number, edit: TaskEdit, opts: { fromIssue?: boolean } = {}): TaskRow {
  const task = mustTask(db, id);
  const project = getProject(db, task.projectId)!;
  const notStarted = ["queued", "blocked", "proposed"].includes(task.status);
  const kind = edit.kind ?? task.kind;
  const surfaces = edit.surfaces ?? task.surfaces;
  if ((edit.kind !== undefined && edit.kind !== task.kind) || (edit.surfaces !== undefined && !sameSet(edit.surfaces, task.surfaces))) {
    if (!notStarted) throw new TaskError("Chỉ đổi được loại và khu vực khi task chưa chạy");
    validateKindAndSurfaces(project.config, kind, surfaces);
  }
  const title = edit.title !== undefined ? edit.title.trim() : task.title;
  if (!title) throw new TaskError("Task cần tiêu đề");

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE task SET title = ?, body = ?, kind = ?, dirty = dirty + ?, updated_at = ${NOW} WHERE id = ?`).run(
      title,
      edit.body ?? task.body,
      kind,
      opts.fromIssue ? 0 : 1,
      id,
    );
    if (edit.surfaces !== undefined) setSurfaces(db, id, task.projectId, surfaces);
    if (edit.dependsOn !== undefined) {
      const deps = [...new Set(edit.dependsOn)].filter((d) => d !== id);
      for (const d of deps) mustTask(db, d, task.projectId);
      if (createsCycle(db, id, deps)) throw new TaskError("Phụ thuộc này tạo thành vòng");
      db.prepare("DELETE FROM task_dependency WHERE task_id = ?").run(id);
      const ins = db.prepare("INSERT INTO task_dependency (task_id, depends_on) VALUES (?, ?)");
      for (const d of deps) ins.run(id, d);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  recordEvent(db, { type: "task.edited", projectId: task.projectId, taskId: id, payload: { by: edit.by ?? (opts.fromIssue ? "github" : "you"), fields: Object.keys(edit).filter((k) => k !== "by") } });

  // Phụ thuộc thay đổi thì xem lại có bị chặn không.
  const now = getTask(db, id)!;
  if (edit.dependsOn !== undefined) {
    const waiting = unfinishedDeps(db, now.dependsOn).length > 0;
    if (now.status === "queued" && waiting) return transition(db, id, "blocked", { by: edit.by ?? "you", blockedReason: "depends_on", reason: "thêm phụ thuộc" });
    if (now.status === "blocked" && now.blockedReason === "depends_on" && !waiting) return transition(db, id, "queued", { by: "core", reason: "hết phụ thuộc chưa xong" });
  }
  return now;
}

function createsCycle(db: Db, id: number, deps: number[]): boolean {
  const seen = new Set<number>();
  const stack = [...deps];
  while (stack.length > 0) {
    const d = stack.pop()!;
    if (d === id) return true;
    if (seen.has(d)) continue;
    seen.add(d);
    stack.push(...(db.prepare("SELECT depends_on FROM task_dependency WHERE task_id = ?").all(d) as { depends_on: number }[]).map((r) => Number(r.depends_on)));
  }
  return false;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Đánh dấu task cần đẩy lên Issue ở lần đồng bộ sau. */
export function markDirty(db: Db, taskId: number): void {
  db.prepare("UPDATE task SET dirty = dirty + 1 WHERE id = ?").run(taskId);
}

// ───────── Bình luận ─────────

export function addComment(db: Db, taskId: number, c: { author: string; body: string; githubId?: number; createdAt?: string; updatedAt?: string }): TaskComment {
  const task = mustTask(db, taskId);
  const r = db
    .prepare(`INSERT INTO task_comment (task_id, github_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE(?, ${NOW}), COALESCE(?, ${NOW}))`)
    .run(taskId, c.githubId ?? null, c.author, c.body, c.createdAt ?? null, c.updatedAt ?? null);
  if (c.githubId === undefined) markDirty(db, taskId);
  recordEvent(db, { type: "task.comment", projectId: task.projectId, taskId, payload: { author: c.author, fromIssue: c.githubId !== undefined } });
  return listComments(db, taskId).find((x) => x.id === Number(r.lastInsertRowid))!;
}

export function listComments(db: Db, taskId: number): TaskComment[] {
  const rows = db.prepare("SELECT * FROM task_comment WHERE task_id = ? ORDER BY created_at, id").all(taskId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    taskId: Number(r.task_id),
    githubId: r.github_id === null ? null : Number(r.github_id),
    author: String(r.author),
    body: String(r.body),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export interface TaskEvent {
  id: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Lịch sử của task: chuyển trạng thái, sửa, bình luận, đồng bộ. */
export function taskHistory(db: Db, taskId: number): TaskEvent[] {
  const rows = db.prepare("SELECT id, ts, type, payload FROM event WHERE task_id = ? ORDER BY id").all(taskId) as Record<string, unknown>[];
  return rows.map((r) => ({ id: Number(r.id), ts: String(r.ts), type: String(r.type), payload: JSON.parse(String(r.payload)) as Record<string, unknown> }));
}

// ───────── Công tắc tạm dừng toàn bộ ─────────

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const isFactoryPaused = (db: Db) => getSetting(db, "paused") === "1";
export function setFactoryPaused(db: Db, paused: boolean): void {
  setSetting(db, "paused", paused ? "1" : "0");
  recordEvent(db, { type: paused ? "factory.paused" : "factory.resumed" });
}

export { MAIN_SURFACE };
