import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import {
  api,
  ApiError,
  useLoad,
  type CommandResultRow,
  type Finding,
  type MainRepoInspection,
  type ProjectDetail,
  type ProjectGate,
  type ScanResult,
  type StartMode,
  type SurfaceCommands,
  type SurfaceDetail,
  type SurfaceInspection,
} from "./api.ts";

export type LinkTo = (to: string) => (e: MouseEvent) => void;

export const projectPath = (id: string) => `/du-an/${encodeURIComponent(id)}`;
export const NEW_PROJECT_PATH = "/du-an/moi";
export const newSurfacePath = (id: string) => `${projectPath(id)}/khu-vuc/moi`;

const MODES: { value: StartMode; label: string; hint: string }[] = [
  { value: "existing", label: "Thư mục có sẵn", hint: "Thư mục dự án trên máy, có hoặc chưa có git." },
  { value: "clone", label: "Clone từ GitHub", hint: "Nhà máy clone repo về thư mục bạn chọn." },
  { value: "new", label: "Bắt đầu trống", hint: "Nhà máy tạo thư mục mới và git init." },
];

const COMMANDS: { key: keyof SurfaceCommands; label: string; hint: string; example: string }[] = [
  { key: "provision", label: "Chuẩn bị", hint: "Cài thư viện trước khi kiểm, chạy trong bản sao sạch.", example: "npm ci" },
  { key: "check", label: "Kiểm", hint: "Kiểm nhanh, như typecheck hay lint.", example: "npm run typecheck" },
  { key: "test", label: "Test", hint: "Chạy test tự động.", example: "npm test" },
];

// ───────── Tạo dự án ─────────

