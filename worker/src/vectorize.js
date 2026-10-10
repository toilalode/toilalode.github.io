// ===================== VECTORIZE — TÌM KIẾM NGỮ NGHĨA TRONG CHAT =====================
// Luồng hoạt động:
//  1) Mỗi khi lưu 1 tin nhắn (D1), gọi thêm indexMessage() để:
//     a. Gửi nội dung tin nhắn sang Gemini model "text-embedding-004" lấy vector 768 chiều
//     b. Lưu vector đó vào Vectorize kèm metadata (conversationId, role, đoạn text gốc)
//  2) Khi người dùng tìm kiếm ("tìm lại đoạn chat nói về...") gọi searchMessages():
//     a. Biến câu tìm kiếm thành vector (cùng model embedding)
//     b. Vectorize trả về các tin nhắn có vector "gần" nhất về mặt ngữ nghĩa
//        (khác tìm theo từ khoá — tìm được cả khi không trùng chữ, chỉ cần ý gần nhau)

import { geminiFetch } from './gemini-proxy.js';

// ⚠️ "text-embedding-004" đã bị Google NGỪNG PHỤC VỤ (trả 404) — đây là lý do tìm kiếm ngữ nghĩa
// từng chạy được rồi đột nhiên ngưng hoạt động. Model thay thế: "gemini-embedding-001" (mặc định
// 3072 chiều) -> ép về 768 chiều bằng outputDimensionality để khớp index Vectorize hiện có.
// Giữ text-embedding-004 làm phương án dự phòng, tự chuyển nếu model đầu báo "không tồn tại".
const EMBED_DIM = 768;
const EMBED_MODELS = ['gemini-embedding-001', 'text-embedding-004'];
let embedModelOk = null; // model embedding đã chạy được gần nhất (trong isolate hiện tại)

function embedOrder() {
  return embedModelOk ? [embedModelOk, ...EMBED_MODELS.filter(m => m !== embedModelOk)] : EMBED_MODELS;
}
function embedReq(model, text, taskType) {
  const req = { model: `models/${model}`, content: { parts: [{ text }] }, taskType };
  if (model.startsWith('gemini-embedding')) req.outputDimensionality = EMBED_DIM;
  return req;
}

// Phương án dự phòng: Workers AI chạy ngay trên Cloudflare (không cần key Gemini, không bị geo-block).
// Cần binding "AI" trong wrangler.toml. Cũng 768 chiều nên dùng chung index Vectorize.
const CF_EMBED_MODEL = '@cf/google/embeddinggemma-300m';

async function embedWithWorkersAI(env, texts) {
  if (!env.AI) throw new Error('chưa khai báo binding "AI" (Workers AI) trong wrangler.toml');
  // embeddinggemma nhận tối đa ~512 token -> cắt ngắn hơn cho chắc
  const out = await env.AI.run(CF_EMBED_MODEL, { text: texts.map(t => t.slice(0, 1200)) });
  const vectors = out?.data;
  if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors[0]?.length !== EMBED_DIM) {
    throw new Error('Workers AI trả về dữ liệu embedding không đúng định dạng');
  }
  return vectors;
}

// Trả về { vectors, source }. source cho biết vector do nguồn nào tạo ('gemini' | 'cf-gemma') —
// vector của 2 model KHÁC NHAU không so sánh được với nhau, nên lưu kèm vào metadata và khi tìm
// kiếm chỉ so với vector cùng nguồn với câu truy vấn.
async function embedBatch(env, apiKey, texts, taskType = 'RETRIEVAL_DOCUMENT') {
  let lastErr = 'không rõ';
  if (apiKey) {
    for (const model of embedOrder()) {
      try {
        const r = await geminiFetch(
          env,
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: texts.map(t => embedReq(model, t, taskType)) }),
          }
        );
        const data = await r.json().catch(() => ({}));
        if (r.ok && Array.isArray(data.embeddings)) {
          embedModelOk = model;
          return { vectors: data.embeddings.map(e => e.values), source: 'gemini' };
        }
        lastErr = `${model}: HTTP ${r.status} ${JSON.stringify(data).slice(0, 300)}`;
      } catch (e) { lastErr = `${model}: ${e.message}`; }
    }
  } else {
    lastErr = 'thiếu GEMINI_API_KEY';
  }
  // Gemini hỏng/hết quota/bị chặn -> chuyển sang Workers AI
  try {
    console.warn('[Vectorize] Gemini embedding lỗi, dùng Workers AI dự phòng —', lastErr);
    return { vectors: await embedWithWorkersAI(env, texts), source: 'cf-gemma' };
  } catch (e2) {
    throw new Error(`Tạo embedding thất bại — Gemini: ${lastErr} | Workers AI: ${e2.message}`);
  }
}

async function embedText(env, apiKey, text, taskType = 'RETRIEVAL_DOCUMENT') {
  const { vectors, source } = await embedBatch(env, apiKey, [text], taskType);
  return { vector: vectors[0], source };
}

