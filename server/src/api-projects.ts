import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addSurface,
  checkSurfaces,
  ConfigError,
  createProject,
  getProject,
  inspectMainRepo,
  inspectSurface,
  latestCommandResults,
  latestOnboarding,
  listSurfaces,
  OnboardingError,
  publishProject,
  reloadProjectConfig,
  runBaseline,
  type Db,
  type FactoryPaths,
  type OnboardingContext,
  type Runner,
  type ShellRunner,
  type StartMode,
  type SurfaceCommands,
  type SurfaceInput,
} from "@factory/core";

/** API tạo dự án và thêm khu vực (luong-onboarding.md). Việc dài chạy nền, tiến độ đi qua WebSocket. */

export interface ProjectApiDeps {
  db: Db;
  paths: FactoryPaths;
  run?: Runner;
  shell?: ShellRunner;
  broadcast: (type: string, payload?: unknown) => void;
}

export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const MAX_BODY_BYTES = 64 * 1024;
const MODES: StartMode[] = ["existing", "clone", "new"];

export function createProjectApi(deps: ProjectApiDeps) {
  /** Dự án đang có việc chạy nền và việc đó là gì; mỗi dự án chỉ một việc một lúc. */
  const busy = new Map<string, string>();

  const ctx = (projectId: string | null): OnboardingContext => ({
    db: deps.db,
    paths: deps.paths,
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.shell ? { shell: deps.shell } : {}),
    log: (message) => deps.broadcast("project.log", { projectId, message }),
  });

  function startJob(projectId: string, job: string, work: () => Promise<unknown>): void {
    const current = busy.get(projectId);
    if (current) throw new HttpError(409, `Dự án đang bận: ${current}`);
    busy.set(projectId, job);
    deps.broadcast("project.changed", { projectId });
    void work()
      .catch((err: unknown) => deps.broadcast("project.log", { projectId, message: `Lỗi: ${(err as Error).message}`, error: true }))
      .finally(() => {
        busy.delete(projectId);
        deps.broadcast("project.changed", { projectId });
      });
  }

  function detail(projectId: string) {
    const project = getProject(deps.db, projectId);
    if (!project) throw new HttpError(404, `Không có dự án ${projectId}`);
    const surfaces = listSurfaces(deps.db, projectId).map((s) => ({
      ...s,
      onboarding: s.implicit ? null : (latestOnboarding(deps.db, projectId, s.id) ?? null),
      baseline: latestCommandResults(deps.db, projectId, s.id, "baseline"),
      doctor: latestCommandResults(deps.db, projectId, s.id, "doctor"),
    }));
    return { project, setup: latestOnboarding(deps.db, projectId) ?? null, surfaces, busy: busy.get(projectId) ?? null };
  }

  /** Trả về true nếu đã xử lý yêu cầu. */
  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const parts = pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent); // bỏ "api"
    if (parts[0] !== "projects") return false;
    const [, id, sub, sid] = parts;
    const route = `${req.method ?? "GET"} ${routeKey(parts)}`;

    try {
      switch (route) {
        case "POST projects/inspect": {
          const body = await readBody(req);
          sendJson(res, 200, await inspectMainRepo(ctx(null), mainRepoInput(body)));
          return true;
        }
        case "POST projects": {
          const body = await readBody(req);
          const input = mainRepoInput(body);
          const name = text(body.name, "name");
          const mainCommands = commands(body.mainCommands);
          const created = await createProject(ctx(null), { ...input, name, ...(mainCommands ? { mainCommands } : {}) });
          deps.broadcast("project.changed", { projectId: created.project.id });
          sendJson(res, 201, created);
          return true;
        }
        case "GET projects/:id":
          sendJson(res, 200, detail(id!));
          return true;
        case "POST projects/:id/publish": {
          const body = await readBody(req);
          const repoName = optionalText(body.repoName);
          mustExist(id!);
          startJob(id!, "lên GitHub", () => publishProject(ctx(id!), id!, repoName ? { repoName } : {}));
          sendJson(res, 202, detail(id!));
          return true;
        }
        case "POST projects/:id/reload": {
          await readBody(req);
          mustExist(id!);
          const config = reloadProjectConfig(ctx(id!), id!);
          if (!config) throw new HttpError(409, "Thư mục repo chưa có .factory/project.yaml");
          deps.broadcast("project.changed", { projectId: id });
          sendJson(res, 200, detail(id!));
          return true;
        }
        case "POST projects/:id/check": {
          await readBody(req);
          mustExist(id!);
          startJob(id!, "kiểm các khu vực", () => checkSurfaces(ctx(id!), id!));
          sendJson(res, 202, detail(id!));
          return true;
        }
        case "POST projects/:id/surfaces/inspect": {
          const body = await readBody(req);
          mustExist(id!);
          sendJson(res, 200, await inspectSurface(ctx(id!), id!, surfaceInput(body)));
          return true;
        }
        case "POST projects/:id/surfaces": {
          const body = await readBody(req);
          mustExist(id!);
          const input = surfaceInput(body);
          if (busy.has(id!)) throw new HttpError(409, `Dự án đang bận: ${busy.get(id!)}`);
          const inspection = await inspectSurface(ctx(id!), id!, input);
          if (!inspection.ok) throw new HttpError(400, inspection.findings.find((f) => f.level === "block")!.message, { inspection });
          startJob(id!, `thêm khu vực ${input.id}`, () => addSurface(ctx(id!), id!, input));
          sendJson(res, 202, detail(id!));
          return true;
        }
        case "POST projects/:id/surfaces/:sid/baseline": {
          await readBody(req);
          mustExist(id!);
          if (!listSurfaces(deps.db, id!).some((s) => s.id === sid)) throw new HttpError(404, `Không có khu vực ${sid}`);
          startJob(id!, `chạy mốc chuẩn của ${sid}`, () => runBaseline(ctx(id!), id!, sid!));
          sendJson(res, 202, detail(id!));
          return true;
        }
        default:
          throw new HttpError(404, "not_found");
      }
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message, ...err.body });
      else if (err instanceof OnboardingError || err instanceof ConfigError) sendJson(res, 400, { error: err.message });
      else throw err;
      return true;
    }
  }

  function mustExist(id: string): void {
    if (!getProject(deps.db, id)) throw new HttpError(404, `Không có dự án ${id}`);
  }

  return { handle, detail, busy };
}

