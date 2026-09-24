import { MODELS, pickAutoModel, buildAutoFallbackList, isQuotaError } from './models.js';
import { saveBase64ToR2, listR2Files, getR2File, deleteR2File } from './storage.js';
import {
  createConversation,
  listConversations,
  listDeletedConversations,
  getConversationMessages,
  saveMessage,
  deleteConversation,
  restoreConversation,
  purgeConversation,
  purgeExpiredConversations,
  renameConversation,
} from './db.js';
import { getAppConfig, setAppConfig, checkRateLimit } from './kv.js';
import { indexMessage, searchMessages } from './vectorize.js';
import { enqueueVideoJob, getVideoJobStatus, processVideoJob } from './queue-video.js';
import { logMetric } from './analytics.js';
import { GeminiProxyDO, geminiFetch } from './gemini-proxy.js';
import { getGeminiKeyChain } from './geminiKeys.js';
import { runMcpChat, resumeMcpChat } from './mcpChat.js';
import { setUserMcpToken, deleteUserMcpToken, getUserConnectedMcpServers, getUserMcpStatus, MCP_PROVIDERS_PAT } from './mcpTokens.js';
import { OAUTH_PROVIDERS, buildAuthorizeUrl, exchangeCodeForToken } from './mcpOAuth.js';
import { verifyGoogleIdToken, createSessionToken, getUserIdFromRequest, upsertUser, registerLocalUser, loginLocalUser, requestPasswordReset, resetPasswordWithToken, getOrCreateApiKey, regenerateApiKey, getUserIdFromApiKey } from './auth.js';
import * as agentBrowserRoutes from './agentBrowser.js';
import * as agentRoutes from './agent.js';

// wrangler yêu cầu Durable Object class phải được export từ đúng file "main" khai báo trong
// wrangler.toml (ở đây là src/index.js) — nên re-export lại ở đây dù class thật định nghĩa
// trong gemini-proxy.js.
export { GeminiProxyDO };

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function corsHeaders() {
  return {
    // ĐỔI dòng dưới thành domain GitHub Pages thật của bạn sau khi bật Pages, ví dụ:
    // 'Access-Control-Allow-Origin': 'https://ten-user.github.io',
    // Để '*' trong lúc test cho tiện, nhưng nên siết lại khi lên production.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  };
}
function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

async function askGemini(env, apiKey, model, prompt, { webSearch = false } = {}) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (webSearch) body.tools = [{ google_search: {} }];
  const r = await geminiFetch(env, `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 1000));
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('\n');
  return { text, grounding: data.candidates?.[0]?.groundingMetadata };
}

// ---------- /api/chat/stream ----------
function handleChatStream(body, env, cors, ctx, userId) {
  const { messages = [], model = 'auto', thinking = false, webSearch = false, systemInstruction, attachments = [] } = body;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event, data) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const work = (async () => {
    try {
      const keyChain = await getGeminiKeyChain(env, userId);
      if (keyChain.length === 0) { await send('error', 'Thiếu GEMINI_API_KEY (đặt bằng: wrangler secret put GEMINI_API_KEY, hoặc cấu hình GEMINI_API_KEY_OWNER + GEMINI_API_KEY_POOL)'); await writer.close(); return; }

      // Model "tốt cho code" (gemini-3.5-flash) chỉ dành cho chủ app. Người khác chọn model
      // này thì tự động rơi về model chat thường (chatSmart) thay vì báo lỗi làm gián đoạn.
      const isOwnerChat = !!(userId && env.OWNER_USER_ID && userId === env.OWNER_USER_ID);
      let effectiveModel = model;
      if (!isOwnerChat && model === MODELS.chatCoding) {
        effectiveModel = MODELS.chatSmart;
      }

      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const lastUserText = lastUserMsg?.parts?.map(p => p.text || '').join(' ') || '';
      const isAuto = effectiveModel === 'auto';
      // Chế độ Auto: thử LẦN LƯỢT các model trong danh sách fallback nếu model đang thử bị từ chối
      // vì HẾT HẠN MỨC (khác tên model = khác hạn mức riêng trên Gemini API). Chỉ chuyển sang model
      // kế tiếp khi đúng là lỗi hết hạn mức — lỗi khác (sai request, API key...) thì dừng báo lỗi
      // ngay, thử thêm model khác cũng sẽ lỗi y hệt, chỉ tốn thời gian chờ của người dùng.
      const candidates = (isAuto ? buildAutoFallbackList(pickAutoModel(lastUserText, { webSearch })) : [effectiveModel])
        .filter(m => isOwnerChat || m !== MODELS.chatCoding); // Auto cũng không được tự chọn trúng model coding nếu không phải chủ app

      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: (m.parts || []).map(p => ({ text: p.text })),
      }));
      if (attachments.length && contents.length) {
        const lastIdx = contents.length - 1;
        if (contents[lastIdx].role === 'user') {
          for (const a of attachments) contents[lastIdx].parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
        }
      }

      // ⚠️ FIX lỗi "Auto không hoạt động": trước đây LUÔN gửi thinkingConfig (kể cả
      // { thinkingBudget: 0 }) cho MỌI model. Một số model Flash-Lite/Flash rẻ mà chế độ
      // Auto hay chọn (gemini-3.1-flash-lite, gemini-3.8-flash) không chấp nhận field này khi
      // không thật sự cần "thinking" -> Google trả lỗi 400 -> FE hiện lỗi ngay khi ở chế độ Auto,
      // trong khi chọn tay 1 model khác (vốn hay được test kỹ hơn) thì không sao.
      // Chỉ gửi thinkingConfig khi người dùng THẬT SỰ bật công tắc "Thinking".
      const reqBody = { contents };
      if (thinking) reqBody.generationConfig = { thinkingConfig: { thinkingBudget: -1 } };
      if (systemInstruction) reqBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      if (webSearch) reqBody.tools = [{ google_search: {} }];

      let upstream, chosenModel, lastErrText = '';
      outer:
      for (let i = 0; i < candidates.length; i++) {
        chosenModel = candidates[i];
        for (let k = 0; k < keyChain.length; k++) {
          const key = keyChain[k];
          upstream = await geminiFetch(env, `${GEMINI_BASE}/${chosenModel}:streamGenerateContent?alt=sse&key=${key}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody),
          });
          if (upstream.ok && upstream.body) break outer; // model + key này dùng được -> dừng thử, dùng luôn
          lastErrText = await upstream.text();
          const isQuota = isQuotaError(upstream.status, lastErrText);
          // Đổi KEY khác (cùng model) chỉ có ích khi đúng là lỗi HẾT HẠN MỨC (mỗi key có hạn mức
          // riêng) — lỗi khác (model sai tên, request sai định dạng...) thì đổi key vô ích, dừng
          // vòng key ngay, nhưng KHÔNG dừng toàn bộ nếu đang Auto — để còn thử ĐỔI MODEL bên dưới.
          if (isQuota && k < keyChain.length - 1) {
            await send('fallback', { from: `key #${k + 1}`, to: `key #${k + 2}`, reason: 'quota', model: chosenModel });
            continue; // thử key kế tiếp CÙNG model
          }
          break; // hết key để thử (hoặc lỗi không phải quota) -> dừng vòng key, xét đổi MODEL bên dưới
        }
        // ⚠️ FIX "Auto không fallback": TRƯỚC ĐÂY chỉ đổi sang model kế tiếp khi lỗi là hết hạn
        // mức (isQuota) — mọi lỗi KHÁC (model tạm lỗi, timeout, model bị Google đổi tên...) sẽ
        // dừng NGAY LẬP TỨC dù đang ở chế độ Auto, khiến Auto trông như "không có tác dụng gì".
        // Giờ ở chế độ Auto: bất kỳ lỗi nào từ model hiện tại cũng thử ĐỔI SANG MODEL KẾ TIẾP
        // trước khi chịu thua — vì mục đích của Auto là cố hết cách để vẫn trả lời được.
        if (!upstream.ok || !upstream.body) {
          if (isAuto && i < candidates.length - 1) {
            await send('fallback', { from: chosenModel, to: candidates[i + 1], reason: 'error' });
            continue;
          }
          break;
        }
        break; // thành công (không nên tới đây vì đã break outer ở trên, giữ để an toàn)
      }
      await send('model', chosenModel);

      if (!upstream.ok || !upstream.body) {
        await send('error', lastErrText.slice(0, 3000));
        await writer.close();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const candidate = parsed.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            for (const p of parts) {
              if (p.thought) await send('thought', p.text || '');
              else if (p.text) await send('chunk', p.text);
            }
            if (candidate?.groundingMetadata) await send('grounding', candidate.groundingMetadata);
          } catch (e) { /* JSON chưa trọn vẹn */ }
        }
      }
      logMetric(env, { endpoint: '/api/chat/stream', model: chosenModel, ok: true });
      await send('done', {});
      await writer.close();
    } catch (err) {
      logMetric(env, { endpoint: '/api/chat/stream', model, ok: false, errorMessage: err.message });
      try { await send('error', err.message); await writer.close(); } catch (e) {}
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors },
  });
}