export function NewProjectPage(props: { go: (to: string) => void; log: string[] }) {
  const [mode, setMode] = useState<StartMode>("existing");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [inspection, setInspection] = useState<MainRepoInspection>();
  const [name, setName] = useState("");
  const [commands, setCommands] = useState<SurfaceCommands>({});
  const [busy, setBusy] = useState<"inspect" | "create">();
  const [error, setError] = useState<string>();

  // Đổi nguồn thì phải kiểm lại.
  useEffect(() => setInspection(undefined), [mode, path, url]);

  const inspect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("inspect");
    setError(undefined);
    try {
      const r = await api.inspectProject({ mode, path, ...(mode === "clone" ? { url } : {}) });
      setInspection(r);
      setName((n) => n || r.suggestedName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("create");
    setError(undefined);
    try {
      const r = await api.createProject({ mode, path, ...(mode === "clone" ? { url } : {}), name, mainCommands: commands });
      props.go(projectPath(r.project.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(undefined);
    }
  };

  const existing = inspection?.existingConfig;
  return (
    <>
      <form className="card form" onSubmit={inspect}>
        <div className="card-head">
          <h2>1. Repo chính</h2>
        </div>
        <fieldset className="choices">
          <legend>Bắt đầu từ</legend>
          {MODES.map((m) => (
            <label key={m.value} className="choice">
              <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
              <span>
                <strong>{m.label}</strong>
                <span className="muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "clone" && (
          <Field label="URL của repo" hint="VD https://github.com/ban/du-an.git">
            <input value={url} onChange={(e) => setUrl(e.target.value)} required spellCheck={false} />
          </Field>
        )}
        <Field
          label={mode === "existing" ? "Thư mục dự án" : "Thư mục đích"}
          hint="Đường dẫn đầy đủ trên máy này, VD D:\Projects\cosplay-run"
        >
          <input value={path} onChange={(e) => setPath(e.target.value)} required spellCheck={false} className="mono" />
        </Field>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy !== undefined || !path.trim()}>
            {busy === "inspect" ? "Đang kiểm…" : "Kiểm tra"}
          </button>
        </div>
        {inspection && (
          <>
            <Findings findings={inspection.findings} />
            {inspection.scan && <ScanSummary scan={inspection.scan} />}
          </>
        )}
      </form>

      {inspection?.ok && (
        <form className="card form" onSubmit={create}>
          <div className="card-head">
            <h2>2. Tên và lệnh kiểm</h2>
          </div>
          <Field label="Tên dự án" hint="Hiện trên giao diện; id của dự án lấy từ tên này.">
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          {existing ? (
            <p className="muted">Repo đã có cấu hình nhà máy ({existing.surfaces.length} khu vực); nhà máy dùng lại các lệnh trong đó.</p>
          ) : (
            <>
              <p className="muted">
                Lệnh của khu vực <code>main</code> (gốc repo), đều không bắt buộc. Mỗi lệnh chạy bằng shell của máy. Đừng đặt lệnh build ở đây.
              </p>
              <CommandFields value={commands} onChange={setCommands} />
            </>
          )}
          <p className="muted small">
            Nhà máy thêm khung (<code>.factory/project.yaml</code>, <code>AGENTS.md</code>, <code>CLAUDE.md</code>…)
            {inspection.git?.isRepo ? " trên nhánh factory/onboarding, không đụng nhánh bạn đang mở." : " rồi commit."} Chưa có gì lên GitHub cho tới khi bạn duyệt ở bước sau.
          </p>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy !== undefined || !name.trim()}>
              {busy === "create" ? "Đang tạo…" : "Tạo dự án"}
            </button>
          </div>
          {busy === "create" && <LogLines lines={props.log} />}
        </form>
      )}
      {error && <p className="error card">{error}</p>}
    </>
  );
}

// ───────── Trang dự án ─────────

export function ProjectPage(props: { id: string; tick: number; log: string[]; link: LinkTo }) {
  const detail = useLoad(() => api.project(props.id));
  const { reload } = detail;
  useEffect(() => {
    if (props.tick > 0) reload();
  }, [props.tick, reload]);
  const [error, setError] = useState<string>();
  const loaded = detail.data !== undefined;
  useEffect(() => {
    if (loaded && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const act = (work: () => Promise<unknown>) => async () => {
    setError(undefined);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    }
    reload();
  };

  if (detail.error) return <p className="error card">{detail.error}</p>;
  const d = detail.data;
  if (!d) return <p className="muted">Đang tải…</p>;

  return (
    <>
      <section className="card">
        <dl className="facts">
          <dt>Thư mục</dt>
          <dd className="mono">{d.project.repoPath}</dd>
          <dt>GitHub</dt>
          <dd>
            {d.project.githubRepo ? (
              <a href={`https://github.com/${d.project.githubRepo}`} target="_blank" rel="noreferrer">
                {d.project.githubRepo}
              </a>
            ) : (
              <span className="muted">chưa lên GitHub</span>
            )}
          </dd>
          <dt>Nhánh chính</dt>
          <dd className="mono">{d.project.baseBranch ?? "main"}</dd>
        </dl>
      </section>

      {d.setup && <SetupCard detail={d} onPublish={(repo) => act(() => api.publish(props.id, repo))()} />}

      <section className="card">
        <div className="card-head">
          <h2>Khu vực</h2>
          <button type="button" onClick={act(() => api.checkSurfaces(props.id))} disabled={d.busy !== null}>
            Kiểm tất cả
          </button>
          <button type="button" onClick={act(() => api.reload(props.id))} disabled={d.busy !== null} title="Sau khi bạn sửa tay .factory/project.yaml">
            Đọc lại cấu hình
          </button>
          <a className="button primary" href={newSurfacePath(props.id)} onClick={props.link(newSurfacePath(props.id))}>
            + Thêm khu vực
          </a>
        </div>
        <ul className="surfaces">
          {d.surfaces.map((s) => (
            <SurfaceItem key={s.id} surface={s} busy={d.busy !== null} onBaseline={act(() => api.baseline(props.id, s.id))} />
          ))}
        </ul>
      </section>

      {(d.busy || props.log.length > 0) && (
        <section className="card">
          <div className="card-head">
            <h2>Tiến độ</h2>
            {d.busy && <span className="pill run">Đang {d.busy}…</span>}
          </div>
          <LogLines lines={props.log} />
        </section>
      )}
      {error && <p className="error card">{error}</p>}
    </>
  );
}

const ACTION_TEXT: Record<ProjectGate["action"], (g: ProjectGate) => string> = {
  create: () => "Tạo repo private trên GitHub của bạn rồi đẩy nhánh chính lên.",
  pr: (g) => `Đẩy nhánh ${g.branch} lên ${g.githubRepo ?? "GitHub"} và mở PR. Merge PR đó thì cấu hình nhà máy có hiệu lực trên nhánh chính.`,
  setup: (g) => `Repo đã có cấu hình nhà máy; bước này chỉ tạo label trên ${g.githubRepo ?? "GitHub"}.`,
};

function SetupCard(props: { detail: ProjectDetail; onPublish: (repoName?: string) => void }) {
  const { setup, busy } = props.detail;
  const gate = setup!.data.gate as ProjectGate | undefined;
  const [repoName, setRepoName] = useState(gate?.suggestedRepoName ?? "");
  if (!setup || !gate) return null;
  const findings = ((setup.data.findings as Finding[] | undefined) ?? []).filter((f) => f.level !== "info");
  const warnings = (setup.data.warnings as string[] | undefined) ?? [];

  if (setup.status === "done") {
    const prUrl = setup.data.prUrl as string | undefined;
    return (
      <section className="card">
        <div className="card-head">
          <h2>Lên GitHub</h2>
          <span className="pill ok">Xong</span>
        </div>
        {prUrl ? (
          <p>
            PR onboarding:{" "}
            <a href={prUrl} target="_blank" rel="noreferrer">
              {prUrl}
            </a>
            . Merge PR rồi pull về để nhánh chính có cấu hình nhà máy.
          </p>
        ) : (
          <p>Repo đã lên GitHub và có đủ label.</p>
        )}
        {warnings.length > 0 && <Findings findings={warnings.map((message) => ({ level: "warn", message }))} />}
      </section>
    );
  }

  const running = busy !== null || setup.status === "running";
  return (
    <section className="card gate">
      <div className="card-head">
        <h2>Duyệt: đưa dự án lên GitHub</h2>
        <span className="pill wait">{running ? "Đang chạy" : "Chờ bạn"}</span>
      </div>
      <p>{ACTION_TEXT[gate.action](gate)}</p>
      <p className="muted">
        {gate.files} file, {formatBytes(gate.totalBytes)}. Sau đó nhà máy tạo label (kind, status, surface), bật bảo vệ nhánh chính và chỉ cho squash merge.
      </p>
      {gate.large.length + gate.secrets.length > 0 && (
        <ul className="findings">
          {gate.large.map((l) => (
            <li key={l.path} className="finding finding-warn">
              File lớn <code>{l.path}</code> ({formatBytes(l.bytes)})
            </li>
          ))}
          {gate.secrets.map((s) => (
            <li key={s.path} className="finding finding-warn">
              Giống secret: <code>{s.path}</code> ({s.reason})
            </li>
          ))}
        </ul>
      )}
      {findings.length > 0 && <Findings findings={findings} />}
      {setup.error && <p className="error">Lần trước hỏng: {withCode(setup.error)}</p>}
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          props.onPublish(gate.action === "create" ? repoName : undefined);
        }}
      >
        {gate.action === "create" && (
          <label className="inline">
            Tên repo
            <input value={repoName} onChange={(e) => setRepoName(e.target.value)} required spellCheck={false} className="mono" />
          </label>
        )}
        <button type="submit" className="primary" disabled={running}>
          {running ? "Đang lên GitHub…" : gate.action === "create" ? "Duyệt và tạo repo" : gate.action === "pr" ? "Duyệt và mở PR" : "Duyệt"}
        </button>
      </form>
    </section>
  );
}

function SurfaceItem(props: { surface: SurfaceDetail; busy: boolean; onBaseline: () => void }) {
  const s = props.surface;
  const commands = Object.entries(s.commands);
  const failedSetup = s.onboarding?.status === "failed";
  return (
    <li className="surface" id={`kv-${s.id}`}>
      <div className="surface-head">
        <strong className="mono">{s.id}</strong>
        <span className="mono muted">{s.implicit ? "gốc repo" : s.location}</span>
        {s.pack && <span className="pill">pack {s.pack}</span>}
        {failedSetup && <span className="pill bad">Thêm hỏng</span>}
        <button type="button" onClick={props.onBaseline} disabled={props.busy || commands.length === 0}>
          {s.baseline.length > 0 ? "Chạy lại mốc chuẩn" : "Chạy mốc chuẩn"}
        </button>
      </div>
      {failedSetup && <p className="error">{s.onboarding?.error}</p>}
      {commands.length === 0 ? (
        <p className="muted">Chưa có lệnh nào nên nhà máy chưa kiểm được việc ở khu vực này.</p>
      ) : (
        <ResultTable commands={commands} baseline={s.baseline} doctor={s.doctor} />
      )}
    </li>
  );
}

const COMMAND_LABEL: Record<string, string> = { provision: "Chuẩn bị", check: "Kiểm", test: "Test" };

function ResultTable(props: { commands: [string, string][]; baseline: CommandResultRow[]; doctor: CommandResultRow[] }) {
  return (
    <div className="table-wrap">
      <table className="results">
        <thead>
          <tr>
            <th scope="col">Lệnh</th>
            <th scope="col">Mốc chuẩn</th>
            <th scope="col">Kiểm tại chỗ</th>
          </tr>
        </thead>
        <tbody>
          {props.commands.map(([key, run]) => (
            <tr key={key}>
              <th scope="row">
                {COMMAND_LABEL[key] ?? key}
                <div className="mono muted">{run}</div>
              </th>
              <td>
                <Result result={props.baseline.find((r) => r.command === key)} />
              </td>
              <td>{key === "check" ? <Result result={props.doctor.find((r) => r.command === key)} /> : <span className="muted">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Result({ result }: { result: CommandResultRow | undefined }) {
  if (!result) return <span className="muted">chưa chạy</span>;
  const when = new Date(result.ranAt).toLocaleString("vi-VN");
  const summary = result.ok
    ? `Qua, ${seconds(result.durationMs)}`
    : result.timedOut
      ? `Quá giờ sau ${seconds(result.durationMs)}`
      : result.exitCode === null
        ? "Bỏ qua"
        : `Hỏng (mã ${result.exitCode}), ${seconds(result.durationMs)}`;
  return (
    <details className={`result ${result.ok ? "result-ok" : "result-bad"}`}>
      <summary title={when}>
        <span aria-hidden="true">{result.ok ? "✓" : "✗"}</span> {summary}
      </summary>
      <pre>{result.output.trim() || "(không có đầu ra)"}</pre>
    </details>
  );
}

// ───────── Thêm khu vực ─────────

export function NewSurfacePage(props: { id: string; go: (to: string) => void }) {
  const detail = useLoad(() => api.project(props.id));
  const [surfaceId, setSurfaceId] = useState("");
  const [location, setLocation] = useState("");
  const [pack, setPack] = useState("");
  const [commands, setCommands] = useState<SurfaceCommands>({});
  const [inspection, setInspection] = useState<SurfaceInspection>();
  const [busy, setBusy] = useState<"inspect" | "add">();
  const [error, setError] = useState<string>();

  useEffect(() => setInspection(undefined), [surfaceId, location, pack, commands]);
  const input = () => ({ id: surfaceId, location, commands, ...(pack.trim() ? { pack: pack.trim() } : {}) });

  const inspect = async () => {
    setBusy("inspect");
    setError(undefined);
    try {
      setInspection(await api.inspectSurface(props.id, input()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const add = async () => {
    setBusy("add");
    setError(undefined);
    try {
      await api.addSurface(props.id, input());
      props.go(projectPath(props.id));
    } catch (err) {
      if (err instanceof ApiError && err.body.inspection) setInspection(err.body.inspection as SurfaceInspection);
      setError((err as Error).message);
      setBusy(undefined);
    }
  };

  const repoPath = detail.data?.project.repoPath;
  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        void (inspection?.ok ? add() : inspect());
      }}
    >
      <Field label="Id của khu vực" hint="Chữ thường, số và dấu gạch ngang, VD web, server, du-lieu. Dùng trong label surface:<id> và tên nhánh.">
        <input value={surfaceId} onChange={(e) => setSurfaceId(e.target.value.toLowerCase())} required spellCheck={false} className="mono" />
      </Field>
      <Field label="Thư mục" hint={repoPath ? `So với gốc repo ${repoPath}, hoặc đường dẫn đầy đủ.` : "So với gốc repo, hoặc đường dẫn đầy đủ."}>
        <input value={location} onChange={(e) => setLocation(e.target.value)} required spellCheck={false} className="mono" />
      </Field>
      <p className="muted">
        Mỗi lệnh chạy trong thư mục của khu vực. Nhà máy chạy chúng một lần trên bản sao sạch của nhánh chính để lấy mốc chuẩn; lỗi có sẵn
        lúc này không bị tính cho agent sau này.
      </p>
      <CommandFields value={commands} onChange={setCommands} />
      <Field label="Pack (không bắt buộc)" hint="Tên pack trong thư mục packs của nhà máy. Lệnh bạn ghi ở trên đè lên lệnh của pack.">
        <input value={pack} onChange={(e) => setPack(e.target.value)} spellCheck={false} className="mono" />
      </Field>
      <div className="actions">
        <button type="button" onClick={() => void inspect()} disabled={busy !== undefined || !surfaceId.trim() || !location.trim()}>
          {busy === "inspect" ? "Đang kiểm…" : "Kiểm tra"}
        </button>
        <button type="submit" className="primary" disabled={busy !== undefined || !inspection?.ok}>
          {busy === "add" ? "Đang thêm…" : "Thêm và chạy mốc chuẩn"}
        </button>
      </div>
      {inspection && (
        <>
          <Findings findings={inspection.findings} />
          {inspection.ok && (
            <p className="muted">
              Ghi vào dự án là <code>{inspection.location}</code>
              {inspection.inMainRepo ? "" : ` (repo ${inspection.repoRoot ?? "khác"})`}.
            </p>
          )}
          {inspection.scan && <ScanSummary scan={inspection.scan} />}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ───────── Phần dùng chung ─────────

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

function CommandFields(props: { value: SurfaceCommands; onChange: (v: SurfaceCommands) => void }) {
  return (
    <div className="command-fields">
      {COMMANDS.map((c) => (
        <Field key={c.key} label={c.label} hint={`${c.hint} VD ${c.example}`}>
          <input
            value={props.value[c.key] ?? ""}
            onChange={(e) => props.onChange({ ...props.value, [c.key]: e.target.value })}
            spellCheck={false}
            className="mono"
          />
        </Field>
      ))}
    </div>
  );
}

const LEVEL_TEXT: Record<Finding["level"], string> = { block: "Chặn", warn: "Lưu ý", info: "Thông tin" };

function Findings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <p className="finding finding-ok">Không thấy vấn đề gì.</p>;
  const order = { block: 0, warn: 1, info: 2 };
  return (
    <ul className="findings">
      {[...findings]
        .sort((a, b) => order[a.level] - order[b.level])
        .map((f, i) => (
          <li key={i} className={`finding finding-${f.level}`}>
            <span className="finding-level">{LEVEL_TEXT[f.level]}</span> {withCode(f.message)}
          </li>
        ))}
    </ul>
  );
}

function ScanSummary({ scan }: { scan: ScanResult }) {
  const exts = scan.topExtensions.map((e) => `${e.ext} (${e.files})`).join(", ");
  return (
    <details className="scan" open={scan.secrets.length + scan.large.length > 0}>
      <summary>
        {scan.files} file, {formatBytes(scan.totalBytes)}
        {scan.hasTests ? ", có test" : ", chưa thấy test"}
        {scan.hasCi ? ", có CI" : ""}
      </summary>
      <ul>
        {exts && <li>Loại file nhiều nhất: {exts}</li>}
        {scan.large.map((l) => (
          <li key={l.path}>
            File lớn <code>{l.path}</code> ({formatBytes(l.bytes)})
          </li>
        ))}
        {scan.secrets.map((s) => (
          <li key={s.path}>
            Giống secret: <code>{s.path}</code> ({s.reason})
          </li>
        ))}
        {scan.longestPath && <li>Đường dẫn dài nhất ({scan.longestPath.length} ký tự): <code>{scan.longestPath}</code></li>}
      </ul>
    </details>
  );
}

function LogLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <p className="muted">Đang chờ tiến độ…</p>;
  return (
    <ol className="log" aria-live="polite">
      {lines.slice(-30).map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ol>
  );
}

/** Hiện phần nằm giữa hai dấu ` thành mã. */
export function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} giây`;
