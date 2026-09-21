// ===================== TOKEN MCP RIÊNG CỦA TỪNG NGƯỜI DÙNG =====================
// Khác với GEMINI_API_KEY_OWNER (1 key dùng chung, cấu hình 1 lần bởi chủ app), token MCP ở đây
// là CỦA RIÊNG TỪNG NGƯỜI DÙNG. Ai cũng dùng được tính năng MCP, nhưng mỗi người chỉ thao tác
// được trên đúng tài khoản GitHub/Google/Cloudflare... của họ — không đụng vào tài khoản người khác.
//
// 2 kiểu kết nối:
//   - OAuth  (Gmail, Google Drive) -> bấm nút, đăng nhập qua trang provider, tự động lưu.
//   - PAT    (GitHub, Cloudflare) -> tự tạo token bên phía đó rồi dán vào, không cần OAuth.
// (Cloudflare OAuth dùng cơ chế "đăng ký client động" phức tạp hơn OAuth cổ điển; còn GitHub thì
//  server MCP api.githubcopilot.com/mcp CHỈ chấp nhận OAuth từ 1 danh sách ứng dụng được GitHub
//  cho phép sẵn — VS Code, JetBrains, Cursor... — OAuth App tự tạo LUÔN bị từ chối kiểu "unknown
//  integration" dù token đúng, không có cách nào lách được. PAT thì server này chấp nhận bình
//  thường với BẤT KỲ ai, không cần Copilot license — nên GitHub dùng PAT là lựa chọn ĐÚNG, không
//  phải PAT "kém hơn" OAuth ở đây.)

const MCP_PROVIDERS_OAUTH = {
  // native:true nghĩa là KHÔNG gọi qua giao thức MCP thật (không có url MCP) — thay vào đó dùng
  // bộ công cụ REST tự viết (xem githubNativeTools.js), vì server MCP thật của GitHub chặn app lạ.
  github: { label: 'GitHub', native: true },
  gmail: { label: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
  drive: { label: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1' },
};

const MCP_PROVIDERS_PAT = {
  cloudflare: {
    label: 'Cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    tokenHint: 'Tạo tại dash.cloudflare.com/profile/api-tokens (thêm quyền Account Resources: Read để tự nhận diện account)',
  },
};

// Provider CẦN OAuth nhưng CHƯA làm (Notion, Slack) — hiện trong Cài đặt dạng "sắp có".
const MCP_PROVIDERS_OAUTH_PENDING = {
  notion: { label: 'Notion', note: 'Cần đăng ký OAuth integration trên notion.so/my-integrations' },
  slack: { label: 'Slack', note: 'Cần tạo Slack App trên api.slack.com/apps' },
};

import { refreshTokenIfNeeded } from './mcpOAuth.js';

async function setUserMcpToken(env, userId, provider, token, refreshToken = null, expiresAt = null) {
  await env.MY_AI_DB.prepare(
    `INSERT INTO user_mcp_tokens (user_id, provider, token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET token = excluded.token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
  ).bind(userId, provider, token, refreshToken, expiresAt).run();
}

async function deleteUserMcpToken(env, userId, provider) {
  await env.MY_AI_DB.prepare('DELETE FROM user_mcp_tokens WHERE user_id = ? AND provider = ?').bind(userId, provider).run();
}

// Trả về danh sách MCP server mà user này ĐÃ kết nối (OAuth lẫn PAT), kèm url + token SẴN SÀNG
// DÙNG (đã tự refresh nếu là Google và access token hết hạn) — dùng để build tools function-calling.
async function getUserConnectedMcpServers(env, userId) {
  const rows = await env.MY_AI_DB.prepare('SELECT * FROM user_mcp_tokens WHERE user_id = ?').bind(userId).all();
  const out = [];
  for (const row of rows.results || []) {
    const meta = MCP_PROVIDERS_OAUTH[row.provider] || MCP_PROVIDERS_PAT[row.provider];
    if (!meta) continue;
    let token = row.token;
    try {
      if (MCP_PROVIDERS_OAUTH[row.provider]) token = await refreshTokenIfNeeded(env, row.provider, row);
    } catch (e) { continue; } // refresh lỗi (token bị thu hồi...) -> bỏ qua server này, không làm hỏng cả request
    out.push({ provider: row.provider, url: meta.url, native: !!meta.native, token });
  }
  return out;
}

// Trạng thái kết nối (không lộ token) — dùng cho UI Cài đặt hiện "đã kết nối" hay chưa.
async function getUserMcpStatus(env, userId) {
  const rows = await env.MY_AI_DB.prepare('SELECT provider FROM user_mcp_tokens WHERE user_id = ?').bind(userId).all();
  const connected = new Set((rows.results || []).map(r => r.provider));
  const oauth = Object.entries(MCP_PROVIDERS_OAUTH).map(([key, v]) => ({ key, label: v.label, connected: connected.has(key), authType: 'oauth' }));
  const pat = Object.entries(MCP_PROVIDERS_PAT).map(([key, v]) => ({ key, label: v.label, tokenHint: v.tokenHint, connected: connected.has(key), authType: 'pat' }));
  const pending = Object.entries(MCP_PROVIDERS_OAUTH_PENDING).map(([key, v]) => ({ key, label: v.label, note: v.note, connected: false, authType: 'oauth_pending' }));
  return [...oauth, ...pat, ...pending];
}

export { MCP_PROVIDERS_OAUTH, MCP_PROVIDERS_PAT, setUserMcpToken, deleteUserMcpToken, getUserConnectedMcpServers, getUserMcpStatus };
