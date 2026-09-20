-- Chạy 1 lần cho DB đã có sẵn dữ liệu (KHÔNG xoá dữ liệu, khác với schema.sql):
--   wrangler d1 execute my-ai-db --file=./migration-add-api-key.sql --remote
ALTER TABLE users ADD COLUMN api_key TEXT;
ALTER TABLE users ADD COLUMN api_key_regen_count INTEGER NOT NULL DEFAULT 0;

-- Bảng lưu token MCP riêng của TỪNG người dùng (mỗi người tự dán token của họ trong Cài đặt,
-- KHÔNG dùng chung 1 token của chủ app) — xem worker/src/mcpTokens.js
CREATE TABLE IF NOT EXISTS user_mcp_tokens (
  user_id    TEXT NOT NULL,
  provider   TEXT NOT NULL,   -- 'github' | 'cloudflare' | 'notion' | 'slack' | 'gmail' | 'drive'
  token      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);
