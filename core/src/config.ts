import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { SURFACE_KINDS, TEST_MODES, type SurfaceKind } from "./model.ts";

/**
 * Cấu hình dự án trong repo chính: `.factory/project.yaml` (mo-hinh-du-an.md mục 3.2).
 * Khu vực ngầm `main` không ghi trong file; `withImplicitMain` thêm nó khi đọc.
 */

export const CONFIG_DIR = ".factory";
export const CONFIG_FILE = ".factory/project.yaml";
export const MAIN_SURFACE = "main";

/** Lệnh của khu vực không có pack (luong-onboarding.md B6, B7). */
export interface SurfaceCommands {
  /** Chuẩn bị worktree mới, VD `npm ci`. */
  provision?: string;
  check?: string;
  test?: string;
}

export interface SurfaceConfig {
  id: string;
  kind: SurfaceKind;
  /** Đường dẫn tương đối so với gốc repo chính (thư mục trong repo chính hoặc repo khác). */
  location: string;
  pack?: string;
  commands?: SurfaceCommands;
}

export interface LinkConfig {
  from: string;
  to: string;
  via?: string;
}

export interface ProjectConfig {
  name: string;
  /** Lệnh của khu vực ngầm `main` (gốc repo chính). */
  main?: { commands?: SurfaceCommands };
  surfaces: SurfaceConfig[];
  links?: LinkConfig[];
  test_mode?: (typeof TEST_MODES)[number];
  task_kinds?: { add?: { key: string; name: string; config?: string }[] };
}

export class ConfigError extends Error {}

const ID_RE = /^[a-z][a-z0-9-]{0,29}$/;
const COMMAND_KEYS = ["provision", "check", "test"] as const;

/** `id` của khu vực: chữ thường, số, gạch ngang, bắt đầu bằng chữ, tối đa 30 ký tự. */
export function validSurfaceId(id: string): boolean {
  return ID_RE.test(id);
}

/** Tên dự án thành id: `Cosplay Run` → `cosplay-run`. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `p-${slug || "du-an"}`;
}

export function parseProjectConfig(text: string): ProjectConfig {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigError(`YAML lỗi: ${doc.errors[0]!.message}`);
  return validateProjectConfig(doc.toJS());
}

export function validateProjectConfig(raw: unknown): ProjectConfig {
  if (!isObject(raw)) throw new ConfigError("project.yaml phải là một object");
  if (typeof raw.name !== "string" || raw.name.trim() === "") throw new ConfigError("Thiếu `name`");
  const surfacesRaw = raw.surfaces ?? [];
  if (!Array.isArray(surfacesRaw)) throw new ConfigError("`surfaces` phải là một danh sách");

  const seen = new Set<string>();
  const surfaces = surfacesRaw.map((s, i): SurfaceConfig => {
    if (!isObject(s)) throw new ConfigError(`surfaces[${i}] phải là một object`);
    const id = s.id;
    if (typeof id !== "string" || !validSurfaceId(id)) throw new ConfigError(`surfaces[${i}].id không hợp lệ: ${String(id)}`);
    if (id === MAIN_SURFACE) throw new ConfigError("Khu vực `main` có sẵn, không cần khai báo");
    if (seen.has(id)) throw new ConfigError(`Khu vực \`${id}\` khai báo hai lần`);
    seen.add(id);
    const kind = s.kind ?? "folder";
    if (typeof kind !== "string" || !(SURFACE_KINDS as readonly string[]).includes(kind)) {
      throw new ConfigError(`Khu vực \`${id}\`: kiểu không hợp lệ: ${String(kind)}`);
    }
    if (typeof s.location !== "string" || s.location === "") throw new ConfigError(`Khu vực \`${id}\`: thiếu \`location\``);
    const surface: SurfaceConfig = { id, kind: kind as SurfaceKind, location: s.location };
    if (s.pack !== undefined) {
      if (typeof s.pack !== "string") throw new ConfigError(`Khu vực \`${id}\`: \`pack\` phải là chuỗi`);
      surface.pack = s.pack;
    }
    if (s.commands !== undefined) surface.commands = validateCommands(s.commands, `Khu vực \`${id}\``);
    return surface;
  });

  const config: ProjectConfig = { name: raw.name, surfaces };
  if (raw.main !== undefined) {
    if (!isObject(raw.main)) throw new ConfigError("`main` phải là một object");
    config.main = raw.main.commands === undefined ? {} : { commands: validateCommands(raw.main.commands, "Khu vực `main`") };
  }
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links)) throw new ConfigError("`links` phải là một danh sách");
    config.links = raw.links.map((l, i) => {
      if (!isObject(l) || typeof l.from !== "string" || typeof l.to !== "string") {
        throw new ConfigError(`links[${i}] cần \`from\` và \`to\``);
      }
      return { from: l.from, to: l.to, ...(typeof l.via === "string" ? { via: l.via } : {}) };
    });
  }
  if (raw.test_mode !== undefined) {
    if (!(TEST_MODES as readonly unknown[]).includes(raw.test_mode)) throw new ConfigError(`test_mode không hợp lệ: ${String(raw.test_mode)}`);
    config.test_mode = raw.test_mode as ProjectConfig["test_mode"];
  }
  if (raw.task_kinds !== undefined) config.task_kinds = raw.task_kinds as ProjectConfig["task_kinds"];
  return config;
}

export function validateCommands(raw: unknown, where: string): SurfaceCommands {
  if (!isObject(raw)) throw new ConfigError(`${where}: \`commands\` phải là một object`);
  const out: SurfaceCommands = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(COMMAND_KEYS as readonly string[]).includes(key)) throw new ConfigError(`${where}: lệnh lạ \`${key}\``);
    if (typeof value !== "string") throw new ConfigError(`${where}: lệnh \`${key}\` phải là chuỗi`);
    if (value.trim() !== "") out[key as keyof SurfaceCommands] = value.trim();
  }
  return out;
}

export function readProjectConfig(repoPath: string): ProjectConfig | undefined {
  const file = join(repoPath, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  return parseProjectConfig(readFileSync(file, "utf8"));
}

export function serializeProjectConfig(config: ProjectConfig): string {
  // Giữ thứ tự khoá dễ đọc: name, main, surfaces, rồi phần còn lại.
  const { name, main, surfaces, ...rest } = config;
  const ordered = { name, ...(main ? { main } : {}), surfaces, ...rest };
  const header =
    "# Cấu hình nhà máy cho dự án này. Khu vực ngầm `main` (gốc repo) không cần khai báo.\n" +
    "# Mỗi khu vực: id, kind (folder), location (so với gốc repo), commands { provision, check, test }.\n";
  return header + stringify(ordered, { lineWidth: 0 });
}

/** Danh sách khu vực kể cả khu vực ngầm `main`. */
export function withImplicitMain(config: ProjectConfig): (SurfaceConfig & { implicit: boolean })[] {
  const mainCommands = config.main?.commands;
  return [
    { id: MAIN_SURFACE, kind: "folder", location: ".", implicit: true, ...(mainCommands ? { commands: mainCommands } : {}) },
    ...config.surfaces.map((s) => ({ ...s, implicit: false })),
  ];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
