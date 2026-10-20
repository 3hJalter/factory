import type { ProcessResult, Runner } from "../src/index.ts";

/**
 * GitHub giả trong bộ nhớ cho `gh api`: Issues, bình luận và phụ thuộc "blocked by" của một repo.
 * Mỗi lần ghi tăng đồng hồ để `updated_at` và tham số `since` chạy như thật.
 */

export interface FakeIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  labels: { name: string }[];
  updated_at: string;
  blockedBy: number[];
  pull_request?: unknown;
}

export interface FakeComment {
  id: number;
  issue: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface FakeGitHub {
  run: Runner;
  issues: Map<number, FakeIssue>;
  comments: FakeComment[];
  calls: string[];
  /** Sửa Issue như người dùng sửa trên web hay điện thoại. */
  edit(number: number, patch: Partial<Omit<FakeIssue, "labels">> & { labels?: string[] }): FakeIssue;
  open(input: { title: string; body?: string; labels?: string[] }): FakeIssue;
  comment(number: number, body: string, login?: string): FakeComment;
  labels(number: number): string[];
  /** Làm hỏng mọi lời gọi khớp mẫu. */
  failOn?: RegExp;
}

export function fakeGitHub(repo = "me/du-an"): FakeGitHub {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  let nextNumber = 1;
  let nextId = 1000;
  const issues = new Map<number, FakeIssue>();
  const comments: FakeComment[] = [];
  const calls: string[] = [];

  const ok = (body: unknown): ProcessResult => ({
    code: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: body === undefined ? "" : JSON.stringify(body),
    stderr: "",
    durationMs: 1,
    cleanedUp: 0,
  });
  const fail = (status: number, message: string): ProcessResult => ({ ...ok(undefined), code: 1, stderr: `gh: ${message} (HTTP ${status})` });

  const view = (i: FakeIssue) => {
    const { blockedBy: _, ...rest } = i;
    return rest;
  };
  const viewComment = (c: FakeComment) => ({ ...c, issue_url: `https://api.github.com/repos/${repo}/issues/${c.issue}` });
  const page = <T>(list: T[], q: URLSearchParams) => {
    const per = Number(q.get("per_page") ?? 30);
    const p = Number(q.get("page") ?? 1);
    return list.slice((p - 1) * per, p * per);
  };

  const fake: FakeGitHub = {
    issues,
    comments,
    calls,
    open(input) {
      const n = nextNumber++;
      const issue: FakeIssue = {
        id: nextId++,
        number: n,
        title: input.title,
        body: input.body ?? null,
        state: "open",
        state_reason: null,
        labels: (input.labels ?? []).map((name) => ({ name })),
        updated_at: tick(),
        blockedBy: [],
      };
      issues.set(n, issue);
      return issue;
    },
    edit(number, patch) {
      const issue = issues.get(number)!;
      const { labels, ...rest } = patch;
      Object.assign(issue, rest, labels ? { labels: labels.map((name) => ({ name })) } : {}, { updated_at: tick() });
      return issue;
    },
    comment(number, body, login = "octo") {
      const at = tick();
      const c: FakeComment = { id: nextId++, issue: number, body, user: { login }, created_at: at, updated_at: at };
      comments.push(c);
      issues.get(number)!.updated_at = at;
      return c;
    },
    labels: (number) => issues.get(number)!.labels.map((l) => l.name).sort(),
    run: async (command, args, opts) => {
      if (command !== "gh" || args[0] !== "api") return fail(400, `lệnh lạ: ${command} ${args.join(" ")}`);
      const method = args[args.indexOf("-X") + 1]!;
      const url = new URL(`https://x/${args[3]!}`);
      const path = url.pathname.slice(1);
      calls.push(`${method} ${path}`);
      if (fake.failOn?.test(`${method} ${path}`)) return fail(502, "Bad Gateway");
      const prefix = `repos/${repo}/`;
      if (!path.startsWith(prefix)) return fail(404, "Not Found");
      const route = path.slice(prefix.length);
      const body = opts?.input ? (JSON.parse(opts.input) as Record<string, any>) : {};
      let m: RegExpExecArray | null;

      if (method === "GET" && route === "issues") {
        const since = url.searchParams.get("since");
        const list = [...issues.values()].filter((i) => !since || i.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        return ok(page(list, url.searchParams).map(view));
      }
      if (method === "POST" && route === "issues") {
        return ok(view(fake.open({ title: body.title, body: body.body, labels: body.labels })));
      }
      if (method === "GET" && route === "issues/comments") {
        const since = url.searchParams.get("since");
        const list = comments.filter((c) => !since || c.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        return ok(page(list, url.searchParams).map(viewComment));
      }
      if ((m = /^issues\/(\d+)$/.exec(route))) {
        const issue = issues.get(Number(m[1]));
        if (!issue) return fail(404, "Not Found");
        if (method === "GET") return ok(view(issue));
        if (method === "PATCH") {
          const { labels, ...rest } = body;
          return ok(view(fake.edit(issue.number, { ...rest, ...(labels ? { labels } : {}) })));
        }
      }
      if ((m = /^issues\/(\d+)\/comments$/.exec(route)) && method === "POST") {
        return ok(viewComment(fake.comment(Number(m[1]), body.body, "me")));
      }
      if ((m = /^issues\/(\d+)\/dependencies\/blocked_by(?:\/(\d+))?$/.exec(route))) {
        const issue = issues.get(Number(m[1]));
        if (!issue) return fail(404, "Not Found");
        if (method === "GET") return ok(page(issue.blockedBy.map((n) => view(issues.get(n)!)), url.searchParams));
        const byId = (id: number) => [...issues.values()].find((i) => i.id === id);
        if (method === "POST") {
          const other = byId(body.issue_id);
          if (!other) return fail(422, "Validation Failed");
          issue.blockedBy.push(other.number);
          issue.updated_at = tick();
          return ok(view(other));
        }
        if (method === "DELETE" && m[2]) {
          const other = byId(Number(m[2]));
          issue.blockedBy = issue.blockedBy.filter((n) => n !== other?.number);
          issue.updated_at = tick();
          return ok(view(other!));
        }
      }
      return fail(404, `Not Found: ${method} ${route}`);
    },
  };
  return fake;
}
