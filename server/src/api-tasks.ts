import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addComment,
  applyUserAction,
  availableActions,
  createTask,
  editTask,
  getProject,
  getTask,
  isFactoryPaused,
  issueSyncState,
  latestOnboarding,
  KANBAN_COLUMN,
  listComments,
  listProjects,
  listSurfaces,
  listTasks,
  setFactoryPaused,
  SyncError,
  syncIssues,
  taskHistory,
  taskKinds,
  TaskError,
  USER_ACTIONS,
  type Db,
  type Runner,
  type SyncReport,
  type TaskEdit,
  type TaskRow,
  type UserAction,
} from "@factory/core";
import { HttpError, readBody, sendJson } from "./api-projects.ts";

/** API task, Kanban và đồng bộ GitHub Issues (may-trang-thai-ticket.md). */

export interface TaskApiDeps {
  db: Db;
  run?: Runner;
  broadcast: (type: string, payload?: unknown) => void;
  /** Chu kỳ kéo Issues của mọi dự án đã lên GitHub; không đặt thì chỉ đồng bộ khi có thay đổi hoặc bấm tay. */
  syncIntervalMs?: number;
  /** Chờ bấy nhiêu ms sau thay đổi tại chỗ rồi mới đẩy, để gom nhiều thay đổi một lần. */
  syncDelayMs?: number;
}

