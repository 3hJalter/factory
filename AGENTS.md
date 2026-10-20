# Hướng dẫn cho agent làm việc trong repo này

## Chạy và kiểm

- `npm test` và `npm run typecheck` phải xanh trước khi mở PR.
- **Không tự build hay tự phát hành** (`npm run build`, gắn tag, tạo release) trừ khi task yêu cầu rõ. Kiểm tra giao diện bằng `npm run dev:web`.
- Đừng chạy `factory autostart on` hay sửa Task Scheduler, cấu hình toàn cục của Claude hoặc Codex.

## Code

- Node ≥ 22.18 chạy thẳng TypeScript bằng type stripping. Chỉ dùng cú pháp xoá được: không `enum`, không `namespace`, không tham số kiểu `constructor(private x)`. Import nội bộ ghi rõ đuôi `.ts`. Import chỉ để lấy kiểu thì dùng `import type`.
- `node:sqlite` (`DatabaseSync`) là cơ sở dữ liệu. Đổi lược đồ bằng cách **thêm** một phần tử vào `MIGRATIONS` trong `core/src/db.ts`, không sửa migration cũ.
- Mọi tiến trình con chạy qua `runProcess` trong `core/src/proc.ts` để được chờ đúng PID và dọn tiến trình sót. Không gọi `child_process` trực tiếp ở chỗ khác.
- Tên trạng thái, lý do chặn, cổng duyệt lấy theo `core/src/model.ts`, khớp với tài liệu thiết kế `may-trang-thai-ticket.md`.
- Chuỗi hiển thị cho người dùng viết bằng tiếng Việt. Tên biến, hàm và commit message viết bằng tiếng Anh.
- Thêm test cạnh code: `core/test/*.test.ts`, `server/test/*.test.ts`, dùng `node:test`.

## Ranh giới

- Server chỉ nghe `127.0.0.1` và kiểm Host/Origin; đừng nới.
- Dữ liệu chạy nằm ở `FACTORY_HOME`, không ghi vào repo.
