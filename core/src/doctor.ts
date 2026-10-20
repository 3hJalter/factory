import { runProcess, type ProcessResult } from "./proc.ts";

export type CheckStatus = "ok" | "warn" | "missing" | "error";

export interface CheckResult {
  id: string;
  name: string;
  required: boolean;
  status: CheckStatus;
  version?: string;
  /** Một câu cho biết đang thế nào. */
  detail: string;
  /** Cách sửa khi chưa ổn. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checkedAt: string;
  checks: CheckResult[];
}

/** Hàm chạy lệnh có thể thay khi test. */
export type Exec = (command: string, args: string[]) => Promise<ProcessResult>;

const defaultExec: Exec = (command, args) => runProcess(command, args, { timeoutMs: 15_000 });

const MIN_NODE = [22, 18, 0] as const;

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

export function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const notInstalled = (r: ProcessResult) => r.spawnError?.code === "ENOENT";

async function checkTool(
  exec: Exec,
  spec: { id: string; name: string; command: string; args?: string[]; required: boolean; install: string },
): Promise<CheckResult & { result: ProcessResult }> {
  const result = await exec(spec.command, spec.args ?? ["--version"]);
  const base = { id: spec.id, name: spec.name, required: spec.required, result };
  if (notInstalled(result)) {
    return { ...base, status: "missing", detail: "Chưa cài trên máy.", fix: spec.install };
  }
  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || result.spawnError?.message || "").trim().split("\n")[0] ?? "";
    return { ...base, status: "error", detail: `Chạy \`${spec.command} --version\` bị lỗi: ${msg}`, fix: spec.install };
  }
  const version = parseVersion(result.stdout + result.stderr);
  return { ...base, status: "ok", version, detail: version ? `Bản ${version}.` : "Đã cài." };
}

export async function runDoctor(exec: Exec = defaultExec, nodeVersion: string = process.versions.node): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  const nodeOk = versionAtLeast(nodeVersion, MIN_NODE);
  checks.push({
    id: "node",
    name: "Node.js",
    required: true,
    status: nodeOk ? "ok" : "error",
    version: nodeVersion,
    detail: nodeOk ? `Bản ${nodeVersion}.` : `Bản ${nodeVersion} cũ hơn ${MIN_NODE.join(".")}.`,
    fix: nodeOk ? undefined : "Cài Node.js 22.18 trở lên từ https://nodejs.org.",
  });

  const [git, gh, claude, codex] = await Promise.all([
    checkTool(exec, { id: "git", name: "Git", command: "git", required: true, install: "Cài Git từ https://git-scm.com." }),
    checkTool(exec, {
      id: "gh",
      name: "GitHub CLI",
      command: "gh",
      required: true,
      install: "Cài GitHub CLI từ https://cli.github.com rồi chạy `gh auth login`.",
    }),
    checkTool(exec, {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      required: false,
      install: "Cài Claude Code: `npm install -g @anthropic-ai/claude-code`, rồi chạy `claude` để đăng nhập.",
    }),
    checkTool(exec, {
      id: "codex",
      name: "Codex CLI",
      command: "codex",
      required: false,
      install: "Cài Codex CLI: `npm install -g @openai/codex`, rồi chạy `codex login`.",
    }),
  ]);

  checks.push(strip(git));

  // GitHub CLI phải đăng nhập thì mới tạo repo, Issue, PR được.
  if (gh.status === "ok") {
    const auth = await exec("gh", ["auth", "status"]);
    if (auth.code !== 0) {
      checks.push({
        ...strip(gh),
        status: "warn",
        detail: `Bản ${gh.version ?? "?"}, nhưng chưa đăng nhập GitHub.`,
        fix: "Chạy `gh auth login`.",
      });
    } else {
      checks.push({ ...strip(gh), detail: `Bản ${gh.version ?? "?"}, đã đăng nhập GitHub.` });
    }
  } else {
    checks.push(strip(gh));
  }

  checks.push(strip(claude));

  if (codex.status === "ok") {
    const auth = await exec("codex", ["login", "status"]);
    checks.push(
      auth.code === 0
        ? { ...strip(codex), detail: `Bản ${codex.version ?? "?"}, đã đăng nhập.` }
        : { ...strip(codex), status: "warn", detail: `Bản ${codex.version ?? "?"}, chưa đăng nhập.`, fix: "Chạy `codex login`." },
    );
  } else {
    checks.push(strip(codex));
  }

  // Cần ít nhất một agent để nhà máy làm được việc.
  if (claude.status !== "ok" && codex.status !== "ok") {
    for (const c of checks) {
      if (c.id === "claude" || c.id === "codex") c.detail += " Cần ít nhất một agent (Claude Code hoặc Codex).";
    }
  }

  const agentOk = claude.status === "ok" || codex.status === "ok";
  const ok = agentOk && checks.every((c) => !c.required || c.status === "ok" || c.status === "warn");
  return { ok, checkedAt: new Date().toISOString(), checks };
}

function strip<T extends { result: ProcessResult }>(c: T): Omit<T, "result"> {
  const { result: _result, ...rest } = c;
  return rest;
}

export function formatDoctor(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "!", missing: "✗", error: "✗" };
  const lines = report.checks.map((c) => {
    const need = c.required ? "" : " (tuỳ chọn)";
    const fix = c.status === "ok" || !c.fix ? "" : `\n    → ${c.fix}`;
    return `  ${icon[c.status]} ${c.name}${need}: ${c.detail}${fix}`;
  });
  const summary = report.ok
    ? "Máy đã sẵn sàng cho nhà máy."
    : "Máy chưa sẵn sàng: sửa các mục đánh dấu ✗ ở trên.";
  return ["Kiểm tra công cụ trên máy", ...lines, "", summary].join("\n");
}
