// ===================== AUTH — Đăng nhập bằng Google =====================
// Luồng:
//   1) Frontend dùng Google Identity Services lấy "credential" (1 JWT do Google ký, RS256).
//   2) POST /api/auth/google { credential } -> Worker xác minh JWT bằng public key JWKS của Google,
//      lấy ra { sub, email, name, picture }, lưu/update vào bảng users, rồi phát 1 SESSION TOKEN
//      riêng của app (HMAC-signed, không phải JWT Google) để FE lưu lại và gửi kèm mọi request sau.
//   3) Mọi route cần đăng nhập gọi requireUser(request, env) để lấy userId từ session token
//      trong header "Authorization: Bearer <token>".
//
// Vì sao không dùng thẳng Google JWT cho mọi request: JWT Google hết hạn sau ~1h và việc verify
// JWKS mỗi request tốn 1 lần fetch mạng (có cache). Session token tự ký (HMAC) bằng SESSION_SECRET
// (đặt qua `wrangler secret put SESSION_SECRET`) thì verify tại chỗ, không cần gọi mạng, và ta có
// thể set hạn dài hơn (ví dụ 30 ngày) cho trải nghiệm không phải đăng nhập lại liên tục.

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const SESSION_TTL_LONG = 60 * 60 * 24 * 30;  // 30 ngày — khi bấm "Ghi nhớ đăng nhập"
const SESSION_TTL_SHORT = 60 * 60 * 12;      // 12 giờ — khi KHÔNG ghi nhớ (đóng trình duyệt là phải đăng nhập lại)

function base64UrlToUint8Array(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64url.length + (4 - (b64url.length % 4)) % 4, '=');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function uint8ArrayToBase64Url(bytes) {
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecodeJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(b64url)));
}

// Cache JWKS trong bộ nhớ của instance Worker (sống vài phút tới vài giờ tuỳ Cloudflare) để không
// phải fetch lại ở mọi request đăng nhập.
let jwksCache = null;
let jwksCacheAt = 0;
async function getGoogleJwks() {
  if (jwksCache && Date.now() - jwksCacheAt < 60 * 60 * 1000) return jwksCache;
  const r = await fetch(GOOGLE_JWKS_URL);
  if (!r.ok) throw new Error('Không tải được JWKS của Google');
  const data = await r.json();
  jwksCache = data.keys;
  jwksCacheAt = Date.now();
  return jwksCache;
}

// Xác minh chữ ký RS256 của Google ID token (KHÔNG dùng thư viện ngoài — chỉ Web Crypto API có sẵn
// trong Cloudflare Workers) và trả về payload nếu hợp lệ.
async function verifyGoogleIdToken(idToken, googleClientId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID token không đúng định dạng JWT');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Sai issuer (không phải Google)');
  }
  if (payload.aud !== googleClientId) throw new Error('Sai audience (Client ID không khớp)');
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('ID token đã hết hạn');

  const jwks = await getGoogleJwks();
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Không tìm thấy public key phù hợp (kid) từ Google');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signature = base64UrlToUint8Array(sigB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedData);
  if (!ok) throw new Error('Chữ ký JWT không hợp lệ');

  return payload; // { sub, email, name, picture, ... }
}

// ---------- Session token của riêng app (HMAC-SHA256, tự ký, không cần gọi mạng để verify) ----------
async function getHmacKey(env) {
  if (!env.SESSION_SECRET) throw new Error('Thiếu SESSION_SECRET (chạy: wrangler secret put SESSION_SECRET)');
  const raw = new TextEncoder().encode(env.SESSION_SECRET);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function createSessionToken(env, userId, rememberMe = true) {
  const key = await getHmacKey(env);
  const ttl = rememberMe ? SESSION_TTL_LONG : SESSION_TTL_SHORT;
  const payload = { userId, exp: Math.floor(Date.now() / 1000) + ttl };
  const payloadB64 = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = uint8ArrayToBase64Url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

async function verifySessionToken(env, token) {
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  const key = await getHmacKey(env);
  const sig = base64UrlToUint8Array(sigB64);
  const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(payloadB64));
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(payloadB64)));
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload.userId;
}

// Đọc userId từ header "Authorization: Bearer <session-token>". Trả về null nếu không có/không hợp lệ
// (route gọi hàm này tự quyết định có bắt buộc đăng nhập hay không).
async function getUserIdFromRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try { return await verifySessionToken(env, token); } catch (e) { return null; }
}

