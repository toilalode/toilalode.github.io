-- Chạy 1 lần cho DB đã có sẵn dữ liệu (KHÔNG xoá dữ liệu, khác với schema.sql):
--   wrangler d1 execute my-ai-db --file=./migration-add-api-key.sql --remote
ALTER TABLE users ADD COLUMN api_key TEXT;
ALTER TABLE users ADD COLUMN api_key_regen_count INTEGER NOT NULL DEFAULT 0;
