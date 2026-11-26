// POST /api/external/chat — API công khai để gắn Velocitix AI vào file HTML/app ngoài (xác thực bằng header x-api-key).
// Tách riêng khỏi index.js (entry.js chặn route này trước khi giao cho index.js) để thêm model/thinking mà không
// phải sửa file index.js rất lớn.
//
// Body JSON:
//   prompt   (string, bắt buộc)
//   model    (tuỳ chọn) lite | fast | flash | smart | coding   -> Gemini 3.5 Flash
//                       hydrogen                              -> Gemini 4 Hydrogen
//                       gemma | gemma-moe                     -> Gemma 4 31B / Gemma 4 26B-A4B
//                       hoặc đúng tên model (vd "gemini-4-hydrogen"). Không gửi / giá trị lạ -> smart (3.5 Flash).
//   effort   (tuỳ chọn) mức nỗ lực suy luận
//                       - hydrogen : low | medium | high | xhigh (mặc định high; model Hydrogen luôn suy luận)
//                       - 3.5 Flash: low | medium | high (gửi effort = tự bật thinking; không gửi thì giữ như cũ: không thinking)
//                       - Gemma    : bỏ qua (Gemma chỉ có bật/tắt)
//   thinking (tuỳ chọn, boolean)
//                       - Gemma    : true = bật thinking, false/không gửi = tắt
//                       - 3.5 Flash: true = bật (mặc định mức high), false = tắt dù có gửi effort
//                       - hydrogen : bỏ qua
// Trả về: { text, grounding, model }
import { MODELS, buildThinkingConfig, isGemmaModel, isHydrogenModel, isQuotaError } from './models.js';
import { getGeminiKeyChain } from './geminiKeys.js';
import { geminiFetch } from './gemini-proxy.js';
import { getUserIdFromApiKey } from './auth.js';
import { checkRateLimit } from './kv.js';
import { logMetric } from './analytics.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const EFFORTS_HYDROGEN = ['low', 'medium', 'high', 'xhigh'];
const EFFORTS_FLASH = ['low', 'medium', 'high'];

// Giống corsHeaders() trong index.js (giữ đồng bộ nếu sau này sửa bên đó).
function corsHeaders(request, env) {
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request?.headers.get('Origin') || '';
  const common = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  };
  if (configured.length === 0) return { 'Access-Control-Allow-Origin': '*', ...common };
  return { 'Access-Control-Allow-Origin': configured.includes(origin) ? origin : configured[0], 'Vary': 'Origin', ...common };
}
const json = (obj, cors, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

function resolveModel(name) {
  const aliases = {
    lite: MODELS.chatLite,
    fast: MODELS.chatFast,
    flash: MODELS.chatFast,
    smart: MODELS.chatSmart,
    coding: MODELS.chatCoding,
    hydrogen: MODELS.chatHydrogen,
    gemma: MODELS.chatGemmaLarge,
    'gemma-moe': MODELS.chatGemmaMoe,
  };
  if (typeof name !== 'string') return null;
  if (aliases[name]) return aliases[name];
  const exact = new Set([MODELS.chatCoding, MODELS.chatHydrogen, MODELS.chatGemmaLarge, MODELS.chatGemmaMoe]);
  return exact.has(name) ? name : null;
}

export async function handleExternalChat(request, env) {
  const cors = corsHeaders(request, env);

  const key = request.headers.get('x-api-key');
  if (!key) return json({ error: 'Thiếu header x-api-key' }, cors, 401);
  const userId = await getUserIdFromApiKey(env, key);
  if (!userId) return json({ error: 'API key không hợp lệ' }, cors, 401);

  // Chặn spam nhanh + chặn xài quá nhiều trong ngày (giữ nguyên như trước).
  const okBurst = await checkRateLimit(env, `ext:${key}:min`, { limit: 3, windowSeconds: 60 });
  if (!okBurst) return json({ error: 'Gửi quá nhanh — tối đa 3 request/phút, thử lại sau ít phút' }, cors, 429);
  const okDaily = await checkRateLimit(env, `ext:${key}:day`, { limit: 200, windowSeconds: 86400 });
  if (!okDaily) return json({ error: 'Đã hết lượt dùng hôm nay cho API key này (200/ngày)' }, cors, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body phải là JSON hợp lệ' }, cors, 400); }
  const prompt = body?.prompt;
  if (!prompt || typeof prompt !== 'string') return json({ error: 'Thiếu prompt (string)' }, cors, 400);

  // Model coding luôn bị chặn cho non-owner (kể cả gửi thẳng tên model) -> rơi về smart.
  const isOwnerExt = !!(userId && env.OWNER_USER_ID && userId === env.OWNER_USER_ID);
  let model = resolveModel(body?.model) || MODELS.chatSmart;
  if (model === MODELS.chatCoding && !isOwnerExt) model = MODELS.chatSmart;

  // ---- Thinking / mức nỗ lực ----
  const effort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : undefined;
  const hasEffort = body?.effort !== undefined && body?.effort !== null && body?.effort !== '';
  let thinking;
  if (isGemmaModel(model)) {
    thinking = body?.thinking === true;                       // Gemma: chỉ bật/tắt, effort bị bỏ qua
  } else if (isHydrogenModel(model)) {
    if (hasEffort && !EFFORTS_HYDROGEN.includes(effort)) {
      return json({ error: `effort không hợp lệ cho Hydrogen: dùng ${EFFORTS_HYDROGEN.join(' | ')}` }, cors, 400);
    }
    thinking = true;                                          // Hydrogen luôn suy luận
  } else {
    if (hasEffort && !EFFORTS_FLASH.includes(effort)) {
      return json({ error: `effort không hợp lệ cho Gemini 3.5 Flash: dùng ${EFFORTS_FLASH.join(' | ')}` }, cors, 400);
    }
    thinking = typeof body?.thinking === 'boolean' ? body.thinking : hasEffort; // có effort => tự bật thinking
  }
  const thinkingConfig = buildThinkingConfig(model, thinking, hasEffort ? effort : undefined);

  const keyChain = await getGeminiKeyChain(env, userId);
  if (keyChain.length === 0) return json({ error: 'Server chưa cấu hình GEMINI_API_KEY' }, cors, 400);

  const reqBody = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (thinkingConfig) reqBody.generationConfig = { thinkingConfig };

  let lastErr = 'Lỗi gọi Gemini';
  for (const geminiKey of keyChain) {
    try {
      const r = await geminiFetch(env, `${GEMINI_BASE}/${model}:generateContent?key=${geminiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody),
      });
      const data = await r.json();
      if (!r.ok) {
        lastErr = JSON.stringify(data).slice(0, 1000);
        if (!isQuotaError(r.status, lastErr)) break; // lỗi khác hết hạn mức -> đổi key vô ích, dừng ngay
        continue;
      }
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
      logMetric(env, { endpoint: '/api/external/chat', model, ok: true });
      return json({ text, grounding: data.candidates?.[0]?.groundingMetadata, model }, cors);
    } catch (e) {
      lastErr = e.message;
      if (!isQuotaError(0, e.message || '')) break;
    }
  }
  logMetric(env, { endpoint: '/api/external/chat', model, ok: false, errorMessage: String(lastErr).slice(0, 200) });
  return json({ error: lastErr }, cors, 500);
}
