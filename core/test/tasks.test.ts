import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addComment,
  applyUserAction,
  availableActions,
  canTransition,
  createTask,
  editTask,
  getTask,
  insertProject,
  isFactoryPaused,
  listComments,
  listTasks,
  openDb,
  setFactoryPaused,
  taskHistory,
  taskKinds,
  transition,
  updateProject,
  type ProjectConfig,
} from "../src/index.ts";

const config: ProjectConfig = {
  name: "Thử",
  surfaces: [{ id: "web", kind: "folder", location: "web/" }],
  task_kinds: { add: [{ key: "balance", name: "Cân bằng" }] },
};

function setup() {
  const db = openDb(":memory:");
  insertProject(db, { id: "p", name: "Thử", repoPath: "/x", config });
  return db;
}

test("loại task gồm năm loại lõi và loại riêng của dự án", () => {
  assert.deepEqual(
    taskKinds(config).map((k) => k.key),
    ["analyze", "make", "fix", "review", "test", "balance"],
  );
});

test("tạo task: bạn tạo vào queued, agent gợi ý vào proposed, còn phụ thuộc thì blocked", () => {
  const db = setup();
  const a = createTask(db, "p", { title: "Làm trang chủ", kind: "make", surfaces: ["web"] });
  assert.equal(a.status, "queued");
  assert.equal(a.ref, `T-${a.id}`);
  assert.equal(a.dirty, true);

  const b = createTask(db, "p", { title: "Gợi ý", kind: "review", surfaces: ["main"], origin: "agent" });
  assert.equal(b.status, "proposed");
  assert.equal(b.gate, "accept_task");

  const c = createTask(db, "p", { title: "Sau trang chủ", kind: "test", surfaces: ["web"], dependsOn: [a.id] });
  assert.equal(c.status, "blocked");
  assert.equal(c.blockedReason, "depends_on");
  assert.deepEqual(c.dependsOn, [a.id]);

  const fromIssue = createTask(db, "p", { title: "Từ Issue", kind: "fix", surfaces: ["main"], githubIssue: 7 });
  assert.equal(fromIssue.ref, "#7");
  assert.equal(fromIssue.dirty, false);

  assert.throws(() => createTask(db, "p", { title: "x", kind: "lạ", surfaces: ["web"] }), /loại task/);
  assert.throws(() => createTask(db, "p", { title: "x", kind: "make", surfaces: ["khong-co"] }), /khu vực/);
  assert.throws(() => createTask(db, "p", { title: "x", kind: "make", surfaces: [] }), /ít nhất một khu vực/);
  assert.throws(() => createTask(db, "p", { title: " ", kind: "make", surfaces: ["web"] }), /tiêu đề/);
  assert.equal(listTasks(db, "p").length, 4);
});

test("bảng chuyển chặn bước không có trong thiết kế", () => {
  assert.equal(canTransition("queued", "preparing"), true);
  assert.equal(canTransition("queued", "done"), false);
  assert.equal(canTransition("running", "cancelled"), true);
  assert.equal(canTransition("done", "cancelled"), false);

  const db = setup();
  const t = createTask(db, "p", { title: "t", kind: "make", surfaces: ["web"] });
  assert.throws(() => transition(db, t.id, "done", { by: "test" }), /không chuyển được/);
  assert.throws(() => transition(db, t.id, "blocked", { by: "test" }), /cần lý do/);
  const stuck = transition(db, transition(db, t.id, "preparing", { by: "core" }).id, "stuck", { by: "core", stuckReason: "worktree hỏng" });
  assert.equal(stuck.stuckReason, "worktree hỏng");
  assert.deepEqual(availableActions(stuck), ["cancel", "resume"]);
  assert.equal(applyUserAction(db, t.id, "resume").status, "queued");
});

test("nhận, không nhận và huỷ task", () => {
  const db = setup();
  const a = createTask(db, "p", { title: "a", kind: "make", surfaces: ["web"] });
  const gợiÝ = createTask(db, "p", { title: "gợi ý", kind: "make", surfaces: ["web"], origin: "agent", dependsOn: [a.id] });
  assert.deepEqual(availableActions(gợiÝ), ["accept", "reject", "cancel"]);

  const accepted = applyUserAction(db, gợiÝ.id, "accept", { comment: "ok, làm đi" });
  assert.equal(accepted.status, "blocked", "còn phụ thuộc chưa xong");
  assert.equal(accepted.gate, null);
  assert.equal(listComments(db, gợiÝ.id)[0]!.body, "ok, làm đi");

  const other = createTask(db, "p", { title: "khác", kind: "fix", surfaces: ["main"], origin: "links" });
  assert.equal(applyUserAction(db, other.id, "reject").status, "rejected");
  assert.throws(() => applyUserAction(db, other.id, "cancel"), /Không huỷ/);

  assert.equal(applyUserAction(db, a.id, "cancel").status, "cancelled");
  const history = taskHistory(db, a.id).filter((e) => e.type === "task.transition").map((e) => [e.payload.from, e.payload.to]);
  assert.deepEqual(history, [[null, "queued"], ["queued", "cancelled"]]);
});

