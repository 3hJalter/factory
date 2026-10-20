import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONFIG_FILE,
  ConfigError,
  MAIN_SURFACE,
  readProjectConfig,
  slugify,
  validSurfaceId,
  validateCommands,
  withImplicitMain,
  type ProjectConfig,
  type SurfaceCommands,
  type SurfaceConfig,
} from "./config.ts";
import type { Db } from "./db.ts";
import { commitAll, defaultRunner, gitInfo, listRepoFiles, mustRun, withWorktree, type GitInfo, type Runner } from "./git.ts";
import { CORE_TASK_KINDS, TASK_STATUSES } from "./model.ts";
import { expandCommand, loadPack, resolveCommands, type Pack } from "./packs.ts";
import type { FactoryPaths } from "./paths.ts";
import { runShell, type ProcessResult, type RunOptions } from "./proc.ts";
import {
  findProjectByPath,
  getProject,
  insertCommandResult,
  insertProject,
  latestOnboarding,
  startOnboarding,
  updateOnboarding,
  updateProject,
  type CommandResultInput,
  type OnboardingRow,
  type ProjectRow,
} from "./projects.ts";
import { scanFiles, walkFiles, type ScanResult } from "./scan.ts";
import { writeScaffold } from "./scaffold.ts";
import { recordEvent } from "./store.ts";

/**
 * Luồng onboarding của lõi (luong-onboarding.md), phạm vi MVP:
 * - Phần A đầy đủ: A1 chọn repo chính, A2 khung nhà máy, A3 tạo repo hoặc mở PR (cổng approve_repo_create), A4 label và bảo vệ main.
 * - Phần B cho khu vực `folder`: B1 kiểu và vị trí, B4 quét, B6 ghi vào dự án, B7 mốc chuẩn, B9 sẵn sàng.
 *
 * Nhà máy không đụng tới thư mục làm việc và nhánh bạn đang mở: mọi sửa đổi trong repo đã có git
 * nằm trên nhánh riêng, viết qua một worktree tạm.
 */

export const ONBOARDING_BRANCH = "factory/onboarding";
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 4000;
const WINDOWS_MAX_PATH = 260;

export type ShellRunner = (commandLine: string, opts: RunOptions) => Promise<ProcessResult>;

export interface OnboardingContext {
  db: Db;
  paths: FactoryPaths;
  run?: Runner;
  shell?: ShellRunner;
  /** Nhận từng dòng tiến độ để đẩy lên giao diện. */
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
}

export type FindingLevel = "block" | "warn" | "info";
export interface Finding {
  level: FindingLevel;
  message: string;
}

export class OnboardingError extends Error {}

export type StartMode = "existing" | "clone" | "new";

/** Thư mục được commit thẳng lên `main` (vừa `git init`) hay qua nhánh `factory/onboarding`. */
type PublishMode = "direct" | "branch" | "none";

export interface ProjectGate {
  gate: "approve_repo_create";
  /** create: tạo repo GitHub mới; pr: đẩy nhánh và mở PR; setup: chỉ tạo label. */
  action: "create" | "pr" | "setup";
  githubRepo: string | null;
  suggestedRepoName: string;
  private: true;
  branch: string;
  files: number;
  totalBytes: number;
  large: ScanResult["large"];
  secrets: ScanResult["secrets"];
}

const runnerOf = (ctx: OnboardingContext) => ctx.run ?? defaultRunner;
const say = (ctx: OnboardingContext, msg: string) => ctx.log?.(msg);

// ───────── A1. Chọn repo chính ─────────

export interface MainRepoInput {
  mode: StartMode;
  path: string;
  url?: string;
}

export interface MainRepoInspection {
  mode: StartMode;
  path: string;
  git?: GitInfo;
  existingConfig?: ProjectConfig;
  suggestedName: string;
  scan?: ScanResult;
  findings: Finding[];
  ok: boolean;
}

