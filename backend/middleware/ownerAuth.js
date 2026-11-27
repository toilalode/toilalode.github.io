// Khoá toàn bộ API của backend Render: CHỈ chủ app (OWNER_USER_ID) mới gọi được.
// Trước đây backend này không có xác thực nào (CORS mở) -> ai biết URL Render đều gọi được Agent/Playwright/Gemini.
//
// Dùng lại SESSION TOKEN do Cloudflare Worker phát (xem worker/src/auth.js):
//   token = base64url(JSON {userId, exp}) + '.' + base64url(HMAC-SHA256(SESSION_SECRET, phần payload))
// FE đã gửi sẵn "Authorization: Bearer <token>" cho mọi request tới backend này.
//
// Biến môi trường (Render Dashboard -> Environment):
//   SESSION_SECRET  : PHẢI giống hệt SESSION_SECRET của Worker (wrangler secret put SESSION_SECRET)
//   OWNER_USER_ID   : userId của chủ app (giống OWNER_USER_ID bên Worker)
// Thiếu 1 trong 2 -> từ chối mọi request (an toàn mặc định), không bao giờ để hở.
const crypto = require('crypto');

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Trả userId nếu token hợp lệ và chưa hết hạn, ngược lại null.
function verifySessionToken(token, secret) {
  const [payloadB64, sigB64] = String(token || '').split('.');
  if (!payloadB64 || !sigB64) return null;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const given = b64urlToBuf(sigB64);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8')); } catch (_) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload.userId || null;
}

function requireOwner(req, res, next) {
  if (req.method === 'OPTIONS') return next(); // preflight CORS do cors() xử lý, không mang token

  const secret = process.env.SESSION_SECRET;
  const owner = process.env.OWNER_USER_ID;
  if (!secret || !owner) {
    return res.status(503).json({ error: 'Backend chưa cấu hình SESSION_SECRET / OWNER_USER_ID nên đang khoá toàn bộ.' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const userId = token ? verifySessionToken(token, secret) : null;
  if (!userId) return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
  if (userId !== owner) return res.status(403).json({ error: 'Backend này chỉ dành cho chủ app.' });
  next();
}

module.exports = { requireOwner, verifySessionToken };
