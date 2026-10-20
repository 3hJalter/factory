import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addComment,
  applyUserAction,
  createTask,
  editTask,
  findTaskByIssue,
  getTask,
  insertProject,
  issueSyncState,
  listComments,
  listTasks,
  openDb,
  startOnboarding,
  syncIssues,
  updateOnboarding,
  transition,
  type ProjectConfig,
} from "../src/index.ts";
import { fakeGitHub } from "./fake-github.ts";

const config: ProjectConfig = { name: "Dự án", surfaces: [{ id: "web", kind: "folder", location: "web/" }] };

function setup(githubRepo: string | null = "me/du-an") {
  const db = openDb(":memory:");
  insertProject(db, { id: "p", name: "Dự án", repoPath: "/x", githubRepo, config });
  const gh = fakeGitHub();
  const sync = () => syncIssues({ db, run: gh.run }, "p");
  return { db, gh, sync };
}

test("dự án chưa lên GitHub thì task giữ tại chỗ", async () => {
  const { db, gh, sync } = setup(null);
  createTask(db, "p", { title: "t", kind: "make", surfaces: ["web"] });
  const r = await sync();
  assert.match(r.skipped!, /chưa lên GitHub/);
  assert.equal(gh.calls.length, 0);
  assert.equal(issueSyncState(db, "p").pending, 1);
});

test("tạo task tại chỗ thì có Issue với label; đổi trạng thái thì label đổi theo", async () => {
  const { db, gh, sync } = setup();
  const a = createTask(db, "p", { title: "Trang chủ", body: "Làm trang chủ", kind: "make", surfaces: ["web"] });
  const r = await sync();
  assert.equal(r.pushed, 1);
  const t = getTask(db, a.id)!;
  assert.equal(t.githubIssue, 1);
  assert.equal(t.ref, "#1");
  assert.equal(t.dirty, false);
  assert.deepEqual(gh.labels(1), ["kind:make", "ready-for-agent", "status:queued", "surface:web"]);
  assert.equal(gh.issues.get(1)!.body, "Làm trang chủ");

  // Nhãn người khác gắn được giữ.
  gh.edit(1, { labels: [...gh.labels(1), "ưu tiên"] });
  applyUserAction(db, a.id, "cancel");
  await sync();
  assert.deepEqual(gh.labels(1), ["kind:make", "ready-for-agent", "status:cancelled", "surface:web", "ưu tiên"]);
  assert.equal(gh.issues.get(1)!.state, "closed");
  assert.equal(gh.issues.get(1)!.state_reason, "not_planned");
  assert.equal(issueSyncState(db, "p").pending, 0);

  // Đồng bộ lại không có gì đổi thì không ghi gì.
  const before = gh.calls.filter((c) => !c.startsWith("GET")).length;
  await sync();
  assert.equal(gh.calls.filter((c) => !c.startsWith("GET")).length, before);
});

test("sửa nội dung trên GitHub thì task cập nhật; sửa tại chỗ thì Issue cập nhật", async () => {
  const { db, gh, sync } = setup();
  const a = createTask(db, "p", { title: "Cũ", kind: "make", surfaces: ["web"] });
  await sync();

  gh.edit(1, { title: "Sửa trên điện thoại", body: "mô tả mới" });
  gh.comment(1, "nhớ thêm footer");
  editTask(db, a.id, { body: "tại chỗ, sẽ thua" });
  const r = await sync();
  const t = getTask(db, a.id)!;
  assert.equal(t.title, "Sửa trên điện thoại");
  assert.equal(t.body, "mô tả mới", "cả hai cùng sửa thì lấy bản GitHub");
  assert.ok(r.warnings.some((w) => /cả hai nơi/.test(w)));
  assert.deepEqual(listComments(db, a.id).map((c) => [c.author, c.body]), [["octo", "nhớ thêm footer"]]);

  editTask(db, a.id, { title: "Sửa tại chỗ" });
  addComment(db, a.id, { author: "you", body: "ok" });
  await sync();
  assert.equal(gh.issues.get(1)!.title, "Sửa tại chỗ");
  assert.equal(gh.issues.get(1)!.body, "mô tả mới");
  assert.deepEqual(gh.comments.map((c) => c.body), ["nhớ thêm footer", "ok"]);
  assert.equal(listComments(db, a.id).length, 2, "bình luận vừa đẩy không bị kéo về thành bản sao");

  // Sửa bình luận trên GitHub.
  gh.comments[0]!.body = "nhớ thêm footer và header";
  gh.comments[0]!.updated_at = "2027-01-01T00:00:00.000Z";
  await sync();
  assert.equal(listComments(db, a.id)[0]!.body, "nhớ thêm footer và header");
});