export async function inspectMainRepo(ctx: OnboardingContext, input: MainRepoInput): Promise<MainRepoInspection> {
  const run = runnerOf(ctx);
  const findings: Finding[] = [];
  const block = (message: string) => findings.push({ level: "block", message });
  const warn = (message: string) => findings.push({ level: "warn", message });
  const info = (message: string) => findings.push({ level: "info", message });
  const path = input.path.trim();
  const base = { mode: input.mode, path, suggestedName: suggestName(path, input.url) };

  if (!isAbsolute(path)) {
    block("Cần đường dẫn đầy đủ, VD D:\\Projects\\cosplay-run");
    return { ...base, findings, ok: false };
  }
  if (findProjectByPath(ctx.db, path)) block("Thư mục này đã là một dự án của nhà máy");

  if (input.mode === "existing") {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      block("Không thấy thư mục này");
      return { ...base, findings, ok: false };
    }
  } else {
    if (existsSync(path) && (!statSync(path).isDirectory() || readdirSync(path).length > 0)) {
      block("Thư mục đích đã có nội dung; chọn một thư mục mới hoặc thư mục trống");
    }
    if (!existsSync(dirname(path))) block(`Không thấy thư mục cha ${dirname(path)}`);
    if (input.mode === "clone" && !input.url?.trim()) block("Cần URL của repo để clone");
    checkDisk(path, warn);
    await checkGh(run, warn);
    return { ...base, findings, ok: !findings.some((f) => f.level === "block") };
  }

  const git = await gitInfo(run, path);
  let scan: ScanResult | undefined;
  let existingConfig: ProjectConfig | undefined;
  if (!git.isRepo) {
    info("Thư mục chưa có git. Nhà máy sẽ `git init`, commit nguyên trạng thành commit đầu, rồi thêm khung nhà máy ở commit thứ hai");
    scan = scanFiles(path, walkFiles(path));
    if (scan.secrets.length > 0) {
      block(`Có ${scan.secrets.length} file giống secret sẽ vào commit đầu tiên. Chuyển chúng ra ngoài hoặc thêm vào .gitignore trước`);
    }
  } else {
    if (git.root && resolve(git.root) !== resolve(path)) {
      block(`Thư mục nằm trong repo ${git.root}. Chọn gốc repo làm repo chính, rồi thêm thư mục này làm khu vực`);
    }
    if (!git.hasCommits) block("Repo chưa có commit nào. Hãy commit một lần trước");
    if (!git.branch) block("Repo đang ở trạng thái detached HEAD. Hãy checkout một nhánh trước");
    if (git.changes.length > 0) {
      warn(`Có ${git.changes.length} thay đổi chưa commit. Nhà máy làm trên nhánh ${ONBOARDING_BRANCH} qua worktree riêng nên không đụng tới chúng`);
    }
    if (git.remote && !git.githubRepo) warn(`Remote origin không phải GitHub (${git.remote}); nhà máy cần GitHub để mở PR`);
    if (!git.remote) info("Repo chưa có remote. Sau khi bạn duyệt, nhà máy tạo repo private trên GitHub và đẩy lên");
    scan = scanFiles(path, await listRepoFiles(run, path));
    if (scan.secrets.length > 0) warn(`Có ${scan.secrets.length} file giống secret trong repo (xem danh sách bên dưới)`);
    try {
      existingConfig = readProjectConfig(path);
      if (existingConfig) info(`Đã có ${CONFIG_FILE}; nhà máy dùng lại cấu hình này`);
    } catch (err) {
      block(`${CONFIG_FILE} có lỗi: ${(err as Error).message}`);
    }
  }
  if (scan.large.length > 0) warn(`Có ${scan.large.length} file trên 50 MB; GitHub chặn file trên 100 MB nếu không dùng Git LFS`);
  checkPathLength(ctx, scan, warn);
  checkDisk(path, warn);
  await checkGh(run, warn);

  return {
    ...base,
    suggestedName: existingConfig?.name ?? base.suggestedName,
    git,
    ...(existingConfig ? { existingConfig } : {}),
    scan,
    findings,
    ok: !findings.some((f) => f.level === "block"),
  };
}

function suggestName(path: string, url?: string): string {
  const fromUrl = url?.trim().replace(/\.git$/, "").split(/[/:]/).pop();
  const fromPath = path.split(/[\\/]/).filter(Boolean).pop();
  return fromUrl || fromPath || "du-an";
}

function checkDisk(path: string, warn: (m: string) => void): void {
  try {
    let probe = path;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const s = statfsSync(probe);
    const free = s.bavail * s.bsize;
    if (free < 2 * 1024 ** 3) warn(`Ổ đĩa chỉ còn ${(free / 1024 ** 3).toFixed(1)} GB trống`);
  } catch {
    // Không đọc được dung lượng thì bỏ qua.
  }
}

async function checkGh(run: Runner, warn: (m: string) => void): Promise<void> {
  const r = await run("gh", ["auth", "status"]);
  if (r.spawnError) warn("Chưa cài GitHub CLI (gh). Cần gh để tạo repo và mở PR ở bước sau");
  else if (r.code !== 0) warn("gh chưa đăng nhập GitHub. Chạy `gh auth login` trước bước tạo repo");
}

function checkPathLength(ctx: OnboardingContext, scan: ScanResult | undefined, warn: (m: string) => void): void {
  if ((ctx.platform ?? process.platform) !== "win32" || !scan) return;
  const longest = scan.longestPath;
  // Worktree của task nằm ở <gốc worktree>\<dự án>\T-1234\
  const prefix = ctx.paths.worktrees.length + 1 + 40 + 1 + 7;
  if (longest && prefix + longest.length > WINDOWS_MAX_PATH) {
    warn(`Đường dẫn dài nhất (${longest}) sẽ vượt ${WINDOWS_MAX_PATH} ký tự trong worktree; bật long paths của Windows và git (core.longpaths)`);
  }
}

// ───────── A1 + A2. Tạo dự án ─────────

export interface CreateProjectInput extends MainRepoInput {
  name: string;
  mainCommands?: SurfaceCommands;
}