// ---------- /api/image/generate ----------
async function handleImageGenerate(body, env, cors, userId) {
  const keyChain = await getGeminiKeyChain(env, userId);
  if (keyChain.length === 0) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
  const { prompt, pro = false, referenceImage } = body;
  if (!prompt) return json({ error: 'Thiếu prompt' }, cors, 400);

  const model = pro ? MODELS.imageGenPro : MODELS.imageGen;
  const parts = [{ text: prompt }];
  if (referenceImage) parts.push({ inlineData: { mimeType: referenceImage.mimeType, data: referenceImage.base64 } });

  let r, data;
  for (const API_KEY of keyChain) {
    r = await geminiFetch(env, `${GEMINI_BASE}/${model}:generateContent?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
    });
    data = await r.json();
    if (r.ok) break;
    if (!isQuotaError(r.status, JSON.stringify(data))) break; // lỗi khác hết hạn mức -> đổi key vô ích, dừng ngay
  }
  if (!r.ok) { logMetric(env, { endpoint: '/api/image/generate', model, ok: false, errorMessage: JSON.stringify(data).slice(0, 200) }); return json({ error: data }, cors, r.status); }
  logMetric(env, { endpoint: '/api/image/generate', model, ok: true });

  const allParts = data.candidates?.[0]?.content?.parts || [];
  const images = allParts.filter(p => p.inlineData).map(p => ({ mimeType: p.inlineData.mimeType, base64: p.inlineData.data }));
  const text = allParts.filter(p => p.text).map(p => p.text).join('\n');

  // Lưu vào R2 để xem lại sau (không chặn response nếu lỗi)
  for (const img of images) {
    try {
      const saved = await saveBase64ToR2(env, { base64: img.base64, mimeType: img.mimeType, folder: 'images' });
      img.savedUrl = saved.url;
      img.key = saved.key;
    } catch (e) { /* R2 chưa cấu hình hoặc lỗi -> bỏ qua, ảnh vẫn hiện được nhờ base64 */ }
  }

  return json({ images, text, model }, cors);
}

// ---------- /api/video/generate ----------
async function handleVideoGenerate(body, env, cors, userId) {
  const keyChain = await getGeminiKeyChain(env, userId);
  if (keyChain.length === 0) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
  const { prompt, durationSeconds = 5, sourceImage } = body;
  if (!prompt) return json({ error: 'Thiếu prompt' }, cors, 400);

  const parts = [{ text: prompt }];
  if (sourceImage) parts.push({ inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.base64 } });

  let r, data;
  for (const API_KEY of keyChain) {
    r = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.videoGen}:generateContent?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['VIDEO'], videoConfig: { durationSeconds } } }),
    });
    data = await r.json();
    if (r.ok) break;
    if (!isQuotaError(r.status, JSON.stringify(data))) break;
  }
  if (!r.ok) {
    logMetric(env, { endpoint: '/api/video/generate', model: MODELS.videoGen, ok: false, errorMessage: JSON.stringify(data).slice(0, 200) });
    return json({ error: data, note: 'Tạo video thường cần tài khoản Google AI có billing/quyền tính năng video.' }, cors, r.status);
  }
  logMetric(env, { endpoint: '/api/video/generate', model: MODELS.videoGen, ok: true });
  const allParts = data.candidates?.[0]?.content?.parts || [];
  const videos = allParts.filter(p => p.inlineData).map(p => ({ mimeType: p.inlineData.mimeType, base64: p.inlineData.data }));

  for (const v of videos) {
    try {
      const saved = await saveBase64ToR2(env, { base64: v.base64, mimeType: v.mimeType, folder: 'videos' });
      v.savedUrl = saved.url;
      v.key = saved.key;
    } catch (e) { /* bỏ qua nếu R2 lỗi */ }
  }

  return json({ videos, model: MODELS.videoGen }, cors);
}

// ---------- /api/tts/speak ----------
async function handleTtsSpeak(body, env, cors, userId) {
  const keyChain = await getGeminiKeyChain(env, userId);
  if (keyChain.length === 0) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
  const { text, voice = 'Kore' } = body;
  if (!text) return json({ error: 'Thiếu text' }, cors, 400);

  let r, data;
  for (const API_KEY of keyChain) {
    r = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.tts}:generateContent?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    data = await r.json();
    if (r.ok) break;
    if (!isQuotaError(r.status, JSON.stringify(data))) break;
  }
  if (!r.ok) { logMetric(env, { endpoint: '/api/tts/speak', model: MODELS.tts, ok: false, errorMessage: JSON.stringify(data).slice(0, 200) }); return json({ error: data }, cors, r.status); }
  const audioPart = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
  if (!audioPart) return json({ error: 'Model không trả về audio' }, cors, 500);
  logMetric(env, { endpoint: '/api/tts/speak', model: MODELS.tts, ok: true });

  const result = { mimeType: audioPart.inlineData.mimeType, base64: audioPart.inlineData.data };
  try {
    const saved = await saveBase64ToR2(env, { base64: result.base64, mimeType: result.mimeType, folder: 'audio' });
    result.savedUrl = saved.url;
    result.key = saved.key;
  } catch (e) { /* bỏ qua nếu R2 lỗi */ }

  return json(result, cors);
}

// ---------- /api/search/browse ----------
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 15000);
}
async function handleBrowse(body, env, cors, userId) {
  const keyChain = await getGeminiKeyChain(env, userId);
  if (keyChain.length === 0) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
  const { url, question } = body;
  if (!url) return json({ error: 'Thiếu url' }, cors, 400);

  // Timeout 20s cho fetch trang đích: nhiều trang chặn bot (403) hoặc tải rất chậm — không để
  // request treo tới khi Cloudflare tự huỷ (khiến client chờ vô thời hạn, tưởng "AI không nói gì").
  let pageRes;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (My-AI Bot)' }, signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Trang đích tải quá lâu (quá 20s), thử lại hoặc dùng URL khác.' : `Không tải được trang: ${e.message}`;
    return json({ error: msg }, cors, 502);
  }
  if (!pageRes.ok) return json({ error: `Không tải được trang (status ${pageRes.status}) — trang có thể chặn truy cập tự động.` }, cors, 400);
  const html = await pageRes.text();
  const text = stripHtml(html);
  if (!text) return json({ error: 'Trang không có nội dung văn bản để đọc (có thể là trang chạy hoàn toàn bằng JavaScript).' }, cors, 400);

  const prompt = `Đây là nội dung văn bản trích từ trang web ${url}:\n\n"""${text}"""\n\n---\nYêu cầu của người dùng: ${question || 'Tóm tắt nội dung chính của trang này bằng tiếng Việt.'}`;
  let lastErr;
  for (const API_KEY of keyChain) {
    try {
      const result = await askGemini(env, API_KEY, MODELS.chatSmart, prompt);
      if (!result.text) return json({ error: 'AI không trả về nội dung (có thể do bị chặn an toàn nội dung hoặc lỗi tạm thời) — thử lại.' }, cors, 502);
      return json({ answer: result.text, sourceUrl: url }, cors);
    } catch (e) {
      lastErr = e;
      if (!isQuotaError(0, e.message || '')) break;
    }
  }
  return json({ error: `Lỗi gọi AI: ${lastErr?.message}` }, cors, 502);
}

// ---------- /api/search/deep-research ----------
// Gọi askGemini nhưng tự thử lần lượt các key trong chain nếu gặp lỗi HẾT HẠN MỨC — dùng cho
// những chỗ gọi askGemini nhiều lần liên tiếp (deep research) để đỡ lặp code retry ở từng chỗ gọi.
async function askGeminiWithChain(env, keyChain, model, prompt, opts) {
  let lastErr;
  for (const key of keyChain) {
    try {
      return await askGemini(env, key, model, prompt, opts);
    } catch (e) {
      lastErr = e;
      if (!isQuotaError(0, e.message || '')) throw e;
    }
  }
  throw lastErr || new Error('Không có key Gemini nào khả dụng');
}

function handleDeepResearch(body, env, cors, ctx, userId) {
  const { query } = body;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event, data) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const work = (async () => {
    try {
      const keyChain = await getGeminiKeyChain(env, userId);
      if (keyChain.length === 0) { await send('error', 'Thiếu GEMINI_API_KEY'); await writer.close(); return; }
      if (!query) { await send('error', 'Thiếu query'); await writer.close(); return; }

      await send('progress', 'Đang lên kế hoạch nghiên cứu...');
      const planPrompt = `Chia câu hỏi sau thành 3-4 câu hỏi phụ cần tra cứu để trả lời đầy đủ và chính xác. Chỉ liệt kê mỗi dòng một câu hỏi, không đánh số, không giải thích thêm:\n"${query}"`;
      const plan = await askGeminiWithChain(env, keyChain, MODELS.chatFast, planPrompt);
      const subQuestions = plan.text.split('\n').map(s => s.replace(/^[-*\d.]+\s*/, '').trim()).filter(Boolean).slice(0, 4);
      await send('plan', subQuestions);

      const findings = [];
      for (const q of subQuestions) {
        await send('progress', `Đang tra cứu: ${q}`);
        const r = await askGeminiWithChain(env, keyChain, MODELS.chatSmart, q, { webSearch: true });
        findings.push({ question: q, answer: r.text });
        await send('finding', { question: q, answer: r.text });
      }

      await send('progress', 'Đang tổng hợp báo cáo cuối cùng...');
      const synthPrompt = `Câu hỏi gốc: "${query}"\n\nCác phát hiện từ tra cứu:\n${findings.map((f, i) => `${i + 1}. ${f.question}\n${f.answer}`).join('\n\n')}\n\nHãy tổng hợp thành một báo cáo mạch lạc, có cấu trúc rõ ràng (dùng heading, gạch đầu dòng), trả lời trực tiếp câu hỏi gốc, bằng tiếng Việt.`;
      const final = await askGeminiWithChain(env, keyChain, MODELS.chatSmart, synthPrompt);
      await send('report', final.text);
      await send('done', {});
      await writer.close();
    } catch (err) {
      try { await send('error', err.message); await writer.close(); } catch (e) {}
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/health') return json({ ok: true, hasApiKey: !!env.GEMINI_API_KEY }, cors);

      // ---------- ROUTE TẠM: tạo Vectorize metadata index cho field "userId" ----------
      // Chỉ cần mở URL này 1 LẦN trên trình duyệt sau khi deploy, để Vectorize cho phép filter
      // theo userId khi tìm kiếm ngữ nghĩa (bắt buộc phải khai báo field trước khi dùng filter).
      // Yêu cầu 2 secret: CF_ACCOUNT_ID và CF_API_TOKEN (token cần quyền "Vectorize: Edit").
      // Sau khi chạy thành công 1 lần, có thể xoá cả route này lẫn 2 secret nếu muốn.
      if (url.pathname === '/api/admin/setup-vectorize-index') {
        if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
          return json({ error: 'Thiếu secret CF_ACCOUNT_ID hoặc CF_API_TOKEN. Chạy: wrangler secret put CF_ACCOUNT_ID và wrangler secret put CF_API_TOKEN' }, cors, 500);
        }
        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/vectorize/v2/indexes/my-ai-chat-index/metadata_index/create`;
        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyName: 'userId', indexType: 'string' }),
        });
        const data = await r.json();
        return json({ status: r.status, cloudflareResponse: data }, cors, r.ok ? 200 : 500);
      }

      // ---------- Đăng nhập bằng Google ----------
      // POST /api/auth/google { credential } -> xác minh ID token Google, upsert user vào D1,
      // trả về { token, user } — "token" là session token riêng của app, FE lưu lại và gửi kèm
      // mọi request sau qua header "Authorization: Bearer <token>".
      if (request.method === 'POST' && url.pathname === '/api/auth/google') {
        const { credential, rememberMe = true } = await request.json();
        if (!credential) return json({ error: 'Thiếu credential' }, cors, 400);
        if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Server chưa cấu hình GOOGLE_CLIENT_ID' }, cors, 500);
        let payload;
        try { payload = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID); }
        catch (e) { return json({ error: 'Đăng nhập Google thất bại: ' + e.message }, cors, 401); }
        const user = { id: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
        await upsertUser(env, user);
        const token = await createSessionToken(env, user.id, rememberMe);
        return json({ token, user }, cors);
      }

      // ---------- Quên mật khẩu ----------
      // POST /api/auth/forgot-password { email, resetUrlBase } -> gửi email chứa link reset.
      // resetUrlBase do FE truyền vào (chính URL trang đăng nhập của FE), để link trong email
      // trỏ đúng về app dù bạn đổi domain sau này (không hard-code domain ở worker).
      if (request.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
        const { email, resetUrlBase } = await request.json();
        if (!email || !resetUrlBase) return json({ error: 'Thiếu email hoặc resetUrlBase' }, cors, 400);
        try {
          await requestPasswordReset(env, { email, resetUrlBase });
        } catch (e) {
          console.error('[forgot-password] lỗi:', e.message);
          // Vẫn trả 200 để không lộ thông tin, nhưng log lỗi thật để bạn tự debug (vd. thiếu RESEND_API_KEY)
        }
        return json({ ok: true, message: 'Nếu email tồn tại, hướng dẫn đặt lại mật khẩu đã được gửi.' }, cors);
      }
      // POST /api/auth/reset-password { token, newPassword } -> đổi mật khẩu bằng token từ email.
      if (request.method === 'POST' && url.pathname === '/api/auth/reset-password') {
        const { token, newPassword } = await request.json();
        try {
          await resetPasswordWithToken(env, { token, newPassword });
        } catch (e) {
          return json({ error: e.message }, cors, 400);
        }
        return json({ ok: true }, cors);
      }
      // POST /api/auth/register { email, password, name?, rememberMe? } -> { token, user }
      if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        const { email, password, name, rememberMe = true } = await request.json();
        let user;
        try { user = await registerLocalUser(env, { email, password, name }); }
        catch (e) { return json({ error: e.message }, cors, 400); }
        const token = await createSessionToken(env, user.id, rememberMe);
        return json({ token, user }, cors);
      }
      // POST /api/auth/login { email, password, rememberMe? } -> { token, user }
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const { email, password, rememberMe = true } = await request.json();
        let user;
        try { user = await loginLocalUser(env, { email, password }); }
        catch (e) { return json({ error: e.message }, cors, 401); }
        const token = await createSessionToken(env, user.id, rememberMe);
        return json({ token, user }, cors);
      }

      // Mọi route /api/conversations* dưới đây yêu cầu đăng nhập.
      const userId = await getUserIdFromRequest(request, env);
      const requireAuth = url.pathname.startsWith('/api/conversations') || url.pathname === '/api/search/semantic';
      if (requireAuth && !userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);

      // ---------- Chỉ CHỦ APP mới được dùng: Agent Mode, "Mở web & hỏi AI", Deep Research ----------
      const isOwnerReq = !!(userId && env.OWNER_USER_ID && userId === env.OWNER_USER_ID);
      const isRestrictedRoute =
        url.pathname.startsWith('/api/agent-browser') ||
        url.pathname.startsWith('/api/agent/') ||
        url.pathname === '/api/search/browse' ||
        url.pathname === '/api/search/deep-research';
      if (isRestrictedRoute && !isOwnerReq) {
        return json({ error: 'Tính năng này chỉ dành cho chủ app.' }, cors, 403);
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/stream') return handleChatStream(await request.json(), env, cors, ctx, userId);
      if (request.method === 'POST' && url.pathname === '/api/image/generate') return await handleImageGenerate(await request.json(), env, cors, userId);
      if (request.method === 'POST' && url.pathname === '/api/video/generate') return await handleVideoGenerate(await request.json(), env, cors, userId);
      if (request.method === 'POST' && url.pathname === '/api/tts/speak') return await handleTtsSpeak(await request.json(), env, cors, userId);

      // ---------- D1: lịch sử chat ----------
      // GET  /api/conversations              -> danh sách hội thoại (của user đang đăng nhập)
      // POST /api/conversations               -> tạo hội thoại mới { title?, model? }
      // GET  /api/conversations/<id>/messages -> lấy toàn bộ tin nhắn 1 hội thoại
      // POST /api/conversations/<id>/messages -> lưu 1 tin nhắn { role, content, model? } (tự động index Vectorize nếu có)
      // POST /api/conversations/<id>/rename   -> đổi tên { title }
      // DELETE /api/conversations/<id>        -> xoá hội thoại + toàn bộ tin nhắn
      if (request.method === 'GET' && url.pathname === '/api/conversations') {
        return json(await listConversations(env, { userId }), cors);
      }
      if (request.method === 'POST' && url.pathname === '/api/conversations') {
        const body = await request.json();
        return json(await createConversation(env, { ...body, userId }), cors);
      }
      const convMsgMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (convMsgMatch && request.method === 'GET') {
        return json(await getConversationMessages(env, convMsgMatch[1], userId), cors);
      }
      if (convMsgMatch && request.method === 'POST') {
        const body = await request.json();
        const { role, content, model } = body;
        if (!role || !content) return json({ error: 'Thiếu role hoặc content' }, cors, 400);
        const saved = await saveMessage(env, { conversationId: convMsgMatch[1], role, content, model });
        // Đánh chỉ mục ngữ nghĩa để tìm lại sau này — không chặn response nếu Vectorize lỗi/chưa cấu hình,
        // nhưng LUÔN log lỗi ra (trước đây .catch(() => {}) nuốt lỗi im lặng, khiến bug
        // "tìm kiếm ngữ nghĩa không ra kết quả" rất khó chẩn đoán vì không có dấu vết gì).
        ctx.waitUntil(
          indexMessage(env, { messageId: saved.id, conversationId: convMsgMatch[1], userId, role, content })
            .catch(err => console.error('[Vectorize] indexMessage lỗi:', err.message))
        );
        return json(saved, cors);
      }
      const convRenameMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/rename$/);
      if (convRenameMatch && request.method === 'POST') {
        const { title } = await request.json();
        await renameConversation(env, convRenameMatch[1], title, userId);
        return json({ ok: true }, cors);
      }
      // ---------- AI tự đặt tên hội thoại (gọi 1 lần sau tin nhắn đầu tiên) ----------
      // POST /api/conversations/<id>/auto-title { userText, assistantText } -> { title }
      const convAutoTitleMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/auto-title$/);
      if (convAutoTitleMatch && request.method === 'POST') {
        const { userText = '', assistantText = '' } = await request.json();
        const prompt = `Đặt 1 tiêu đề thật ngắn gọn (tối đa 6 từ, không dấu ngoặc kép, không chấm câu cuối) ` +
          `cho đoạn hội thoại sau, bằng tiếng Việt:\nNgười dùng: ${userText.slice(0, 300)}\nTrợ lý: ${assistantText.slice(0, 300)}`;
        let title = 'Cuộc trò chuyện mới';
        try {
          const result = await askGemini(env, env.GEMINI_API_KEY, MODELS.chatLite, prompt);
          title = (result?.text || '').replace(/["'.\n]/g, '').trim().slice(0, 60) || title;
        } catch (e) { title = userText.slice(0, 60) || title; }
        await renameConversation(env, convAutoTitleMatch[1], title, userId);
        return json({ title }, cors);
      }
      // DELETE /api/conversations/<id> -> xoá MỀM (khôi phục được trong 7 ngày, xem /api/conversations/trash)
      const convDelMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (convDelMatch && request.method === 'DELETE') {
        await deleteConversation(env, convDelMatch[1], userId);
        return json({ ok: true }, cors);
      }

      // GET /api/conversations/trash -> danh sách hội thoại đã xoá, còn trong hạn 7 ngày
      // (tự dọn rác quá hạn trước khi trả kết quả, không cần cron riêng)
      if (request.method === 'GET' && url.pathname === '/api/conversations/trash') {
        ctx.waitUntil(purgeExpiredConversations(env).catch(() => {}));
        return json(await listDeletedConversations(env, { userId }), cors);
      }

      // POST /api/conversations/<id>/restore -> khôi phục hội thoại đã xoá mềm
      const convRestoreMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/restore$/);
      if (convRestoreMatch && request.method === 'POST') {
        await restoreConversation(env, convRestoreMatch[1], userId);
        return json({ ok: true }, cors);
      }

      // DELETE /api/conversations/<id>/purge -> xoá vĩnh viễn ngay (bỏ qua 7 ngày chờ)
      const convPurgeMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/purge$/);
      if (convPurgeMatch && request.method === 'DELETE') {
        await purgeConversation(env, convPurgeMatch[1], userId);
        return json({ ok: true }, cors);
      }

      // ---------- Vectorize: tìm kiếm ngữ nghĩa trong lịch sử chat ----------
      // GET /api/search/semantic?q=...&conversationId=... (conversationId tuỳ chọn, để lọc trong 1 hội thoại)
      if (request.method === 'GET' && url.pathname === '/api/search/semantic') {
        const q = url.searchParams.get('q');
        const conversationId = url.searchParams.get('conversationId') || undefined;
        if (!q) return json({ error: 'Thiếu tham số q' }, cors, 400);
        return json(await searchMessages(env, q, { conversationId, userId }), cors);
      }

      // ---------- Queue: tạo video chạy nền (không sợ timeout) ----------
      // POST /api/video/generate-async { prompt, durationSeconds?, sourceImage? } -> { jobId }
      // GET  /api/video/status/<jobId>                                            -> { status, videos? }
      if (request.method === 'POST' && url.pathname === '/api/video/generate-async') {
        const body = await request.json();
        if (!body.prompt) return json({ error: 'Thiếu prompt' }, cors, 400);
        return json(await enqueueVideoJob(env, body, userId), cors);
      }
      const videoStatusMatch = url.pathname.match(/^\/api\/video\/status\/([^/]+)$/);
      if (videoStatusMatch && request.method === 'GET') {
        return json(await getVideoJobStatus(env, videoStatusMatch[1]), cors);
      }

      // ---------- KV: cấu hình app ----------
      // GET  /api/config      -> đọc cấu hình hiện tại
      // POST /api/config      -> ghi đè cấu hình { ...bất kỳ key nào bạn muốn lưu... }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return json(await getAppConfig(env), cors);
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        const body = await request.json();
        return json(await setAppConfig(env, body), cors);
      }
      // ===================== API KEY — gắn Velocitix AI vào file HTML/app ngoài =====================
      // GET  /api/apikey             -> lấy (hoặc tạo lần đầu) key của user đang đăng nhập (cần session token)
      // POST /api/apikey/regenerate  -> thu hồi key cũ, phát key mới (cần session token)
      // POST /api/external/chat      -> gọi AI bằng key này thay vì đăng nhập, kèm rate limit
      if (request.method === 'GET' && url.pathname === '/api/me') {
        return json({ isOwner: isOwnerReq }, cors);
      }
      if (request.method === 'GET' && url.pathname === '/api/apikey') {
        const userId = await getUserIdFromRequest(request, env);
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        const apiKey = await getOrCreateApiKey(env, userId);
        // Đọc số lần đã dùng trong KV (không tăng đếm, chỉ xem) để hiện "còn X/2 lượt hôm nay".
        const usedRaw = await env.MY_AI_KV?.get(`ratelimit:apikey-regen:${userId}`);
        const remaining = Math.max(0, 2 - (usedRaw ? parseInt(usedRaw, 10) : 0));
        return json({ apiKey, remaining }, cors);
      }
      if (request.method === 'POST' && url.pathname === '/api/apikey/regenerate') {
        const userId = await getUserIdFromRequest(request, env);
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        try {
          const { apiKey } = await regenerateApiKey(env, userId);
          const usedRaw = await env.MY_AI_KV?.get(`ratelimit:apikey-regen:${userId}`);
          const remaining = Math.max(0, 2 - (usedRaw ? parseInt(usedRaw, 10) : 0));
          return json({ apiKey, remaining }, cors);
        } catch (e) {
          return json({ error: e.message }, cors, e.limitReached ? 403 : 500);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/external/chat') {
        const key = request.headers.get('x-api-key');
        if (!key) return json({ error: 'Thiếu header x-api-key' }, cors, 401);
        const userId = await getUserIdFromApiKey(env, key);
        if (!userId) return json({ error: 'API key không hợp lệ' }, cors, 401);

        // Chặn spam nhanh (chống 1 file HTML gọi lặp vô tội vạ) + chặn xài quá nhiều trong ngày.
        const okBurst = await checkRateLimit(env, `ext:${key}:min`, { limit: 3, windowSeconds: 60 });
        if (!okBurst) return json({ error: 'Gửi quá nhanh — tối đa 3 request/phút, thử lại sau ít phút' }, cors, 429);
        const okDaily = await checkRateLimit(env, `ext:${key}:day`, { limit: 200, windowSeconds: 86400 });
        if (!okDaily) return json({ error: 'Đã hết lượt dùng hôm nay cho API key này (200/ngày)' }, cors, 429);

        const body = await request.json();
        const prompt = body?.prompt;
        if (!prompt || typeof prompt !== 'string') return json({ error: 'Thiếu prompt (string)' }, cors, 400);

        // Cho phép chọn model qua field "model" (auto/lite/fast/smart) — mặc định chatSmart nếu
        // không gửi hoặc gửi giá trị lạ. Model coding luôn bị chặn ở đây cho non-owner, kể cả khi
        // gửi thẳng tên model đó qua request (không đi qua UI).
        const ALLOWED_EXTERNAL_MODELS = { lite: MODELS.chatLite, fast: MODELS.chatFast, smart: MODELS.chatSmart, coding: MODELS.chatCoding };
        const isOwnerExt = !!(userId && env.OWNER_USER_ID && userId === env.OWNER_USER_ID);
        let chosenModel = ALLOWED_EXTERNAL_MODELS[body?.model] || MODELS.chatSmart;
        if (chosenModel === MODELS.chatCoding && !isOwnerExt) chosenModel = MODELS.chatSmart;

        const keyChain = await getGeminiKeyChain(env, userId);
        if (keyChain.length === 0) return json({ error: 'Server chưa cấu hình GEMINI_API_KEY' }, cors, 400);

        let lastErr;
        for (const geminiKey of keyChain) {
          try {
            const result = await askGemini(env, geminiKey, chosenModel, prompt);
            return json(result, cors);
          } catch (e) {
            lastErr = e;
            if (!isQuotaError(0, e.message || '')) break; // lỗi khác hết hạn mức -> dừng ngay, đổi key vô ích
          }
        }
        return json({ error: lastErr?.message || 'Lỗi gọi Gemini' }, cors, 500);
      }

      if (request.method === 'POST' && url.pathname === '/api/search/browse') return await handleBrowse(await request.json(), env, cors, userId);
      if (request.method === 'POST' && url.pathname === '/api/search/deep-research') return handleDeepResearch(await request.json(), env, cors, ctx, userId);

      // ---------- Thư viện file (R2) ----------
      // Liệt kê file: GET /api/files?folder=images&cursor=...
      if (request.method === 'GET' && url.pathname === '/api/files') {
        const folder = url.searchParams.get('folder') || '';
        const cursor = url.searchParams.get('cursor') || undefined;
        const result = await listR2Files(env, { prefix: folder, cursor });
        return json(result, cors);
      }

      // Upload file base64 thủ công: POST /api/files/upload { base64, mimeType, filename, folder }
      if (request.method === 'POST' && url.pathname === '/api/files/upload') {
        const body = await request.json();
        const { base64, mimeType, filename, folder = 'uploads' } = body;
        if (!base64 || !mimeType) return json({ error: 'Thiếu base64 hoặc mimeType' }, cors, 400);
        const saved = await saveBase64ToR2(env, { base64, mimeType, filename, folder });
        return json(saved, cors);
      }

      // Xem 1 file: GET /api/files/<key>  (key có thể chứa "/", vd images/12345-abcd.png)
      if (request.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const key = decodeURIComponent(url.pathname.replace('/api/files/', ''));
        const file = await getR2File(env, key);
        if (!file) return json({ error: 'Không tìm thấy file' }, cors, 404);
        const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
        return new Response(bytes, {
          headers: {
            'Content-Type': file.mimeType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000',
            ...cors,
          },
        });
      }

      // Xoá 1 file: DELETE /api/files/<key>
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/files/')) {
        const key = decodeURIComponent(url.pathname.replace('/api/files/', ''));
        await deleteR2File(env, key);
        return json({ ok: true }, cors);
      }

      // ===================== MCP — MỌI NGƯỜI DÙNG tự kết nối tài khoản riêng của họ =====================
      // Khác hẳn GEMINI_API_KEY_OWNER (1 key dùng chung do chủ app cấu hình): token MCP ở đây là
      // CỦA RIÊNG từng user, tự dán trong Cài đặt — nên ai cũng dùng được, không chỉ chủ app.
      if (request.method === 'GET' && url.pathname === '/api/mcp/status') {
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        return json({ servers: await getUserMcpStatus(env, userId) }, cors);
      }
      if (request.method === 'POST' && url.pathname === '/api/mcp/connect') {
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        const { provider, token } = await request.json();
        if (!MCP_PROVIDERS_PAT[provider]) return json({ error: 'Provider không hợp lệ hoặc chưa hỗ trợ dán token (cần OAuth)' }, cors, 400);
        if (!token || typeof token !== 'string') return json({ error: 'Thiếu token' }, cors, 400);
        await setUserMcpToken(env, userId, provider, token.trim());
        return json({ ok: true }, cors);
      }
      if (request.method === 'POST' && url.pathname === '/api/mcp/disconnect') {
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        const { provider } = await request.json();
        await deleteUserMcpToken(env, userId, provider);
        return json({ ok: true }, cors);
      }

      // ---- OAuth cho GitHub/Gmail/Drive: bấm nút -> đăng nhập bên provider -> tự lưu token ----
      // GET vì trình duyệt điều hướng thẳng (window.location), không gắn header Authorization được
      // -> truyền session token qua query string thay vì header, chỉ dùng lúc khởi tạo redirect này.
      if (request.method === 'GET' && url.pathname === '/api/mcp/oauth/start') {
        const provider = url.searchParams.get('provider');
        const sessionToken = url.searchParams.get('token');
        if (!OAUTH_PROVIDERS[provider]) return json({ error: 'Provider OAuth không hợp lệ' }, cors, 400);
        const fakeReq = new Request(request.url, { headers: { Authorization: 'Bearer ' + sessionToken } });
        const oauthUserId = await getUserIdFromRequest(fakeReq, env);
        if (!oauthUserId) return json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' }, cors, 401);

        const state = crypto.randomUUID();
        await env.MY_AI_KV.put(`mcp-oauth-state:${state}`, JSON.stringify({ userId: oauthUserId, provider }), { expirationTtl: 600 });
        const authorizeUrl = await buildAuthorizeUrl(env, provider, state);
        return Response.redirect(authorizeUrl, 302);
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const errorParam = url.searchParams.get('error');
        // ⚠️ FIX: URL trước đây là "<APP_URL>/#settings?mcp_connected=..." — SAI THỨ TỰ, vì phần
        // sau dấu "#" là fragment, nên "?mcp_connected=..." bị coi là 1 phần của fragment thay vì
        // query string thật. window.location.search phía frontend luôn RỖNG, nên không bao giờ
        // phát hiện được đã kết nối xong hay lỗi gì — trông như OAuth "không có tác dụng gì", dù
        // token vẫn được lưu đúng ở D1. Query string PHẢI đứng TRƯỚC dấu "#".
        const appBase = env.APP_URL || '';
        const withParam = (param) => `${appBase}/?${param}#settings`;
        if (errorParam) return Response.redirect(withParam(`mcp_error=${encodeURIComponent(errorParam)}`), 302);

        const raw = await env.MY_AI_KV.get(`mcp-oauth-state:${state}`);
        if (!raw) return Response.redirect(withParam('mcp_error=state_expired'), 302);
        await env.MY_AI_KV.delete(`mcp-oauth-state:${state}`);
        const { userId: oauthUserId, provider } = JSON.parse(raw);

        try {
          const { accessToken, refreshToken, expiresAt } = await exchangeCodeForToken(env, provider, code);
          await setUserMcpToken(env, oauthUserId, provider, accessToken, refreshToken, expiresAt);
          return Response.redirect(withParam(`mcp_connected=${provider}`), 302);
        } catch (e) {
          return Response.redirect(withParam(`mcp_error=${encodeURIComponent(e.message)}`), 302);
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/mcp/chat') {
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        const { message } = await request.json();
        if (!message) return json({ error: 'Thiếu message' }, cors, 400);
        const keyChain = await getGeminiKeyChain(env, userId);
        if (keyChain.length === 0) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
        try {
          const servers = await getUserConnectedMcpServers(env, userId);
          const result = await runMcpChat(env, keyChain, servers, message, userId);
          return json(result, cors);
        } catch (e) {
          return json({ error: e.message }, cors, 500);
        }
      }
      // Xác nhận (hoặc huỷ) 1 hành động KHÔNG THỂ HOÀN TÁC mà /api/mcp/chat vừa báo là
      // needsConfirmation=true — confirmId lấy từ chính response đó. approve=false vẫn cho AI
      // tiếp tục trả lời (giải thích là đã huỷ), chỉ approve=true mới thật sự gọi tool.
      if (request.method === 'POST' && url.pathname === '/api/mcp/chat/confirm') {
        if (!userId) return json({ error: 'Chưa đăng nhập' }, cors, 401);
        const { confirmId, approve } = await request.json();
        if (!confirmId) return json({ error: 'Thiếu confirmId' }, cors, 400);
        const keyChain = await getGeminiKeyChain(env, userId);
        if (keyChain.length === 0) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
        try {
          const result = await resumeMcpChat(env, keyChain, userId, confirmId, !!approve);
          return json(result, cors);
        } catch (e) {
          return json({ error: e.message }, cors, 500);
        }
      }

      // ---------- Điều khiển trình duyệt thật (mục riêng sidebar) — dùng Browser Rendering ----------
      if (request.method === 'POST' && url.pathname === '/api/agent-browser/session') {
        return await agentBrowserRoutes.handleCreateSession(await request.json(), env, json, cors);
      }
      {
        const m = url.pathname.match(/^\/api\/agent-browser\/([^/]+)\/(state|act|approve|reject|step)$/);
        if (m) {
          const [, sid, action] = m;
          if (action === 'state' && request.method === 'GET') return await agentBrowserRoutes.handleGetState(sid, env, json, cors);
          if (action === 'act' && request.method === 'POST') return await agentBrowserRoutes.handleAct(sid, await request.json(), env, json, cors);
          if (action === 'approve' && request.method === 'POST') return await agentBrowserRoutes.handleApprove(sid, env, json, cors);
          if (action === 'reject' && request.method === 'POST') return await agentBrowserRoutes.handleReject(sid, env, json, cors);
          if (action === 'step' && request.method === 'POST') return await agentBrowserRoutes.handleStep(sid, await request.json(), env, json, cors, userId);
        }
      }
      {
        const m = url.pathname.match(/^\/api\/agent-browser\/([^/]+)$/);
        if (m && request.method === 'DELETE') return await agentBrowserRoutes.handleClose(m[1], env, json, cors);
      }

      // ---------- Agent Mode (đa công cụ, khác Deep Research) ----------
      if (request.method === 'POST' && url.pathname === '/api/agent/run') {
        return agentRoutes.handleRun(await request.json(), env, cors, ctx, userId);
      }
      {
        const m = url.pathname.match(/^\/api\/agent\/([^/]+)\/resume$/);
        if (m && request.method === 'POST') return agentRoutes.handleResume(m[1], await request.json(), env, cors, ctx, userId);
      }
      {
        const m = url.pathname.match(/^\/api\/agent\/([^/]+)$/);
        if (m && request.method === 'DELETE') return await agentRoutes.handleDeleteTask(m[1], env, json, cors);
      }

      return json({ error: 'Not found' }, cors, 404);
    } catch (err) {
      return json({ error: err.message }, cors, 500);
    }
  },

  // ---------- Queue consumer: xử lý job video NỀN ----------
  // Cloudflare tự gọi hàm này mỗi khi có message mới trong queue
  // "my-ai-video-queue" (xem [[queues.consumers]] trong wrangler.toml).
  // KHÔNG liên quan tới request HTTP nào -> không sợ timeout 30s.
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processVideoJob(env, message.body);
        message.ack(); // báo Cloudflare: job đã xử lý xong, không cần retry
      } catch (err) {
        message.retry(); // lỗi -> Cloudflare tự thử lại theo max_retries trong wrangler.toml
      }
    }
  },
};
