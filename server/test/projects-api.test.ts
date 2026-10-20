import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { defaultRunner, factoryPaths, openDb, type Runner } from "@factory/core";
import { createApp, type App } from "../src/index.ts";

process.env.GIT_AUTHOR_NAME = "Factory Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "Factory Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const node = `"${process.execPath}"`;
const ok = (stdout = "") => ({ code: 0, signal: null, timedOut: false, cancelled: false, stdout, stderr: "", durationMs: 1, cleanedUp: 0 });
// Giả `gh` đã đăng nhập; git chạy thật.
const run: Runner = async (command, args, o) => (command === "gh" ? ok("Logged in") : defaultRunner(command, args, o));

let app: App;
let port: number;
let repo: string;

before(async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-home-"));
  repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
  for (const [rel, content] of Object.entries({ "index.html": "<p/>", "web/app.ts": "export {}" })) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  const paths = factoryPaths(home, { FACTORY_WORKTREES: join(home, "wt"), FACTORY_PACKS: join(home, "packs") });
  app = createApp({ db: openDb(":memory:"), version: "test", paths, run });
  ({ port } = await app.listen());
});

after(() => app.close());

interface Res {
  status: number;
  body: Record<string, any>;
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(method === "POST" ? { "content-type": "application/json", origin: `http://127.0.0.1:${port}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitIdle(id: string): Promise<Res> {
  for (let i = 0; i < 200; i++) {
    const r = await call("GET", `/api/projects/${id}`);
    if (!r.body.busy) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Việc nền không xong");
}

test("POST chỉ nhận JSON từ chính trang nhà máy", async () => {
  const body = { path: repo };
  assert.equal((await call("POST", "/api/projects/inspect", body, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/projects/inspect", body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("POST", "/api/projects/inspect", { mode: "lạ", path: repo })).status, 400);
});

test("kiểm thư mục, tạo dự án, cổng tạo repo nằm trong hộp chờ bạn", async () => {
  const rel = await call("POST", "/api/projects/inspect", { path: "du-an" });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.ok, false);

  const inspected = await call("POST", "/api/projects/inspect", { mode: "existing", path: repo });
  assert.equal(inspected.body.ok, true);

  const created = await call("POST", "/api/projects", { path: repo, name: "Thử API", mainCommands: { check: `${node} -e 0`, test: "" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.id, "thu-api");
  assert.deepEqual(created.body.project.config.main, { commands: { check: `${node} -e 0` } });

  const again = await call("POST", "/api/projects", { path: repo, name: "Lần hai" });
  assert.equal(again.status, 400);

  const detail = await call("GET", "/api/projects/thu-api");
  assert.equal(detail.body.setup.step, "A3");
  assert.equal(detail.body.setup.status, "waiting_you");
  const overview = await call("GET", "/api/overview");
  assert.equal(overview.body.inbox, 1);
  assert.equal(overview.body.projects[0].setup.status, "waiting_you");
});

test("thêm khu vực chạy nền rồi có mốc chuẩn", async () => {
  const preview = await call("POST", "/api/projects/thu-api/surfaces/inspect", { id: "web", location: "web" });
  assert.equal(preview.body.ok, true);
  assert.equal(preview.body.location, "web/");

  const bad = await call("POST", "/api/projects/thu-api/surfaces", { id: "Web", location: "web" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.inspection);

  const started = await call("POST", "/api/projects/thu-api/surfaces", { id: "web", location: "web", commands: { check: `${node} -e 0`, test: `${node} -e "process.exit(1)"` } });
  assert.equal(started.status, 202);
  const done = await waitIdle("thu-api");
  const web = done.body.surfaces.find((s: { id: string }) => s.id === "web");
  assert.equal(web.onboarding.step, "B9");
  assert.deepEqual(web.baseline.map((r: { command: string; ok: boolean }) => [r.command, r.ok]), [["check", true], ["test", false]]);

  assert.equal((await call("POST", "/api/projects/thu-api/surfaces/khong-co/baseline", {})).status, 404);
  assert.equal((await call("GET", "/api/projects/khong-co")).status, 404);
});

test("kiểm các khu vực tại chỗ", async () => {
  assert.equal((await call("POST", "/api/projects/thu-api/check", {})).status, 202);
  const done = await waitIdle("thu-api");
  const main = done.body.surfaces.find((s: { id: string }) => s.id === "main");
  assert.equal(main.doctor[0].ok, true);
});