test("label status sửa tay bị đặt lại; label khu vực và loại được nhận khi task chưa chạy", async () => {
  const { db, gh, sync } = setup();
  const a = createTask(db, "p", { title: "t", kind: "make", surfaces: ["web"] });
  await sync();

  gh.edit(1, { labels: ["status:done", "kind:fix", "surface:main", "ready-for-agent"] });
  const r = await sync();
  assert.ok(r.warnings.some((w) => /bị sửa tay/.test(w)));
  const t = getTask(db, a.id)!;
  assert.equal(t.status, "queued");
  assert.equal(t.kind, "fix");
  assert.deepEqual(t.surfaces, ["main"]);
  assert.deepEqual(gh.labels(1), ["kind:fix", "ready-for-agent", "status:queued", "surface:main"]);

  transition(db, a.id, "preparing", { by: "core" });
  await sync();
  gh.edit(1, { labels: ["status:preparing", "kind:review", "surface:main", "ready-for-agent"] });
  await sync();
  assert.equal(getTask(db, a.id)!.kind, "fix", "task đã chạy thì không đổi loại");
  assert.deepEqual(gh.labels(1), ["kind:fix", "ready-for-agent", "status:preparing", "surface:main"]);
});

test("Issue mới trên GitHub: đủ label thì vào queued, thiếu thì đoán và để proposed", async () => {
  const { db, gh, sync } = setup();
  gh.open({ title: "Thêm nút", labels: ["kind:make", "surface:web"] });
  gh.open({ title: "Lỗi trên web khi bấm", body: "Trang web trắng", labels: ["bug"] });
  gh.open({ title: "Ý tưởng chung" });
  gh.open({ title: "Issue cũ đã đóng" });
  gh.edit(4, { state: "closed", state_reason: "completed" });
  gh.issues.set(99, { ...gh.issues.get(1)!, number: 99, id: 9999, pull_request: {} });

  const r = await sync();
  assert.equal(r.imported, 3);
  const [one, two, three] = [1, 2, 3].map((n) => findTaskByIssue(db, "p", n)!);
  assert.equal(one!.status, "queued");
  assert.equal(two!.status, "proposed");
  assert.equal(two!.kind, "fix");
  assert.deepEqual(two!.surfaces, ["web"]);
  assert.equal(three!.status, "proposed");
  assert.deepEqual(three!.surfaces, ["main"]);
  assert.equal(findTaskByIssue(db, "p", 4), undefined, "Issue đóng không phải task của nhà máy thì bỏ qua");
  assert.deepEqual(gh.labels(2), ["bug", "kind:fix", "ready-for-agent", "status:proposed", "surface:web"]);

  // Đóng Issue trên GitHub thì task bị huỷ.
  gh.edit(1, { state: "closed", state_reason: "not_planned" });
  await sync();
  assert.equal(getTask(db, one!.id)!.status, "cancelled");
});

