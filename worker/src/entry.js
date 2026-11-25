// Điểm vào của Worker (wrangler.toml: main = "src/entry.js"). Bọc index.js để:
//  1. Chế độ Auto: nhờ Cloudflare AI chọn model + mức nỗ lực rồi giao cho handler chat cũ.
//  2. Tạo ảnh / tạo video / Deep Research đã bị gỡ khỏi app: các route này trả 410 (đỡ tốn quota/billing).
import base, { GeminiProxyDO, GeminiLiveDO } from './index.js';
import { routeAuto } from './autoRouter.js';
import { rememberAutoRoute } from './models.js';

export { GeminiProxyDO, GeminiLiveDO };

const REMOVED = [
  /^\/api\/image\/generate$/,
  /^\/api\/video\/generate(-async)?$/,
  /^\/api\/video\/status\//,
  /^\/api\/search\/deep-research$/,
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'OPTIONS' && REMOVED.some(re => re.test(url.pathname))) {
      return new Response(JSON.stringify({ error: 'Tính năng này đã được gỡ khỏi app.' }), {
        status: 410,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Vary': 'Origin',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/stream' && request.headers.get('Authorization')) {
      const backup = request.clone();
      try {
        const body = await request.json();
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
