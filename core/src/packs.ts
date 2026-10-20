import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { SurfaceCommands, SurfaceConfig } from "./config.ts";
import { SURFACE_KINDS, type SurfaceKind } from "./model.ts";

/**
 * Pack Loader một lớp (ke-hoach-mvp.md M2): đọc `pack.yaml` của một pack cài trên máy,
 * lấy lệnh chuẩn `provision`, `check`, `test.unit`. Chưa có kế thừa (`extends`), checklist,
 * loại task hay kiểm kê asset; những phần đó có từ V1 (dac-ta-pack.md).
 */

export interface PackCommand {
  run: string;
  timeoutMs?: number;
}

export interface Pack {
  name: string;
  version: string;
  surfaceKind: SurfaceKind;
  description?: string;
  dir: string;
  commands: { provision?: PackCommand; check?: PackCommand; test?: PackCommand };
}

export class PackError extends Error {}

const NAME_RE = /^[a-z][a-z0-9-]{0,49}$/;

export function loadPack(packsDir: string, name: string): Pack {
  if (!NAME_RE.test(name)) throw new PackError(`Tên pack không hợp lệ: ${name}`);
  const dir = join(packsDir, name);
  const file = join(dir, "pack.yaml");
  if (!existsSync(file)) throw new PackError(`Không thấy pack \`${name}\` (${file})`);
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (doc.errors.length > 0) throw new PackError(`pack.yaml của \`${name}\` lỗi YAML: ${doc.errors[0]!.message}`);
  return parsePack(doc.toJS(), name, dir);
}

export function parsePack(raw: unknown, expectedName: string, dir: string): Pack {
  if (typeof raw !== "object" || raw === null) throw new PackError(`pack.yaml của \`${expectedName}\` phải là một object`);
  const r = raw as Record<string, unknown>;
  if (r.name !== expectedName) throw new PackError(`pack.yaml ghi name \`${String(r.name)}\`, thư mục là \`${expectedName}\``);
  if (typeof r.version !== "string") throw new PackError(`Pack \`${expectedName}\` thiếu \`version\``);
  if (r.extends !== undefined) throw new PackError(`Pack \`${expectedName}\` dùng \`extends\`; kế thừa pack có từ V1`);
  if (r.abstract === true) throw new PackError(`Pack \`${expectedName}\` là pack trừu tượng, không gắn trực tiếp vào khu vực được`);
  const kind = r.surface_kind ?? "folder";
  if (!(SURFACE_KINDS as readonly unknown[]).includes(kind)) throw new PackError(`Pack \`${expectedName}\`: surface_kind lạ: ${String(kind)}`);

  const commandsRaw = (r.commands ?? {}) as Record<string, unknown>;
  const commands: Pack["commands"] = {};
  const take = (key: string, as: keyof Pack["commands"]) => {
    const c = commandsRaw[key];
    if (c === undefined) return;
    if (typeof c === "string") commands[as] = { run: c };
    else if (typeof c === "object" && c !== null && typeof (c as { run?: unknown }).run === "string") {
      const timeout = (c as { timeout?: unknown }).timeout;
      commands[as] = { run: (c as { run: string }).run, ...(timeout !== undefined ? { timeoutMs: parseDuration(timeout) } : {}) };
    } else throw new PackError(`Pack \`${expectedName}\`: lệnh \`${key}\` phải có \`run\``);
  };
  take("provision", "provision");
  take("check", "check");
  take("test.unit", "test");

  return {
    name: expectedName,
    version: r.version,
    surfaceKind: kind as SurfaceKind,
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    dir,
    commands,
  };
}

/** `30m`, `90s`, `2h` hoặc số giây → mili giây. */
export function parseDuration(value: unknown): number {
  if (typeof value === "number") return value * 1000;
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(value).trim());
  if (!m) throw new PackError(`Thời gian không hợp lệ: ${String(value)}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
}

export interface ResolvedCommand {
  run: string;
  timeoutMs?: number;
  source: "pack" | "surface";
}

/** Lệnh thực dùng cho một khu vực: lệnh trong `commands` của khu vực đè lên lệnh của pack. */
export function resolveCommands(
  surface: Pick<SurfaceConfig, "pack" | "commands">,
  pack: Pack | undefined,
): Partial<Record<keyof SurfaceCommands, ResolvedCommand>> {
  const out: Partial<Record<keyof SurfaceCommands, ResolvedCommand>> = {};
  for (const key of ["provision", "check", "test"] as const) {
    const own = surface.commands?.[key];
    const fromPack = pack?.commands[key];
    if (own) out[key] = { run: own, source: "surface" };
    else if (fromPack) out[key] = { run: fromPack.run, ...(fromPack.timeoutMs ? { timeoutMs: fromPack.timeoutMs } : {}), source: "pack" };
  }
  return out;
}

/** Thay `{worktree}` và các biến lõi cung cấp trong một lệnh. */
export function expandCommand(run: string, vars: Record<string, string>): string {
  return run.replace(/\{([a-z_.]+)\}/g, (all, key: string) => vars[key] ?? all);
}
