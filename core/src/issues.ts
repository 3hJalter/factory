import type { Db } from "./db.ts";
import { withImplicitMain } from "./config.ts";
import { TASK_STATUSES, type TaskStatus } from "./model.ts";
import { defaultRunner, type Runner } from "./git.ts";
import { getProject, latestOnboarding, type ProjectRow } from "./projects.ts";
import { recordEvent } from "./store.ts";
import {
  createTask,
  editTask,
  findTaskByIssue,
  getTask,
  isFinal,
  taskKinds,
  TaskError,
  transition,
  type TaskEdit,
  type TaskRow,
} from "./tasks.ts";

/**
 * Đồng bộ hai chiều task ↔ GitHub Issues trên repo chính (may-trang-thai-ticket.md mục 8).
 *
 * - Nội dung (tiêu đề, mô tả, bình luận, phụ thuộc) sửa ở đâu cũng được. Mỗi task giữ bản Issue lúc đồng bộ
 *   cuối (`synced`) làm gốc: phía nào khác gốc là phía đã sửa; cả hai cùng sửa thì lấy bản trên GitHub.
 * - Trạng thái do lõi giữ: label `status:*` bị sửa tay thì đặt lại. Label `surface:*`, `kind:*` sửa trên GitHub
 *   được nhận khi task chưa chạy, còn lại cũng đặt lại.
 * - Kéo về trước, đẩy lên sau. Task có thay đổi tại chỗ (`dirty`) mới được đẩy.
 */

export interface SyncContext {
  db: Db;
  run?: Runner;
  log?: (message: string) => void;
}

export interface SyncReport {
  /** Lý do không đồng bộ, VD dự án chưa lên GitHub. */
  skipped?: string;
  /** Lý do chỉ kéo về mà không đẩy lên, VD bạn chưa duyệt bước lên GitHub. */
  pushSkipped?: string;
  pulled: number;
  imported: number;
  pushed: number;
  comments: number;
  warnings: string[];
}

/** Issue lúc đồng bộ cuối. `deps` là số Issue chặn Issue này. */
interface Synced {
  id: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  deps: number[];
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: ({ name: string } | string)[];
  updated_at: string;
  pull_request?: unknown;
}

interface GhComment {
  id: number;
  issue_url: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export class SyncError extends Error {}

const running = new Set<string>();
const PAGE = 100;

export async function syncIssues(ctx: SyncContext, projectId: string): Promise<SyncReport> {
  const report: SyncReport = { pulled: 0, imported: 0, pushed: 0, comments: 0, warnings: [] };
  const project = getProject(ctx.db, projectId);
  if (!project) throw new SyncError(`Không có dự án ${projectId}`);
  if (!project.githubRepo) return { ...report, skipped: "Dự án chưa lên GitHub, task giữ tại chỗ" };
  if (running.has(projectId)) return { ...report, skipped: "Đang đồng bộ" };
  running.add(projectId);
  const gh = new Gh(ctx.run ?? defaultRunner, project.githubRepo);
  const warn = (m: string) => {
    report.warnings.push(m);
    ctx.log?.(m);
  };
  try {
    await pull(ctx.db, gh, project, report, warn);
    // Chưa duyệt bước lên GitHub (A3) thì chỉ đọc, không ghi gì lên repo.
    const setup = latestOnboarding(ctx.db, projectId);
    if (setup && setup.status !== "done") report.pushSkipped = "Chưa duyệt bước lên GitHub, task mới giữ tại chỗ";
    else await push(ctx.db, gh, project, report, warn);
    ctx.db
      .prepare(
        `INSERT INTO issue_sync (project_id, last_ok_at, last_error) VALUES (?, ?, NULL)
         ON CONFLICT (project_id) DO UPDATE SET last_ok_at = excluded.last_ok_at, last_error = NULL`,
      )
      .run(projectId, new Date().toISOString());
    if (report.pulled + report.pushed + report.comments > 0) recordEvent(ctx.db, { type: "issues.synced", projectId, payload: { ...report } });
    return report;
  } catch (err) {
    ctx.db
      .prepare("INSERT INTO issue_sync (project_id, last_error) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET last_error = excluded.last_error")
      .run(projectId, (err as Error).message);
    throw err;
  } finally {
    running.delete(projectId);
  }
}

export interface IssueSyncState {
  lastOkAt: string | null;
  lastError: string | null;
  pending: number;
}

export function issueSyncState(db: Db, projectId: string): IssueSyncState {
  const row = db.prepare("SELECT last_ok_at, last_error FROM issue_sync WHERE project_id = ?").get(projectId) as
    | { last_ok_at: string | null; last_error: string | null }
    | undefined;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM task WHERE project_id = ? AND dirty > 0").get(projectId) as { n: number };
  return { lastOkAt: row?.last_ok_at ?? null, lastError: row?.last_error ?? null, pending: Number(pending.n) };
}

// ───────── Label ─────────

const isManaged = (l: string) => /^(status|surface|kind):/.test(l) || l === "ready-for-agent" || l === "ready-for-human";
const labelNames = (labels: GhIssue["labels"]) => labels.map((l) => (typeof l === "string" ? l : l.name));
const sameSet = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x) => b.includes(x));
const withPrefix = (labels: string[], prefix: string) => labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));

