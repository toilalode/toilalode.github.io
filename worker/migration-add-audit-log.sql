-- Chạy 1 lần cho DB đã có sẵn dữ liệu (KHÔNG xoá dữ liệu, khác với schema.sql):
--   wrangler d1 execute my-ai-db --file=./migration-add-audit-log.sql --remote

-- Nhật ký các hành động KHÔNG THỂ HOÀN TÁC đã đi qua cổng xác nhận (xem IRREVERSIBLE_TOOLS trong
-- worker/src/mcpChat.js: delete_repo, revoke_access, merge_pull_request, delete_branch,
-- delete_file, delete_webhook, remove_collaborator...). KHÔNG ghi log cho tool đọc/ghi thường
-- (quá nhiều, không cần) — chỉ ghi khi có 1 quyết định đồng ý/từ chối thật sự của người dùng.
CREATE TABLE IF NOT EXISTS mcp_tool_audit_log (
  id           TEXT PRIMARY KEY,        -- uuid
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,           -- 'github' | ...
  tool_name    TEXT NOT NULL,           -- tên gốc, VD: 'delete_repo'
  args_json    TEXT NOT NULL,           -- JSON.stringify(args) — tham số gốc của lệnh gọi
  decision     TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  result_text  TEXT,                    -- kết quả trả về từ tool (rút gọn), NULL nếu decision='rejected'
  is_error     INTEGER NOT NULL DEFAULT 0, -- 1 nếu tool báo lỗi khi thực thi
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON mcp_tool_audit_log(user_id, created_at DESC);
