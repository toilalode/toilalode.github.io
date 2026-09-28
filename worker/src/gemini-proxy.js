// ---------- Durable Object: ép mọi request gọi Gemini API luôn xuất phát từ 1 vùng cố định ----------
// Lý do: Cloudflare Worker "thường" chạy phân tán khắp nơi trên thế giới, có lúc bị định tuyến
// qua 1 vùng mà Google chưa hỗ trợ Gemini API (=> lỗi "User location is not supported for the
// API use", dù bạn đang ngồi ở vùng được hỗ trợ). Durable Object thì được ghim cố định vào 1
// vùng (locationHint) ngay từ lần đầu tạo, nên mọi lần gọi Gemini sau đó luôn xuất phát từ đúng
// vùng đó, ổn định hơn nhiều so với Worker thường.
export class GeminiProxyDO {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    // Chỉ đơn thuần chuyển tiếp y nguyên request (kể cả streaming) tới Gemini.
    return fetch(request);
  }
}

// Thử lần lượt các vùng này cho tới khi gọi Gemini thành công (né lỗi "User location is not supported").
// Thứ tự ưu tiên vùng Mỹ/Canada trước (Gemini API hỗ trợ chắc chắn). Bỏ 'weur'/'eeur' khỏi danh sách
// đầu vì Google có thể chặn key free tier khi request đi từ EEA/UK/CH ("...without a billing account linked").
// 'apac' để sau vì có thể rơi vào datacenter HKG (không ổn định với Gemini).
const GEMINI_LOCATION_HINTS = ['wnam', 'enam', 'oc', 'sam', 'apac', 'weur', 'eeur'];

// Tên DO có hậu tố phiên bản: DO đã lỡ tạo ở vùng bị chặn sẽ "dính" vùng đó mãi mãi (locationHint chỉ
// có tác dụng lúc tạo lần đầu). Đổi hậu tố => tạo DO mới ở đúng vùng. Nếu vẫn lỗi, đổi v3, v4...
const DO_NAME_VERSION = 'v3';

// Nhớ vùng gọi thành công gần nhất (trong isolate hiện tại) để lần sau thử vùng đó trước, khỏi lặp cả danh sách.
let lastGoodHint = null;

async function isLocationBlockedResponse(res) {
  if (res.status !== 400 && res.status !== 403) return false;
  try {
    const data = await res.clone().json();
    const msg = data?.error?.message || '';
    return /user location is not supported/i.test(msg);
  } catch { return false; }
}

export async function geminiFetch(env, url, options = {}) {
  if (!env.GEMINI_PROXY) return fetch(url, options); // fallback nếu chưa deploy DO binding

  const order = lastGoodHint
    ? [lastGoodHint, ...GEMINI_LOCATION_HINTS.filter(h => h !== lastGoodHint)]
    : GEMINI_LOCATION_HINTS;

  // Body dạng stream chỉ đọc được 1 lần -> chuyển sang string để thử lại nhiều vùng được.
  const opts = { ...options };
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof ArrayBuffer)) {
    opts.body = await new Response(opts.body).arrayBuffer();
  }

  let lastRes = null;
  for (const hint of order) {
    const id = env.GEMINI_PROXY.idFromName(`gemini-proxy-${DO_NAME_VERSION}-${hint}`);
    const stub = env.GEMINI_PROXY.get(id, { locationHint: hint });
    let res;
    try { res = await stub.fetch(new Request(url, opts)); }
    catch { continue; }
    if (!(await isLocationBlockedResponse(res))) { lastGoodHint = hint; return res; }
    lastRes = res; // lỗi vị trí -> thử vùng tiếp theo
  }
  return lastRes || fetch(url, opts);
}

// Chẩn đoán: mỗi vùng thực sự chạy ở datacenter nào + Google có chấp nhận không.
export async function diagnoseGeminiRegions(env, apiKey) {
  const out = [];
  for (const hint of GEMINI_LOCATION_HINTS) {
    const id = env.GEMINI_PROXY.idFromName(`gemini-proxy-${DO_NAME_VERSION}-${hint}`);
    const stub = env.GEMINI_PROXY.get(id, { locationHint: hint });
    const row = { hint };
    try {
      const t = await (await stub.fetch(new Request('https://www.cloudflare.com/cdn-cgi/trace'))).text();
      row.colo = /colo=(\w+)/.exec(t)?.[1]; row.loc = /loc=(\w+)/.exec(t)?.[1];
      const r = await stub.fetch(new Request(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1`));
      row.gemini = (await isLocationBlockedResponse(r)) ? 'BLOCKED' : `OK (${r.status})`;
    } catch (e) { row.error = String(e.message || e); }
    out.push(row);
  }
  return out;
}