/** Label nhà máy quản lý cho một task. */
export function taskLabels(t: Pick<TaskRow, "status" | "kind" | "surfaces" | "executor">): string[] {
  return [`status:${t.status}`, `kind:${t.kind}`, ...t.surfaces.map((s) => `surface:${s}`), t.executor === "human" ? "ready-for-human" : "ready-for-agent"];
}

function issueState(status: TaskStatus): { state: "open" | "closed"; state_reason?: "completed" | "not_planned" } {
  if (status === "done") return { state: "closed", state_reason: "completed" };
  if (isFinal(status)) return { state: "closed", state_reason: "not_planned" };
  return { state: "open" };
}

// ───────── Kéo về ─────────

async function pull(db: Db, gh: Gh, project: ProjectRow, report: SyncReport, warn: (m: string) => void): Promise<void> {
  const since = db.prepare("SELECT issues_since, comments_since FROM issue_sync WHERE project_id = ?").get(project.id) as
    | { issues_since: string | null; comments_since: string | null }
    | undefined;

  const issues = (await gh.pages<GhIssue>("issues", { state: "all", sort: "updated", direction: "asc", since: since?.issues_since })).filter(
    (i) => i.pull_request === undefined,
  );
  const touched: { task: TaskRow; issue: GhIssue }[] = [];
  for (const issue of issues) {
    report.pulled++;
    const existing = findTaskByIssue(db, project.id, issue.number);
    const task = existing ? applyIssue(db, project, existing, issue, warn) : importIssue(db, project, issue, report);
    if (task && !isFinal(task.status)) touched.push({ task, issue });
  }

  // Phụ thuộc cần mọi task đã có mặt nên làm sau.
  for (const { task, issue } of touched) {
    const remote = await gh.blockedBy(issue.number).catch((err: Error) => {
      warn(`Không đọc được phụ thuộc của Issue #${issue.number}: ${err.message}`);
      return undefined;
    });
    if (remote) applyDeps(db, project, getTask(db, task.id)!, remote, warn);
  }

  const comments = await gh.pages<GhComment>("issues/comments", { sort: "updated", direction: "asc", since: since?.comments_since });
  for (const c of comments) if (applyComment(db, project, c)) report.comments++;

  const latest = (list: { updated_at: string }[], prev: string | null | undefined) =>
    list.reduce<string | null>((m, x) => (m === null || x.updated_at > m ? x.updated_at : m), prev ?? null);
  db.prepare(
    `INSERT INTO issue_sync (project_id, issues_since, comments_since) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET issues_since = excluded.issues_since, comments_since = excluded.comments_since`,
  ).run(project.id, latest(issues, since?.issues_since), latest(comments, since?.comments_since));
}

