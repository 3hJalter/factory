import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  addSurface,
  checkSurfaces,
  createProject,
  getProject,
  inspectMainRepo,
  inspectSurface,
  latestCommandResults,
  latestOnboarding,
  listSurfaces,
  parseProjectConfig,
  publishProject,
  reloadProjectConfig,
  showFile,
  defaultRunner,
} from "../src/index.ts";
import { context, fakeGh, git, node, repoWithRemote, tempDir, write } from "./helpers.ts";

test("A1: chặn đường dẫn tương đối, thư mục không có, và secret sẽ vào commit đầu", async () => {
  const ctx = context(fakeGh().run);
  const rel = await inspectMainRepo(ctx, { mode: "existing", path: "du-an" });
  assert.equal(rel.ok, false);

  const missing = await inspectMainRepo(ctx, { mode: "existing", path: join(tempDir(), "khong-co") });
  assert.equal(missing.ok, false);

  const dir = tempDir();
  write(dir, "index.html", "<p>hi</p>");
  write(dir, ".env", "TOKEN=abc");
  const withSecret = await inspectMainRepo(ctx, { mode: "existing", path: dir });
  assert.equal(withSecret.ok, false);
  assert.match(withSecret.findings.find((f) => f.level === "block")!.message, /secret/);
});

test("A1: thư mục con của một repo không làm repo chính được", async () => {
  const { repo } = await repoWithRemote({ "web/index.html": "<p/>" });
  const ctx = context(fakeGh().run);
  const r = await inspectMainRepo(ctx, { mode: "existing", path: join(repo, "web") });
  assert.equal(r.ok, false);
});

test("A2: thư mục chưa có git thành hai commit trên main, cổng là tạo repo", async () => {
  const dir = tempDir();
  write(dir, "index.html", "<p>hi</p>");
  const gh = fakeGh();
  const ctx = context(gh.run);
  const { project, onboarding } = await createProject(ctx, { mode: "existing", path: dir, name: "Cosplay Run", mainCommands: { check: "echo ok" } });

  assert.equal(project.id, "cosplay-run");
  assert.equal(project.baseBranch, "main");
  const log = await git(dir, "log", "--format=%s");
  assert.deepEqual(log.split("\n"), ["factory onboarding", "Trạng thái ban đầu"]);
  for (const f of [".factory/project.yaml", ".factory/packs.lock", "AGENTS.md", "CLAUDE.md", "GLOSSARY.md", "docs/adr/README.md", ".github/ISSUE_TEMPLATE/bug.yml"]) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  const config = parseProjectConfig(readFileSync(join(dir, ".factory/project.yaml"), "utf8"));
  assert.equal(config.name, "Cosplay Run");
  assert.deepEqual(config.main, { commands: { check: "echo ok" } });
  assert.equal(onboarding.step, "A3");
  assert.equal(onboarding.status, "waiting_you");
  assert.equal((onboarding.data.gate as { action: string }).action, "create");
  assert.deepEqual(listSurfaces(ctx.db, project.id).map((s) => s.id), ["main"]);
});

