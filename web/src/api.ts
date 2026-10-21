import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandResultRow,
  DoctorReport,
  IssueSyncState,
  TaskComment,
  TaskEvent,
  TaskKindInfo,
  TaskRow,
  TaskStatus,
  UserAction,
  MainRepoInspection,
  OnboardingRow,
  Overview,
  ProjectRow,
  ProjectSummary,
  StartMode,
  SurfaceCommands,
  SurfaceInspection,
  SurfaceRow,
} from "@factory/core";

export type {
  CheckResult,
  CommandResultRow,
  DoctorReport,
  Finding,
  MainRepoInspection,
  OnboardingRow,
  Overview,
  ProjectGate,
  ProjectRow,
  ProjectSummary,
  ScanResult,
  StartMode,
  SurfaceCommands,
  SurfaceInspection,
  SurfaceRow,
  TaskComment,
  TaskEvent,
  TaskKindInfo,
  TaskStatus,
  UserAction,
} from "@factory/core";

export interface OverviewProject extends ProjectSummary {
  /** Bước tạo dự án mới nhất (phần A). */
  setup: { step: string; status: OnboardingRow["status"] } | null;
  busy: string | null;
}

export interface OverviewResponse extends Overview {
  projects: OverviewProject[];
  /** Số việc đang chờ bạn trên mọi dự án. */
  inbox: number;
  /** Công tắc "Tạm dừng toàn bộ". */
  paused: boolean;
}

export type KanbanColumn = "queue" | "running" | "you" | "done";

export interface TaskView extends TaskRow {
  column: KanbanColumn;
  actions: UserAction[];
}

export interface BoardResponse {
  project: { id: string; name: string; githubRepo: string | null };
  tasks: TaskView[];
  kinds: TaskKindInfo[];
  surfaces: { id: string; location: string; paused: boolean }[];
  sync: IssueSyncState & { running: boolean };
  paused: boolean;
}

export interface TaskLink {
  id: number;
  ref: string;
  title: string;
  status: TaskStatus;
}

export interface TaskDetail {
  task: TaskView;
  comments: TaskComment[];
  history: TaskEvent[];
  dependsOn: TaskLink[];
  dependents: TaskLink[];
}

export interface NewTaskBody {
  title: string;
  body?: string;
  kind: string;
  surfaces: string[];
  dependsOn?: number[];
}

export interface InboxResponse {
  projects: { id: string; name: string; githubRepo: string | null; setup: OnboardingRow | null; tasks: TaskView[] }[];
}

export interface SurfaceDetail extends SurfaceRow {
  onboarding: OnboardingRow | null;
  baseline: CommandResultRow[];
  doctor: CommandResultRow[];
}

export interface ProjectDetail {
  project: ProjectRow;
  setup: OnboardingRow | null;
  surfaces: SurfaceDetail[];
  /** Việc đang chạy nền của dự án, nếu có. */
  busy: string | null;
}

export interface MainRepoInput {
  mode: StartMode;
  path: string;
  url?: string;
}

export interface SurfaceInputBody {
  id: string;
  location: string;
  commands?: SurfaceCommands;
  pack?: string;
}

/** Lỗi từ API, kèm thân trả về (VD kết quả kiểm khi bị chặn). */
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw await toError(path, res);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(path, res);
  return (await res.json()) as T;
}

async function toError(path: string, res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Không phải JSON.
  }
  // Vite trả 502 khi không nối được server nhà máy phía sau (`npm run dev:web` không tự bật server).
  if (res.status >= 502 && res.status <= 504 && body.error === undefined) {
    return new ApiError(res.status, "Server nhà máy chưa chạy. Mở thêm một cửa sổ terminal trong thư mục repo rồi chạy `npm run serve`", body);
  }
  const message = typeof body.error === "string" && body.error !== "not_found" ? body.error : `${path} trả về ${res.status}`;
  return new ApiError(res.status, message, body);
}

const project = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  overview: () => getJson<OverviewResponse>("/api/overview"),
  doctor: (refresh = false) => getJson<DoctorReport>(refresh ? "/api/doctor?refresh" : "/api/doctor"),
  inspectProject: (input: MainRepoInput) => postJson<MainRepoInspection>("/api/projects/inspect", input),
  createProject: (input: MainRepoInput & { name: string; mainCommands?: SurfaceCommands }) =>
    postJson<{ project: ProjectRow; onboarding: OnboardingRow }>("/api/projects", input),
  project: (id: string) => getJson<ProjectDetail>(project(id)),
  publish: (id: string, repoName?: string) => postJson<ProjectDetail>(`${project(id)}/publish`, repoName ? { repoName } : {}),
  reload: (id: string) => postJson<ProjectDetail>(`${project(id)}/reload`),
  checkSurfaces: (id: string) => postJson<ProjectDetail>(`${project(id)}/check`),
  inspectSurface: (id: string, input: SurfaceInputBody) => postJson<SurfaceInspection>(`${project(id)}/surfaces/inspect`, input),
  addSurface: (id: string, input: SurfaceInputBody) => postJson<ProjectDetail>(`${project(id)}/surfaces`, input),
  baseline: (id: string, surfaceId: string) => postJson<ProjectDetail>(`${project(id)}/surfaces/${encodeURIComponent(surfaceId)}/baseline`),
  board: (id: string) => getJson<BoardResponse>(`${project(id)}/tasks`),
  createTask: (id: string, body: NewTaskBody) => postJson<TaskDetail>(`${project(id)}/tasks`, body),
  sync: (id: string) => postJson<BoardResponse>(`${project(id)}/sync`),
  task: (taskId: number) => getJson<TaskDetail>(`/api/tasks/${taskId}`),
  editTask: (taskId: number, body: Partial<NewTaskBody>) => postJson<TaskDetail>(`/api/tasks/${taskId}`, body),
  comment: (taskId: number, body: string) => postJson<TaskDetail>(`/api/tasks/${taskId}/comments`, { body }),
  act: (taskId: number, action: UserAction, comment?: string) =>
    postJson<TaskDetail>(`/api/tasks/${taskId}/actions/${action}`, comment ? { comment } : {}),
  inbox: () => getJson<InboxResponse>("/api/inbox"),
  setPaused: (paused: boolean) => postJson<{ paused: boolean }>("/api/settings", { paused }),
};

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Tải dữ liệu một lần và cho phép tải lại. */
export function useLoad<T>(load: (again: boolean) => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback((again: boolean) => {
    setLoading(true);
    loadRef
      .current(again)
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => run(false), [run]);
  return { data, error, loading, reload: useCallback(() => run(true), [run]) };
}

export type Connection = "connecting" | "open" | "closed";

export interface ServerEvent {
  type: string;
  payload?: unknown;
}

/** Giữ một kết nối WebSocket tới server, tự nối lại khi mất. */
export function useServerEvents(onEvent: (e: ServerEvent) => void): Connection {
  const [state, setState] = useState<Connection>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      setState("connecting");
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0;
        setState("open");
      };
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(String(m.data)) as ServerEvent);
        } catch {
          // Bỏ qua tin không đọc được.
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setState("closed");
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return state;
}
