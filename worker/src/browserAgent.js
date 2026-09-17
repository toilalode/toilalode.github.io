// worker/src/browserAgent.js
//
// Bản THAY THẾ Playwright gốc (backend/utils/browserAgent.js) để chạy được trên Cloudflare
// Workers, dùng Cloudflare Browser Run (trước đây gọi "Browser Rendering") — dịch vụ headless
// Chrome CHẠY TRÊN HẠ TẦNG CLOUDFLARE, điều khiển qua bản fork chính thức "@cloudflare/playwright"
// (Playwright hỗ trợ GA từ 09/2025, đồng bộ Playwright v1.5x). KHÔNG cần cài Chromium/Playwright
// ở đâu cả, không cần VPS riêng.
//
// LƯU Ý khi đọc code này nếu quen @cloudflare/puppeteer: tên hàm reuse-session ở bản Playwright
// đổi khác — browser.close() ở đây CHỈ NGẮT KẾT NỐI (session thật vẫn sống), không giống ý nghĩa
// browser.close() bên Puppeteer (đóng hẳn). Đây là quy ước riêng của @cloudflare/playwright.
//
// KHÁC BIỆT quan trọng so với bản Playwright (Node) chạy trên server thường:
//  - Worker là môi trường KHÔNG GIỮ TRẠNG THÁI giữa các request (mỗi request = 1 lần chạy mới).
//    Trình duyệt thật vẫn tiếp tục chạy trên hạ tầng Cloudflare giữa các request (miễn còn hoạt
//    động — mặc định tự tắt sau ~60 giây không có lệnh nào, có thể tăng bằng keep_alive), nhưng
//    Worker phải "kết nối lại" (connect(env.MYBROWSER, sessionId)) vào đúng session cũ mỗi lần xử
//    lý 1 request, thay vì giữ biến trong bộ nhớ như Node. Vì vậy metadata của mỗi phiên
//    (sessionId thật của Cloudflare, URL hiện tại, hành động đang chờ duyệt, log...) được lưu
//    trong Workers KV.
//  - Giới hạn Free plan: tối đa vài phiên đồng thời/phút, tối đa 10 phút "browser time"/ngày.
//    Đủ dùng thử nghiệm cá nhân; dùng nhiều hơn cần nâng lên Workers Paid.
//
// Bất kỳ hành động nào bị coi là "nhạy cảm" (gửi form, mua hàng, xoá, điền thông tin nhạy cảm...)
// vẫn LUÔN dừng lại trong `pendingAction`, KHÔNG tự chạy — giữ đúng nguyên tắc "phải xin phép"
// như bản Playwright gốc.

import { launch, connect } from '@cloudflare/playwright';

const KV_PREFIX = 'browser-session:';
const SESSION_TTL_SECONDS = 30 * 60; // metadata KV hết hạn sau 30 phút không dùng (dọn rác tự động)
const KEEP_ALIVE_MS = 5 * 60 * 1000; // giữ trình duyệt thật sống tối đa 5 phút giữa các request

const SENSITIVE_ACTIONS = new Set(['click_submit', 'fill_sensitive', 'checkout', 'delete', 'submit_form']);

function isSensitive(action) {
  if (SENSITIVE_ACTIONS.has(action.type)) return true;
  if (action.type === 'click' && action.selectorText) {
    const t = action.selectorText.toLowerCase();
    if (/(mua|đặt hàng|thanh toán|xác nhận|gửi|xoá|xóa|submit|buy|checkout|pay|delete|confirm|đăng ký|order)/.test(t)) return true;
  }
  if (action.type === 'fill' && action.inputType && /password|email|tel|number/.test(action.inputType)) return true;
  return false;
}

