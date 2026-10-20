import type { Db } from "./db.ts";
import { KANBAN_COLUMN, type TaskStatus } from "./model.ts";

export interface ColumnCounts {
  queue: number;
  running: number;
  you: number;
  done: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  githubRepo: string | null;
  surfaces: number;
  tasks: ColumnCounts;
}

export interface Overview {
  projects: ProjectSummary[];
  totals: ColumnCounts;
}

const emptyCounts = (): ColumnCounts => ({ queue: 0, running: 0, you: 0, done: 0 });

export function getOverview(db: Db): Overview {
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.repo_path AS repoPath, p.github_repo AS githubRepo,
              (SELECT COUNT(*) FROM surface s WHERE s.project_id = p.id) AS surfaces
         FROM project p ORDER BY p.name`,
    )
    .all() as unknown as Omit<ProjectSummary, "tasks">[];

  const counts = db
    .prepare("SELECT project_id AS projectId, status, COUNT(*) AS n FROM task GROUP BY project_id, status")
    .all() as unknown as { projectId: string; status: TaskStatus; n: number }[];

  const byProject = new Map<string, ColumnCounts>();
  const totals = emptyCounts();
  for (const row of counts) {
    const column = KANBAN_COLUMN[row.status];
    const c = byProject.get(row.projectId) ?? emptyCounts();
    c[column] += row.n;
    totals[column] += row.n;
    byProject.set(row.projectId, c);
  }

  return {
    projects: projects.map((p) => ({ ...p, tasks: byProject.get(p.id) ?? emptyCounts() })),
    totals,
  };
}

export interface EventInput {
  type: string;
  projectId?: string;
  taskId?: number;
  runId?: string;
  payload?: unknown;
}

export function recordEvent(db: Db, e: EventInput): number {
  const result = db
    .prepare("INSERT INTO event (project_id, task_id, run_id, type, payload) VALUES (?, ?, ?, ?, ?)")
    .run(e.projectId ?? null, e.taskId ?? null, e.runId ?? null, e.type, JSON.stringify(e.payload ?? {}));
  return Number(result.lastInsertRowid);
}