test("phụ thuộc đi hai chiều qua liên kết blocked by", async () => {
  const { db, gh, sync } = setup();
  const a = createTask(db, "p", { title: "a", kind: "make", surfaces: ["web"] });
  const b = createTask(db, "p", { title: "b", kind: "test", surfaces: ["web"], dependsOn: [a.id] });
  await sync();
  assert.deepEqual(gh.issues.get(2)!.blockedBy, [1]);
  assert.deepEqual(gh.labels(2), ["kind:test", "ready-for-agent", "status:blocked", "surface:web"]);

  // Bỏ phụ thuộc trên GitHub thì task hết bị chặn.
  gh.issues.get(2)!.blockedBy = [];
  gh.edit(2, {});
  await sync();
  assert.equal(getTask(db, b.id)!.status, "queued");
  assert.deepEqual(gh.labels(2), ["kind:test", "ready-for-agent", "status:queued", "surface:web"]);

  // Thêm lại tại chỗ thì GitHub có liên kết.
  editTask(db, b.id, { dependsOn: [a.id] });
  await sync();
  assert.deepEqual(gh.issues.get(2)!.blockedBy, [1]);
});

test("máy mới dựng lại task từ Issues", async () => {
  const { db, gh, sync } = setup();
  const a = createTask(db, "p", { title: "a", kind: "make", surfaces: ["web"] });
  createTask(db, "p", { title: "b", kind: "test", surfaces: ["web"], dependsOn: [a.id] });
  createTask(db, "p", { title: "gợi ý", kind: "review", surfaces: ["main"], origin: "agent" });
  const c = createTask(db, "p", { title: "xong", kind: "fix", surfaces: ["main"] });
  applyUserAction(db, c.id, "cancel");
  addComment(db, a.id, { author: "you", body: "ghi chú" });
  await sync();

  const other = openDb(":memory:");
  insertProject(other, { id: "p", name: "Dự án", repoPath: "/y", githubRepo: "me/du-an", config });
  await syncIssues({ db: other, run: gh.run }, "p");
  const rebuilt = listTasks(other, "p")
    .map((t) => [t.ref, t.title, t.status, t.dependsOn.length])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  assert.deepEqual(rebuilt, [
    ["#1", "a", "queued", 0],
    ["#2", "b", "blocked", 1],
    ["#3", "gợi ý", "proposed", 0],
    ["#4", "xong", "cancelled", 0],
  ]);
  assert.equal(listComments(other, findTaskByIssue(other, "p", 1)!.id)[0]!.body, "ghi chú");
  assert.equal(issueSyncState(other, "p").pending, 0, "dựng lại không đẩy gì ngược lên");
});

test("chưa duyệt bước lên GitHub thì chỉ kéo về, không ghi lên repo", async () => {
  const { db, gh, sync } = setup();
  const onboarding = startOnboarding(db, { projectId: "p", step: "A3", status: "waiting_you" });
  gh.open({ title: "Có sẵn", labels: ["kind:make", "surface:web", "status:queued", "ready-for-agent"] });
  createTask(db, "p", { title: "mới", kind: "make", surfaces: ["web"] });
  const r = await sync();
  assert.equal(r.imported, 1);
  assert.match(r.pushSkipped!, /Chưa duyệt/);
  assert.equal(gh.issues.size, 1);
  assert.ok(gh.calls.every((c) => c.startsWith("GET")));

  updateOnboarding(db, onboarding, { step: "A4", status: "done" });
  await sync();
  assert.equal(gh.issues.size, 2);
});

test("lỗi GitHub được ghi lại, task vẫn chờ đẩy", async () => {
  const { db, gh, sync } = setup();
  createTask(db, "p", { title: "t", kind: "make", surfaces: ["web"] });
  gh.failOn = /^POST/;
  const r = await sync();
  assert.ok(r.warnings.some((w) => /Không tạo được Issue/.test(w)));
  assert.equal(issueSyncState(db, "p").pending, 1);

  gh.failOn = /^GET/;
  await assert.rejects(sync(), /Bad Gateway/);
  assert.match(issueSyncState(db, "p").lastError!, /Bad Gateway/);

  gh.failOn = undefined;
  await sync();
  assert.equal(issueSyncState(db, "p").pending, 0);
  assert.equal(issueSyncState(db, "p").lastError, null);
});