function genId() { return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

// Playwright hỗ trợ click theo text bằng chính API get-by-text/locator, nhưng để tương thích với
// mọi kiểu phần tử (kể cả không chuẩn ARIA) và giữ logic y như bản Puppeteer cũ, vẫn tự tìm phần
// tử khớp text ngay trong DOM qua page.evaluate() rồi bấm trực tiếp.
async function clickByText(page, text) {
  const clicked = await page.evaluate((needle) => {
    const all = Array.from(document.querySelectorAll('a, button, input, [role="button"], [role="link"], label, span, div'));
    const target = all.find(el => (el.innerText || el.value || '').trim().toLowerCase().includes(String(needle).toLowerCase()));
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }, text);
  if (!clicked) throw new Error('Không tìm thấy phần tử có chữ: ' + text);
}

async function loadState(env, id) {
  const raw = await env.MY_AI_KV.get(KV_PREFIX + id);
  if (!raw) throw new Error('Không tìm thấy phiên trình duyệt (có thể đã hết hạn hoặc bị đóng).');
  return JSON.parse(raw);
}

async function saveState(env, id, state) {
  await env.MY_AI_KV.put(KV_PREFIX + id, JSON.stringify(state), { expirationTtl: SESSION_TTL_SECONDS });
}

function pushLog(state, entry) {
  state.log = state.log || [];
  state.log.push({ ...entry, timestamp: new Date().toISOString() });
  if (state.log.length > 30) state.log.shift();
}

// Kết nối (hoặc mở mới nếu chưa có / đã hết hạn) vào đúng trình duyệt thật ứng với 1 state.
async function connectBrowser(env, state) {
  if (state.ppSessionId) {
    try {
      const browser = await connect(env.MYBROWSER, state.ppSessionId);
      return { browser, launched: false };
    } catch (e) {
      // Session cũ đã bị Cloudflare tự đóng (idle quá lâu / hết hạn) -> mở phiên mới bên dưới.
    }
  }
  const browser = await launch(env.MYBROWSER, { keep_alive: KEEP_ALIVE_MS });
  state.ppSessionId = browser.sessionId();
  return { browser, launched: true };
}

// Playwright quản lý page theo BrowserContext (không có browser.pages() phẳng như Puppeteer) —
// duyệt qua các context đang mở để tìm tab có sẵn, nếu chưa có thì mở tab mới.
async function getPage(browser) {
  for (const ctx of browser.contexts()) {
    const pages = ctx.pages();
    if (pages.length) return pages[0];
  }
  return browser.newPage();
}

// Chạy 1 thao tác với browser+page thật, rồi NGẮT KẾT NỐI (không đóng thật) để giữ phiên sống cho
// request tiếp theo, và lưu lại state mới nhất vào KV. Với @cloudflare/playwright, browser.close()
// chính là thao tác "ngắt kết nối nhưng giữ session sống" (khác nghĩa Puppeteer).
async function withSession(env, id, fn) {
  const state = await loadState(env, id);
  const { browser } = await connectBrowser(env, state);
  const page = await getPage(browser);
  try {
    const result = await fn(browser, page, state);
    state.lastUsedAt = Date.now();
    await saveState(env, id, state);
    return result;
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

async function createSession(env, { url } = {}) {
  const id = genId();
  const state = { id, ppSessionId: null, url: null, pendingAction: null, log: [], createdAt: Date.now(), lastUsedAt: Date.now() };
  const { browser } = await connectBrowser(env, state);
  const page = await getPage(browser);
  if (url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  state.url = page.url();
  await saveState(env, id, state);
  const screenshot = await screenshotOf(page);
  try { await browser.close(); } catch (_) {}
  return { id, url: state.url, screenshot, log: state.log, pendingAction: null };
}

// Chuyển bytes ảnh chụp màn hình sang base64 mà KHÔNG dùng Buffer (API riêng của Node.js) —
// dùng Buffer trong Worker cần polyfill "node:buffer" qua compatibility_flags, hay bị lỗi
// "No such module 'node:buffer'" tuỳ môi trường/account. Hàm thuần JS dưới đây luôn chạy được,
// xử lý theo từng khối nhỏ (chunk) để không bị tràn ngăn xếp với ảnh lớn.
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000; // 32KB / lần, tránh lỗi "Maximum call stack size exceeded"
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function screenshotOf(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
  const b64 = typeof buf === 'string' ? buf : bytesToBase64(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  return 'data:image/jpeg;base64,' + b64;
}

async function screenshot(env, id) {
  return withSession(env, id, async (browser, page) => screenshotOf(page));
}

// Gộp "đọc nội dung trang" + "chụp ảnh" vào CÙNG 1 lần kết nối trình duyệt (1 withSession) thay vì
// 2 lần riêng biệt — mỗi lần kết nối lại (connect/launch) đều tốn hạn mức "phiên/phút" của gói
// Free Browser Rendering; gộp lại giúp /step không dễ chạm giới hạn đó (nguyên nhân phổ biến gây
// lỗi 500 khi vừa bấm chạy agent).
async function readPageSummary(env, id) {
  return withSession(env, id, async (browser, page) => {
    const title = await page.title().catch(() => '');
    const url = page.url();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 6000) || '').catch(() => '');
    const interactive = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"]')).slice(0, 80);
      return els.map((el, i) => ({
        index: i, tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80),
        type: el.getAttribute('type') || null, name: el.getAttribute('name') || null,
      })).filter(e => e.text || e.tag === 'input');
    }).catch(() => []);
    const screenshot = await screenshotOf(page);
    return { title, url, text, interactive, screenshot };
  });
}