/** Issue chưa có task: nhận vào. Issue đóng mà chưa từng là task của nhà máy thì bỏ qua. */
function importIssue(db: Db, project: ProjectRow, issue: GhIssue, report: SyncReport): TaskRow | undefined {
  const labels = labelNames(issue.labels);
  const status = withPrefix(labels, "status:").find((s) => (TASK_STATUSES as readonly string[]).includes(s)) as TaskStatus | undefined;
  if (issue.state === "closed" && !status) return undefined;

  const known = new Set(withImplicitMain(project.config).map((s) => s.id));
  const kinds = new Set(taskKinds(project.config).map((k) => k.key));
  const surfaces = withPrefix(labels, "surface:").filter((s) => known.has(s));
  const kind = withPrefix(labels, "kind:").find((k) => kinds.has(k));
  const text = `${issue.title}\n${issue.body ?? ""}`.toLowerCase();
  const guessedSurfaces = [...known].filter((s) => s !== "main" && new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(s)}($|[^\\p{L}\\p{N}_-])`, "u").test(text));

  const closedAs =
    issue.state === "closed" ? (status && isFinal(status) ? (status as "done" | "rejected" | "cancelled") : issue.state_reason === "completed" ? "done" : "cancelled") : undefined;
  const task = createTask(db, project.id, {
    title: issue.title,
    body: issue.body ?? "",
    kind: kind ?? (labels.includes("bug") ? "fix" : "make"),
    surfaces: surfaces.length > 0 ? surfaces : guessedSurfaces.length > 0 ? guessedSurfaces : ["main"],
    executor: labels.includes("ready-for-human") ? "human" : "auto",
    githubIssue: issue.number,
    synced: snapshot(issue, []),
    ...(closedAs ? { closedAs } : {}),
    propose: !closedAs && (status === "proposed" || surfaces.length === 0 || kind === undefined),
    by: "github",
  });
  report.imported++;
  return dirtyIfDiffers(db, task);
}

/** Issue đã có task: so ba bên với bản lúc đồng bộ cuối. */
function applyIssue(db: Db, project: ProjectRow, task: TaskRow, issue: GhIssue, warn: (m: string) => void): TaskRow {
  const base = readSynced(db, task.id) ?? snapshot(issue, []);
  const labels = labelNames(issue.labels).filter(isManaged);
  const edit: TaskEdit = { by: "github" };

  for (const field of ["title", "body"] as const) {
    const remote = field === "title" ? issue.title : (issue.body ?? "");
    if (remote === base[field]) continue;
    if (task[field] !== base[field] && task[field] !== remote) warn(`Issue #${issue.number}: ${field === "title" ? "tiêu đề" : "mô tả"} sửa ở cả hai nơi, lấy bản trên GitHub`);
    edit[field] = remote;
  }

  const notStarted = ["queued", "blocked", "proposed"].includes(task.status);
  const remoteKinds = withPrefix(labels, "kind:");
  if (!sameSet(remoteKinds, withPrefix(base.labels, "kind:"))) {
    if (notStarted && remoteKinds.length === 1) edit.kind = remoteKinds[0]!;
    else warn(`Issue #${issue.number}: label kind: đổi khi task đã chạy hoặc không hợp lệ, đặt lại`);
  }
  const remoteSurfaces = withPrefix(labels, "surface:");
  if (!sameSet(remoteSurfaces, withPrefix(base.labels, "surface:"))) {
    if (notStarted && remoteSurfaces.length > 0) edit.surfaces = remoteSurfaces;
    else warn(`Issue #${issue.number}: label surface: đổi khi task đã chạy hoặc bỏ hết, đặt lại`);
  }
  if (!sameSet(withPrefix(labels, "status:"), withPrefix(base.labels, "status:"))) {
    warn(`Issue #${issue.number}: label status: bị sửa tay, đặt lại status:${task.status}`);
  }

  if (Object.keys(edit).length > 1) {
    try {
      task = editTask(db, task.id, edit, { fromIssue: true });
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      warn(`Issue #${issue.number}: ${err.message}, giữ bản tại chỗ`);
      if (edit.title !== undefined || edit.body !== undefined) task = editTask(db, task.id, { title: edit.title, body: edit.body, by: "github" }, { fromIssue: true });
    }
  }

  if (issue.state !== base.state) {
    if (issue.state === "closed" && !isFinal(task.status)) {
      task = transition(db, task.id, "cancelled", { by: "github", reason: "Issue bị đóng trên GitHub" });
    } else if (issue.state === "open" && isFinal(task.status)) {
      warn(`Issue #${issue.number} được mở lại nhưng task đã kết thúc; tạo task mới nếu cần làm tiếp`);
    }
  }

  writeSynced(db, task.id, snapshot(issue, base.deps));
  return dirtyIfDiffers(db, getTask(db, task.id)!);
}