export async function createProject(ctx: OnboardingContext, input: CreateProjectInput): Promise<{ project: ProjectRow; onboarding: OnboardingRow }> {
  const run = runnerOf(ctx);
  const name = input.name.trim();
  if (!name) throw new OnboardingError("Cần tên dự án");
  const id = uniqueProjectId(ctx.db, slugify(name));
  const mainCommands = input.mainCommands ? validateCommands(input.mainCommands, "Khu vực `main`") : undefined;

  const inspection = await inspectMainRepo(ctx, input);
  const blocker = inspection.findings.find((f) => f.level === "block");
  if (blocker) throw new OnboardingError(blocker.message);
  const path = resolve(input.path);

  say(ctx, "A1: chuẩn bị repo chính");
  if (input.mode === "new") {
    mkdirSync(path, { recursive: true });
    await mustRun(run, "git", ["init", "-q", "-b", "main"], { cwd: path });
  } else if (input.mode === "clone") {
    say(ctx, `Đang clone ${input.url}`);
    await mustRun(run, "git", ["clone", "-q", input.url!.trim(), path], { timeoutMs: 30 * 60_000 });
  } else if (!inspection.git?.isRepo) {
    await mustRun(run, "git", ["init", "-q", "-b", "main"], { cwd: path });
    if (readdirSync(path).some((f) => f !== ".git")) {
      say(ctx, "Commit 1: trạng thái ban đầu");
      await commitAll(run, path, "Trạng thái ban đầu");
    }
  }

  const git = await gitInfo(run, path);
  const baseBranch = git.branch ?? "main";
  const existing = readProjectConfig(path);
  const config: ProjectConfig = existing ?? { name, ...(mainCommands ? { main: { commands: mainCommands } } : {}), surfaces: [] };
  if (existing && mainCommands) config.main = { commands: mainCommands };

  say(ctx, "A2: thêm khung nhà máy");
  const freshInit = input.mode === "new" || (input.mode === "existing" && !inspection.git?.isRepo);
  const publishMode = await writeProjectFiles(ctx, { id, repoPath: path, baseBranch, config, direct: freshInit });

  insertProject(ctx.db, { id, name: config.name, repoPath: path, githubRepo: git.githubRepo ?? null, baseBranch, config });
  const scan = scanFiles(path, await listRepoFiles(run, path));
  const gate: ProjectGate = {
    gate: "approve_repo_create",
    action: !git.remote ? "create" : publishMode === "branch" ? "pr" : "setup",
    githubRepo: git.githubRepo ?? null,
    suggestedRepoName: id,
    private: true,
    branch: publishMode === "direct" ? baseBranch : ONBOARDING_BRANCH,
    files: scan.files,
    totalBytes: scan.totalBytes,
    large: scan.large,
    secrets: scan.secrets,
  };
  startOnboarding(ctx.db, {
    projectId: id,
    step: "A3",
    status: "waiting_you",
    data: { mode: input.mode, publishMode, gate, findings: inspection.findings },
  });
  recordEvent(ctx.db, { type: "project.created", projectId: id, payload: { mode: input.mode, publishMode } });
  say(ctx, "A3: chờ bạn duyệt tạo repo hoặc mở PR");
  return { project: getProject(ctx.db, id)!, onboarding: latestOnboarding(ctx.db, id)! };
}

