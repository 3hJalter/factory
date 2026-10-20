import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE, MAIN_SURFACE, serializeProjectConfig, type ProjectConfig } from "./config.ts";

/**
 * Khung nhà máy trong repo chính (luong-onboarding.md bước A2).
 * Mọi hàm ở đây chạy lại được: file đã có thì giữ phần của bạn, chỉ thay khối do nhà máy quản lý.
 */

export const AGENTS_BEGIN = "<!-- factory:begin -->";
export const AGENTS_END = "<!-- factory:end -->";
const LOCAL_IGNORE = ".factory/local/";

export interface ScaffoldOptions {
  config: ProjectConfig;
}

/** Ghi khung vào `dir`, trả về các file đã tạo hoặc đổi. */
export function writeScaffold(dir: string, opts: ScaffoldOptions): string[] {
  const changed: string[] = [];
  const put = (rel: string, content: string) => {
    const file = join(dir, rel);
    if (existsSync(file) && readFileSync(file, "utf8") === content) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    changed.push(rel);
  };
  const putIfMissing = (rel: string, content: string) => {
    if (!existsSync(join(dir, rel))) put(rel, content);
  };

  put(CONFIG_FILE, serializeProjectConfig(opts.config));
  putIfMissing(".factory/packs.lock", "# Phiên bản và hash pack của từng khu vực. Nhà máy tự ghi.\npacks: {}\n");
  put("AGENTS.md", mergeAgents(readOr(join(dir, "AGENTS.md")), opts));
  put("CLAUDE.md", ensureClaudeImport(readOr(join(dir, "CLAUDE.md"))));
  putIfMissing("GLOSSARY.md", GLOSSARY);
  putIfMissing("docs/adr/README.md", ADR_README);
  putIfMissing(".github/ISSUE_TEMPLATE/bug.yml", BUG_TEMPLATE);
  put(".gitignore", ensureLine(readOr(join(dir, ".gitignore")), LOCAL_IGNORE));
  return changed;
}

function readOr(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function ensureLine(text: string | undefined, line: string): string {
  const current = text ?? "";
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return current;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  return `${current}${sep}${line}\n`;
}

export function ensureClaudeImport(text: string | undefined): string {
  if (text === undefined || text.trim() === "") return "@AGENTS.md\n";
  if (text.split(/\r?\n/)[0]?.trim() === "@AGENTS.md") return text;
  return `@AGENTS.md\n${text}`;
}

/** Thay (hoặc thêm vào cuối) khối do nhà máy quản lý, giữ nguyên phần còn lại của AGENTS.md. */
export function mergeAgents(text: string | undefined, opts: ScaffoldOptions): string {
  const block = `${AGENTS_BEGIN}\n${renderAgentsBlock(opts)}${AGENTS_END}\n`;
  if (text === undefined || text.trim() === "") return `# ${opts.config.name}\n\n${block}`;
  const start = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  if (start >= 0 && end > start) {
    const after = text.slice(end + AGENTS_END.length).replace(/^\r?\n/, "");
    return text.slice(0, start) + block + after;
  }
  const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return text + sep + block;
}

function renderAgentsBlock({ config }: ScaffoldOptions): string {
  const rows = [
    { id: MAIN_SURFACE, location: "gốc repo", commands: config.main?.commands },
    ...config.surfaces.map((s) => ({ id: s.id, location: `\`${s.location}\``, commands: s.commands })),
  ];
  const cmd = (c: string | undefined) => (c ? `\`${c}\`` : "–");
  const lines = [
    "## Nhà máy",
    "",
    "Phần này do nhà máy sinh từ `.factory/project.yaml`; sửa ở file đó rồi để nhà máy cập nhật, đừng sửa tay giữa hai dấu `factory:begin`/`factory:end`.",
    "",
    "- Việc được giao thành task. Mỗi task nhắm một hoặc vài **khu vực** bên dưới; chỉ sửa trong khu vực của task.",
    "- Lệnh của khu vực chạy từ thư mục của khu vực đó. Trước khi xong việc, lệnh kiểm và lệnh test của mọi khu vực đã đụng tới phải xanh.",
    "- Không tự build, không tự phát hành: đó là loại task riêng, chỉ chạy khi có task yêu cầu.",
    "",
    "| Khu vực | Vị trí | Chuẩn bị | Kiểm | Test |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| \`${r.id}\` | ${r.location} | ${cmd(r.commands?.provision)} | ${cmd(r.commands?.check)} | ${cmd(r.commands?.test)} |`),
    "",
  ];
  return lines.join("\n");
}

const GLOSSARY = `# Thuật ngữ

Từ ngữ riêng của dự án, để người và agent hiểu giống nhau. Task \`analyze\` điền dần.

| Từ | Nghĩa |
|---|---|
`;

const ADR_README = `# Quyết định kiến trúc (ADR)

Mỗi quyết định một file \`NNNN-ten-ngan.md\`: bối cảnh, quyết định, hệ quả.
`;

const BUG_TEMPLATE = `name: Báo lỗi
description: Báo một lỗi để nhà máy tạo task sửa
labels: [bug]
body:
  - type: textarea
    id: what
    attributes:
      label: Lỗi gì?
      description: Bạn thấy gì, lẽ ra phải thấy gì.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Cách tái hiện
  - type: input
    id: surface
    attributes:
      label: Khu vực (nếu biết)
      placeholder: VD web
`;
