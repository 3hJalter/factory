import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  countOnboardingWaiting,
  factoryPaths,
  getOverview,
  isFactoryPaused,
  latestOnboarding,
  runDoctor,
  type Db,
  type DoctorReport,
  type FactoryPaths,
  type Runner,
  type ShellRunner,
} from "@factory/core";
import { WebSocketServer, type WebSocket } from "ws";
import { createProjectApi, sendJson } from "./api-projects.ts";
import { createTaskApi } from "./api-tasks.ts";

export interface AppOptions {
  db: Db;
  version: string;
  /** Thư mục giao diện đã build (web/dist). */
  webDir?: string;
  host?: string;
  port?: number;
  doctor?: () => Promise<DoctorReport>;
  /** Thư mục dữ liệu cho worktree, log chạy và pack; mặc định theo FACTORY_HOME. */
  paths?: FactoryPaths;
  run?: Runner;
  shell?: ShellRunner;
  /** Chu kỳ đồng bộ GitHub Issues (ms); không đặt thì chỉ đồng bộ khi có thay đổi hoặc bấm tay. */
  syncIntervalMs?: number;
  syncDelayMs?: number;
}

export interface App {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Đẩy một sự kiện tới mọi trình duyệt đang mở. */
  broadcast(type: string, payload?: unknown): void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const DOCTOR_TTL_MS = 5 * 60_000;

export function createApp(opts: AppOptions): App {
  const host = opts.host ?? "127.0.0.1";
  const startedAt = new Date().toISOString();
  const doctor = opts.doctor ?? (() => runDoctor());
  let doctorCache: { at: number; report: Promise<DoctorReport> } | undefined;
  let boundPort = opts.port ?? 0;

  const getDoctor = (refresh: boolean) => {
    if (refresh || !doctorCache || Date.now() - doctorCache.at > DOCTOR_TTL_MS) {
      const report = doctor();
      doctorCache = { at: Date.now(), report };
      report.catch(() => (doctorCache = undefined));
    }
    return doctorCache.report;
  };

  // Chỉ nhận yêu cầu gửi tới localhost, để trang web lạ không gọi được API qua DNS rebinding.
  const allowedHost = (value: string | undefined) => {
    if (!value) return false;
    const allowed = [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`];
    return allowed.includes(value.toLowerCase());
  };
  const allowedOrigin = (value: string | undefined) =>
    value === undefined || ["http://localhost", "http://127.0.0.1", "http://[::1]"].some((o) => value === `${o}:${boundPort}`);

  const clients = new Set<WebSocket>();
  const broadcast = (type: string, payload?: unknown) => {
    const msg = JSON.stringify({ type, payload });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };
  const tasks = createTaskApi({
    db: opts.db,
    ...(opts.run ? { run: opts.run } : {}),
    broadcast,
    ...(opts.syncIntervalMs ? { syncIntervalMs: opts.syncIntervalMs } : {}),
    ...(opts.syncDelayMs !== undefined ? { syncDelayMs: opts.syncDelayMs } : {}),
  });
  const projects = createProjectApi({
    db: opts.db,
    paths: opts.paths ?? factoryPaths(),
    ...(opts.run ? { run: opts.run } : {}),
    ...(opts.shell ? { shell: opts.shell } : {}),
    broadcast,
    onPublished: (id) => void tasks.syncNow(id),
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHost(req.headers.host)) {
      sendJson(res, 403, { error: "forbidden_host" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        // Thay đổi chỉ nhận từ chính trang nhà máy (hoặc công cụ không gửi Origin, như curl).
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (!allowedOrigin(req.headers.origin)) {
          sendJson(res, 403, { error: "forbidden_origin" });
          return;
        }
      }
      if (await tasks.handle(req, res, url.pathname)) return;
      if (await projects.handle(req, res, url.pathname)) return;
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      switch (url.pathname) {
        case "/api/health":
          sendJson(res, 200, { ok: true, version: opts.version, pid: process.pid, startedAt });
          return;
        case "/api/overview": {
          const overview = getOverview(opts.db);
          const withSetup = overview.projects.map((p) => {
            const setup = latestOnboarding(opts.db, p.id);
            return { ...p, setup: setup ? { step: setup.step, status: setup.status } : null, busy: projects.busy.get(p.id) ?? null };
          });
          sendJson(res, 200, {
            ...overview,
            projects: withSetup,
            inbox: overview.totals.you + countOnboardingWaiting(opts.db),
            paused: isFactoryPaused(opts.db),
          });
          return;
        }
        case "/api/doctor":
          sendJson(res, 200, await getDoctor(url.searchParams.has("refresh")));
          return;
        default:
          sendJson(res, 404, { error: "not_found" });
          return;
      }
    }

    serveStatic(url.pathname, res);
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const webDir = opts.webDir ? resolve(opts.webDir) : undefined;
    if (!webDir || !existsSync(join(webDir, "index.html"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Factory</title>' +
          '<p style="font-family:system-ui;padding:24px">Server đang chạy nhưng chưa có giao diện. ' +
          "Chạy <code>npm run build</code> trong thư mục repo <code>factory</code> rồi tải lại trang.</p>",
      );
      return;
    }
    let file = normalize(join(webDir, decodeURIComponent(pathname)));
    if (!file.startsWith(webDir + sep) && file !== webDir) {
      sendJson(res, 400, { error: "bad_path" });
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html"); // SPA
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "content-type": type, "cache-control": cache });
    createReadStream(file).pipe(res);
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "hello", payload: { version: opts.version, startedAt } }));
    });
  });

  return {
    server,
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(opts.port ?? 0, host, () => {
          boundPort = (server.address() as AddressInfo).port;
          resolveListen({ host, port: boundPort });
        });
      }),
    close: async () => {
      tasks.close();
      await tasks.idle();
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
    broadcast,
  };
}
