import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  api,
  useLoad,
  useServerEvents,
  type CheckResult,
  type Connection,
  type DoctorReport,
  type Loaded,
  type OverviewResponse,
  type SurfaceRow,
} from "./api.ts";
import { NEW_PROJECT_PATH, newSurfacePath, NewProjectPage, NewSurfacePage, projectPath, ProjectPage, withCode, type LinkTo } from "./projects.tsx";

interface Route {
  path: string;
  label: string;
  title: string;
  intro: string;
}

const FACTORY_ROUTES: Route[] = [
  {
    path: "/",
    label: "Tổng quan",
    title: "Tổng quan",
    intro: "Mọi dự án trong nhà máy, việc đang cần bạn và tình trạng máy.",
  },
  {
    path: "/hop-duyet",
    label: "Hộp duyệt",
    title: "Hộp duyệt",
    intro: "Mọi việc cần bạn quyết: duyệt PR, trả lời câu hỏi của agent, nhận task được đề xuất.",
  },
  {
    path: "/han-muc",
    label: "Hạn mức",
    title: "Hạn mức",
    intro: "Hạn mức còn lại của Claude và Codex, token từng task đã dùng.",
  },
  {
    path: "/bo-nho",
    label: "Bộ nhớ",
    title: "Bộ nhớ",
    intro: "Những gì agent ghi nhớ giữa các task, gắn theo dự án và khu vực.",
  },
];

/** Màn chưa làm, kèm mốc sẽ có. */
const COMING: Record<string, string> = {
  "/hop-duyet": "Hộp duyệt có từ M4, khi task đầu tiên chạy xong và mở PR.",
  "/han-muc": "Thanh hạn mức và token từng task có từ M5, khi nhà máy đọc được hạn mức của Claude và Codex.",
  "/bo-nho": "Bộ nhớ có từ M8, khi gắn Engram.",
};

/** Màn của một dự án, đọc từ đường dẫn. */
type ProjectView = { kind: "new-project" } | { kind: "project"; id: string } | { kind: "new-surface"; id: string };

function projectView(path: string): ProjectView | undefined {
  if (path === NEW_PROJECT_PATH) return { kind: "new-project" };
  const m = /^\/du-an\/([^/]+)(\/khu-vuc\/moi)?\/?$/.exec(path);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]!);
  return m[2] ? { kind: "new-surface", id } : { kind: "project", id };
}

const NEW_KEY = "_new";
const MAX_LOG = 200;

/** Cuộn tới phần tử trong `#...` của địa chỉ, nếu đã có trên trang. */
function scrollToHash(): void {
  if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: "start" }));
}

function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    if (to === location.pathname + location.hash) return;
    history.pushState(null, "", to);
    setPath(location.pathname);
    scrollToHash();
  }, []);
  return [path, go];
}

