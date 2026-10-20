import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRunner, factoryPaths, openDb, type FactoryPaths, type Runner } from "../src/index.ts";

// Commit trong test cần danh tính git, không phụ thuộc cấu hình máy.
process.env.GIT_AUTHOR_NAME = "Factory Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "Factory Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const node = `"${process.execPath}"`;

export function tempDir(prefix = "factory-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await defaultRunner("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Repo git có một commit và remote origin là một bare repo cục bộ. */
export async function repoWithRemote(files: Record<string, string> = { "README.md": "# Thử\n" }): Promise<{ repo: string; bare: string }> {
  const root = tempDir();
  const bare = join(root, "remote.git");
  const repo = join(root, "repo");
  await defaultRunner("git", ["init", "-q", "--bare", "-b", "main", bare]);
  mkdirSync(repo);
  await git(repo, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "remote", "add", "origin", bare);
  await git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, bare };
}

export interface FakeGh {
  run: Runner;
  calls: string[][];
}

/**
 * Chạy git thật, giả `gh`: ghi lại lời gọi, `repo create` thêm remote là một bare repo cục bộ,
 * và `git remote get-url` trả về URL GitHub giả để nhà máy nhận ra owner/name.
 */
export function fakeGh(opts: { owner?: string; loggedIn?: boolean; failProtection?: boolean } = {}): FakeGh {
  const calls: string[][] = [];
  const owner = opts.owner ?? "me";
  const ok = (stdout = "") => ({ code: 0, signal: null, timedOut: false, cancelled: false, stdout, stderr: "", durationMs: 1, cleanedUp: 0 });
  const fail = (stderr: string) => ({ ...ok(), code: 1, stderr });
  const run: Runner = async (command, args, o) => {
    if (command === "gh") {
      calls.push(args);
      if (args[0] === "auth") return opts.loggedIn === false ? fail("not logged in") : ok("Logged in");
      if (args[0] === "repo" && args[1] === "create") {
        const name = args[2]!.includes("/") ? args[2]!.split("/")[1]! : args[2]!;
        const source = args[args.indexOf("--source") + 1]!;
        const bare = join(tempDir("factory-gh-"), `${name}.git`);
        await defaultRunner("git", ["init", "-q", "--bare", "-b", "main", bare]);
        await git(source, "remote", "add", "origin", bare);
        return ok(`https://github.com/${owner}/${name}\n`);
      }
      if (args[0] === "pr" && args[1] === "view") return fail("no pull requests found");
      if (args[0] === "pr" && args[1] === "create") return ok(`https://github.com/${owner}/x/pull/1\n`);
      if (args[0] === "api" && args.includes("PUT") && opts.failProtection) return fail("Upgrade to GitHub Pro or make this repository public");
      return ok();
    }
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      const r = await defaultRunner(command, args, o);
      if (r.code !== 0) return r;
      const name = r.stdout.trim().split(/[\\/]/).pop()!.replace(/\.git$/, "");
      return { ...r, stdout: `https://github.com/${owner}/${name}.git\n` };
    }
    return defaultRunner(command, args, o);
  };
  return { run, calls };
}

export function context(run: Runner): { db: ReturnType<typeof openDb>; paths: FactoryPaths; run: Runner; log: (m: string) => void; logs: string[] } {
  const home = tempDir("factory-home-");
  const paths = factoryPaths(home, { FACTORY_WORKTREES: join(home, "wt"), FACTORY_PACKS: join(home, "packs") });
  const logs: string[] = [];
  return { db: openDb(":memory:"), paths, run, log: (m) => logs.push(m), logs };
}
