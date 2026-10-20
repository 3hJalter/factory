# Factory

Bộ công cụ quản lý dự án vibe code chạy trên máy của bạn. Mỗi dự án có nhiều **khu vực** làm việc (repo chính, thư mục prototype, sheet dữ liệu…). Việc được giao thành **task** theo từng yêu cầu, Claude Code hoặc Codex làm trong worktree riêng rồi mở PR để bạn duyệt. Nhà máy không bao giờ tự build hay tự phát hành; đó là những loại task chỉ chạy khi bạn tạo.

Tài liệu thiết kế nằm trong thư mục dự án `vibe-code-toolkit/` (bắt đầu từ `mo-hinh-du-an.md` và `ke-hoach-mvp.md`).

## Trạng thái

Đang ở **M1: bộ khung**. Đã có:

- Server chạy nền trên `localhost`, giao diện có thanh trên, sidebar và màn Tổng quan rỗng.
- Cơ sở dữ liệu SQLite với các bảng dự án, khu vực, loại task, task, lần chạy và sự kiện.
- Lệnh `factory doctor` kiểm tra git, Node, gh, Claude Code, Codex.
- Bộ chạy tiến trình chung: chờ đúng PID, dọn tiến trình con còn sót, có hết giờ và huỷ.

Chưa có: tạo dự án và khu vực (M2), task và Kanban (M3), chạy agent (M4).

## Cần có trên máy

- Node.js **22.18** trở lên (chạy thẳng file `.ts`, không cần bước biên dịch).
- Git và GitHub CLI (`gh`), đã `gh auth login`.
- Ít nhất một agent: Claude Code hoặc Codex CLI.

## Cài đặt

Chạy lần lượt từng lệnh:

```
git clone https://github.com/3hJalter/factory.git
cd factory
npm install
npm run build
npm run factory -- doctor
```

`npm run build` dựng giao diện web vào `web/dist`; `factory doctor` kiểm tra công cụ trên máy.

Muốn gõ `factory` ở mọi nơi thì chạy thêm `npm link` trong thư mục repo.

## Dùng

| Lệnh | Việc |
|---|---|
| `factory start` | Bật server chạy nền, mở địa chỉ in ra (mặc định http://localhost:7319) |
| `factory status` | Xem server có đang chạy không |
| `factory stop` | Tắt server |
| `factory serve` | Chạy server ngay trong terminal, Ctrl+C để dừng |
| `factory autostart on` / `off` | Tự bật server khi đăng nhập Windows (Task Scheduler, không cần quyền admin) |
| `factory doctor [--json]` | Kiểm tra công cụ trên máy |

Đổi cổng bằng `--port N` hoặc biến môi trường `FACTORY_PORT`.

Dữ liệu chạy (cơ sở dữ liệu, log) nằm ngoài repo: `%APPDATA%\factory` trên Windows, `~/.local/share/factory` trên Linux và macOS. Đặt `FACTORY_HOME` để dùng thư mục khác.

Server chỉ nghe trên `127.0.0.1` và từ chối yêu cầu có Host hoặc Origin lạ, để trang web khác không gọi được API của nhà máy.

## Phát triển

| Lệnh | Việc |
|---|---|
| `npm test` | Test của core và server (`node --test`) |
| `npm run typecheck` | Kiểm kiểu toàn bộ, gồm cả web |
| `npm run serve` | Server ở cổng 7319 |
| `npm run dev:web` | Vite ở cổng 5173, chuyển `/api` và `/ws` sang server |

Cấu trúc:

| Thư mục | Nội dung |
|---|---|
| `core/` | Mô hình, SQLite, đường dẫn, bộ chạy tiến trình, `doctor` |
| `server/` | HTTP + WebSocket, chạy nền, lệnh `factory` |
| `web/` | Giao diện React + Vite |
| `pack-kit/` | Giao diện cho pack (dùng từ V1) |

Quy ước viết code cho người và agent nằm trong [AGENTS.md](AGENTS.md).
