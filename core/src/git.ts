import { runProcess, type ProcessResult } from "./proc.ts";

/** Chạy lệnh ngoài; tách ra để test thay được (VD giả `gh`). */
export type Runner = (command: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<ProcessResult>;

export const defaultRunner: Runner = (command, args, opts = {}) => runProcess(command, args, { timeoutMs: 120_000, ...opts });

export class CommandError extends Error {
  readonly result: ProcessResult;
  constructor(message: string, result: ProcessResult) {
    super(message);
    this.result = result;
  }
}

/** Chạy và ném lỗi kèm stderr khi mã thoát khác 0. */
export async function mustRun(run: Runner, command: string, args: string[], opts?: Parameters<Runner>[2]): Promise<string> {
  const r = await run(command, args, opts);
  if (r.spawnError) throw new CommandError(`Không chạy được ${command}: ${r.spawnError.message}`, r);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n");
    throw new CommandError(`${command} ${args.slice(0, 3).join(" ")} lỗi (mã ${r.code}): ${detail}`, r);
  }
  return r.stdout;
}

export interface GitInfo {
  isRepo: boolean;
  /** Gốc repo chứa thư mục đã hỏi. */
  root?: string;
  branch?: string;
  /** URL remote `origin`. */
  remote?: string;
  /** owner/name nếu remote là GitHub. */
  githubRepo?: string;
  /** Các dòng `git status --porcelain`. */
  changes: string[];
  hasCommits: boolean;
}

export async function gitInfo(run: Runner, dir: string): Promise<GitInfo> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
  if (top.code !== 0) return { isRepo: false, changes: [], hasCommits: false };
  const root = top.stdout.trim();
  const [branch, remote, status, head] = await Promise.all([
    run("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root }),
    run("git", ["remote", "get-url", "origin"], { cwd: root }),
    run("git", ["status", "--porcelain"], { cwd: root }),
    run("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: root }),
  ]);
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() : undefined;
  return {
    isRepo: true,
    root,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    remote: remoteUrl,
    githubRepo: remoteUrl ? parseGithubRepo(remoteUrl) : undefined,
    changes: status.stdout.split("\n").filter((l) => l.trim() !== ""),
    hasCommits: head.code === 0,
  };
}

/** `https://github.com/a/b.git`, `git@github.com:a/b.git` → `a/b`. */
export function parseGithubRepo(url: string): string | undefined {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export async function branchExists(run: Runner, repo: string, branch: string): Promise<boolean> {
  const r = await run("git", ["show-ref", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo });
  return r.code === 0;
}

/** Nội dung một file ở một ref, hoặc undefined nếu không có. */
export async function showFile(run: Runner, repo: string, ref: string, path: string): Promise<string | undefined> {
  const r = await run("git", ["show", `${ref}:${path}`], { cwd: repo });
  return r.code === 0 ? r.stdout : undefined;
}

/** Danh sách file sẽ được commit (đã theo dõi + chưa theo dõi, bỏ qua theo .gitignore). */
export async function listRepoFiles(run: Runner, repo: string): Promise<string[]> {
  const out = await mustRun(run, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo });
  return [...new Set(out.split("\0").filter(Boolean))];
}

/**
 * Tạo worktree tạm trên một nhánh, chạy `fn` trong đó, rồi gỡ worktree.
 * Nhờ vậy nhà máy không đụng tới thư mục làm việc và nhánh đang mở của bạn.
 */
export async function withWorktree<T>(
  run: Runner,
  repo: string,
  path: string,
  opts: { branch: string; base: string },
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await run("git", ["worktree", "prune"], { cwd: repo });
  const exists = await branchExists(run, repo, opts.branch);
  const args = exists ? ["worktree", "add", path, opts.branch] : ["worktree", "add", "-b", opts.branch, path, opts.base];
  await mustRun(run, "git", args, { cwd: repo });
  try {
    return await fn(path);
  } finally {
    await run("git", ["worktree", "remove", "--force", path], { cwd: repo });
  }
}

/** `git add -A` rồi commit nếu có thay đổi. Trả về true nếu đã tạo commit. */
export async function commitAll(run: Runner, dir: string, message: string): Promise<boolean> {
  await mustRun(run, "git", ["add", "-A"], { cwd: dir });
  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: dir });
  if (staged.code === 0) return false;
  await mustRun(run, "git", ["commit", "-q", "-m", message], { cwd: dir });
  return true;
}