/** `projects/abc/surfaces/web/baseline` → `projects/:id/surfaces/:sid/baseline`. */
function routeKey(parts: string[]): string {
  return parts
    .map((p, i) => {
      if (i === 1 && !(parts.length === 2 && p === "inspect")) return ":id";
      if (i === 3 && parts[2] === "surfaces" && p !== "inspect") return ":sid";
      return p;
    })
    .join("/");
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.startsWith("application/json")) throw new HttpError(415, "Cần content-type application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Yêu cầu quá lớn");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "JSON không hợp lệ");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "Cần một object JSON");
  return value as Record<string, unknown>;
}

function text(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `Thiếu \`${field}\``);
  return v.trim();
}

function optionalText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function mainRepoInput(body: Record<string, unknown>): { mode: StartMode; path: string; url?: string } {
  const mode = body.mode ?? "existing";
  if (!MODES.includes(mode as StartMode)) throw new HttpError(400, `mode phải là một trong ${MODES.join(", ")}`);
  const url = optionalText(body.url);
  return { mode: mode as StartMode, path: text(body.path, "path"), ...(url ? { url } : {}) };
}

function commands(v: unknown): SurfaceCommands | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "commands phải là object");
  const out: SurfaceCommands = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (k !== "provision" && k !== "check" && k !== "test") throw new HttpError(400, `Lệnh lạ: ${k}`);
    const line = optionalText(value);
    if (line) out[k] = line;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function surfaceInput(body: Record<string, unknown>): SurfaceInput {
  const cmds = commands(body.commands);
  const pack = optionalText(body.pack);
  return { id: text(body.id, "id"), location: text(body.location, "location"), ...(cmds ? { commands: cmds } : {}), ...(pack ? { pack } : {}) };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
