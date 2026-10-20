import {
  createTask,
  getProject,
  getTask,
  issueSyncState,
  KANBAN_COLUMN,
  listComments,
  listTasks,
  syncIssues,
  taskHistory,
  type Db,
  type TaskRow,
} from "@factory/core";
import { context, parseArgs, str } from "./cli-projects.ts";

/** Lệnh `factory task ...` và `factory sync`. */

export const TASK_HELP = `
  task add <dự án> <tiêu đề> --kind LOẠI --surface KHU_VỰC[,KHU_VỰC] [--body MÔ_TẢ] [--after ID[,ID]]
                         Tạo task; --after là các task phải xong trước
  task list <dự án>      Xem task theo cột Kanban
  task show <id>         Xem chi tiết, bình luận và lịch sử của task
  sync <dự án>           Đồng bộ task với GitHub Issues ngay`;

const COLUMNS = [
  ["queue", "Hàng chờ"],
  ["running", "Đang chạy"],
  ["you", "Chờ bạn"],
  ["done", "Xong"],
] as const;

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export async function taskCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const [sub, ...rest] = p.positional;
  const ctx = context();
  try {
    switch (sub) {
      case "add": {
        const [projectId, title] = rest;
        const kind = str(p, "--kind");
        const surfaces = list(str(p, "--surface"));
        if (!projectId || !title || !kind || surfaces.length === 0) throw new Error("Dùng: factory task add <dự án> <tiêu đề> --kind LOẠI --surface KHU_VỰC");
        const after = list(str(p, "--after")).map((ref) => resolveRef(ctx.db, projectId, ref));
        const body = str(p, "--body");
        const t = createTask(ctx.db, projectId, { title, kind, surfaces, ...(body ? { body } : {}), ...(after.length ? { dependsOn: after } : {}), by: "you" });
        console.log(`Đã tạo task ${t.id} (${t.ref}), trạng thái ${t.status}.`);
        await syncAndReport(ctx.db, projectId);
        return 0;
      }
      case "list": {
        const projectId = rest[0];
        if (!projectId || !getProject(ctx.db, projectId)) throw new Error(`Không có dự án ${projectId ?? ""}`);
        const tasks = listTasks(ctx.db, projectId);
        if (tasks.length === 0) console.log(`Chưa có task. Tạo bằng: factory task add ${projectId} "<tiêu đề>" --kind make --surface main`);
        for (const [column, label] of COLUMNS) {
          const inColumn = tasks.filter((t) => KANBAN_COLUMN[t.status] === column);
          if (inColumn.length === 0) continue;
          console.log(`${label} (${inColumn.length})`);
          for (const t of inColumn) console.log(`  ${line(t)}`);
        }
        const sync = issueSyncState(ctx.db, projectId);
        if (sync.pending > 0) console.log(`\n${sync.pending} task chưa đẩy lên GitHub.`);
        if (sync.lastError) console.log(`Lần đồng bộ trước lỗi: ${sync.lastError}`);
        return 0;
      }
      case "show": {
        const id = Number(rest[0]);
        const t = Number.isInteger(id) ? getTask(ctx.db, id) : undefined;
        if (!t) throw new Error(`Không có task ${rest[0] ?? ""}`);
        console.log(`${t.ref} ${t.title}\n  ${t.status}${t.blockedReason ? ` (${t.blockedReason})` : ""} · ${t.kind} · ${t.surfaces.join(", ")}`);
        if (t.dependsOn.length) console.log(`  Chờ: ${t.dependsOn.map((d) => getTask(ctx.db, d)?.ref ?? d).join(", ")}`);
        if (t.body) console.log(`\n${t.body}`);
        const comments = listComments(ctx.db, t.id);
        if (comments.length) console.log("\nBình luận:");
        for (const c of comments) console.log(`  ${c.author} (${c.createdAt.slice(0, 16).replace("T", " ")}): ${c.body}`);
        console.log("\nLịch sử:");
        for (const e of taskHistory(ctx.db, t.id)) {
          if (e.type !== "task.transition") continue;
          console.log(`  ${e.ts.slice(0, 16).replace("T", " ")} ${String(e.payload.from ?? "·")} → ${String(e.payload.to)} (${String(e.payload.by)}${e.payload.reason ? `: ${String(e.payload.reason)}` : ""})`);
        }
        return 0;
      }
      default:
        console.error(`Dùng:${TASK_HELP}`);
        return 2;
    }
  } finally {
    ctx.db.close();
  }
}

export async function syncCommand(args: string[]): Promise<number> {
  const projectId = args[0];
  if (!projectId) throw new Error("Dùng: factory sync <dự án>");
  const ctx = context();
  try {
    if (!getProject(ctx.db, projectId)) throw new Error(`Không có dự án ${projectId}`);
    return (await syncAndReport(ctx.db, projectId)) ? 0 : 1;
  } finally {
    ctx.db.close();
  }
}

async function syncAndReport(db: Db, projectId: string): Promise<boolean> {
  try {
    const r = await syncIssues({ db }, projectId);
    if (r.skipped) {
      console.log(r.skipped);
      return true;
    }
    console.log(`GitHub: kéo ${r.pulled} Issue (mới ${r.imported}), đẩy ${r.pushed} task, ${r.comments} bình luận.`);
    if (r.pushSkipped) console.log(r.pushSkipped);
    for (const w of r.warnings) console.log(`  ! ${w}`);
    return true;
  } catch (err) {
    console.log(`Đồng bộ GitHub lỗi: ${(err as Error).message}. Task vẫn giữ tại chỗ, lần sau sẽ đẩy lại.`);
    return false;
  }
}

/** `12` là id task, `#12` là số Issue, `T-12` là id task chưa có Issue. */
function resolveRef(db: Db, projectId: string, ref: string): number {
  const issue = /^#(\d+)$/.exec(ref);
  const t = issue
    ? listTasks(db, projectId).find((x) => x.githubIssue === Number(issue[1]))
    : getTask(db, Number(ref.replace(/^T-/i, "")));
  if (!t || t.projectId !== projectId) throw new Error(`Không có task ${ref} trong dự án ${projectId}`);
  return t.id;
}

const line = (t: TaskRow) =>
  `${String(t.id).padStart(4)}  ${t.ref.padEnd(6)} ${t.status.padEnd(14)} ${t.kind.padEnd(8)} ${t.surfaces.join(",").padEnd(12)} ${t.title}`;