function applyDeps(db: Db, project: ProjectRow, task: TaskRow, remote: number[], warn: (m: string) => void): void {
  const base = readSynced(db, task.id);
  if (!base || sameSet(remote, base.deps)) return;
  writeSynced(db, task.id, { ...base, deps: remote });
  const ids = remote.map((n) => findTaskByIssue(db, project.id, n)?.id).filter((id): id is number => id !== undefined);
  try {
    editTask(db, task.id, { dependsOn: ids, by: "github" }, { fromIssue: true });
  } catch (err) {
    if (!(err instanceof TaskError)) throw err;
    warn(`Issue #${task.githubIssue}: ${err.message}, giữ phụ thuộc tại chỗ`);
  }
  dirtyIfDiffers(db, getTask(db, task.id)!);
}

function applyComment(db: Db, project: ProjectRow, c: GhComment): boolean {
  const number = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
  const task = Number.isFinite(number) ? findTaskByIssue(db, project.id, number) : undefined;
  if (!task) return false;
  const existing = db.prepare("SELECT id, body FROM task_comment WHERE github_id = ?").get(c.id) as { id: number; body: string } | undefined;
  if (existing) {
    if (existing.body === c.body) return false;
    db.prepare("UPDATE task_comment SET body = ?, updated_at = ? WHERE id = ?").run(c.body, c.updated_at, existing.id);
  } else {
    db.prepare("INSERT INTO task_comment (task_id, github_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      task.id,
      c.id,
      c.user?.login ?? "github",
      c.body,
      c.created_at,
      c.updated_at,
    );
  }
  recordEvent(db, { type: "task.comment", projectId: project.id, taskId: task.id, payload: { author: c.user?.login ?? "github", fromIssue: true, edited: !!existing } });
  return true;
}

// ───────── Đẩy lên ─────────

async function push(db: Db, gh: Gh, project: ProjectRow, report: SyncReport, warn: (m: string) => void): Promise<void> {
  const ids = (db.prepare("SELECT id FROM task WHERE project_id = ? AND dirty > 0 ORDER BY id").all(project.id) as { id: number }[]).map((r) => Number(r.id));

  // Tạo Issue cho task mới trước để phụ thuộc trỏ được tới nhau.
  for (const id of ids) {
    const t = getTask(db, id)!;
    if (t.githubIssue !== null) continue;
    try {
      const created = await gh.call<GhIssue>("POST", "issues", { title: t.title, body: t.body, labels: taskLabels(t) });
      db.prepare("UPDATE task SET github_issue = ?, synced = ? WHERE id = ?").run(created.number, JSON.stringify(snapshot(created, [])), id);
      recordEvent(db, { type: "task.issue", projectId: project.id, taskId: id, payload: { issue: created.number } });
    } catch (err) {
      warn(`Không tạo được Issue cho task T-${id}: ${(err as Error).message}`);
    }
  }

  for (const id of ids) {
    const t = getTask(db, id)!;
    if (t.githubIssue === null) continue;
    const dirty = (db.prepare("SELECT dirty FROM task WHERE id = ?").get(id) as { dirty: number }).dirty;
    try {
      await pushTask(db, gh, project, t, report);
      // Có thay đổi mới trong lúc đẩy thì để lần sau.
      db.prepare("UPDATE task SET dirty = 0, synced_at = ? WHERE id = ? AND dirty = ?").run(new Date().toISOString(), id, dirty);
      report.pushed++;
    } catch (err) {
      warn(`Không đẩy được ${t.ref} lên GitHub: ${(err as Error).message}`);
    }
  }
}

