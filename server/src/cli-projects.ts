import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  addSurface,
  checkSurfaces,
  createProject,
  factoryPaths,
  getProject,
  inspectMainRepo,
  latestCommandResults,
  latestOnboarding,
  listProjects,
  listSurfaces,
  openDb,
  publishProject,
  reloadProjectConfig,
  runBaseline,
  type Finding,
  type OnboardingContext,
  type ProjectGate,
  type StartMode,
  type SurfaceCommands,
} from "@factory/core";

/** Lệnh `factory project ...`, `factory surface ...` và `factory doctor --project`. */

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["--name", "--clone", "--check", "--test", "--provision", "--pack", "--repo", "--project"]);

export function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) {
        const v = args[i + 1];
        if (v === undefined) throw new Error(`Thiếu giá trị cho ${a}`);
        flags.set(a, v);
        i++;
      } else flags.set(a, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (p: Parsed, flag: string) => {
  const v = p.flags.get(flag);
  return typeof v === "string" ? v : undefined;
};

function commandsFrom(p: Parsed): SurfaceCommands | undefined {
  const c: SurfaceCommands = {};
  for (const k of ["provision", "check", "test"] as const) {
    const v = str(p, `--${k}`);
    if (v) c[k] = v;
  }
  return Object.keys(c).length > 0 ? c : undefined;
}

function context(): OnboardingContext {
  const paths = factoryPaths();
  mkdirSync(paths.home, { recursive: true });
  return { db: openDb(paths.db), paths, log: (m) => console.log(`  · ${m}`) };
}

const MARK = { block: "✗", warn: "!", info: "·" } as const;
const printFindings = (findings: Finding[]) => {
  for (const f of findings) console.log(`  ${MARK[f.level]} ${f.message}`);
};

export const PROJECT_HELP = `
  project add <thư mục> [--name TÊN] [--new | --clone URL]
                         Tạo dự án từ thư mục có sẵn, thư mục mới, hoặc clone repo
                         [--check LỆNH] [--test LỆNH] [--provision LỆNH]  lệnh của khu vực main
  project publish <dự án> [--repo TÊN]
                         Duyệt bước lên GitHub: tạo repo private hoặc mở PR, tạo label
  project list           Liệt kê dự án
  project show <dự án>   Xem khu vực và tiến độ onboarding
  project reload <dự án> Đọc lại .factory/project.yaml sau khi bạn sửa tay
  surface add <dự án> <id> <thư mục> [--check LỆNH] [--test LỆNH] [--provision LỆNH] [--pack TÊN]
                         Thêm khu vực kiểu folder rồi chạy mốc chuẩn
  surface baseline <dự án> <id>
                         Chạy lại mốc chuẩn của một khu vực
  doctor --project <dự án>
                         Chạy lệnh kiểm của từng khu vực`;

export async function projectCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const [sub, ...rest] = p.positional;
  const ctx = context();
  try {
    switch (sub) {
      case "add": {
        const path = rest[0];
        if (!path) throw new Error("Dùng: factory project add <thư mục>");
        const clone = str(p, "--clone");
        const mode: StartMode = clone ? "clone" : p.flags.has("--new") ? "new" : "existing";
        const input = { mode, path: resolve(path), ...(clone ? { url: clone } : {}) };
        const inspection = await inspectMainRepo(ctx, input);
        console.log(`Kiểm ${input.path}:`);
        printFindings(inspection.findings);
        if (!inspection.ok) return 1;
        const commands = commandsFrom(p);
        const { project, onboarding } = await createProject(ctx, {
          ...input,
          name: str(p, "--name") ?? inspection.suggestedName,
          ...(commands ? { mainCommands: commands } : {}),
        });
        const gate = onboarding.data.gate as ProjectGate;
        console.log(`\nĐã tạo dự án \`${project.id}\`.`);
        printGate(gate);
        console.log(`\nDuyệt bằng: factory project publish ${project.id}${gate.action === "create" ? " [--repo TÊN]" : ""}`);
        console.log(`Thêm khu vực: factory surface add ${project.id} <id> <thư mục> --check "..." --test "..."`);
        return 0;
      }
      case "publish": {
        const id = rest[0];
        if (!id) throw new Error("Dùng: factory project publish <dự án>");
        const repo = str(p, "--repo");
        const done = await publishProject(ctx, id, repo ? { repoName: repo } : {});
        console.log(`Xong. Repo: ${String(done.data.githubRepo)}${done.data.prUrl ? `\nPR: ${String(done.data.prUrl)}` : ""}`);
        for (const w of (done.data.warnings as string[] | undefined) ?? []) console.log(`  ! ${w}`);
        return 0;
      }
      case "list": {
        const projects = listProjects(ctx.db);
        if (projects.length === 0) console.log("Chưa có dự án. Tạo bằng: factory project add <thư mục>");
        for (const pr of projects) console.log(`${pr.id}\t${pr.name}\t${pr.repoPath}\t${pr.githubRepo ?? "(chưa lên GitHub)"}`);
        return 0;
      }
      case "show": {
        const id = rest[0];
        const project = id ? getProject(ctx.db, id) : undefined;
        if (!project) throw new Error(`Không có dự án ${id ?? ""}`);
        const a = latestOnboarding(ctx.db, project.id);
        console.log(`${project.name} (${project.id})\n  ${project.repoPath}\n  GitHub: ${project.githubRepo ?? "chưa"}`);
        if (a) console.log(`  Tạo dự án: bước ${a.step}, ${a.status}${a.error ? ` (${a.error})` : ""}`);
        console.log("Khu vực:");
        for (const s of listSurfaces(ctx.db, project.id)) {
          const o = s.implicit ? undefined : latestOnboarding(ctx.db, project.id, s.id);
          const base = latestCommandResults(ctx.db, project.id, s.id, "baseline");
          const summary = base.length ? base.map((r) => `${r.command} ${r.ok ? "✓" : "✗"}`).join(" ") : "chưa có mốc chuẩn";
          console.log(`  ${s.id}\t${s.location}\t${o ? `${o.step} ${o.status}` : ""}\t${summary}`);
        }
        return 0;
      }
      case "reload": {
        const id = rest[0];
        if (!id) throw new Error("Dùng: factory project reload <dự án>");
        const config = reloadProjectConfig(ctx, id);
        if (!config) {
          console.error("Thư mục repo chưa có .factory/project.yaml (PR onboarding đã merge và pull về chưa?)");
          return 1;
        }
        console.log(`Đã đọc lại: ${config.surfaces.map((s) => s.id).join(", ") || "chỉ có main"}`);
        return 0;
      }
      default:
        console.error(`Dùng:${PROJECT_HELP}`);
        return 2;
    }
  } finally {
    ctx.db.close();
  }
}