// Lưu/update user vào D1 (upsert theo id = Google "sub")
async function upsertUser(env, { id, email, name, picture }) {
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');
  await db.prepare(
    `INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`
  ).bind(id, email, name || null, picture || null).run();
}

// ===================== Đăng ký / đăng nhập bằng email + mật khẩu =====================
// Mật khẩu KHÔNG BAO GIỜ lưu dạng thô — chỉ lưu hash PBKDF2-SHA256 (100.000 vòng lặp) kèm salt
// ngẫu nhiên riêng cho mỗi user, dùng Web Crypto API có sẵn trong Cloudflare Workers (không cần
// cài thư viện ngoài như bcrypt, vốn không chạy được trên Workers runtime).

async function hashPassword(password, saltB64url) {
  const enc = new TextEncoder();
  const salt = saltB64url ? base64UrlToUint8Array(saltB64url) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256
  );
  const hashB64 = uint8ArrayToBase64Url(new Uint8Array(bits));
  const saltOut = uint8ArrayToBase64Url(salt);
  return `${saltOut}$${hashB64}`; // lưu cả salt lẫn hash trong 1 chuỗi, tách bằng "$"
}

async function verifyPassword(password, stored) {
  const [saltB64url, expectedHashB64] = (stored || '').split('$');
  if (!saltB64url || !expectedHashB64) return false;
  const recomputed = await hashPassword(password, saltB64url);
  const [, recomputedHashB64] = recomputed.split('$');
  // So sánh hằng thời gian tránh timing attack
  if (recomputedHashB64.length !== expectedHashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < recomputedHashB64.length; i++) diff |= recomputedHashB64.charCodeAt(i) ^ expectedHashB64.charCodeAt(i);
  return diff === 0;
}

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || ''); }

// Đăng ký tài khoản mới bằng email + mật khẩu. id = "local:" + email (để không đụng namespace với id Google "sub").
async function registerLocalUser(env, { email, password, name }) {
  if (!isValidEmail(email)) throw new Error('Email không hợp lệ');
  if (!password || password.length < 6) throw new Error('Mật khẩu phải có ít nhất 6 ký tự');
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');

  const id = 'local:' + email.toLowerCase().trim();
  const existing = await db.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
  if (existing) throw new Error('Email này đã được đăng ký');

  const passwordHash = await hashPassword(password);
  await db.prepare(
    `INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`
  ).bind(id, email.toLowerCase().trim(), name || email.split('@')[0], passwordHash).run();

  return { id, email: email.toLowerCase().trim(), name: name || email.split('@')[0], picture: null };
}

// Đăng nhập bằng email + mật khẩu, trả về thông tin user nếu đúng.
async function loginLocalUser(env, { email, password }) {
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');
  const id = 'local:' + (email || '').toLowerCase().trim();
  const user = await db.prepare(`SELECT id, email, name, picture, password_hash FROM users WHERE id = ?`).bind(id).first();
  if (!user || !user.password_hash) throw new Error('Sai email hoặc mật khẩu');
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw new Error('Sai email hoặc mật khẩu');
  return { id: user.id, email: user.email, name: user.name, picture: user.picture };
}

// ===================== API KEY (dùng để gắn Velocitix AI vào file HTML/app ngoài) =====================
// Khác với session token (ngắn hạn, gắn với 1 lần đăng nhập), api_key sống lâu dài và không hết hạn
// cho tới khi người dùng chủ động bấm "Tạo key mới" (regenerate) trong Settings.
function generateApiKey() {
  return 'vlx_' + crypto.randomUUID().replace(/-/g, '');
}

// Lấy api_key hiện có của user; nếu chưa có thì tạo mới rồi lưu vào D1.
async function getOrCreateApiKey(env, userId) {
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');
  const row = await db.prepare('SELECT api_key FROM users WHERE id = ?').bind(userId).first();
  if (row?.api_key) return row.api_key;
  const key = generateApiKey();
  await db.prepare('UPDATE users SET api_key = ? WHERE id = ?').bind(key, userId).run();
  return key;
}

const MAX_API_KEY_REGENS = 2;