function uniqueProjectId(db: Db, base: string): string {
  let id = base;
  for (let i = 2; getProject(db, id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * Ghi khung nhà máy (A2) hoặc cập nhật cấu hình (B6) vào repo chính.
 * - Repo vừa `git init` bởi nhà máy và chưa đẩy lên: commit thẳng lên nhánh đang mở.
 * - Repo đã có: commit trên nhánh `branch` (mặc định `factory/onboarding`) qua worktree tạm.
 */
async function writeProjectFiles(
  ctx: OnboardingContext,
  o: { id: string; repoPath: string; baseBranch: string; config: ProjectConfig; branch?: string; base?: string; direct?: boolean; message?: string },
): Promise<PublishMode> {
  const run = runnerOf(ctx);
  const message = o.message ?? "factory onboarding";
  if (o.direct) {
    writeScaffold(o.repoPath, { config: o.config });
    return (await commitAll(run, o.repoPath, message)) ? "direct" : "none";
  }
  const branch = o.branch ?? ONBOARDING_BRANCH;
  const wt = join(ctx.paths.worktrees, o.id, worktreeName(branch));
  mkdirSync(dirname(wt), { recursive: true });
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  const committed = await withWorktree(run, o.repoPath, wt, { branch, base: o.base ?? o.baseBranch }, async (dir) => {
    writeScaffold(dir, { config: o.config });
    return commitAll(run, dir, message);
  });
  if (!committed) {
    // Không có gì mới: bỏ nhánh rỗng nếu nó không đi trước nhánh gốc.
    const ahead = await run("git", ["rev-list", "--count", `${o.base ?? o.baseBranch}..${branch}`], { cwd: o.repoPath });
    if (ahead.code === 0 && ahead.stdout.trim() === "0") await run("git", ["branch", "-D", branch], { cwd: o.repoPath });
    return ahead.stdout.trim() === "0" ? "none" : "branch";
  }
  return "branch";
}

const worktreeName = (branch: string) => branch.replace(/[^a-zA-Z0-9-]+/g, "-");

// ───────── A3 + A4. Lên GitHub ─────────

export interface PublishInput {
  /** Tên repo khi tạo mới: `ten` hoặc `owner/ten`. */
  repoName?: string;
}

export async function publishProject(ctx: OnboardingContext, projectId: string, input: PublishInput = {}): Promise<OnboardingRow> {
  const run = runnerOf(ctx);
  const project = mustProject(ctx.db, projectId);
  const onboarding = latestOnboarding(ctx.db, projectId);
  if (!onboarding || onboarding.step !== "A3" || onboarding.status !== "waiting_you") {
    throw new OnboardingError("Dự án không có bước tạo repo nào đang chờ duyệt");
  }
  const gate = onboarding.data.gate as ProjectGate;
  const publishMode = onboarding.data.publishMode as PublishMode;
  updateOnboarding(ctx.db, onboarding.id, { status: "running", error: null });
  recordEvent(ctx.db, { type: "gate.approved", projectId, payload: { gate: gate.gate, action: gate.action } });

  try {
    const auth = await run("gh", ["auth", "status"]);
    if (auth.spawnError || auth.code !== 0) throw new OnboardingError("gh chưa cài hoặc chưa đăng nhập. Chạy `gh auth login` rồi duyệt lại");
    const base = project.baseBranch ?? "main";
    let githubRepo = project.githubRepo;
    let prUrl: string | undefined;

    if (gate.action === "create") {
      const name = (input.repoName ?? gate.suggestedRepoName).trim();
      if (!/^([A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/.test(name)) throw new OnboardingError(`Tên repo không hợp lệ: ${name}`);
      say(ctx, `A3: tạo repo private ${name} trên GitHub`);
      await mustRun(run, "gh", ["repo", "create", name, "--private", "--source", project.repoPath, "--remote", "origin"], { cwd: project.repoPath });
      githubRepo = (await gitInfo(run, project.repoPath)).githubRepo ?? null;
      say(ctx, `Đẩy nhánh ${base}`);
      await mustRun(run, "git", ["push", "-u", "origin", base], { cwd: project.repoPath, timeoutMs: 30 * 60_000 });
    }
    if (publishMode === "branch") {
      say(ctx, `Đẩy nhánh ${ONBOARDING_BRANCH} và mở PR`);
      await mustRun(run, "git", ["push", "-u", "origin", ONBOARDING_BRANCH], { cwd: project.repoPath, timeoutMs: 30 * 60_000 });
      prUrl = await openPr(run, project.repoPath, githubRepo!, {
        base,
        head: ONBOARDING_BRANCH,
        title: "factory onboarding",
        body: "Thêm khung nhà máy: `.factory/project.yaml`, AGENTS.md, CLAUDE.md, GLOSSARY.md, mẫu Issue báo lỗi.\n\nMở bởi nhà máy sau khi bạn duyệt.",
      });
    }
    if (!githubRepo) throw new OnboardingError("Không xác định được repo GitHub của dự án");
    updateProject(ctx.db, projectId, { githubRepo });

    updateOnboarding(ctx.db, onboarding.id, { step: "A4", data: { githubRepo, ...(prUrl ? { prUrl } : {}) } });
    const warnings = await setupGithub(ctx, githubRepo, base, project.config);
    const done = updateOnboarding(ctx.db, onboarding.id, { step: "A4", status: "done", data: { warnings } });
    recordEvent(ctx.db, { type: "project.published", projectId, payload: { githubRepo, prUrl } });
    say(ctx, "Xong phần tạo dự án");
    return done;
  } catch (err) {
    updateOnboarding(ctx.db, onboarding.id, { status: "waiting_you", error: (err as Error).message });
    throw err;
  }
}

async function openPr(run: Runner, cwd: string, repo: string, pr: { base: string; head: string; title: string; body: string }): Promise<string> {
  const existing = await run("gh", ["pr", "view", pr.head, "--repo", repo, "--json", "url,state", "-q", "select(.state == \"OPEN\") | .url"], { cwd });
  if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
  const out = await mustRun(run, "gh", ["pr", "create", "--repo", repo, "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body", pr.body], { cwd });
  return out.trim().split("\n").pop() ?? "";
}

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** Bộ label chuẩn trên repo chính (luong-onboarding.md A4, may-trang-thai-ticket.md mục 8). */
export function standardLabels(config: ProjectConfig): LabelSpec[] {
  const kinds = [...CORE_TASK_KINDS.map((k) => ({ key: k.key, name: k.name })), ...(config.task_kinds?.add ?? [])];
  return [
    ...kinds.map((k) => ({ name: `kind:${k.key}`, color: "1F4FBF", description: `Loại task: ${k.name}` })),
    ...TASK_STATUSES.map((s) => ({ name: `status:${s}`, color: "D9D6CE", description: "Trạng thái task, do nhà máy đặt" })),
    ...withImplicitMain(config).map((s) => surfaceLabel(s.id)),
    { name: "ready-for-agent", color: "4CC27A", description: "Agent làm được" },
    { name: "ready-for-human", color: "E5A33A", description: "Cần người làm" },
    { name: "bug", color: "D73A4A", description: "Báo lỗi, thành task sửa lỗi" },
  ];
}

export const surfaceLabel = (id: string): LabelSpec => ({ name: `surface:${id}`, color: "8A8F96", description: `Khu vực ${id}` });

async function createLabels(run: Runner, repo: string, labels: LabelSpec[]): Promise<string[]> {
  const failed: string[] = [];
  for (const l of labels) {
    const r = await run("gh", ["label", "create", l.name, "--repo", repo, "--color", l.color, "--description", l.description, "--force"]);
    if (r.code !== 0) failed.push(l.name);
  }
  return failed;
}

async function setupGithub(ctx: OnboardingContext, repo: string, base: string, config: ProjectConfig): Promise<string[]> {
  const run = runnerOf(ctx);
  const warnings: string[] = [];
  say(ctx, "A4: tạo label");
  const failed = await createLabels(run, repo, standardLabels(config));
  if (failed.length > 0) warnings.push(`Không tạo được ${failed.length} label: ${failed.slice(0, 5).join(", ")}`);

  say(ctx, `A4: bảo vệ nhánh ${base}`);
  const protection = JSON.stringify({
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0 },
    restrictions: null,
  });
  const p = await run("gh", ["api", "-X", "PUT", `repos/${repo}/branches/${base}/protection`, "--input", "-"], { input: protection });
  if (p.code !== 0) {
    warnings.push(
      /upgrade|Pro|plan/i.test(p.stderr + p.stdout)
        ? `GitHub chỉ bảo vệ nhánh của repo private với gói trả phí; nhánh ${base} chưa được bảo vệ`
        : `Không bảo vệ được nhánh ${base}: ${(p.stderr || p.stdout).trim().split("\n")[0]}`,
    );
  }
  const m = await run("gh", ["api", "-X", "PATCH", `repos/${repo}`, "-F", "allow_squash_merge=true", "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false"]);
  if (m.code !== 0) warnings.push("Không đặt được squash làm cách merge mặc định");
  return warnings;
}

// ───────── Phần B. Thêm khu vực ─────────

export interface SurfaceInput {
  id: string;
  location: string;
  pack?: string;
  commands?: SurfaceCommands;
}

export interface SurfaceInspection {
  id: string;
  location: string;
  absolutePath: string;
  repoRoot?: string;
  inMainRepo: boolean;
  scan?: ScanResult;
  pack?: Pick<Pack, "name" | "version" | "description">;
  findings: Finding[];
  ok: boolean;
}

/** B1 + B4: kiểm vị trí và quét hiện trạng, chưa ghi gì. */
export async function inspectSurface(ctx: OnboardingContext, projectId: string, input: SurfaceInput): Promise<SurfaceInspection> {
  const run = runnerOf(ctx);
  const project = mustProject(ctx.db, projectId);
  const findings: Finding[] = [];
  const block = (message: string) => findings.push({ level: "block", message });
  const warn = (message: string) => findings.push({ level: "warn", message });
  const id = input.id.trim();

  if (!validSurfaceId(id)) block("Id khu vực chỉ gồm chữ thường, số và dấu gạch ngang, bắt đầu bằng chữ, tối đa 30 ký tự");
  if (id === MAIN_SURFACE || project.config.surfaces.some((s) => s.id === id)) block(`Dự án đã có khu vực \`${id}\``);

  const absolutePath = resolve(project.repoPath, input.location.trim() || ".");
  const location = toConfigLocation(project.repoPath, absolutePath);
  const base = { id, location, absolutePath, inMainRepo: isInside(project.repoPath, absolutePath) };
  if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    block(`Không thấy thư mục ${absolutePath}`);
    return { ...base, findings, ok: false };
  }
  if (resolve(absolutePath) === resolve(project.repoPath)) block("Gốc repo chính đã là khu vực `main`");
  const taken = project.config.surfaces.find((s) => resolve(project.repoPath, s.location) === absolutePath);
  if (taken) block(`Thư mục này đã là khu vực \`${taken.id}\``);

  let pack: Pack | undefined;
  if (input.pack) {
    try {
      pack = loadPack(ctx.paths.packs, input.pack);
      if (pack.surfaceKind !== "folder") block(`Pack \`${pack.name}\` dành cho khu vực kiểu ${pack.surfaceKind}`);
    } catch (err) {
      block((err as Error).message);
    }
  }
  try {
    if (input.commands) validateCommands(input.commands, "Lệnh");
  } catch (err) {
    if (err instanceof ConfigError) block(err.message);
    else throw err;
  }
  const commands = resolveCommands({ ...(input.pack ? { pack: input.pack } : {}), ...(input.commands ? { commands: input.commands } : {}) }, pack);
  if (!commands.check && !commands.test) warn("Chưa có lệnh kiểm hay lệnh test; nhà máy sẽ không kiểm được việc agent làm ở khu vực này");

  const git = await gitInfo(run, absolutePath);
  let scan: ScanResult | undefined;
  if (!git.isRepo) {
    block("Thư mục không nằm trong repo git nào. Với MVP, khu vực phải nằm trong repo chính hoặc một repo git khác");
  } else {
    if (!base.inMainRepo) warn(`Khu vực nằm ở repo khác (${git.root}); PR của task sẽ mở ở repo đó`);
    if (git.changes.length > 0) warn(`Repo chứa khu vực có ${git.changes.length} thay đổi chưa commit; mốc chuẩn chạy trên bản đã commit`);
    const rel = relative(git.root!, absolutePath).split(sep).join("/");
    const files = (await listRepoFiles(run, git.root!)).filter((f) => rel === "" || f === rel || f.startsWith(`${rel}/`));
    scan = scanFiles(git.root!, files);
    if (scan.files === 0) warn("Thư mục chưa có file nào được git theo dõi");
    if (scan.secrets.length > 0) warn(`Có ${scan.secrets.length} file giống secret trong khu vực`);
    if (scan.large.length > 0) warn(`Có ${scan.large.length} file trên 50 MB`);
  }
  return {
    ...base,
    ...(git.root ? { repoRoot: git.root } : {}),
    ...(scan ? { scan } : {}),
    ...(pack ? { pack: { name: pack.name, version: pack.version, ...(pack.description ? { description: pack.description } : {}) } } : {}),
    findings,
    ok: !findings.some((f) => f.level === "block"),
  };
}

function toConfigLocation(repoPath: string, abs: string): string {
  const rel = relative(repoPath, abs).split(sep).join("/");
  return rel === "" ? "." : isInside(repoPath, abs) ? `${rel}/` : rel;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** B1 → B9 cho khu vực `folder`: kiểm, ghi vào dự án, chạy mốc chuẩn, đánh dấu sẵn sàng. */
export async function addSurface(ctx: OnboardingContext, projectId: string, input: SurfaceInput): Promise<OnboardingRow> {
  const run = runnerOf(ctx);
  const inspection = await inspectSurface(ctx, projectId, input);
  const blocker = inspection.findings.find((f) => f.level === "block");
  if (blocker) throw new OnboardingError(blocker.message);
  const project = mustProject(ctx.db, projectId);

  const surface: SurfaceConfig = {
    id: inspection.id,
    kind: "folder",
    location: inspection.location,
    ...(input.pack ? { pack: input.pack } : {}),
    ...(input.commands && Object.keys(validateCommands(input.commands, "Lệnh")).length > 0 ? { commands: validateCommands(input.commands, "Lệnh") } : {}),
  };
  const onboardingId = startOnboarding(ctx.db, {
    projectId,
    surfaceId: surface.id,
    step: "B6",
    data: { location: surface.location, findings: inspection.findings, scan: summarizeScan(inspection.scan), ...(inspection.pack ? { pack: inspection.pack } : {}) },
  });

  try {
    say(ctx, `B6: ghi khu vực ${surface.id} vào dự án`);
    const config: ProjectConfig = { ...project.config, surfaces: [...project.config.surfaces, surface] };
    const result = await writeSurfaceConfig(ctx, project, config, surface.id);
    updateProject(ctx.db, projectId, { config });
    if (project.githubRepo) {
      const r = await run("gh", ["label", "create", surfaceLabel(surface.id).name, "--repo", project.githubRepo, "--color", "8A8F96", "--description", `Khu vực ${surface.id}`, "--force"]);
      if (r.code !== 0) say(ctx, "Không tạo được label của khu vực (sẽ thử lại khi đồng bộ Issues)");
    }
    updateOnboarding(ctx.db, onboardingId, { step: "B7", data: result });
    recordEvent(ctx.db, { type: "surface.added", projectId, payload: { surfaceId: surface.id, ...result } });
  } catch (err) {
    updateOnboarding(ctx.db, onboardingId, { status: "failed", error: (err as Error).message });
    throw err;
  }
  return runBaseline(ctx, projectId, surface.id, onboardingId);
}

/**
 * Nơi ghi cấu hình khi thêm khu vực:
 * - Phần A chưa xong: gộp vào commit onboarding (nhánh `factory/onboarding`, hoặc nhánh chính nếu nhà máy vừa `git init`).
 * - Phần A đã xong: nhánh `factory/surface-<id>` từ nhánh chính, đẩy lên và mở PR.
 */
async function writeSurfaceConfig(
  ctx: OnboardingContext,
  project: ProjectRow,
  config: ProjectConfig,
  surfaceId: string,
): Promise<{ branch: string; prUrl?: string }> {
  const run = runnerOf(ctx);
  const partA = latestOnboarding(ctx.db, project.id);
  const base = project.baseBranch ?? "main";
  const message = `factory: thêm khu vực ${surfaceId}`;

  if (partA && partA.status !== "done") {
    const publishMode = partA.data.publishMode as PublishMode;
    if (publishMode === "direct") {
      await writeProjectFiles(ctx, { id: project.id, repoPath: project.repoPath, baseBranch: base, config, direct: true, message });
      return { branch: base };
    }
    const mode = await writeProjectFiles(ctx, { id: project.id, repoPath: project.repoPath, baseBranch: base, config, message });
    if (mode === "branch" && publishMode !== "branch") {
      const gate = { ...(partA.data.gate as ProjectGate) };
      if (gate.action === "setup") gate.action = "pr";
      gate.branch = ONBOARDING_BRANCH;
      updateOnboarding(ctx.db, partA.id, { data: { publishMode: "branch", gate } });
    }
    return { branch: ONBOARDING_BRANCH };
  }

  const branch = `factory/surface-${surfaceId}`;
  await run("git", ["fetch", "-q", "origin", base], { cwd: project.repoPath, timeoutMs: 5 * 60_000 });
  const remoteBase = (await run("git", ["rev-parse", "-q", "--verify", `origin/${base}`], { cwd: project.repoPath })).code === 0 ? `origin/${base}` : base;
  const mode = await writeProjectFiles(ctx, { id: project.id, repoPath: project.repoPath, baseBranch: base, base: remoteBase, config, branch, message });
  if (mode !== "branch" || !project.githubRepo) return { branch };
  await mustRun(run, "git", ["push", "-u", "origin", branch], { cwd: project.repoPath, timeoutMs: 10 * 60_000 });
  const prUrl = await openPr(run, project.repoPath, project.githubRepo, {
    base,
    head: branch,
    title: `factory: thêm khu vực ${surfaceId}`,
    body: `Thêm khu vực \`${surfaceId}\` vào \`.factory/project.yaml\` và cập nhật AGENTS.md.\n\nMở bởi nhà máy.`,
  });
  return { branch, prUrl };
}

function summarizeScan(scan: ScanResult | undefined) {
  if (!scan) return undefined;
  return { files: scan.files, totalBytes: scan.totalBytes, hasTests: scan.hasTests, hasCi: scan.hasCi, topExtensions: scan.topExtensions, large: scan.large, secrets: scan.secrets };
}

// ───────── B7. Mốc chuẩn ─────────

export interface CommandRun {
  command: "provision" | "check" | "test";
  run: string;
  ok: boolean;
  skipped?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/**
 * Chạy `provision` → `check` → `test` của khu vực trên một worktree mới từ nhánh chính
 * (luong-onboarding.md B7). Không bao giờ chạy `build`.
 */
export async function runBaseline(ctx: OnboardingContext, projectId: string, surfaceId: string, onboardingId?: number): Promise<OnboardingRow> {
  const run = runnerOf(ctx);
  const project = mustProject(ctx.db, projectId);
  const surface = withImplicitMain(project.config).find((s) => s.id === surfaceId);
  if (!surface) throw new OnboardingError(`Không có khu vực ${surfaceId}`);
  const id = onboardingId ?? startOnboarding(ctx.db, { projectId, surfaceId, step: "B7" });
  updateOnboarding(ctx.db, id, { step: "B7", status: "running", error: null });

  const absolutePath = resolve(project.repoPath, surface.location);
  const git = await gitInfo(run, absolutePath);
  if (!git.isRepo) {
    const failed = updateOnboarding(ctx.db, id, { status: "failed", error: "Khu vực không nằm trong repo git" });
    return failed;
  }
  const repoRoot = git.root!;
  const ref = resolve(repoRoot) === resolve(project.repoPath) ? (project.baseBranch ?? "HEAD") : (git.branch ?? "HEAD");
  const wt = join(ctx.paths.worktrees, project.id, `baseline-${surfaceId}`);
  const out = join(ctx.paths.runs, project.id, `baseline-${surfaceId}`);
  mkdirSync(dirname(wt), { recursive: true });
  mkdirSync(out, { recursive: true });
  if (existsSync(wt)) {
    await run("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot });
    rmSync(wt, { recursive: true, force: true });
  }

  const pack = surface.pack ? loadPack(ctx.paths.packs, surface.pack) : undefined;
  const commands = resolveCommands(surface, pack);
  const results: CommandRun[] = [];
  say(ctx, `B7: dựng worktree mốc chuẩn từ ${ref}`);
  try {
    await run("git", ["worktree", "prune"], { cwd: repoRoot });
    await mustRun(run, "git", ["worktree", "add", "--detach", wt, ref], { cwd: repoRoot });
    const cwd = join(wt, relative(repoRoot, absolutePath));
    let stop = false;
    for (const key of ["provision", "check", "test"] as const) {
      const c = commands[key];
      if (!c) continue;
      const line = expandCommand(c.run, { worktree: wt, out });
      if (stop) {
        results.push({ command: key, run: line, ok: false, skipped: true, exitCode: null, timedOut: false, durationMs: 0, output: "Bỏ qua vì bước chuẩn bị hỏng" });
        continue;
      }
      say(ctx, `B7: chạy ${key}: ${line}`);
      const r = await runSurfaceCommand(ctx, line, cwd, c.timeoutMs);
      const result: CommandRun = { command: key, ...r };
      results.push(result);
      record(ctx.db, { projectId, surfaceId, purpose: "baseline", command: key, ...r });
      say(ctx, `${key}: ${r.ok ? "đạt" : r.timedOut ? "quá giờ" : `hỏng (mã ${r.exitCode})`} sau ${(r.durationMs / 1000).toFixed(1)} giây`);
      if (key === "provision" && !r.ok) stop = true;
    }
  } catch (err) {
    updateOnboarding(ctx.db, id, { status: "failed", error: (err as Error).message, data: { baseline: results } });
    throw err;
  } finally {
    await run("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot });
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  }

  const ok = results.every((r) => r.ok);
  const done = updateOnboarding(ctx.db, id, {
    step: "B9",
    status: "done",
    data: {
      baseline: results.map(({ output: _o, ...r }) => r),
      baselineOk: ok,
      ...(ok ? {} : { warning: "Mốc chuẩn có lệnh hỏng; khu vực vẫn nhận task, lỗi sẵn có không bị tính cho agent" }),
    },
  });
  recordEvent(ctx.db, { type: "surface.baseline", projectId, payload: { surfaceId, ok } });
  say(ctx, `B9: khu vực ${surfaceId} sẵn sàng nhận task`);
  return done;
}

async function runSurfaceCommand(
  ctx: OnboardingContext,
  line: string,
  cwd: string,
  timeoutMs?: number,
): Promise<Omit<CommandRun, "command">> {
  const shell = ctx.shell ?? runShell;
  const r = await shell(line, { cwd, timeoutMs: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS });
  const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return {
    run: line,
    ok: r.code === 0 && !r.timedOut,
    exitCode: r.code,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    output: r.spawnError ? r.spawnError.message : output.slice(-OUTPUT_TAIL),
  };
}

function record(db: Db, r: Omit<CommandResultInput, "output" | "exitCode" | "timedOut" | "durationMs" | "ok" | "run"> & Omit<CommandRun, "command" | "skipped">): void {
  insertCommandResult(db, {
    projectId: r.projectId,
    surfaceId: r.surfaceId,
    purpose: r.purpose,
    command: r.command,
    run: r.run,
    ok: r.ok,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    output: r.output,
  });
}

// ───────── Kiểm từng khu vực (factory doctor --project) ─────────

export interface SurfaceCheck {
  surfaceId: string;
  location: string;
  result?: Omit<CommandRun, "command">;
  /** Không có lệnh kiểm. */
  missing?: boolean;
}

/** Chạy lệnh `check` của từng khu vực ngay tại thư mục của nó (không dựng worktree). */
export async function checkSurfaces(ctx: OnboardingContext, projectId: string, only?: string[]): Promise<SurfaceCheck[]> {
  const project = mustProject(ctx.db, projectId);
  const checks: SurfaceCheck[] = [];
  for (const s of withImplicitMain(project.config)) {
    if (only && only.length > 0 && !only.includes(s.id)) continue;
    const cwd = resolve(project.repoPath, s.location);
    let pack: Pack | undefined;
    try {
      pack = s.pack ? loadPack(ctx.paths.packs, s.pack) : undefined;
    } catch (err) {
      checks.push({ surfaceId: s.id, location: s.location, result: { run: "", ok: false, exitCode: null, timedOut: false, durationMs: 0, output: (err as Error).message } });
      continue;
    }
    const check = resolveCommands(s, pack).check;
    if (!check) {
      checks.push({ surfaceId: s.id, location: s.location, missing: true });
      continue;
    }
    const outDir = join(ctx.paths.runs, project.id, `doctor-${s.id}`);
    mkdirSync(outDir, { recursive: true });
    const line = expandCommand(check.run, { worktree: resolve(project.repoPath), out: outDir });
    say(ctx, `Kiểm ${s.id}: ${line}`);
    const result = await runSurfaceCommand(ctx, line, cwd, check.timeoutMs);
    record(ctx.db, { projectId, surfaceId: s.id, purpose: "doctor", command: "check", ...result });
    checks.push({ surfaceId: s.id, location: s.location, result });
  }
  return checks;
}

/**
 * Đọc lại `.factory/project.yaml` từ thư mục repo sau khi bạn sửa tay (đổi lệnh, thêm khu vực).
 * Trả về undefined nếu bản trong thư mục chưa có file (ví dụ PR onboarding chưa merge).
 */
export function reloadProjectConfig(ctx: OnboardingContext, projectId: string): ProjectConfig | undefined {
  const project = mustProject(ctx.db, projectId);
  const config = readProjectConfig(project.repoPath);
  if (!config) return undefined;
  updateProject(ctx.db, projectId, { config });
  say(ctx, `Đọc lại ${CONFIG_FILE}: ${config.surfaces.length} khu vực`);
  return config;
}

function mustProject(db: Db, id: string): ProjectRow {
  const p = getProject(db, id);
  if (!p) throw new OnboardingError(`Không có dự án ${id}`);
  return p;
}