async function performActionRaw(browser, page, action) {
  switch (action.type) {
    case 'goto':
      if (!action.url) throw new Error('Thiếu url');
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    case 'click':
      if (action.selector) await page.click(action.selector, { timeout: 15000 });
      else if (action.selectorText) await clickByText(page, action.selectorText);
      else throw new Error('Thiếu selector hoặc selectorText cho hành động click');
      break;
    case 'fill':
    case 'fill_sensitive':
      // Playwright có page.fill() gán thẳng giá trị (đợi sẵn phần tử, tự clear trước) — đơn giản
      // và ổn định hơn cách focus + xoá tay + gõ từng ký tự của Puppeteer.
      if (!action.selector) throw new Error('Thiếu selector cho hành động fill');
      await page.fill(action.selector, action.value ?? '', { timeout: 15000 });
      break;
    case 'submit_form':
    case 'click_submit':
    case 'checkout':
      if (action.selector) await page.click(action.selector, { timeout: 15000 });
      else if (action.selectorText) await clickByText(page, action.selectorText);
      break;
    case 'scroll':
      await page.evaluate((dy) => window.scrollBy(0, dy), action.deltaY ?? 800);
      break;
    case 'press_key':
      await page.keyboard.press(action.key || 'Enter');
      break;
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(action.ms || 1000, 8000)));
      break;
    case 'go_back':
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      break;
    default:
      throw new Error(`Loại hành động không hỗ trợ: ${action.type}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

async function performAction(env, id, action, { force = false } = {}) {
  return withSession(env, id, async (browser, page, state) => {
    if (!force && isSensitive(action)) {
      state.pendingAction = action;
      pushLog(state, { type: 'awaiting_approval', detail: action });
      const screenshot = await screenshotOf(page);
      return { needsApproval: true, action, screenshot, url: state.url, pendingAction: state.pendingAction, log: state.log };
    }
    state.pendingAction = null;
    await performActionRaw(browser, page, action);
    state.url = page.url();
    pushLog(state, { type: 'action', detail: action });
    const screenshot = await screenshotOf(page);
    return { needsApproval: false, action, url: state.url, screenshot, pendingAction: null, log: state.log };
  });
}

async function approvePending(env, id) {
  return withSession(env, id, async (browser, page, state) => {
    if (!state.pendingAction) throw new Error('Không có hành động nào đang chờ xác nhận.');
    const action = state.pendingAction;
    await performActionRaw(browser, page, action);
    state.url = page.url();
    state.pendingAction = null;
    pushLog(state, { type: 'action', detail: action });
    const screenshot = await screenshotOf(page);
    return { action, url: state.url, screenshot, pendingAction: null, log: state.log };
  });
}

async function rejectPending(env, id) {
  return withSession(env, id, async (browser, page, state) => {
    if (!state.pendingAction) throw new Error('Không có hành động nào đang chờ xác nhận.');
    const action = state.pendingAction;
    state.pendingAction = null;
    pushLog(state, { type: 'action_rejected', detail: action });
    return { rejected: true, action };
  });
}

async function closeSession(env, id) {
  try {
    const state = await loadState(env, id);
    if (state.ppSessionId) {
      try {
        const browser = await connect(env.MYBROWSER, state.ppSessionId);
        // Với @cloudflare/playwright, browser.close() chỉ ngắt kết nối chứ không có API riêng để
        // buộc tắt ngay phiên thật từ SDK. Ta vẫn gọi close() để dọn kết nối phía Worker, và xoá
        // ngay metadata KV bên dưới để app coi như phiên đã đóng (không dùng lại nữa); phiên thật
        // trên Cloudflare sẽ tự tắt theo keep_alive/thời gian idle nếu không có Worker nào khác
        // đang giữ.
        await browser.close();
      } catch (_) { /* phiên có thể đã tự đóng rồi, bỏ qua */ }
    }
  } catch (_) { /* không tìm thấy state -> coi như đã đóng */ }
  await env.MY_AI_KV.delete(KV_PREFIX + id);
}

async function getPublicState(env, id) {
  const state = await loadState(env, id);
  return { id: state.id, url: state.url, pendingAction: state.pendingAction, log: (state.log || []).slice(-30) };
}

export {
  createSession, closeSession, screenshot, readPageSummary,
  performAction, approvePending, rejectPending, isSensitive, getPublicState,
};
