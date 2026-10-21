import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  useLoad,
  type BoardResponse,
  type InboxResponse,
  type KanbanColumn,
  type TaskDetail,
  type TaskEvent,
  type TaskLink,
  type TaskStatus,
  type TaskView,
  type UserAction,
} from "./api.ts";
import { projectPath, withCode, type LinkTo } from "./projects.tsx";

export const boardPath = (id: string) => `${projectPath(id)}/task`;
export const taskPath = (id: string, taskId: number) => `${boardPath(id)}/${taskId}`;

const COLUMNS: { key: KanbanColumn; name: string }[] = [
  { key: "queue", name: "Hàng chờ" },
  { key: "running", name: "Đang chạy" },
  { key: "you", name: "Chờ bạn" },
  { key: "done", name: "Xong" },
];

const STATUS_TEXT: Record<TaskStatus, string> = {
  proposed: "Chờ bạn nhận",
  queued: "Chờ tới lượt",
  blocked: "Bị chặn",
  preparing: "Đang chuẩn bị",
  running: "Agent đang làm",
  checking: "Đang kiểm",
  applying: "Đang áp vào",
  waiting_gate: "Chờ bạn duyệt",
  waiting_answer: "Chờ bạn trả lời",
  waiting_human: "Chờ bạn làm",
  stuck: "Stuck",
  done: "Xong",
  rejected: "Không nhận",
  cancelled: "Đã huỷ",
};

const BLOCKED_TEXT: Record<string, string> = {
  depends_on: "chờ task khác xong",
  children: "chờ task con",
  resource: "chờ tài nguyên",
  quota: "hết hạn mức",
  agent_offline: "agent mất đăng nhập",
  tool_disabled: "công cụ đang tắt",
  surface_paused: "khu vực đang tạm dừng",
  kind_paused: "loại task đang tạm dừng",
  budget: "hết ngân sách",
};

const ACTION_LABEL: Record<UserAction, string> = {
  accept: "Nhận",
  reject: "Không nhận",
  cancel: "Huỷ task",
  resume: "Chạy tiếp",
  request_changes: "Yêu cầu sửa",
};

/** Dòng cho biết vì sao task nằm ở cột đó. */
function statusLine(t: TaskView, refs: Map<number, string>): string {
  if (t.status === "blocked") {
    if (t.blockedReason === "depends_on") return `Chặn: chờ ${t.dependsOn.map((d) => refs.get(d) ?? `T-${d}`).join(", ")}`;
    return `Chặn: ${BLOCKED_TEXT[t.blockedReason ?? ""] ?? t.blockedReason}`;
  }
  if (t.status === "stuck" && t.stuckReason) return `Stuck: ${t.stuckReason}`;
  return STATUS_TEXT[t.status];
}

const pillClass = (c: KanbanColumn) => ({ queue: "pill", running: "pill run", you: "pill wait", done: "pill ok" })[c];

// ───────── Kanban ─────────

const MULTI = "_nhieu";
const DONE_SHOWN = 12;

