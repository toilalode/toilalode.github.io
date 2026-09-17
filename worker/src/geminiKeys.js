// ===================== POOL NHIỀU API KEY GEMINI =====================
// Mục đích: 6 API key Gemini free-tier thay vì 1, để tổng hạn mức (request/ngày) tăng lên ~6 lần.
//   - 1 key RIÊNG cho chủ app (GEMINI_API_KEY_OWNER) — không chia sẻ hạn mức với ai khác.
//   - 5 key CHUNG (GEMINI_API_KEY_POOL) — mọi người dùng khác (kể cả khách chưa đăng nhập, kể cả
//     người gọi qua /api/external/chat bằng api_key riêng) được xoay vòng qua 5 key này.
//
// Cấu hình (wrangler secret put ... hoặc dashboard -> Settings -> Variables and Secrets):
//   GEMINI_API_KEY_OWNER            -> key chính, chỉ chủ app dùng
//   GEMINI_API_KEY_OWNER_FALLBACK   -> key dự phòng của chủ app (không bắt buộc) — nếu key chính
//                                      hết hạn mức, tự chuyển sang key này trước khi đụng pool chung
//   GEMINI_API_KEY_POOL             -> 5 key, cách nhau bằng dấu phẩy, ví dụ:
//                             wrangler secret put GEMINI_API_KEY_POOL
//                             (dán vào) AIzaKey1,AIzaKey2,AIzaKey3,AIzaKey4,AIzaKey5
//   OWNER_USER_ID          -> id tài khoản chủ app (sub Google, hoặc "local:email@...")
//                             để biết request nào là của chủ app mà phát key riêng.
//
// Nếu CHƯA cấu hình GEMINI_API_KEY_OWNER/GEMINI_API_KEY_POOL, mọi hàm dưới đây tự rơi về dùng
// env.GEMINI_API_KEY (key cũ, 1 key duy nhất) để không phá app đang chạy — cấu hình dần dần được.

function getPoolKeys(env) {
  return (env.GEMINI_API_KEY_POOL || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
}

// Xoay vòng round-robin bằng 1 counter lưu trong KV. Không cần tuyệt đối chính xác khi có nhiều
// request cùng lúc (không dùng lock) — chỉ cần dàn đều ra 5 key là đủ mục đích, nên chấp nhận
// đôi khi 2 request liền nhau trùng key nếu chạy song song, không ảnh hưởng gì.
async function nextPoolIndex(env, poolSize) {
  if (poolSize <= 1) return 0;
  const kv = env.MY_AI_KV;
  if (!kv) return Math.floor(Math.random() * poolSize); // không có KV -> chọn ngẫu nhiên, vẫn dàn đều được
  const raw = await kv.get('gemini-pool-cursor');
  const cur = raw ? parseInt(raw, 10) % poolSize : 0;
  await kv.put('gemini-pool-cursor', String((cur + 1) % poolSize));
  return cur;
}

// Trả về DANH SÁCH key để thử lần lượt cho 1 request, ưu tiên key phù hợp nhất trước:
//   - Là chủ app -> [key riêng] (không đụng vào pool chung của người khác).
//   - Người khác -> [key pool xoay vòng, ...4 key còn lại trong pool] để nếu key đầu hết hạn
//     mức thì tự thử tiếp key khác trong CÙNG request, không bắt người dùng chờ/thử lại.
async function getGeminiKeyChain(env, userId) {
  const isOwner = !!(userId && env.OWNER_USER_ID && userId === env.OWNER_USER_ID);
  if (isOwner && env.GEMINI_API_KEY_OWNER) {
    // Chủ app cũng có key dự phòng riêng (GEMINI_API_KEY_OWNER_FALLBACK) — nếu key chính hết hạn
    // mức, tự chuyển sang key dự phòng này TRƯỚC KHI đụng tới pool dùng chung của người khác.
    const chain = [env.GEMINI_API_KEY_OWNER];
    if (env.GEMINI_API_KEY_OWNER_FALLBACK) chain.push(env.GEMINI_API_KEY_OWNER_FALLBACK);
    return chain;
  }
  const pool = getPoolKeys(env);
  if (pool.length === 0) {
    // Chưa cấu hình pool -> rơi về key cũ (hoặc key owner nếu chỉ mới cấu hình mỗi cái đó).
    const fallback = env.GEMINI_API_KEY || env.GEMINI_API_KEY_OWNER;
    return fallback ? [fallback] : [];
  }
  const startIdx = await nextPoolIndex(env, pool.length);
  const chain = [];
  for (let i = 0; i < pool.length; i++) chain.push(pool[(startIdx + i) % pool.length]);
  return chain;
}

export { getGeminiKeyChain, getPoolKeys };