export function createTaskApi(deps: TaskApiDeps) {
  const { db } = deps;
  const timers = new Map<string, NodeJS.Timeout>();
  const syncing = new Map<string, Promise<SyncReport | undefined>>();

  /** Đồng bộ một dự án ngay; lỗi được ghi vào trạng thái đồng bộ và báo lên giao diện. */
  function syncNow(projectId: string): Promise<SyncReport | undefined> {
    const current = syncing.get(projectId);
    if (current) return current;
    const job = syncIssues({ db, ...(deps.run ? { run: deps.run } : {}) }, projectId)
      .catch((err: unknown) => {
        deps.broadcast("project.log", { projectId, message: `Đồng bộ GitHub lỗi: ${(err as Error).message}`, error: true });
        return undefined;
      })
      .finally(() => {
        syncing.delete(projectId);
        deps.broadcast("tasks.changed", { projectId });
      });
    syncing.set(projectId, job);
    return job;
  }

  function scheduleSync(projectId: string): void {
    if (!getProject(db, projectId)?.githubRepo) return;
    clearTimeout(timers.get(projectId));
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        void syncNow(projectId);
      }, deps.syncDelayMs ?? 1500),
    );
  }

  let loop: NodeJS.Timeout | undefined;
  if (deps.syncIntervalMs) {
    const tick = () => {
      for (const p of listProjects(db)) if (p.githubRepo) void syncNow(p.id);
    };
    loop = setInterval(tick, deps.syncIntervalMs);
    setTimeout(tick, 2000).unref();
  }

  const changed = (projectId: string) => {
    deps.broadcast("tasks.changed", { projectId });
    scheduleSync(projectId);
  };

  const view = (t: TaskRow) => ({ ...t, column: KANBAN_COLUMN[t.status], actions: availableActions(t) });

  function board(projectId: string) {
    const project = getProject(db, projectId);
    if (!project) throw new HttpError(404, `Không có dự án ${projectId}`);
    return {
      project: { id: project.id, name: project.name, githubRepo: project.githubRepo },
      tasks: listTasks(db, projectId).map(view),
      kinds: taskKinds(project.config),
      surfaces: listSurfaces(db, projectId).map((s) => ({ id: s.id, location: s.location, paused: s.paused })),
      sync: { ...issueSyncState(db, projectId), running: syncing.has(projectId) },
      paused: isFactoryPaused(db),
    };
  }

  function taskDetail(id: number) {
    const task = getTask(db, id);
    if (!task) throw new HttpError(404, `Không có task ${id}`);
    return {
      task: view(task),
      comments: listComments(db, id),
      history: taskHistory(db, id),
      dependsOn: task.dependsOn.map((d) => getTask(db, d)).filter((d): d is TaskRow => !!d).map((d) => ({ id: d.id, ref: d.ref, title: d.title, status: d.status })),
      dependents: (db.prepare("SELECT task_id FROM task_dependency WHERE depends_on = ? ORDER BY task_id").all(id) as { task_id: number }[])
        .map((r) => getTask(db, Number(r.task_id))!)
        .map((d) => ({ id: d.id, ref: d.ref, title: d.title, status: d.status })),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const parts = pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent); // bỏ "api"
    const method = req.method ?? "GET";
    try {
      // /api/inbox: việc chờ bạn ở mọi dự án
      if (parts[0] === "inbox" && parts.length === 1 && method === "GET") {
        const projects = listProjects(db).map((p) => {
          const setup = latestOnboarding(db, p.id);
          return {
            id: p.id,
            name: p.name,
            githubRepo: p.githubRepo,
            setup: setup && setup.status !== "done" ? setup : null,
            tasks: listTasks(db, p.id).filter((t) => KANBAN_COLUMN[t.status] === "you").map(view),
          };
        });
        sendJson(res, 200, { projects: projects.filter((p) => p.setup || p.tasks.length > 0) });
        return true;
      }

      // /api/settings
      if (parts[0] === "settings" && parts.length === 1) {
        if (method === "POST") {
          const body = await readBody(req);
          if (typeof body.paused !== "boolean") throw new HttpError(400, "Cần `paused` là true hoặc false");
          setFactoryPaused(db, body.paused);
          deps.broadcast("settings.changed", { paused: body.paused });
        }
        sendJson(res, 200, { paused: isFactoryPaused(db) });
        return true;
      }

      // /api/projects/:id/tasks, /api/projects/:id/sync
      if (parts[0] === "projects" && parts.length === 3 && (parts[2] === "tasks" || parts[2] === "sync")) {
        const projectId = parts[1]!;
        if (!getProject(db, projectId)) throw new HttpError(404, `Không có dự án ${projectId}`);
        if (parts[2] === "sync") {
          if (method !== "POST") throw new HttpError(405, "Dùng POST");
          await readBody(req);
          if (!getProject(db, projectId)!.githubRepo) throw new HttpError(409, "Dự án chưa lên GitHub, task giữ tại chỗ");
          void syncNow(projectId);
          sendJson(res, 202, board(projectId));
          return true;
        }
        if (method === "GET") {
          sendJson(res, 200, board(projectId));
          return true;
        }
        const body = await readBody(req);
        const task = createTask(db, projectId, {
          title: text(body.title, "title"),
          body: optionalString(body.body) ?? "",
          kind: text(body.kind, "kind"),
          surfaces: stringList(body.surfaces, "surfaces"),
          ...(body.dependsOn !== undefined ? { dependsOn: idList(body.dependsOn) } : {}),
          ...(typeof body.executor === "string" ? { executor: body.executor } : {}),
          by: "you",
        });
        changed(projectId);
        sendJson(res, 201, taskDetail(task.id));
        return true;
      }

      // /api/tasks/:id[/comments | /actions/:action]
      if (parts[0] === "tasks" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new HttpError(404, "not_found");
        const task = getTask(db, id);
        if (!task) throw new HttpError(404, `Không có task ${parts[1]}`);
        const sub = parts.slice(2).join("/");
        if (method === "GET" && sub === "") {
          sendJson(res, 200, taskDetail(id));
          return true;
        }
        if (method !== "POST") throw new HttpError(405, "Dùng POST");
        const body = await readBody(req);
        if (sub === "") {
          const edit: TaskEdit = { by: "you" };
          if (body.title !== undefined) edit.title = text(body.title, "title");
          if (body.body !== undefined) edit.body = optionalString(body.body) ?? "";
          if (body.kind !== undefined) edit.kind = text(body.kind, "kind");
          if (body.surfaces !== undefined) edit.surfaces = stringList(body.surfaces, "surfaces");
          if (body.dependsOn !== undefined) edit.dependsOn = idList(body.dependsOn);
          editTask(db, id, edit);
        } else if (sub === "comments") {
          addComment(db, id, { author: "you", body: text(body.body, "body") });
        } else if (parts[2] === "actions" && parts.length === 4) {
          const action = parts[3] as UserAction;
          if (!(action in USER_ACTIONS)) throw new HttpError(404, `Không có hành động ${parts[3]}`);
          const comment = optionalString(body.comment);
          applyUserAction(db, id, action, { by: "you", ...(comment ? { comment } : {}) });
        } else throw new HttpError(404, "not_found");
        changed(task.projectId);
        sendJson(res, 200, taskDetail(id));
        return true;
      }
      return false;
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message, ...err.body });
      else if (err instanceof TaskError || err instanceof SyncError) sendJson(res, 400, { error: err.message });
      else throw err;
      return true;
    }
  }

  function close(): void {
    if (loop) clearInterval(loop);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { handle, board, syncNow, close, idle: () => Promise.all(syncing.values()) };
}

function text(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `Thiếu \`${field}\``);
  return v.trim();
}

const optionalString = (v: unknown) => (typeof v === "string" ? v : undefined);

function stringList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new HttpError(400, `\`${field}\` phải là danh sách chuỗi`);
  return v as string[];
}

function idList(v: unknown): number[] {
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) throw new HttpError(400, "`dependsOn` phải là danh sách id task");
  return v as number[];
}
