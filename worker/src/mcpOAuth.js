// ===================== OAUTH CHO MCP (GitHub, Gmail, Drive) =====================
// Luồng chuẩn Authorization Code: /oauth/start -> redirect người dùng sang trang đăng nhập của
// provider -> họ đồng ý -> provider redirect về /oauth/callback kèm "code" -> worker đổi code
// lấy access_token (+ refresh_token với Google) -> lưu vào D1 (user_mcp_tokens), gắn với user
// đang đăng nhập (biết được nhờ "state" — 1 chuỗi ngẫu nhiên lưu tạm trong KV, ánh xạ sang userId).
//
// Cấu hình cần thiết (wrangler secret put ... hoặc dashboard):
//   GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET
//     -> Tạo tại: github.com/settings/developers -> "New OAuth App"
//     -> Authorization callback URL PHẢI đúng: <API_BASE>/api/mcp/oauth/callback
//   GOOGLE_MCP_CLIENT_ID / GOOGLE_MCP_CLIENT_SECRET
//     -> Tạo tại: console.cloud.google.com -> APIs & Services -> Credentials -> OAuth client ID
//        (loại "Web application")
//     -> Authorized redirect URI PHẢI đúng: <API_BASE>/api/mcp/oauth/callback
//     -> Dùng CHUNG 1 client cho cả Gmail và Drive (2 lượt kết nối riêng, scope khác nhau)
//     -> LƯU Ý: Gmail/Drive MCP hiện là "Developer Preview" của Google — tài khoản Google Cloud
//        của bạn cần được duyệt tham gia chương trình này thì mới thật sự gọi được (xem
//        developers.google.com/workspace/preview). Phần OAuth vẫn chạy đúng, nhưng bước gọi
//        tools/list có thể báo lỗi quyền truy cập nếu project chưa được duyệt.

const OAUTH_PROVIDERS = {
  // GitHub dùng OAuth để LẤY TOKEN, nhưng token đó được worker dùng gọi thẳng GitHub REST API
  // (xem githubNativeTools.js) — KHÔNG gọi qua api.githubcopilot.com/mcp, vì chỗ đó chỉ chấp
  // nhận OAuth từ danh sách ứng dụng GitHub tự duyệt sẵn (VS Code, JetBrains...), OAuth App tự
  // tạo luôn bị từ chối "unknown integration" dù token đúng — đây là giới hạn CỦA RIÊNG endpoint
  // MCP đó, không phải giới hạn của bản thân token OAuth.
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'repo read:org read:user',
    clientIdVar: 'GITHUB_OAUTH_CLIENT_ID',
    clientSecretVar: 'GITHUB_OAUTH_CLIENT_SECRET',
    extraAuthParams: {},
  },
  gmail: {
    label: 'Gmail',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    clientIdVar: 'GOOGLE_MCP_CLIENT_ID',
    clientSecretVar: 'GOOGLE_MCP_CLIENT_SECRET',
    mcpUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' }, // bắt buộc để Google trả refresh_token
  },
  drive: {
    label: 'Google Drive',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
    clientIdVar: 'GOOGLE_MCP_CLIENT_ID',
    clientSecretVar: 'GOOGLE_MCP_CLIENT_SECRET',
    mcpUrl: 'https://drivemcp.googleapis.com/mcp/v1',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
};

function getRedirectUri(env) {
  // API_BASE_URL đặt trong wrangler.toml [vars] — dùng để build đúng callback URL, tránh hard-code.
  return `${env.API_BASE_URL || ''}/api/mcp/oauth/callback`;
}

async function buildAuthorizeUrl(env, provider, state) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error('Provider OAuth không hợp lệ: ' + provider);
  const clientId = env[cfg.clientIdVar];
  if (!clientId) throw new Error(`Server chưa cấu hình ${cfg.clientIdVar}`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(env),
    scope: cfg.scope,
    state,
    response_type: 'code',
    ...cfg.extraAuthParams,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForToken(env, provider, code) {
  const cfg = OAUTH_PROVIDERS[provider];
  const clientId = env[cfg.clientIdVar];
  const clientSecret = env[cfg.clientSecretVar];
  if (!clientId || !clientSecret) throw new Error(`Server chưa cấu hình ${cfg.clientIdVar}/${cfg.clientSecretVar}`);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: getRedirectUri(env),
    grant_type: 'authorization_code',
  });

  const r = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('Đổi mã OAuth thất bại: ' + JSON.stringify(data).slice(0, 300));

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : null,
  };
}

// Google access token hết hạn sau ~1h — dùng refresh_token xin token mới nếu sắp/đã hết hạn.
// GitHub token không hết hạn nên hàm này chỉ có tác dụng thật với provider Google.
async function refreshTokenIfNeeded(env, provider, tokenRow) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg || !tokenRow.refresh_token || !tokenRow.expires_at) return tokenRow.token; // không có gì để refresh
  const now = Math.floor(Date.now() / 1000);
  if (tokenRow.expires_at - now > 120) return tokenRow.token; // còn hạn > 2 phút -> dùng luôn

  const clientId = env[cfg.clientIdVar];
  const clientSecret = env[cfg.clientSecretVar];
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokenRow.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('Làm mới access token thất bại: ' + JSON.stringify(data).slice(0, 300));

  const newExpiresAt = data.expires_in ? now + data.expires_in : null;
  await env.MY_AI_DB.prepare('UPDATE user_mcp_tokens SET token = ?, expires_at = ? WHERE user_id = ? AND provider = ?')
    .bind(data.access_token, newExpiresAt, tokenRow.user_id, provider).run();
  return data.access_token;
}

export { OAUTH_PROVIDERS, buildAuthorizeUrl, exchangeCodeForToken, refreshTokenIfNeeded };
