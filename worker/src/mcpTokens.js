// ===================== TOKEN MCP RIÊNG CỦA TỪNG NGƯỜI DÙNG =====================
// Khác với GEMINI_API_KEY_OWNER (1 key dùng chung, cấu hình 1 lần bởi chủ app), token MCP ở đây
// là CỦA RIÊNG TỪNG NGƯỜI DÙNG — mỗi người tự tạo token bên phía dịch vụ (GitHub, Cloudflare...)
// rồi dán vào Cài đặt của CHÍNH HỌ. Ai cũng dùng được tính năng MCP, nhưng mỗi người chỉ thao
// tác được trên đúng tài khoản GitHub/Cloudflare/... của họ — không đụng vào tài khoản người khác.

// Đăng ký các provider MCP đã hỗ trợ thật (PAT — dán token trực tiếp, không cần OAuth).
// Muốn thêm provider mới kiểu PAT: chỉ cần thêm 1 dòng ở đây, không cần sửa gì khác.
const MCP_PROVIDERS_PAT = {
  github: {
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    tokenHint: 'Tạo tại github.com/settings/tokens (cấp quyền repo cần dùng)',
  },
  cloudflare: {
    label: 'Cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    tokenHint: 'Tạo tại dash.cloudflare.com/profile/api-tokens (thêm quyền Account Resources: Read để tự nhận diện account)',
  },
};

// Các provider CẦN OAuth (Google, Notion, Slack không cho dán token đơn giản) — đặt sẵn ở đây để
// hiện trong danh sách Cài đặt dạng "sắp có", và để code sau này chỉ cần bổ sung oauth flow rồi
// chuyển provider từ danh sách này sang MCP_PROVIDERS_PAT (hoặc 1 danh sách OAuth riêng) là xong.
const MCP_PROVIDERS_OAUTH_PENDING = {
  gmail: { label: 'Gmail', note: 'Cần đăng ký OAuth app trên Google Cloud Console' },
  drive: { label: 'Google Drive', note: 'Cần đăng ký OAuth app trên Google Cloud Console' },
  notion: { label: 'Notion', note: 'Cần đăng ký OAuth integration trên notion.so/my-integrations' },
  slack: { label: 'Slack', note: 'Cần tạo Slack App trên api.slack.com/apps' },
};

async function getUserMcpToken(env, userId, provider) {
  const row = await env.MY_AI_DB.prepare('SELECT token FROM user_mcp_tokens WHERE user_id = ? AND provider = ?').bind(userId, provider).first();
  return row?.token || null;
}

async function setUserMcpToken(env, userId, provider, token) {
  await env.MY_AI_DB.prepare(
    'INSERT INTO user_mcp_tokens (user_id, provider, token) VALUES (?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET token = excluded.token'
  ).bind(userId, provider, token).run();
}

async function deleteUserMcpToken(env, userId, provider) {
  await env.MY_AI_DB.prepare('DELETE FROM user_mcp_tokens WHERE user_id = ? AND provider = ?').bind(userId, provider).run();
}

// Trả về danh sách provider PAT mà user này ĐÃ kết nối (đã có token), kèm url — dùng để build
// tools cho function-calling. Không trả về giá trị token thật ra ngoài hàm này (giữ bí mật).
async function getUserConnectedMcpServers(env, userId) {
  const rows = await env.MY_AI_DB.prepare('SELECT provider, token FROM user_mcp_tokens WHERE user_id = ?').bind(userId).all();
  return (rows.results || [])
    .filter(r => MCP_PROVIDERS_PAT[r.provider])
    .map(r => ({ provider: r.provider, url: MCP_PROVIDERS_PAT[r.provider].url, token: r.token }));
}

// Trạng thái kết nối (không lộ token) — dùng cho UI Cài đặt hiện "đã kết nối" hay chưa.
async function getUserMcpStatus(env, userId) {
  const rows = await env.MY_AI_DB.prepare('SELECT provider FROM user_mcp_tokens WHERE user_id = ?').bind(userId).all();
  const connected = new Set((rows.results || []).map(r => r.provider));
  const pat = Object.entries(MCP_PROVIDERS_PAT).map(([key, v]) => ({ key, label: v.label, tokenHint: v.tokenHint, connected: connected.has(key), authType: 'pat' }));
  const oauth = Object.entries(MCP_PROVIDERS_OAUTH_PENDING).map(([key, v]) => ({ key, label: v.label, note: v.note, connected: false, authType: 'oauth_pending' }));
  return [...pat, ...oauth];
}

export { MCP_PROVIDERS_PAT, getUserMcpToken, setUserMcpToken, deleteUserMcpToken, getUserConnectedMcpServers, getUserMcpStatus };
