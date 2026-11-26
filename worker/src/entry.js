// Điểm vào của Worker (wrangler.toml: main = "src/entry.js"). Bọc index.js để:
//  1. Chế độ Auto: nhờ Cloudflare AI chọn model + mức nỗ lực rồi giao cho handler chat cũ.
//  2. Tạo ảnh / tạo video / Deep Research đã bị gỡ khỏi app: các route này trả 410 (đỡ tốn quota/billing).
//  3. POST /api/auto/route: cho Agent Mode (chạy ở Render) và "Mở web & hỏi AI" hỏi Cloudflare AI nên dùng model nào.
//  4. "Mở web & hỏi AI" (/api/search/browse) dùng đúng model người dùng chọn.
//  5. API ngoài POST /api/external/chat (x-api-key): thêm model Hydrogen / Gemma + mức nỗ lực / bật-tắt thinking
//     — xử lý ở externalChat.js (route cũ trong index.js không còn được chạy tới).
//  6. Gemini 4 Hydrogen CHỈ DÀNH CHO CHỦ APP (OWNER_USER_ID). Người khác chọn Hydrogen (hoặc Auto định tuyến
//     ra Hydrogen) thì tự rơi về 3.5 Flash — chặn thật ở đây, giao diện chỉ ẩn cho gọn.
import base, { GeminiProxyDO, GeminiLiveDO } from './index.js';
import { routeAuto } from './autoRouter.js';
import { MODELS, isHydrogenModel, rememberAutoRoute, modelScope, normalizeChatModel } from './models.js';
import { getUserIdFromRequest } from './auth.js';
import { handleExternalChat } from './externalChat.js';

export { GeminiProxyDO, GeminiLiveDO };

const REMOVED = [
  /^\/api\/image\/generate$/,
  /^\/api\/video\/generate(-async)?$/,
  /^\/api\/video\/status\//,
  /^\/api\/search\/deep-research$/,
];

const isOwnerUser = (env, userId) => !!(userId && env.OWNER_USER_ID && userId === env.OWNER_USER_ID);
// Hydrogen chỉ cho chủ app: người khác bị hạ về 3.5 Flash.
const downgradeHydrogen = (model, isOwner) => (!isOwner && isHydrogenModel(model)) ? MODELS.chatFast : model;

const jsonRes = (obj, request, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Vary': 'Origin',
  },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'OPTIONS' && REMOVED.some(re => re.test(url.pathname))) {
      return jsonRes({ error: 'Tính năng này đã được gỡ khỏi app.' }, request, 410);
    }

    // API ngoài (x-api-key): Gemini 3.5 Flash / Gemini 4 Hydrogen (chỉ chủ app) / Gemma 4, có effort + thinking.
    if (request.method === 'POST' && url.pathname === '/api/external/chat') {
      return handleExternalChat(request, env);
    }

    // Hỏi Cloudflare AI: câu này nên dùng model nào? (cần đăng nhập). Trả { model, level, source }.
    if (request.method === 'POST' && url.pathname === '/api/auto/route') {
      const userId = await getUserIdFromRequest(request, env);
      if (!userId) return jsonRes({ error: 'Chưa đăng nhập' }, request, 401);
      let text = '';
      try { text = String((await request.json())?.text || ''); } catch (_) {}
      const route = await routeAuto(env, { text });
      const model = downgradeHydrogen(route.model, isOwnerUser(env, userId));
      return jsonRes({ model, level: route.level, source: route.source }, request);
    }

    // "Mở web & hỏi AI": chạy handler cũ trong phạm vi model người dùng chọn (MODELS.chatSmart đọc từ modelScope).
    if (request.method === 'POST' && url.pathname === '/api/search/browse' && request.headers.get('Authorization')) {
      const backup = request.clone();
      try {
        const body = await request.json();
        let model = body.model;
        if (model === 'auto') {
          model = (await routeAuto(env, { text: body.question || body.url || '' })).model;
        }
        model = normalizeChatModel(model);
        model = downgradeHydrogen(model, isOwnerUser(env, await getUserIdFromRequest(request, env)));
        const req = new Request(request, { body: JSON.stringify(body) });
        if (model === 'auto') return base.fetch(req, env, ctx);
        return modelScope.run({ model }, () => base.fetch(req, env, ctx));
      } catch (e) {
        console.warn('[entry] browse: không áp dụng được model đã chọn:', e.message);
        return base.fetch(backup, env, ctx);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/stream' && request.headers.get('Authorization')) {
      const backup = request.clone();
      try {
        const body = await request.json();
        const isOwner = isOwnerUser(env, await getUserIdFromRequest(request, env));
        body.model = downgradeHydrogen(body.model, isOwner);
        if ((body.model || 'auto') === 'auto') {
          const messages = body.messages || [];
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          // Phải GIỐNG HỆT cách index.js ghép lastUserText, vì models.js tra cứu theo chuỗi này.
          const lastUserText = lastUser?.parts?.map(p => p.text || '').join(' ') || '';
          const route = await routeAuto(env, {
            text: lastUserText,
            hasAttachments: (body.attachments || []).length > 0,
            webSearch: !!body.webSearch,
          });
          route.model = downgradeHydrogen(route.model, isOwner);
          rememberAutoRoute(lastUserText, route.model);
          body.model = 'auto';
          body.thinking = route.thinking;
          body.thinkingEffort = route.effort;
          console.log(`[auto] ${route.level} (${route.source}) -> ${route.model}, thinking=${route.thinking}, effort=${route.effort}`);
        }
        return base.fetch(new Request(request, { body: JSON.stringify(body) }), env, ctx);
      } catch (e) {
        console.warn('[entry] không định tuyến được, chuyển thẳng:', e.message);
        return base.fetch(backup, env, ctx);
      }
    }

    return base.fetch(request, env, ctx);
  },
  queue: base.queue,
};