export function BoardPage(props: { id: string; tick: number; link: LinkTo }) {
  const board = useLoad(() => api.board(props.id));
  const reload = board.reload;
  useEffect(() => {
    if (props.tick > 0) reload();
  }, [props.tick, reload]);
  const [adding, setAdding] = useState(false);
  const [surface, setSurface] = useState("");
  const [kind, setKind] = useState("");
  const [lanes, setLanes] = useState(true);
  const [syncError, setSyncError] = useState<string>();

  const b = board.data;
  if (board.error && !b) return <p className="error card">Không đọc được task: {withCode(board.error)}</p>;
  if (!b) return <p className="muted">Đang tải…</p>;

  const refs = new Map(b.tasks.map((t) => [t.id, t.ref]));
  const shown = b.tasks.filter((t) => (!surface || (surface === MULTI ? t.surfaces.length > 1 : t.surfaces.includes(surface))) && (!kind || t.kind === kind));
  const laneKeys = lanes ? [...b.surfaces.map((s) => s.id), MULTI].filter((k) => shown.some((t) => laneOf(t) === k)) : [""];

  const sync = async () => {
    setSyncError(undefined);
    try {
      await api.sync(props.id);
      reload();
    } catch (err) {
      setSyncError((err as Error).message);
    }
  };

  return (
    <>
      {b.paused && (
        <section className="card banner">
          Cả nhà máy đang tạm dừng: không mở lần chạy mới ở dự án nào. Lần chạy đang dở vẫn được làm xong.
        </section>
      )}
      <section className="card">
        <div className="card-head">
          <h2>Task</h2>
          <SyncState board={b} />
          {b.project.githubRepo && (
            <button type="button" onClick={() => void sync()} disabled={b.sync.running}>
              {b.sync.running ? "Đang đồng bộ…" : "Đồng bộ ngay"}
            </button>
          )}
          <button type="button" className="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            + Task mới
          </button>
        </div>
        {syncError && <p className="error">{withCode(syncError)}</p>}
        {b.sync.lastError && !b.sync.running && <p className="error">Lần đồng bộ trước lỗi: {withCode(b.sync.lastError)}</p>}
        {adding && (
          <NewTaskForm
            board={b}
            onDone={() => {
              setAdding(false);
              reload();
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        <div className="filters">
          <label>
            Khu vực
            <select value={surface} onChange={(e) => setSurface(e.target.value)}>
              <option value="">Tất cả</option>
              {b.surfaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
              <option value={MULTI}>nhiều khu vực</option>
            </select>
          </label>
          <label>
            Loại
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Tất cả</option>
              {b.kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.key}
                </option>
              ))}
            </select>
          </label>
          <label className="check-inline">
            <input type="checkbox" checked={lanes} onChange={(e) => setLanes(e.target.checked)} />
            Chia làn theo khu vực
          </label>
        </div>
      </section>

      {b.tasks.length === 0 ? (
        <section className="card empty">
          Chưa có task. Bấm <strong>+ Task mới</strong>, hoặc tạo Issue trên repo chính với label <code>surface:*</code> và <code>kind:*</code>.
        </section>
      ) : (
        <div className="board" role="region" aria-label="Bảng task">
          <div className="board-row board-head">
            {lanes && <div className="lane-name" />}
            {COLUMNS.map((c) => (
              <div key={c.key} className="column-head">
                {c.name} <span className="muted">{shown.filter((t) => t.column === c.key).length}</span>
              </div>
            ))}
          </div>
          {laneKeys.map((lane) => (
            <div key={lane || "all"} className="board-row">
              {lanes && (
                <div className="lane-name">
                  <span className="mono">{lane === MULTI ? "nhiều khu vực" : lane}</span>
                </div>
              )}
              {COLUMNS.map((c) => {
                const cards = shown.filter((t) => t.column === c.key && (!lanes || laneOf(t) === lane));
                const visible = c.key === "done" ? [...cards].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, DONE_SHOWN) : cards;
                return (
                  <div key={c.key} className="column" aria-label={c.name}>
                    {visible.map((t) => (
                      <TaskCard key={t.id} task={t} refs={refs} href={taskPath(props.id, t.id)} link={props.link} />
                    ))}
                    {cards.length === 0 && <span className="column-empty">Trống</span>}
                    {cards.length > visible.length && <span className="muted small-inline">và {cards.length - visible.length} task cũ hơn</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const laneOf = (t: TaskView) => (t.surfaces.length > 1 ? MULTI : (t.surfaces[0] ?? ""));

function TaskCard(props: { task: TaskView; refs: Map<number, string>; href: string; link: LinkTo }) {
  const t = props.task;
  return (
    <a className={`task-card col-${t.column}`} href={props.href} onClick={props.link(props.href)}>
      <span className="task-card-top">
        <span className="mono">{t.ref}</span>
        <span className="tag">{t.kind}</span>
        <span className="muted small-inline">{t.surfaces.join(" + ")}</span>
        {t.origin !== "user" && t.status === "proposed" && <span className="tag">đề xuất</span>}
      </span>
      <span className="task-title">{t.title}</span>
      <span className="task-status">{statusLine(t, props.refs)}</span>
    </a>
  );
}

function SyncState({ board }: { board: BoardResponse }) {
  if (!board.project.githubRepo) return <span className="muted small-inline">Dự án chưa lên GitHub, task giữ tại chỗ</span>;
  const { lastOkAt, pending } = board.sync;
  return (
    <span className="muted small-inline">
      Issues trên {board.project.githubRepo}
      {lastOkAt ? ` · đồng bộ lúc ${new Date(lastOkAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}` : " · chưa đồng bộ"}
      {pending > 0 && ` · ${pending} task chưa đẩy lên`}
    </span>
  );
}

function NewTaskForm(props: { board: BoardResponse; onDone: () => void; onCancel: () => void }) {
  const b = props.board;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [surfaces, setSurfaces] = useState<string[]>(b.surfaces.length === 1 ? [b.surfaces[0]!.id] : []);
  const [kind, setKind] = useState("make");
  const [after, setAfter] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open = b.tasks.filter((t) => t.column !== "done");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (surfaces.length === 0) {
      setError("Chọn ít nhất một khu vực");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.createTask(b.project.id, { title, body, kind, surfaces, ...(after.length ? { dependsOn: after } : {}) });
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="form new-task" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field-label">Yêu cầu</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="VD: Thêm nút đăng xuất ở thanh trên" />
      </label>
      <label className="field">
        <span className="field-label">Mô tả</span>
        <span className="field-hint">Gõ như nói với người làm cùng: cần gì, xong thì trông thế nào.</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </label>
      <fieldset className="choices">
        <legend>Khu vực</legend>
        {b.surfaces.map((s) => (
          <label key={s.id} className="choice">
            <input
              type="checkbox"
              checked={surfaces.includes(s.id)}
              onChange={(e) => setSurfaces((all) => (e.target.checked ? [...all, s.id] : all.filter((x) => x !== s.id)))}
            />
            <span>
              <span className="mono">{s.id}</span>
              <span className="muted small-inline">{s.id === "main" ? "gốc repo" : s.location}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="actions">
        <label className="inline">
          Loại task
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {b.kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.key}: {k.name}
                {k.source === "project" ? " (của dự án)" : ""}
              </option>
            ))}
          </select>
        </label>
        {open.length > 0 && (
          <label className="inline">
            Làm sau các task (giữ Ctrl để chọn nhiều)
            <select multiple value={after.map(String)} onChange={(e) => setAfter([...e.target.selectedOptions].map((o) => Number(o.value)))} size={Math.min(4, open.length)}>
              {open.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.ref} {t.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="muted small-inline">
        Hoặc tạo Issue trên repo chính với label <code>surface:*</code> và <code>kind:*</code>; nhà máy tự nhận về.
      </p>
      {error && <p className="error">{withCode(error)}</p>}
      <div className="actions">
        <button type="button" onClick={props.onCancel}>
          Huỷ
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Đang tạo…" : "Tạo task"}
        </button>
      </div>
    </form>
  );
}

// ───────── Chi tiết task ─────────

export function TaskPage(props: { id: string; taskId: number; tick: number; link: LinkTo }) {
  const detail = useLoad(() => api.task(props.taskId));
  const board = useLoad(() => api.board(props.id));
  const reloadDetail = detail.reload;
  const reloadBoard = board.reload;
  useEffect(() => {
    if (props.tick === 0) return;
    reloadDetail();
    reloadBoard();
  }, [props.tick, reloadDetail, reloadBoard]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const d = detail.data;
  if (detail.error && !d) return <p className="error card">Không đọc được task: {withCode(detail.error)}</p>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const t = d.task;
  const repo = board.data?.project.githubRepo;
  const refs = new Map((board.data?.tasks ?? []).map((x) => [x.id, x.ref]));

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      reloadDetail();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const act = (action: UserAction) => void run(() => api.act(t.id, action, comment.trim() || undefined)).then((ok) => ok && setComment(""));

  return (
    <>
      <p>
        <a href={boardPath(props.id)} onClick={props.link(boardPath(props.id))}>
          ← Bảng task
        </a>
      </p>
      <section className="card">
        <div className="card-head">
          <h2>
            <span className="mono">{t.ref}</span> {t.title}
          </h2>
          <span className={pillClass(t.column)}>{statusLine(t, refs)}</span>
          {!editing && t.column !== "done" && (
            <button type="button" onClick={() => setEditing(true)}>
              Sửa
            </button>
          )}
        </div>
        {editing && board.data ? (
          <EditTaskForm
            detail={d}
            board={board.data}
            onDone={() => {
              setEditing(false);
              reloadDetail();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className="facts">
              <dt>Khu vực</dt>
              <dd className="mono">{t.surfaces.join(", ")}</dd>
              <dt>Loại</dt>
              <dd className="mono">{t.kind}</dd>
              <dt>GitHub</dt>
              <dd>
                {t.githubIssue && repo ? (
                  <a href={`https://github.com/${repo}/issues/${t.githubIssue}`} target="_blank" rel="noreferrer">
                    Issue #{t.githubIssue}
                  </a>
                ) : repo ? (
                  "Chưa có Issue, sẽ tạo ở lần đồng bộ tới"
                ) : (
                  "Dự án chưa lên GitHub"
                )}
                {t.dirty && t.githubIssue ? <span className="muted"> · có thay đổi chưa đẩy lên</span> : null}
              </dd>
              {d.dependsOn.length > 0 && (
                <>
                  <dt>Làm sau</dt>
                  <dd>
                    <TaskLinks links={d.dependsOn} project={props.id} link={props.link} />
                  </dd>
                </>
              )}
              {d.dependents.length > 0 && (
                <>
                  <dt>Task chờ nó</dt>
                  <dd>
                    <TaskLinks links={d.dependents} project={props.id} link={props.link} />
                  </dd>
                </>
              )}
            </dl>
            {t.body ? <div className="task-body">{t.body}</div> : <p className="muted">Chưa có mô tả.</p>}
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Bình luận</h2>
        </div>
        {d.comments.length === 0 && <p className="muted">Chưa có bình luận.</p>}
        <ul className="comments">
          {d.comments.map((c) => (
            <li key={c.id}>
              <div className="muted small-inline">
                <strong>{c.author === "you" ? "Bạn" : c.author}</strong> · {formatTime(c.createdAt)}
                {c.githubId === null && repo ? " · chưa lên GitHub" : ""}
              </div>
              <div className="task-body">{c.body}</div>
            </li>
          ))}
        </ul>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!comment.trim()) return;
            void run(() => api.comment(t.id, comment.trim())).then((ok) => ok && setComment(""));
          }}
        >
          <label className="field">
            <span className="field-label">Viết bình luận</span>
            <span className="field-hint">Đi lên Issue và vào ngữ cảnh lần chạy sau. Bấm một hành động bên dưới thì bình luận đi kèm hành động đó.</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy || !comment.trim()}>
              Gửi bình luận
            </button>
            {t.actions.map((a) => (
              <button key={a} type="button" className={a === "accept" || a === "resume" ? "primary" : a === "cancel" || a === "reject" ? "danger" : ""} disabled={busy} onClick={() => act(a)}>
                {ACTION_LABEL[a]}
              </button>
            ))}
          </div>
          {error && <p className="error">{withCode(error)}</p>}
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Lịch sử</h2>
        </div>
        <ol className="history">
          {d.history.map((e) => (
            <li key={e.id}>
              <span className="muted small-inline">{formatTime(e.ts)}</span> {describe(e)}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function TaskLinks(props: { links: TaskLink[]; project: string; link: LinkTo }) {
  return (
    <span className="task-links">
      {props.links.map((l) => (
        <a key={l.id} href={taskPath(props.project, l.id)} onClick={props.link(taskPath(props.project, l.id))}>
          <span className="mono">{l.ref}</span> {l.title} <span className="muted">({STATUS_TEXT[l.status].toLowerCase()})</span>
        </a>
      ))}
    </span>
  );
}

function EditTaskForm(props: { detail: TaskDetail; board: BoardResponse; onDone: () => void; onCancel: () => void }) {
  const t = props.detail.task;
  const notStarted = ["queued", "blocked", "proposed"].includes(t.status);
  const [title, setTitle] = useState(t.title);
  const [body, setBody] = useState(t.body);
  const [kind, setKind] = useState(t.kind);
  const [surfaces, setSurfaces] = useState(t.surfaces);
  const [after, setAfter] = useState(t.dependsOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const others = props.board.tasks.filter((x) => x.id !== t.id && (x.column !== "done" || t.dependsOn.includes(x.id)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.editTask(t.id, { title, body, ...(notStarted ? { kind, surfaces } : {}), dependsOn: after });
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field-label">Yêu cầu</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="field">
        <span className="field-label">Mô tả</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
      </label>
      {notStarted ? (
        <>
          <fieldset className="choices">
            <legend>Khu vực</legend>
            {props.board.surfaces.map((s) => (
              <label key={s.id} className="choice">
                <input
                  type="checkbox"
                  checked={surfaces.includes(s.id)}
                  onChange={(e) => setSurfaces((all) => (e.target.checked ? [...all, s.id] : all.filter((x) => x !== s.id)))}
                />
                <span className="mono">{s.id}</span>
              </label>
            ))}
          </fieldset>
          <label className="inline">
            Loại task
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {props.board.kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.key}: {k.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <p className="muted">Task đã chạy nên không đổi được khu vực và loại.</p>
      )}
      {others.length > 0 && (
        <label className="inline">
          Làm sau các task
          <select multiple value={after.map(String)} onChange={(e) => setAfter([...e.target.selectedOptions].map((o) => Number(o.value)))} size={Math.min(5, others.length)}>
            {others.map((x) => (
              <option key={x.id} value={x.id}>
                {x.ref} {x.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="error">{withCode(error)}</p>}
      <div className="actions">
        <button type="button" onClick={props.onCancel}>
          Huỷ
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Đang lưu…" : "Lưu"}
        </button>
      </div>
    </form>
  );
}

const BY: Record<string, string> = { you: "bạn", core: "nhà máy", github: "GitHub", user: "bạn", agent: "agent", links: "nhà máy" };

function describe(e: TaskEvent): ReactNode {
  const p = e.payload as Record<string, unknown>;
  const by = BY[String(p.by)] ?? String(p.by ?? "");
  switch (e.type) {
    case "task.transition":
      return (
        <>
          {p.from ? `${STATUS_TEXT[p.from as TaskStatus]} → ` : ""}
          <strong>{STATUS_TEXT[p.to as TaskStatus]}</strong>
          {p.reason ? `: ${String(p.reason)}` : ""} <span className="muted">({by})</span>
        </>
      );
    case "task.edited":
      return `Sửa ${(p.fields as string[]).map((f) => FIELD[f] ?? f).join(", ")} (${by})`;
    case "task.comment":
      return `Bình luận của ${String(p.author) === "you" ? "bạn" : String(p.author)}${p.fromIssue ? " trên GitHub" : ""}${p.edited ? " được sửa" : ""}`;
    case "task.issue":
      return `Tạo Issue #${String(p.issue)}`;
    default:
      return e.type;
  }
}

const FIELD: Record<string, string> = { title: "tiêu đề", body: "mô tả", kind: "loại", surfaces: "khu vực", dependsOn: "phụ thuộc" };

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

// ───────── Hộp duyệt ─────────

export function InboxPage(props: { tick: number; link: LinkTo }) {
  const inbox = useLoad(() => api.inbox());
  const reload = inbox.reload;
  useEffect(() => {
    if (props.tick > 0) reload();
  }, [props.tick, reload]);
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState<string>();
  const data: InboxResponse | undefined = inbox.data;
  const empty = useMemo(() => data && data.projects.length === 0, [data]);

  if (inbox.error && !data) return <p className="error card">Không đọc được hộp duyệt: {withCode(inbox.error)}</p>;
  if (!data) return <p className="muted">Đang tải…</p>;

  const act = async (taskId: number, action: UserAction) => {
    setBusy(taskId);
    setError(undefined);
    try {
      await api.act(taskId, action);
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      {error && <p className="error card">{withCode(error)}</p>}
      {empty && <section className="card empty">Không có việc nào chờ bạn. Duyệt PR và câu hỏi của agent sẽ vào đây từ M4.</section>}
      {data.projects.map((p) => (
        <section key={p.id} className="card">
          <div className="card-head">
            <h2>{p.name}</h2>
            <a href={boardPath(p.id)} onClick={props.link(boardPath(p.id))}>
              Bảng task
            </a>
          </div>
          <ul className="inbox-list">
            {p.setup && (
              <li>
                <span className="pill wait">Duyệt lên GitHub</span>
                <a href={projectPath(p.id)} onClick={props.link(projectPath(p.id))}>
                  Đưa dự án lên GitHub (bước {p.setup.step})
                </a>
              </li>
            )}
            {p.tasks.map((t) => (
              <li key={t.id}>
                <span className="pill wait">{STATUS_TEXT[t.status]}</span>
                <a href={taskPath(p.id, t.id)} onClick={props.link(taskPath(p.id, t.id))}>
                  <span className="mono">{t.ref}</span> {t.title}
                </a>
                <span className="muted small-inline">
                  {t.kind} · {t.surfaces.join(" + ")}
                </span>
                <span className="inbox-actions">
                  {t.actions
                    .filter((a) => a !== "cancel")
                    .map((a) => (
                      <button key={a} type="button" className={a === "accept" || a === "resume" ? "primary" : ""} disabled={busy === t.id} onClick={() => void act(t.id, a)}>
                        {ACTION_LABEL[a]}
                      </button>
                    ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