test("xong task thì gỡ chặn task phụ thuộc và đóng task cha", () => {
  const db = setup();
  const a = createTask(db, "p", { title: "a", kind: "make", surfaces: ["web"] });
  const b = createTask(db, "p", { title: "b", kind: "make", surfaces: ["web"] });
  const c = createTask(db, "p", { title: "c", kind: "test", surfaces: ["web"], dependsOn: [a.id, b.id] });
  const parent = createTask(db, "p", { title: "cha", kind: "make", surfaces: ["web"] });
  transition(db, parent.id, "blocked", { by: "core", blockedReason: "children" });
  const child = createTask(db, "p", { title: "con", kind: "make", surfaces: ["web"], parentId: parent.id });

  const finish = (id: number) => {
    transition(db, id, "preparing", { by: "core" });
    transition(db, id, "running", { by: "core" });
    transition(db, id, "checking", { by: "core" });
    transition(db, id, "done", { by: "core" });
  };
  finish(a.id);
  assert.equal(getTask(db, c.id)!.status, "blocked");
  finish(b.id);
  assert.equal(getTask(db, c.id)!.status, "queued");

  assert.equal(getTask(db, parent.id)!.status, "blocked");
  applyUserAction(db, child.id, "cancel");
  assert.equal(getTask(db, parent.id)!.status, "done");
});

test("sửa task: loại và khu vực chỉ đổi khi chưa chạy, phụ thuộc không được tạo vòng", () => {
  const db = setup();
  const a = createTask(db, "p", { title: "a", kind: "make", surfaces: ["web"] });
  const b = createTask(db, "p", { title: "b", kind: "make", surfaces: ["web"], dependsOn: [a.id] });

  const edited = editTask(db, a.id, { title: "a mới", kind: "balance", surfaces: ["web", "main"] });
  assert.equal(edited.title, "a mới");
  assert.equal(edited.kind, "balance");
  assert.deepEqual(edited.surfaces, ["main", "web"]);

  assert.throws(() => editTask(db, a.id, { dependsOn: [b.id] }), /vòng/);
  assert.deepEqual(getTask(db, a.id)!.dependsOn, [], "lỗi thì không đổi gì");

  // Bỏ phụ thuộc thì hết bị chặn; thêm lại thì bị chặn.
  assert.equal(editTask(db, b.id, { dependsOn: [] }).status, "queued");
  assert.equal(editTask(db, b.id, { dependsOn: [a.id] }).status, "blocked");

  transition(db, a.id, "preparing", { by: "core" });
  assert.throws(() => editTask(db, a.id, { kind: "fix" }), /chưa chạy/);
  assert.equal(editTask(db, a.id, { body: "thêm mô tả" }).body, "thêm mô tả");
});

test("sửa từ Issue không đánh dấu cần đẩy lên, bình luận tại chỗ thì có", () => {
  const db = setup();
  const t = createTask(db, "p", { title: "từ issue", kind: "fix", surfaces: ["main"], githubIssue: 3 });
  assert.equal(editTask(db, t.id, { title: "đổi trên GitHub" }, { fromIssue: true }).dirty, false);
  addComment(db, t.id, { author: "octo", body: "từ GitHub", githubId: 99 });
  assert.equal(getTask(db, t.id)!.dirty, false);
  addComment(db, t.id, { author: "you", body: "tại chỗ" });
  assert.equal(getTask(db, t.id)!.dirty, true);
  assert.deepEqual(listComments(db, t.id).map((c) => c.githubId), [99, null]);
});

test("bỏ khu vực khỏi cấu hình thì task của nó chuyển sang main", () => {
  const db = setup();
  const t = createTask(db, "p", { title: "t", kind: "make", surfaces: ["web"] });
  const both = createTask(db, "p", { title: "cả hai", kind: "make", surfaces: ["web", "main"] });
  updateProject(db, "p", { config: { ...config, surfaces: [] } });
  assert.deepEqual(getTask(db, t.id)!.surfaces, ["main"]);
  assert.deepEqual(getTask(db, both.id)!.surfaces, ["main"]);
  db.prepare("DELETE FROM project WHERE id = 'p'").run();
  assert.equal(listTasks(db, "p").length, 0);
});

test("công tắc tạm dừng toàn bộ", () => {
  const db = setup();
  assert.equal(isFactoryPaused(db), false);
  setFactoryPaused(db, true);
  assert.equal(isFactoryPaused(db), true);
  setFactoryPaused(db, false);
  assert.equal(isFactoryPaused(db), false);
});
