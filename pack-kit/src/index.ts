// Thư viện cho script của pack (dac-ta-pack.md mục 11). MVP chưa có pack nào;
// gói này mới chỉ giữ kiểu dữ liệu chung để lõi và pack dùng cùng một định nghĩa.

/** Lệnh chuẩn của một mặt. MVP đọc thẳng từ `commands` của mặt trong `.factory/project.yaml`. */
export interface SurfaceCommands {
  provision?: string;
  check?: string;
  test?: string;
  "test.unit"?: string;
  "test.e2e"?: string;
  build?: string;
  [name: string]: string | undefined;
}
