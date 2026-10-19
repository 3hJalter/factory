import assert from "node:assert/strict";
import { test } from "node:test";
import { getOverview, openDb, recordEvent, schemaVersion } from "../src/index.ts";

test("tạo schema và nạp 5 loại task của lõi", () => {
  const db = openDb(":memory:");
  assert.equal(schemaVersion(db), 1);
  const kinds = db.prepare("SELECT key FROM task_kind WHERE project_id = '' ORDER BY key").all() as { key: string }[];
  assert.deepEqual(kinds.map((k) => k.key), ["analyze", "fix", "make", "review", "test"]);
});

test("mở lại không chạy migration hai lần", () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA user_version = 1");
  assert.equal(schemaVersion(db), 1);
});

test("trạng thái blocked bắt buộc có lý do và ngược lại", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO project (id, name, repo_path) VALUES ('p', 'P', '/x')").run();
  const insert = db.prepare("INSERT INTO task (project_id, kind, title, status, blocked_reason) VALUES ('p', 'make', 't', ?, ?)");
  assert.throws(() => insert.run("blocked", null), /CHECK/);
  assert.throws(() => insert.run("queued", "quota"), /CHECK/);
  assert.throws(() => insert.run("passed", null), /CHECK/); // trạng thái cũ, không còn
  insert.run("blocked", "quota");
});

test("tổng quan đếm task theo cột Kanban", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO project (id, name, repo_path) VALUES ('p', 'Factory', '/x')").run();
  db.prepare("INSERT INTO surface (project_id, id, kind, location, implicit) VALUES ('p', 'main', 'folder', '.', 1)").run();
  const add = db.prepare("INSERT INTO task (project_id, kind, title, status) VALUES ('p', 'make', 't', ?)");
  for (const s of ["queued", "running", "checking", "waiting_gate", "proposed", "done"]) add.run(s);

  const o = getOverview(db);
  assert.equal(o.projects.length, 1);
  assert.equal(o.projects[0]?.surfaces, 1);
  assert.deepEqual(o.totals, { queue: 1, running: 2, you: 2, done: 1 });
});

test("ghi sự kiện", () => {
  const db = openDb(":memory:");
  const id = recordEvent(db, { type: "server.started", payload: { port: 1 } });
  const row = db.prepare("SELECT type, payload FROM event WHERE id = ?").get(id) as { type: string; payload: string };
  assert.equal(row.type, "server.started");
  assert.deepEqual(JSON.parse(row.payload), { port: 1 });
});
