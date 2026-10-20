import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

/**
 * Quét nhanh một thư mục trước khi đưa lên GitHub hoặc nhận làm khu vực
 * (luong-onboarding.md bước A3, B4): file lớn, secret, quy mô.
 */

export const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const CONTENT_SCAN_BYTES = 512 * 1024;
const DEFAULT_SKIP_DIRS = new Set([".git", "node_modules", "Library", "Temp", "obj", "dist", "build", ".factory-home"]);

export interface SecretFinding {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: number;
  totalBytes: number;
  large: { path: string; bytes: number }[];
  secrets: SecretFinding[];
  /** Phần mở rộng phổ biến nhất, để đoán ngôn ngữ chính. */
  topExtensions: { ext: string; files: number }[];
  hasTests: boolean;
  hasCi: boolean;
  /** Đường dẫn tương đối dài nhất, để cảnh báo giới hạn 260 ký tự của Windows. */
  longestPath?: string;
}

const SECRET_FILE_RULES: [RegExp, string][] = [
  [/^\.env(\..+)?$/i, "file .env"],
  [/\.(pem|key|p12|pfx)$/i, "khoá riêng hoặc chứng chỉ"],
  [/\.(keystore|jks)$/i, "keystore Android"],
  [/^id_(rsa|ed25519|ecdsa|dsa)$/, "khoá SSH"],
  [/^credentials(\.json)?$/i, "file credentials"],
];
const SAFE_ENV = /\.(example|sample|template|dist)$/i;

const SECRET_CONTENT_RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "khoá riêng trong file"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "GitHub token"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/, "API key (OpenAI/Anthropic)"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
];

/** Duyệt thư mục khi chưa có git; có git thì truyền `files` lấy từ `git ls-files`. */
export function walkFiles(root: string, skipDirs: Set<string> = DEFAULT_SKIP_DIRS): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  return out.sort();
}

export function scanFiles(root: string, files: string[]): ScanResult {
  const result: ScanResult = { files: 0, totalBytes: 0, large: [], secrets: [], topExtensions: [], hasTests: false, hasCi: false };
  const exts = new Map<string, number>();
  for (const rel of files) {
    let size: number;
    try {
      size = statSync(join(root, rel)).size;
    } catch {
      continue; // file đã xoá nhưng còn trong index
    }
    result.files++;
    result.totalBytes += size;
    if (!result.longestPath || rel.length > result.longestPath.length) result.longestPath = rel;
    if (size > LARGE_FILE_BYTES) result.large.push({ path: rel, bytes: size });
    const ext = extname(rel).toLowerCase() || basename(rel);
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
    if (/(^|\/)(tests?|__tests__|spec)\//i.test(rel) || /\.(test|spec)\.[a-z]+$/i.test(rel)) result.hasTests = true;
    if (rel.startsWith(".github/workflows/") || rel === ".gitlab-ci.yml" || rel === "azure-pipelines.yml") result.hasCi = true;

    const name = basename(rel);
    const fileRule = SECRET_FILE_RULES.find(([re]) => re.test(name));
    if (fileRule && !SAFE_ENV.test(name)) {
      result.secrets.push({ path: rel, reason: fileRule[1] });
      continue;
    }
    if (size > 0 && size <= CONTENT_SCAN_BYTES) {
      const text = readHead(join(root, rel), size);
      if (text === undefined) continue;
      const contentRule = SECRET_CONTENT_RULES.find(([re]) => re.test(text));
      if (contentRule) result.secrets.push({ path: rel, reason: contentRule[1] });
    }
  }
  result.topExtensions = [...exts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, n]) => ({ ext, files: n }));
  return result;
}

/** Đọc file văn bản; bỏ qua file nhị phân (có byte 0). */
function readHead(path: string, size: number): string | undefined {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    if (buf.includes(0)) return undefined;
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
