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
} from "./api.ts";

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

function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    if (to === location.pathname) return;
    history.pushState(null, "", to);
    setPath(to);
  }, []);
  return [path, go];
}

export function App() {
  const [path, go] = usePath();
  const overview = useLoad(() => api.overview());
  const doctor = useLoad((again) => api.doctor(again));
  const reloadOverview = overview.reload;

  const connection = useServerEvents(
    useCallback(
      (e) => {
        if (e.type !== "hello") reloadOverview();
      },
      [reloadOverview],
    ),
  );

  const route = FACTORY_ROUTES.find((r) => r.path === path) ?? FACTORY_ROUTES[0]!;
  useEffect(() => {
    document.title = route.path === "/" ? "Factory" : `${route.title} · Factory`;
  }, [route]);

  const link = (to: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(to);
  };

  return (
    <div className="app">
      <TopBar overview={overview.data} connection={connection} link={link} />
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
            <p className="nav-empty">Chưa có dự án nào nên chưa có khu vực. Tạo dự án và thêm khu vực có từ M2.</p>
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
            {route.path === "/" ? (
              <OverviewPage overview={overview} doctor={doctor} />
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
  link: (to: string) => (e: MouseEvent) => void;
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
        <select aria-label="Chọn dự án" disabled={projects.length === 0}>
          {projects.length === 0 ? (
            <option>Chưa có dự án</option>
          ) : (
            projects.map((p) => <option key={p.id}>{p.name}</option>)
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

function OverviewPage(props: { overview: Loaded<OverviewResponse>; doctor: Loaded<DoctorReport> }) {
  const { overview, doctor } = props;
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Dự án</h2>
        </div>
        {overview.error ? (
          <p className="error">Không đọc được danh sách dự án: {overview.error}</p>
        ) : overview.data && overview.data.projects.length > 0 ? (
          <ul className="projects">
            {overview.data.projects.map((p) => (
              <li key={p.id}>
                <span className="project-name">{p.name}</span>
                <span className="muted">
                  {p.surfaces} khu vực · {p.tasks.running} đang chạy · {p.tasks.you} chờ bạn · {p.tasks.queue} trong hàng chờ
                </span>
              </li>
            ))}
          </ul>
        ) : overview.loading ? (
          <p className="muted">Đang tải…</p>
        ) : (
          <p className="empty">Nhà máy chưa có dự án nào. Wizard tạo dự án có từ M2.</p>
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

/** Hiện phần nằm giữa hai dấu ` thành mã, giống đầu ra của `factory doctor`. */
function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
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
