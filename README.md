# Factory

Bộ công cụ quản lý dự án vibe code chạy trên máy của bạn. Mỗi dự án có nhiều **khu vực** làm việc (repo chính, thư mục prototype, sheet dữ liệu…). Việc được giao thành **task** theo từng yêu cầu, Claude Code hoặc Codex làm trong worktree riêng rồi mở PR để bạn duyệt. Nhà máy không bao giờ tự build hay tự phát hành; đó là những loại task chỉ chạy khi bạn tạo.

Tài liệu thiết kế nằm trong thư mục dự án `vibe-code-toolkit/` (bắt đầu từ `mo-hinh-du-an.md` và `ke-hoach-mvp.md`).

## Trạng thái

Đang ở **M3: task và Kanban**. Đã có:

- Server chạy nền trên `localhost`, giao diện có thanh trên, sidebar và màn Tổng quan.
- Cơ sở dữ liệu SQLite với các bảng dự án, khu vực, loại task, task, lần chạy và sự kiện.
- Lệnh `factory doctor` kiểm tra git, Node, gh, Claude Code, Codex.
- Bộ chạy tiến trình chung: chờ đúng PID, dọn tiến trình con còn sót, có hết giờ và huỷ.
- Tạo dự án từ thư mục có sẵn, clone, hoặc thư mục trống; duyệt bước đưa lên GitHub; thêm khu vực kiểu thư mục và chạy mốc chuẩn. Làm được trên giao diện hoặc bằng lệnh.
- Task theo máy trạng thái trong tài liệu thiết kế, Kanban cột theo trạng thái và làn theo khu vực, Hộp duyệt cho task chờ bạn, công tắc **Tạm dừng toàn bộ**.
- Đồng bộ hai chiều với GitHub Issues của repo chính.

Chưa có: chạy agent (M4).

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

## Tạo dự án và thêm khu vực

Trên giao diện: **Tổng quan → + Dự án mới**, rồi **+ Thêm khu vực** trong trang dự án. Bằng lệnh:

| Lệnh | Việc |
|---|---|
| `factory project add <thư mục> [--name TÊN]` | Kiểm thư mục rồi tạo dự án. Thêm `--new` cho thư mục trống, `--clone URL` để clone |
| `factory project publish <dự án> [--repo TÊN]` | Duyệt bước lên GitHub: tạo repo private, hoặc đẩy nhánh `factory/onboarding` và mở PR |
| `factory project list` / `show <dự án>` | Xem dự án, khu vực và mốc chuẩn |
| `factory project reload <dự án>` | Đọc lại `.factory/project.yaml` sau khi bạn sửa tay |
| `factory surface add <dự án> <id> <thư mục>` | Thêm khu vực rồi chạy mốc chuẩn |
| `factory surface baseline <dự án> <id>` | Chạy lại mốc chuẩn của một khu vực |
| `factory doctor --project <dự án>` | Chạy lệnh kiểm của từng khu vực ngay tại thư mục của nó |

`project add` và `surface add` nhận thêm `--provision`, `--check`, `--test`: lệnh chuẩn bị, lệnh kiểm và lệnh test, chạy bằng shell của máy trong thư mục của khu vực. Ví dụ với chính repo này:

```
factory project add D:\Projects\factory --name factory --provision "npm ci" --check "npm run typecheck" --test "npm test"
factory project publish factory
factory surface add factory web D:\Projects\factory\web --check "npx tsc -p tsconfig.json"
```

Với repo đã có git, nhà máy thêm khung (`.factory/project.yaml`, `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`…) trên nhánh `factory/onboarding` qua một worktree riêng, không đụng nhánh và thay đổi dở của bạn. Chưa có gì lên GitHub cho tới khi bạn chạy `publish` hoặc bấm duyệt. Mốc chuẩn chạy trên một bản sao sạch của nhánh chính, nằm ở `C:\f` trên Windows (đặt `FACTORY_WORKTREES` để đổi).

## Task và GitHub Issues

Trên giao diện: chọn dự án rồi **Task (Kanban) → + Task mới**. Bằng lệnh:

| Lệnh | Việc |
|---|---|
| `factory task add <dự án> <tiêu đề> --kind LOẠI --surface KHU_VỰC` | Tạo task. Nhiều khu vực thì ngăn bằng dấu phẩy; `--body` cho mô tả, `--after 3,#12` cho task phải xong trước |
| `factory task list <dự án>` | Xem task theo cột Kanban |
| `factory task show <id>` | Xem mô tả, bình luận và lịch sử |
| `factory sync <dự án>` | Đồng bộ với GitHub Issues ngay |

Mỗi task là một Issue trên repo chính. Nội dung (tiêu đề, mô tả, bình luận, phụ thuộc "blocked by") sửa ở nhà máy hay trên GitHub đều được; cả hai nơi cùng sửa thì lấy bản trên GitHub. Trạng thái do nhà máy giữ và đẩy lên thành label `status:*`, `surface:*`, `kind:*`; sửa tay label `status:*` thì nhà máy đặt lại. Tạo Issue mới trên GitHub (VD từ điện thoại) với label `surface:*` và `kind:*` thì task vào hàng chờ; thiếu label thì task chờ bạn nhận trong Hộp duyệt. Đóng Issue trên GitHub là huỷ task.

Server đồng bộ mỗi phút và ngay sau mỗi thay đổi trên giao diện. Dự án chưa duyệt bước lên GitHub thì nhà máy chỉ đọc Issues, task tạo tại chỗ chờ tới khi duyệt mới lên.

Mang dự án sang máy khác: clone repo rồi chạy `factory project add <thư mục>`; task được dựng lại từ Issues ngay. Duyệt bước lên GitHub (`factory project publish`) thì nhà máy mới ghi ngược lên Issues.

## Phát triển

| Lệnh | Việc |
|---|---|
| `npm test` | Test của core và server (`node --test`) |
| `npm run typecheck` | Kiểm kiểu toàn bộ, gồm cả web |
| `npm run serve` | Server ở cổng 7319 |
| `npm run dev:web` | Vite ở cổng 5173, chuyển `/api` và `/ws` sang server. Cần chạy `npm run serve` ở một cửa sổ khác |

Cấu trúc:

| Thư mục | Nội dung |
|---|---|
| `core/` | Mô hình, SQLite, đường dẫn, bộ chạy tiến trình, `doctor`, tạo dự án và khu vực, task và đồng bộ Issues |
| `server/` | HTTP + WebSocket, chạy nền, lệnh `factory` |
| `web/` | Giao diện React + Vite |
| `pack-kit/` | Giao diện cho pack (dùng từ V1) |

Quy ước viết code cho người và agent nằm trong [AGENTS.md](AGENTS.md).
