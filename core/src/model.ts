// Tên chuẩn lấy từ tài liệu thiết kế (mo-hinh-du-an.md, may-trang-thai-ticket.md).
// Đổi ở đây thì đổi cả ràng buộc CHECK trong schema (db.ts) qua một migration mới.

export const SURFACE_KINDS = ["folder", "sheet"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Năm loại task của lõi. Pack và dự án thêm loại riêng qua `task_kinds.add`. */
export const CORE_TASK_KINDS = [
  { key: "analyze", name: "Phân tích" },
  { key: "make", name: "Làm" },
  { key: "fix", name: "Sửa lỗi" },
  { key: "review", name: "Rà soát" },
  { key: "test", name: "Kiểm thử" },
] as const;

export const TASK_KIND_SOURCES = ["core", "pack", "project"] as const;

export const TASK_STATUSES = [
  "proposed",
  "queued",
  "blocked",
  "preparing",
  "running",
  "checking",
  "applying",
  "waiting_gate",
  "waiting_answer",
  "waiting_human",
  "stuck",
  "done",
  "rejected",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const BLOCKED_REASONS = [
  "depends_on",
  "children",
  "resource",
  "quota",
  "agent_offline",
  "tool_disabled",
  "surface_paused",
  "kind_paused",
  "budget",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const TASK_ORIGINS = ["user", "agent", "links", "pipeline"] as const;
export const EXECUTORS = ["auto", "tool", "human"] as const;
export const TEST_MODES = ["manual", "script", "agent", "skip"] as const;

/** Cột Kanban của mỗi trạng thái (may-trang-thai-ticket.md mục 2). */
export const KANBAN_COLUMN: Record<TaskStatus, "queue" | "running" | "you" | "done"> = {
  proposed: "you",
  queued: "queue",
  blocked: "queue",
  preparing: "running",
  running: "running",
  checking: "running",
  applying: "running",
  waiting_gate: "you",
  waiting_answer: "you",
  waiting_human: "you",
  stuck: "you",
  done: "done",
  rejected: "done",
  cancelled: "done",
};