// Thu hồi key cũ (nếu có) và phát 1 key mới — dùng khi user lỡ để lộ key ra ngoài.
// Giới hạn tối đa MAX_API_KEY_REGENS lần/tài khoản để tránh spam tạo key vô tội vạ.
async function regenerateApiKey(env, userId) {
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');
  const row = await db.prepare('SELECT api_key_regen_count FROM users WHERE id = ?').bind(userId).first();
  const usedCount = row?.api_key_regen_count || 0;
  if (usedCount >= MAX_API_KEY_REGENS) {
    const err = new Error(`Đã dùng hết ${MAX_API_KEY_REGENS} lần tạo key mới cho phép. Liên hệ chủ app nếu cần thêm.`);
    err.limitReached = true;
    throw err;
  }
  const key = generateApiKey();
  await db.prepare('UPDATE users SET api_key = ?, api_key_regen_count = api_key_regen_count + 1 WHERE id = ?').bind(key, userId).run();
  return { apiKey: key, remaining: MAX_API_KEY_REGENS - (usedCount + 1) };
}

// Tra userId từ 1 api_key (dùng ở route public /api/external/*, KHÔNG dùng session token).
async function getUserIdFromApiKey(env, apiKey) {
  if (!apiKey) return null;
  const db = env.MY_AI_DB;
  if (!db) return null;
  const row = await db.prepare('SELECT id FROM users WHERE api_key = ?').bind(apiKey).first();
  return row?.id || null;
}

export {
  verifyGoogleIdToken, createSessionToken, verifySessionToken, getUserIdFromRequest, upsertUser,
  registerLocalUser, loginLocalUser, requestPasswordReset, resetPasswordWithToken,
  getOrCreateApiKey, regenerateApiKey, getUserIdFromApiKey,
};

// ===================== Quên mật khẩu (gửi email qua Resend) =====================
// Luồng:
//   1) POST /api/auth/forgot-password { email } -> tạo 1 token ngẫu nhiên, lưu vào bảng
//      password_resets (hết hạn 15 phút), gửi email chứa link "…?resetToken=<token>".
//      LUÔN trả về thành công (kể cả email không tồn tại) để tránh lộ thông tin ai đã đăng ký.
//   2) POST /api/auth/reset-password { token, newPassword } -> kiểm tra token còn hạn & chưa
//      dùng, đổi mật khẩu, đánh dấu token đã dùng (không dùng lại được).

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return uint8ArrayToBase64Url(bytes);
}

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) throw new Error('Server chưa cấu hình RESEND_API_KEY');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'Velocitix AI <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Resend lỗi ${r.status}: ${errText.slice(0, 200)}`);
  }
}

// Tạo yêu cầu đặt lại mật khẩu + gửi email. KHÔNG throw nếu email không tồn tại (bảo mật) —
// nhưng vẫn throw nếu Resend/D1 thực sự lỗi kỹ thuật, để log được ở nơi gọi.
async function requestPasswordReset(env, { email, resetUrlBase }) {
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');
  const id = 'local:' + (email || '').toLowerCase().trim();
  const user = await db.prepare(`SELECT id, email, name FROM users WHERE id = ?`).bind(id).first();
  if (!user) return; // im lặng: không tiết lộ email có tồn tại hay không

  const token = randomToken();
  await db.prepare(
    `INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))`
  ).bind(token, user.id).run();

  const link = `${resetUrlBase}?resetToken=${encodeURIComponent(token)}`;
  await sendEmail(env, {
    to: user.email,
    subject: 'Đặt lại mật khẩu Velocitix AI',
    html: `
      <p>Xin chào ${user.name || ''},</p>
      <p>Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản Velocitix AI.</p>
      <p><a href="${link}" style="background:#b5502e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;">Đặt lại mật khẩu</a></p>
      <p>Hoặc dán link này vào trình duyệt: ${link}</p>
      <p>Link có hiệu lực trong <b>15 phút</b>. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p>
    `,
  });
}

// Đổi mật khẩu bằng token nhận từ email.
async function resetPasswordWithToken(env, { token, newPassword }) {
  if (!newPassword || newPassword.length < 6) throw new Error('Mật khẩu mới phải có ít nhất 6 ký tự');
  const db = env.MY_AI_DB;
  if (!db) throw new Error('D1 chưa được cấu hình');

  const row = await db.prepare(
    `SELECT token, user_id, expires_at, used_at FROM password_resets WHERE token = ?`
  ).bind(token).first();
  if (!row) throw new Error('Link đặt lại mật khẩu không hợp lệ');
  if (row.used_at) throw new Error('Link này đã được sử dụng');
  const expired = await db.prepare(`SELECT (datetime('now') > ?) AS is_expired`).bind(row.expires_at).first();
  if (expired.is_expired) throw new Error('Link đặt lại mật khẩu đã hết hạn (quá 15 phút)');

  const passwordHash = await hashPassword(newPassword);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, row.user_id).run();
  await db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE token = ?`).bind(token).run();
}
