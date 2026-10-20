import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb, type DoctorReport } from "@factory/core";
import { WebSocket } from "ws";
import { createApp, type App } from "../src/index.ts";

const report: DoctorReport = { ok: true, checkedAt: "2026-10-19T00:00:00.000Z", checks: [] };
let doctorCalls = 0;
let app: App;
let port: number;
let webDir: string;

before(async () => {
  webDir = mkdtempSync(join(tmpdir(), "factory-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Factory</title>");
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
  const db = openDb(":memory:");
  db.exec("INSERT INTO project (id, name, repo_path) VALUES ('p1', 'Thử', '/tmp/thu')");
  db.exec("INSERT INTO task (project_id, kind, status, title, origin) VALUES ('p1', 'make', 'waiting_gate', 'A', 'user')");
  app = createApp({
    db,
    version: "0.1.0-test",
    webDir,
    doctor: async () => {
      doctorCalls++;
      return report;
    },
  });
  ({ port } = await app.listen());
});

after(() => app.close());

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(path: string, opts: { host?: string; method?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("health trả phiên bản", async () => {
  const r = await get("/api/health");
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).version, "0.1.0-test");
});

test("overview đếm task theo cột và số việc chờ bạn", async () => {
  const body = JSON.parse((await get("/api/overview")).body);
  assert.equal(body.projects.length, 1);
  assert.deepEqual(body.totals, { queue: 0, running: 0, you: 1, done: 0 });
  assert.equal(body.inbox, 1);
});

test("doctor được giữ đệm, ?refresh thì chạy lại", async () => {
  const before = doctorCalls;
  await get("/api/doctor");
  await get("/api/doctor");
  assert.equal(doctorCalls, before + 1);
  await get("/api/doctor?refresh");
  assert.equal(doctorCalls, before + 2);
});

test("chặn Host lạ (DNS rebinding)", async () => {
  const r = await get("/api/health", { host: `evil.example:${port}` });
  assert.equal(r.status, 403);
  assert.equal((await get("/api/health", { host: `localhost:${port}` })).status, 200);
});

test("API chỉ nhận GET, đường lạ trả 404", async () => {
  assert.equal((await get("/api/health", { method: "POST" })).status, 405);
  assert.equal((await get("/api/khong-co")).status, 404);
});

test("phục vụ file tĩnh và trả index.html cho đường của SPA", async () => {
  const js = await get("/assets/app.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers["content-type"]), /javascript/);
  assert.match(String(js.headers["cache-control"]), /immutable/);
  const spa = await get("/du-an/abc/kanban");
  assert.equal(spa.status, 200);
  assert.match(spa.body, /<title>Factory<\/title>/);
});

test("không cho đọc file ngoài thư mục giao diện", async () => {
  const r = await get("/..%2f..%2fetc%2fpasswd");
  assert.notEqual(r.body.includes("root:"), true);
  assert.equal(r.status, 400);
});

test("WebSocket gửi hello rồi nhận sự kiện broadcast", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const messages: { type: string; payload: unknown }[] = [];
  const hello = new Promise<void>((resolve) => ws.once("message", () => resolve()));
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await hello;
  const next = new Promise<void>((resolve) => ws.once("message", () => resolve()));
  app.broadcast("task.updated", { id: 1 });
  await next;
  ws.close();
  assert.equal(messages[0]?.type, "hello");
  assert.deepEqual(messages[1], { type: "task.updated", payload: { id: 1 } });
});

test("WebSocket từ trang lạ bị từ chối", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "https://evil.example" });
  const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
  assert.match(err.message, /403/);
});