export function App() {
  const [path, go] = usePath();
  const overview = useLoad(() => api.overview());
  const doctor = useLoad((again) => api.doctor(again));
  const reloadOverview = overview.reload;
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [tick, setTick] = useState(0);

  const connection = useServerEvents(
    useCallback(
      (e) => {
        if (e.type === "hello") return;
        if (e.type === "project.log") {
          const { projectId, message } = e.payload as { projectId: string | null; message: string };
          const key = projectId ?? NEW_KEY;
          setLogs((all) => ({ ...all, [key]: [...(all[key] ?? []), message].slice(-MAX_LOG) }));
          return;
        }
        if (e.type === "project.changed") setTick((t) => t + 1);
        reloadOverview();
      },
      [reloadOverview],
    ),
  );

  const view = projectView(path);
  const projects = overview.data?.projects ?? [];
  const currentId = view && view.kind !== "new-project" ? view.id : undefined;
  const current = projects.find((p) => p.id === currentId);
  const route: Route = view
    ? view.kind === "new-project"
      ? { path, label: "", title: "Dự án mới", intro: "Chọn repo chính, nhà máy kiểm rồi thêm khung. Chưa có gì lên GitHub cho tới khi bạn duyệt." }
      : view.kind === "new-surface"
        ? { path, label: "", title: "Thêm khu vực", intro: `Một thư mục trong ${current?.name ?? view.id} mà agent sẽ làm việc, kèm lệnh để kiểm việc đó.` }
        : { path, label: "", title: current?.name ?? view.id, intro: "Khu vực, mốc chuẩn và các bước đưa dự án vào nhà máy." }
    : (FACTORY_ROUTES.find((r) => r.path === path) ?? FACTORY_ROUTES[0]!);
  useEffect(() => {
    document.title = route.path === "/" ? "Factory" : `${route.title} · Factory`;
  }, [route.path, route.title]);

  const link = (to: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(to);
  };

  return (
    <div className="app">
      <TopBar overview={overview.data} connection={connection} link={link} go={go} currentId={currentId} />
      <div className="body">
        <nav className="sidebar" aria-label="Điều hướng chính">
          <NavGroup title="NHÀ MÁY">
            {FACTORY_ROUTES.map((r) => (
              <a
                key={r.path}
                href={r.path}
                onClick={link(r.path)}
                className="nav-item"
                aria-current={r.path === route.path ? "page" : undefined}
              >
                {r.label}
                {r.path === "/hop-duyet" && (overview.data?.inbox ?? 0) > 0 && (
                  <span className="badge">{overview.data?.inbox}</span>
                )}
              </a>
            ))}
          </NavGroup>
          <NavGroup title="KHU VỰC">
            {currentId ? (
              <SurfaceNav id={currentId} tick={tick} link={link} path={path} />
            ) : projects.length > 0 ? (
              <p className="nav-empty">Chọn một dự án để thấy khu vực của nó.</p>
            ) : (
              <p className="nav-empty">Chưa có dự án nào nên chưa có khu vực.</p>
            )}
          </NavGroup>
          <div className="sidebar-foot">
            <label className="switch" title="Bật được khi có hàng đợi task (M3)">
              <input type="checkbox" disabled />
              <span>Tạm dừng toàn bộ</span>
            </label>
          </div>
        </nav>
        <main className="main">
          <div className="page">
            <header className="page-head">
              <h1>{route.title}</h1>
              <p>{route.intro}</p>
            </header>
            {view?.kind === "new-project" ? (
              <NewProjectPage go={go} log={logs[NEW_KEY] ?? []} />
            ) : view?.kind === "project" ? (
              <ProjectPage key={view.id} id={view.id} tick={tick} log={logs[view.id] ?? []} link={link} />
            ) : view?.kind === "new-surface" ? (
              <NewSurfacePage key={view.id} id={view.id} go={go} />
            ) : route.path === "/" ? (
              <OverviewPage overview={overview} doctor={doctor} link={link} />
            ) : (
              <section className="card empty">{COMING[route.path]}</section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function TopBar(props: {
  overview: OverviewResponse | undefined;
  connection: Connection;
  link: LinkTo;
  go: (to: string) => void;
  currentId: string | undefined;
}) {
  const projects = props.overview?.projects ?? [];
  const inbox = props.overview?.inbox ?? 0;
  return (
    <header className="topbar">
      <a href="/" onClick={props.link("/")} className="brand">
        <FactoryIcon />
        Factory
      </a>
      <div className="topbar-project">
        <select
          aria-label="Chọn dự án"
          disabled={projects.length === 0}
          value={props.currentId ?? ""}
          onChange={(e) => props.go(e.target.value ? projectPath(e.target.value) : "/")}
        >
          {projects.length === 0 ? (
            <option value="">Chưa có dự án</option>
          ) : (
            <>
              <option value="">Mọi dự án</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </>
          )}
        </select>
        <ConnectionDot state={props.connection} />
      </div>
      <Meter name="Claude" />
      <Meter name="Codex" />
      <a href="/hop-duyet" onClick={props.link("/hop-duyet")} className="inbox" aria-label={`Hộp duyệt, ${inbox} mục`}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 13h5l2 3h4l2-3h5" />
          <path d="M5 5h14l2 8v6H3v-6z" />
        </svg>
        {inbox > 0 && <span className="badge">{inbox}</span>}
      </a>
    </header>
  );
}

/** Hạn mức chưa đọc được trước M5 nên hiện gạch ngang. */
function Meter({ name }: { name: string }) {
  return (
    <span className="meter" title={`Hạn mức ${name} hiện từ M5`}>
      {name}
      <span className="meter-bar" aria-hidden="true" />
      –
    </span>
  );
}

function ConnectionDot({ state }: { state: Connection }) {
  const text = { open: "Đã nối server", connecting: "Đang nối server…", closed: "Mất kết nối server, đang thử lại" }[state];
  return (
    <span className={`conn conn-${state}`} role="status">
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

const SETUP_TEXT: Record<string, string> = {
  waiting_you: "Chờ bạn duyệt lên GitHub",
  running: "Đang lên GitHub",
  failed: "Tạo dự án hỏng",
};

function OverviewPage(props: { overview: Loaded<OverviewResponse>; doctor: Loaded<DoctorReport>; link: LinkTo }) {
  const { overview, doctor, link } = props;
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Dự án</h2>
          <a className="button primary" href={NEW_PROJECT_PATH} onClick={link(NEW_PROJECT_PATH)}>
            + Dự án mới
          </a>
        </div>
        {overview.error ? (
          <p className="error">Không đọc được danh sách dự án: {overview.error}</p>
        ) : overview.data && overview.data.projects.length > 0 ? (
          <ul className="projects">
            {overview.data.projects.map((p) => (
              <li key={p.id}>
                <a className="project-name" href={projectPath(p.id)} onClick={link(projectPath(p.id))}>
                  {p.name}
                </a>
                {p.setup && p.setup.status !== "done" && (
                  <span className={p.setup.status === "failed" ? "pill bad" : "pill wait"}>{SETUP_TEXT[p.setup.status]}</span>
                )}
                {p.busy && <span className="pill run">Đang {p.busy}</span>}
                <span className="muted">
                  {p.surfaces} khu vực · {p.tasks.running} đang chạy · {p.tasks.you} chờ bạn · {p.tasks.queue} trong hàng chờ
                </span>
              </li>
            ))}
          </ul>
        ) : overview.loading ? (
          <p className="muted">Đang tải…</p>
        ) : (
          <p className="empty">
            Nhà máy chưa có dự án nào.{" "}
            <a href={NEW_PROJECT_PATH} onClick={link(NEW_PROJECT_PATH)}>
              Tạo dự án đầu tiên
            </a>
            .
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Máy của bạn</h2>
          {doctor.data && (
            <span className={doctor.data.ok ? "pill ok" : "pill bad"}>{doctor.data.ok ? "Đủ để chạy" : "Còn thiếu"}</span>
          )}
          <button type="button" onClick={doctor.reload} disabled={doctor.loading}>
            {doctor.loading ? "Đang kiểm tra…" : "Kiểm tra lại"}
          </button>
        </div>
        {doctor.error && <p className="error">Không chạy được kiểm tra: {doctor.error}</p>}
        {doctor.data && (
          <ul className="checks">
            {doctor.data.checks.map((c) => (
              <Check key={c.id} check={c} />
            ))}
          </ul>
        )}
        <p className="muted small">
          Giống lệnh <code>factory doctor</code>.
          {doctor.data && ` Kiểm lúc ${new Date(doctor.data.checkedAt).toLocaleTimeString("vi-VN")}.`}
        </p>
      </section>
    </>
  );
}

const STATUS_MARK: Record<CheckResult["status"], string> = { ok: "✓", warn: "!", missing: "✗", error: "✗" };

function Check({ check }: { check: CheckResult }) {
  return (
    <li className={`check check-${check.status}`}>
      <span className="mark" aria-hidden="true">
        {STATUS_MARK[check.status]}
      </span>
      <div>
        <div>
          <strong>{check.name}</strong>
          {check.version && <span className="mono"> {check.version}</span>}
          {!check.required && <span className="muted"> · không bắt buộc</span>}
        </div>
        <div className="muted">{withCode(check.detail)}</div>
        {check.fix && check.status !== "ok" && <div className="fix">{withCode(check.fix)}</div>}
      </div>
    </li>
  );
}

/** Khu vực của dự án đang chọn, tải lại khi dự án thay đổi. */
function SurfaceNav(props: { id: string; tick: number; link: LinkTo; path: string }) {
  const [surfaces, setSurfaces] = useState<SurfaceRow[]>();
  useEffect(() => {
    let live = true;
    api
      .project(props.id)
      .then((d) => live && setSurfaces(d.surfaces))
      .catch(() => live && setSurfaces([]));
    return () => {
      live = false;
    };
  }, [props.id, props.tick]);
  const page = projectPath(props.id);
  const add = newSurfacePath(props.id);
  return (
    <>
      {surfaces?.map((s) => (
        <a key={s.id} href={`${page}#kv-${s.id}`} onClick={props.link(`${page}#kv-${s.id}`)} className="nav-item">
          <span className="mono">{s.id}</span>
          <span className="muted small-inline">{s.implicit ? "gốc repo" : s.location}</span>
        </a>
      ))}
      <a href={add} onClick={props.link(add)} className="nav-item" aria-current={props.path === add ? "page" : undefined}>
        + Thêm khu vực
      </a>
    </>
  );
}

function NavGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="nav-group">
      <div className="nav-title">{title}</div>
      {children}
    </div>
  );
}

function FactoryIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V10l6 4v-4l6 4V5h6v16H3z" />
    </svg>
  );
}