// Đánh chỉ mục 1 tin nhắn vào Vectorize (gọi sau khi đã saveMessage vào D1)
async function indexMessage(env, { messageId, conversationId, userId, role, content }) {
  const vectorize = env.MY_AI_VECTORIZE;
  const apiKey = env.GEMINI_API_KEY;
  if (!vectorize) throw new Error('Vectorize chưa được cấu hình (thiếu binding MY_AI_VECTORIZE)');

  // Chỉ lấy 2000 ký tự đầu để tránh vượt giới hạn input của model embedding
  const trimmed = content.slice(0, 2000);
  const { vector, source } = await embedText(env, apiKey, trimmed, 'RETRIEVAL_DOCUMENT');

  await vectorize.upsert([{
    id: messageId,
    values: vector,
    metadata: { conversationId, userId: userId || '', role, emb: source, preview: trimmed.slice(0, 300) },
  }]);
}

// Tìm các tin nhắn gần nghĩa nhất với câu truy vấn — LUÔN lọc theo userId để người dùng
// chỉ tìm thấy tin nhắn trong chính lịch sử chat của mình, không thấy của người khác.
async function searchMessages(env, query, { topK = 8, conversationId, userId } = {}) {
  const vectorize = env.MY_AI_VECTORIZE;
  const apiKey = env.GEMINI_API_KEY;
  if (!vectorize) throw new Error('Vectorize chưa được cấu hình');
  if (!userId) throw new Error('Thiếu userId (chưa đăng nhập)');

  const { vector, source } = await embedText(env, apiKey, query, 'RETRIEVAL_QUERY');
  const filter = conversationId ? { conversationId, userId } : { userId };
  // Vector cũ (chưa có nhãn emb) coi là của Gemini.
  const sameSource = m => (m.metadata?.emb || 'gemini') === source;
  let matches = [];
  try {
    matches = ((await vectorize.query(vector, { topK: 20, returnMetadata: true, filter })).matches || []).filter(sameSource);
  } catch (e) { console.error('[Vectorize] query có filter lỗi:', e.message); }
  // Không có metadata index thì filter trả RỖNG -> truy vấn không filter rồi LỌC TAY theo
  // userId/conversationId. Vẫn đảm bảo chỉ thấy tin nhắn của chính mình.
  if (!matches.length) {
    const all = (await vectorize.query(vector, { topK: 20, returnMetadata: true })).matches || [];
    matches = all.filter(m => m.metadata?.userId === userId
      && (!conversationId || m.metadata?.conversationId === conversationId) && sameSource(m));
  }
  matches = matches.slice(0, topK);

  return matches.map(m => ({
    messageId: m.id,
    score: m.score, // độ tương đồng, càng gần 1 càng liên quan
    conversationId: m.metadata?.conversationId,
    role: m.metadata?.role,
    // ⚠️ FIX lỗi "tìm kiếm ngữ nghĩa không hoạt động dù deploy được": Vectorize CÓ trả kết
    // quả thật (không lỗi mạng/lỗi server), nhưng field tên là "preview" trong khi frontend
    // (app.js -> semResultEl) lại đọc "content"/"text" -> mọi kết quả hiện ra RỖNG, trông như
    // "không hoạt động". Trả thêm cả "content" (alias của preview) để khớp đúng với FE.
    preview: m.metadata?.preview,
    content: m.metadata?.preview,
  }));
}

// Đánh chỉ mục LẠI toàn bộ lịch sử chat của 1 user theo từng lô (vector cũ tạo bằng model khác
// không so sánh được với vector mới, nên sau khi đổi model phải làm lại 1 lần).
// Gọi lặp với offset = next trả về cho tới khi done = true.
async function reindexUserMessages(env, userId, { offset = 0, limit = 40 } = {}) {
  const vectorize = env.MY_AI_VECTORIZE, db = env.MY_AI_DB, apiKey = env.GEMINI_API_KEY;
  if (!vectorize) throw new Error('Vectorize chưa được cấu hình (thiếu binding MY_AI_VECTORIZE)');
  if (!db) throw new Error('D1 chưa được cấu hình');
  limit = Math.min(Math.max(limit, 1), 100);

  const { results } = await db.prepare(
    `SELECT m.id, m.conversation_id AS conversationId, m.role, m.content
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ? AND c.deleted_at IS NULL AND m.role IN ('user','assistant')
      ORDER BY m.created_at ASC, m.id ASC LIMIT ? OFFSET ?`
  ).bind(userId, limit, offset).all();

  if (!results.length) return { processed: 0, next: offset, done: true };

  const rows = results.filter(m => (m.content || '').trim());
  if (rows.length) {
    const trimmed = rows.map(m => m.content.slice(0, 2000));
    const { vectors, source } = await embedBatch(env, apiKey, trimmed, 'RETRIEVAL_DOCUMENT');
    await vectorize.upsert(rows.map((m, i) => ({
      id: m.id,
      values: vectors[i],
      metadata: { conversationId: m.conversationId, userId, role: m.role, emb: source, preview: trimmed[i].slice(0, 300) },
    })));
  }
  return { processed: results.length, next: offset + results.length, done: results.length < limit };
}

export { indexMessage, searchMessages, reindexUserMessages };