async function pushTask(db: Db, gh: Gh, project: ProjectRow, t: TaskRow, report: SyncReport): Promise<void> {
  const number = t.githubIssue!;
  const pending = db.prepare("SELECT id, body FROM task_comment WHERE task_id = ? AND github_id IS NULL ORDER BY id").all(t.id) as { id: number; body: string }[];
  for (const c of pending) {
    const posted = await gh.call<GhComment>("POST", `issues/${number}/comments`, { body: c.body });
    db.prepare("UPDATE task_comment SET github_id = ?, created_at = ?, updated_at = ? WHERE id = ?").run(posted.id, posted.created_at, posted.updated_at, c.id);
    report.comments++;
  }

  // Đọc lại Issue để giữ label người khác gắn.
  const current = await gh.call<GhIssue>("GET", `issues/${number}`);
  const base = readSynced(db, t.id) ?? snapshot(current, []);
  const labels = [...labelNames(current.labels).filter((l) => !isManaged(l)), ...taskLabels(t)];
  const state = issueState(t.status);
  const patch: Record<string, unknown> = {};
  if (current.title !== t.title) patch.title = t.title;
  if ((current.body ?? "") !== t.body) patch.body = t.body;
  if (!sameSet(labelNames(current.labels), labels)) patch.labels = labels;
  if (current.state !== state.state) Object.assign(patch, state);
  const updated = Object.keys(patch).length > 0 ? await gh.call<GhIssue>("PATCH", `issues/${number}`, patch) : current;

  const deps = t.dependsOn.map((d) => getTask(db, d)).filter((d): d is TaskRow => d?.githubIssue != null);
  const want = deps.map((d) => d.githubIssue!);
  if (!sameSet(want, base.deps)) {
    for (const d of deps) if (!base.deps.includes(d.githubIssue!)) await gh.call("POST", `issues/${number}/dependencies/blocked_by`, { issue_id: readSynced(db, d.id)!.id });
    for (const n of base.deps) {
      if (want.includes(n)) continue;
      const other = findTaskByIssue(db, project.id, n);
      const otherId = other ? readSynced(db, other.id)?.id : undefined;
      if (otherId !== undefined) await gh.call("DELETE", `issues/${number}/dependencies/blocked_by/${otherId}`);
    }
  }
  writeSynced(db, t.id, snapshot(updated, want));
}

// ───────── Bản Issue lúc đồng bộ cuối ─────────

function snapshot(issue: GhIssue, deps: number[]): Synced {
  return { id: issue.id, title: issue.title, body: issue.body ?? "", labels: labelNames(issue.labels).filter(isManaged), state: issue.state, deps };
}

function readSynced(db: Db, taskId: number): Synced | undefined {
  const row = db.prepare("SELECT synced FROM task WHERE id = ?").get(taskId) as { synced: string | null } | undefined;
  return row?.synced ? (JSON.parse(row.synced) as Synced) : undefined;
}

function writeSynced(db: Db, taskId: number, s: Synced): void {
  db.prepare("UPDATE task SET synced = ?, synced_at = ? WHERE id = ?").run(JSON.stringify(s), new Date().toISOString(), taskId);
}

/** Task khác bản trên GitHub (VD label trạng thái bị sửa tay) thì đánh dấu để đẩy lại. */
function dirtyIfDiffers(db: Db, task: TaskRow): TaskRow {
  const s = readSynced(db, task.id);
  if (!s || task.dirty) return task;
  const deps = task.dependsOn.map((d) => getTask(db, d)?.githubIssue).filter((n): n is number => n != null);
  const same = s.title === task.title && s.body === task.body && sameSet(s.labels, taskLabels(task)) && s.state === issueState(task.status).state && sameSet(s.deps, deps);
  if (same) return task;
  db.prepare("UPDATE task SET dirty = dirty + 1 WHERE id = ?").run(task.id);
  return getTask(db, task.id)!;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ───────── Gọi GitHub qua gh ─────────

class Gh {
  run: Runner;
  repo: string;
  constructor(run: Runner, repo: string) {
    this.run = run;
    this.repo = repo;
  }

  async call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const args = ["api", "-X", method, `repos/${this.repo}/${path}`, "-H", "Accept: application/vnd.github+json"];
    if (body !== undefined) args.push("--input", "-");
    const r = await this.run("gh", args, { ...(body !== undefined ? { input: JSON.stringify(body) } : {}), timeoutMs: 60_000, maxOutput: 20_000_000 });
    if (r.spawnError) throw new SyncError("Chưa cài GitHub CLI (gh)");
    if (r.code !== 0) throw new SyncError(firstLine(r.stderr) || firstLine(r.stdout) || `gh api thoát mã ${r.code}`);
    const text = r.stdout.trim();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Đọc hết các trang của một danh sách. */
  async pages<T>(path: string, query: Record<string, string | null | undefined>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const q = Object.entries({ ...query, per_page: String(PAGE), page: String(page) })
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      const items = await this.call<T[]>("GET", `${path}?${q}`);
      out.push(...items);
      if (items.length < PAGE) return out;
    }
  }

  async blockedBy(number: number): Promise<number[]> {
    const list = await this.pages<{ number: number }>(`issues/${number}/dependencies/blocked_by`, {});
    return list.map((i) => i.number);
  }
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";