export async function surfaceCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const [sub, projectId, surfaceId, location] = p.positional;
  const ctx = context();
  try {
    switch (sub) {
      case "add": {
        if (!projectId || !surfaceId || !location) throw new Error("Dùng: factory surface add <dự án> <id> <thư mục>");
        const commands = commandsFrom(p);
        const pack = str(p, "--pack");
        const project = getProject(ctx.db, projectId);
        if (!project) throw new Error(`Không có dự án ${projectId}`);
        const done = await addSurface(ctx, projectId, {
          id: surfaceId,
          location: resolve(location),
          ...(commands ? { commands } : {}),
          ...(pack ? { pack } : {}),
        });
        printBaseline(ctx, projectId, surfaceId, done.data);
        return 0;
      }
      case "baseline": {
        if (!projectId || !surfaceId) throw new Error("Dùng: factory surface baseline <dự án> <id>");
        const done = await runBaseline(ctx, projectId, surfaceId);
        printBaseline(ctx, projectId, surfaceId, done.data);
        return done.data.baselineOk ? 0 : 1;
      }
      default:
        console.error(`Dùng:${PROJECT_HELP}`);
        return 2;
    }
  } finally {
    ctx.db.close();
  }
}

export async function doctorProject(projectId: string): Promise<number> {
  const ctx = context();
  try {
    const checks = await checkSurfaces(ctx, projectId);
    console.log(`\nKiểm từng khu vực của ${projectId}:`);
    for (const c of checks) {
      if (c.missing) console.log(`  · ${c.surfaceId}: chưa có lệnh kiểm`);
      else if (c.result) {
        console.log(`  ${c.result.ok ? "✓" : "✗"} ${c.surfaceId}: ${c.result.run} (${(c.result.durationMs / 1000).toFixed(1)} giây)`);
        if (!c.result.ok) console.log(indent(c.result.output.split("\n").slice(-15).join("\n")));
      }
    }
    return checks.every((c) => c.missing || c.result?.ok) ? 0 : 1;
  } finally {
    ctx.db.close();
  }
}

function printGate(gate: ProjectGate): void {
  const what = {
    create: `Bước tiếp theo tạo repo private ${gate.suggestedRepoName} trên GitHub và đẩy nhánh ${gate.branch}.`,
    pr: `Bước tiếp theo đẩy nhánh ${gate.branch} lên ${gate.githubRepo ?? "GitHub"} và mở PR.`,
    setup: `Cấu hình đã có sẵn; bước tiếp theo chỉ tạo label trên ${gate.githubRepo ?? "GitHub"}.`,
  }[gate.action];
  console.log(what);
  console.log(`  ${gate.files} file, ${(gate.totalBytes / 1024 / 1024).toFixed(1)} MB`);
  for (const l of gate.large) console.log(`  ! File lớn: ${l.path} (${(l.bytes / 1024 / 1024).toFixed(0)} MB)`);
  for (const s of gate.secrets) console.log(`  ! Giống secret: ${s.path} (${s.reason})`);
}

function printBaseline(ctx: OnboardingContext, projectId: string, surfaceId: string, data: Record<string, unknown>): void {
  if (data.prUrl) console.log(`PR: ${String(data.prUrl)}`);
  const results = latestCommandResults(ctx.db, projectId, surfaceId, "baseline");
  console.log(`Mốc chuẩn của ${surfaceId}:`);
  if (results.length === 0) console.log("  Khu vực chưa có lệnh nào để chạy");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.command}: ${r.run} (${(r.durationMs / 1000).toFixed(1)} giây)`);
    if (!r.ok) console.log(indent(r.output.split("\n").slice(-15).join("\n")));
  }
  if (data.warning) console.log(`  ! ${String(data.warning)}`);
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
