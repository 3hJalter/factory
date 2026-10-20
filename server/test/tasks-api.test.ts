import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { insertProject, openDb, type Db } from "@factory/core";
import { fakeGitHub } from "../../core/test/fake-github.ts";
import { createApp, type App } from "../src/index.ts";

let app: App;
let port: number;
let db: Db;
const gh = fakeGitHub("me/du-an");

before(async () => {
  db = openDb(":memory:");
  const config = { name: "Dự án", surfaces: [{ id: "web", kind: "folder" as const, location: "web/" }] };
  insertProject(db, { id: "p", name: "Dự án", repoPath: "/x", githubRepo: "me/du-an", config });
  insertProject(db, { id: "local", name: "Tại chỗ", repoPath: "/y", config });
  app = createApp({ db, version: "test", run: gh.run, syncDelayMs: 0 });
  ({ port } = await app.listen());
});

after(() => app.close());

interface Res {
  status: number;
  body: Record<string, any>;
}

function call(method: string, path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, ...(method === "POST" ? { "content-type": "application/json", origin: `http://127.0.0.1:${port}` } : {}) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? "" : JSON.stringify(body));
  });
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Chờ quá lâu");
}

test("tạo task trên giao diện thì có Issue trên GitHub", async () => {
  const created = await call("POST", "/api/projects/p/tasks", { title: "Trang chủ", body: "mô tả", kind: "make", surfaces: ["web"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.status, "queued");
  assert.equal(created.body.task.column, "queue");
  assert.deepEqual(created.body.task.actions, ["cancel"]);

  const settled = async () => {
    const b = await call("GET", "/api/projects/p/tasks");
    return b.body.sync.pending === 0 && !b.body.sync.running;
  };
  await until(settled);
  const board = await call("GET", "/api/projects/p/tasks");
  assert.equal(board.body.tasks[0].ref, "#1");
  assert.equal(board.body.sync.pending, 0);
  assert.deepEqual(board.body.kinds.map((k: { key: string }) => k.key), ["analyze", "make", "fix", "review", "test"]);
  assert.deepEqual(board.body.surfaces.map((s: { id: string }) => s.id), ["main", "web"]);
});

test("dữ liệu sai bị từ chối", async () => {
  assert.equal((await call("POST", "/api/projects/p/tasks", { title: "x", kind: "lạ", surfaces: ["web"] })).status, 400);
  assert.equal((await call("POST", "/api/projects/p/tasks", { title: "x", kind: "make", surfaces: "web" })).status, 400);
  assert.equal((await call("POST", "/api/projects/khong-co/tasks", { title: "x", kind: "make", surfaces: ["web"] })).status, 404);
  assert.equal((await call("GET", "/api/tasks/9999")).status, 404);
  assert.equal((await call("POST", "/api/tasks/1/actions/bay", {})).status, 404);
  assert.equal((await call("POST", "/api/projects/local/sync", {})).status, 409);
});

test("sửa, bình luận, huỷ task; Issue đổi theo", async () => {
  const id = (await call("GET", "/api/projects/p/tasks")).body.tasks[0].id;
  const edited = await call("POST", `/api/tasks/${id}`, { title: "Trang chủ mới", surfaces: ["web", "main"] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.task.surfaces, ["main", "web"]);
  await call("POST", `/api/tasks/${id}/comments`, { body: "thêm footer" });
  const cancelled = await call("POST", `/api/tasks/${id}/actions/cancel`, { comment: "không cần nữa" });
  assert.equal(cancelled.body.task.status, "cancelled");
  assert.equal(cancelled.body.task.column, "done");
  assert.deepEqual(cancelled.body.comments.map((c: { body: string }) => c.body), ["thêm footer", "không cần nữa"]);
  assert.deepEqual(
    cancelled.body.history.filter((e: { type: string }) => e.type === "task.transition").map((e: { payload: { to: string } }) => e.payload.to),
    ["queued", "cancelled"],
  );

  await until(() => gh.issues.get(1)!.state === "closed");
  assert.equal(gh.issues.get(1)!.title, "Trang chủ mới");
  assert.equal(gh.comments.length, 2);
  assert.equal((await call("POST", `/api/tasks/${id}/actions/cancel`, {})).status, 400);
});

test("bấm đồng bộ thì kéo Issue mới về", async () => {
  gh.open({ title: "Từ điện thoại", labels: ["kind:fix", "surface:web"] });
  assert.equal((await call("POST", "/api/projects/p/sync", {})).status, 202);
  await until(() => gh.calls.filter((c) => c.startsWith("GET repos/me/du-an/issues/comments")).length >= 3);
  const board = await call("GET", "/api/projects/p/tasks");
  const imported = board.body.tasks.find((t: { ref: string }) => t.ref === "#2");
  assert.equal(imported.status, "queued");
});

test("công tắc tạm dừng toàn bộ", async () => {
  assert.equal((await call("GET", "/api/settings")).body.paused, false);
  assert.equal((await call("POST", "/api/settings", { paused: "có" })).status, 400);
  assert.equal((await call("POST", "/api/settings", { paused: true })).body.paused, true);
  assert.equal((await call("GET", "/api/overview")).body.paused, true);
  await call("POST", "/api/settings", { paused: false });
});
