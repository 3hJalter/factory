import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigError,
  ensureClaudeImport,
  loadPack,
  mergeAgents,
  parseGithubRepo,
  parseProjectConfig,
  resolveCommands,
  scanFiles,
  serializeProjectConfig,
  slugify,
  walkFiles,
  type ProjectConfig,
} from "../src/index.ts";
import { tempDir, write } from "./helpers.ts";

test("đọc và ghi project.yaml giữ nguyên nội dung", () => {
  const config: ProjectConfig = {
    name: "factory",
    main: { commands: { check: "npm run typecheck", test: "npm test" } },
    surfaces: [{ id: "web", kind: "folder", location: "web/", commands: { check: "npx tsc -p tsconfig.json" } }],
  };
  const text = serializeProjectConfig(config);
  assert.match(text, /^# /);
  assert.deepEqual(parseProjectConfig(text), config);
});

test("báo lỗi cấu hình rõ ràng", () => {
  assert.throws(() => parseProjectConfig("surfaces: []"), /name/);
  assert.throws(() => parseProjectConfig("name: x\nsurfaces:\n  - { id: main, location: . }"), /có sẵn/);
  assert.throws(() => parseProjectConfig("name: x\nsurfaces:\n  - { id: Web, location: web }"), ConfigError);
  assert.throws(() => parseProjectConfig("name: x\nsurfaces:\n  - { id: a, location: a }\n  - { id: a, location: b }"), /hai lần/);
  assert.throws(() => parseProjectConfig("name: x\nsurfaces:\n  - { id: a, location: a, commands: { build: x } }"), /lệnh lạ/);
});

test("tên dự án thành id", () => {
  assert.equal(slugify("Cosplay Run"), "cosplay-run");
  assert.equal(slugify("Đường đua Việt"), "duong-dua-viet");
  assert.equal(slugify("2048"), "p-2048");
});

test("đọc owner/name từ remote GitHub", () => {
  assert.equal(parseGithubRepo("https://github.com/3hJalter/factory.git"), "3hJalter/factory");
  assert.equal(parseGithubRepo("git@github.com:a/b.git"), "a/b");
  assert.equal(parseGithubRepo("https://gitlab.com/a/b.git"), undefined);
});

test("AGENTS.md: thêm khối nhà máy, chạy lại thì thay đúng khối, giữ phần của bạn", () => {
  const config: ProjectConfig = { name: "X", surfaces: [] };
  const once = mergeAgents("# Luật của tôi\n", { config });
  assert.match(once, /^# Luật của tôi\n\n<!-- factory:begin -->/);
  const withSurface = mergeAgents(once + "\nPhần sau.\n", { config: { ...config, surfaces: [{ id: "web", kind: "folder", location: "web/" }] } });
  assert.equal(withSurface.match(/<!-- factory:begin -->/g)!.length, 1);
  assert.match(withSurface, /`web`/);
  assert.match(withSurface, /Phần sau\./);
  assert.equal(ensureClaudeImport("Ghi chú\n"), "@AGENTS.md\nGhi chú\n");
  assert.equal(ensureClaudeImport("@AGENTS.md\n"), "@AGENTS.md\n");
});

test("pack một lớp: đọc lệnh chuẩn, lệnh của khu vực đè lên pack, không cho kế thừa", () => {
  const packs = tempDir();
  write(packs, "web-vite/pack.yaml", "name: web-vite\nversion: 0.1.0\ncommands:\n  provision: npm ci\n  check: { run: npx tsc, timeout: 5m }\n  test.unit: npm test\n");
  write(packs, "child/pack.yaml", "name: child\nversion: 0.1.0\nextends: web-vite\n");
  const pack = loadPack(packs, "web-vite");
  assert.equal(pack.commands.check!.timeoutMs, 300_000);
  const cmds = resolveCommands({ pack: "web-vite", commands: { test: "npm run test:web" } }, pack);
  assert.equal(cmds.provision!.run, "npm ci");
  assert.equal(cmds.test!.run, "npm run test:web");
  assert.equal(cmds.test!.source, "surface");
  assert.throws(() => loadPack(packs, "child"), /V1/);
  assert.throws(() => loadPack(packs, "khong-co"), /Không thấy/);
});

test("quét tìm secret, file lớn và dấu hiệu có test", () => {
  const dir = tempDir();
  write(dir, "src/app.ts", "export const a = 1;");
  write(dir, "src/app.test.ts", "test");
  write(dir, "config.ts", `const key = "ghp_${"a".repeat(36)}";`);
  write(dir, ".env.example", "TOKEN=");
  write(dir, "node_modules/x/index.js", "skip");
  const r = scanFiles(dir, walkFiles(dir));
  assert.equal(r.files, 4);
  assert.deepEqual(r.secrets.map((s) => s.path), ["config.ts"]);
  assert.equal(r.hasTests, true);
});