test("A2: repo có sẵn được sửa trên nhánh riêng, không đụng nhánh và thay đổi dở của bạn", async () => {
  const { repo } = await repoWithRemote({ "README.md": "# Thử\n", "AGENTS.md": "# Luật của tôi\n\nĐừng xoá dòng này.\n" });
  write(repo, "README.md", "# Đang sửa dở\n");
  const head = await git(repo, "rev-parse", "HEAD");
  const ctx = context(fakeGh().run);
  const { onboarding } = await createProject(ctx, { mode: "existing", path: repo, name: "Thử" });

  assert.equal(await git(repo, "rev-parse", "HEAD"), head);
  assert.equal(await git(repo, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Đang sửa dở\n");
  assert.equal(existsSync(join(repo, ".factory")), false);

  const agents = await showFile(defaultRunner, repo, "factory/onboarding", "AGENTS.md");
  assert.match(agents!, /Đừng xoá dòng này/);
  assert.match(agents!, /factory:begin/);
  assert.ok(await showFile(defaultRunner, repo, "factory/onboarding", ".factory/project.yaml"));
  assert.equal((onboarding.data.gate as { action: string }).action, "pr");
});

test("A3 + A4: sau khi duyệt, đẩy nhánh, mở PR, tạo label; bảo vệ nhánh hỏng chỉ là cảnh báo", async () => {
  const { repo, bare } = await repoWithRemote();
  const gh = fakeGh({ failProtection: true });
  const ctx = context(gh.run);
  const { project } = await createProject(ctx, { mode: "existing", path: repo, name: "Thử" });
  const done = await publishProject(ctx, project.id);

  assert.equal(done.status, "done");
  assert.equal(done.data.prUrl, "https://github.com/me/x/pull/1");
  assert.ok(await git(bare, "rev-parse", "factory/onboarding"));
  assert.ok(gh.calls.some((c) => c[0] === "pr" && c[1] === "create"));
  const labels = gh.calls.filter((c) => c[0] === "label").map((c) => c[2]);
  assert.ok(labels.includes("kind:make"));
  assert.ok(labels.includes("status:waiting_gate"));
  assert.ok(labels.includes("surface:main"));
  assert.match(String((done.data.warnings as string[])[0]), /gói trả phí/);
  assert.equal(getProject(ctx.db, project.id)!.githubRepo, "me/remote");
});

test("A3: tạo repo mới khi chưa có remote, rồi đẩy main", async () => {
  const dir = tempDir();
  write(dir, "a.txt", "a");
  const gh = fakeGh();
  const ctx = context(gh.run);
  const { project } = await createProject(ctx, { mode: "existing", path: dir, name: "Mới" });
  const done = await publishProject(ctx, project.id, { repoName: "moi" });
  assert.equal(done.status, "done");
  assert.ok(gh.calls.some((c) => c[0] === "repo" && c[1] === "create" && c.includes("--private")));
  assert.equal(getProject(ctx.db, project.id)!.githubRepo, "me/moi");
});

test("A3: gh chưa đăng nhập thì cổng vẫn chờ, kèm lỗi", async () => {
  const dir = tempDir();
  write(dir, "a.txt", "a");
  const ctx = context(fakeGh({ loggedIn: false }).run);
  const { project } = await createProject(ctx, { mode: "existing", path: dir, name: "X" });
  await assert.rejects(publishProject(ctx, project.id), /gh/);
  const o = latestOnboarding(ctx.db, project.id)!;
  assert.equal(o.status, "waiting_you");
  assert.match(o.error!, /gh auth login/);
});

test("B: thêm khu vực trước khi lên GitHub gộp vào nhánh onboarding và chạy mốc chuẩn", async () => {
  const { repo } = await repoWithRemote({ "web/index.html": "<p/>", "web/ok.txt": "x" });
  const ctx = context(fakeGh().run);
  const { project } = await createProject(ctx, { mode: "existing", path: repo, name: "Thử" });

  const preview = await inspectSurface(ctx, project.id, { id: "web", location: "web" });
  assert.equal(preview.ok, true);
  assert.equal(preview.location, "web/");
  assert.equal(preview.scan!.files, 2);

  const done = await addSurface(ctx, project.id, {
    id: "web",
    location: "web",
    commands: { provision: `${node} -e "require('fs').writeFileSync('ready', '1')"`, check: `${node} -e "require('fs').accessSync('ready')"`, test: `${node} -e "process.exit(3)"` },
  });
  assert.equal(done.step, "B9");
  assert.equal(done.status, "done");
  assert.equal(done.data.baselineOk, false);
  const results = latestCommandResults(ctx.db, project.id, "web", "baseline");
  assert.deepEqual(results.map((r) => [r.command, r.ok]), [["provision", true], ["check", true], ["test", false]]);
  assert.equal(results[2]!.exitCode, 3);

  const yaml = await showFile(defaultRunner, repo, "factory/onboarding", ".factory/project.yaml");
  assert.match(yaml!, /id: web/);
  assert.deepEqual(listSurfaces(ctx.db, project.id).map((s) => s.id), ["main", "web"]);
  assert.equal(existsSync(join(repo, "web", "ready")), false, "mốc chuẩn chạy trong worktree riêng");
  await assert.rejects(addSurface(ctx, project.id, { id: "web", location: "web" }), /đã có khu vực/);
});

test("B: thêm khu vực sau khi dự án đã lên GitHub mở PR riêng", async () => {
  const { repo, bare } = await repoWithRemote({ "server/a.ts": "export {}" });
  const gh = fakeGh();
  const ctx = context(gh.run);
  const { project } = await createProject(ctx, { mode: "existing", path: repo, name: "Thử" });
  await publishProject(ctx, project.id);
  const done = await addSurface(ctx, project.id, { id: "server", location: "server", commands: { check: `${node} -e "0"` } });
  assert.equal(done.status, "done");
  assert.ok(await git(bare, "rev-parse", "factory/surface-server"));
  assert.ok(gh.calls.some((c) => c[0] === "pr" && c[1] === "create" && c.includes("factory/surface-server")));
});

test("factory doctor --project chạy lệnh kiểm của từng khu vực tại chỗ", async () => {
  const { repo } = await repoWithRemote({ "web/a.txt": "a" });
  const ctx = context(fakeGh().run);
  const { project } = await createProject(ctx, { mode: "existing", path: repo, name: "Thử", mainCommands: { check: `${node} -e "0"` } });
  await addSurface(ctx, project.id, { id: "web", location: "web", commands: { check: `${node} -e "process.exit(require('fs').existsSync('a.txt') ? 0 : 1)"` } });
  const checks = await checkSurfaces(ctx, project.id);
  assert.deepEqual(checks.map((c) => [c.surfaceId, c.result?.ok]), [["main", true], ["web", true]]);
});

test("đọc lại project.yaml sau khi sửa tay", async () => {
  const dir = tempDir();
  write(dir, "a.txt", "a");
  const ctx = context(fakeGh().run);
  const { project } = await createProject(ctx, { mode: "existing", path: dir, name: "X" });
  write(dir, ".factory/project.yaml", "name: X\nmain:\n  commands: { check: echo moi }\nsurfaces:\n  - { id: docs, kind: folder, location: docs/ }\n");
  reloadProjectConfig(ctx, project.id);
  assert.deepEqual(listSurfaces(ctx.db, project.id).map((s) => s.id), ["main", "docs"]);
  assert.equal(getProject(ctx.db, project.id)!.config.main!.commands!.check, "echo moi");
  write(dir, ".factory/project.yaml", "name: X\nsurfaces:\n  - { id: Sai, location: x }\n");
  assert.throws(() => reloadProjectConfig(ctx, project.id));
  assert.deepEqual(listSurfaces(ctx.db, project.id).map((s) => s.id), ["main", "docs"]);
});
