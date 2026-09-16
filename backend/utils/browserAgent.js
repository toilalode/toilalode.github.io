// backend/utils/browserAgent.js
//
// Quản lý các "phiên trình duyệt thật" (Playwright + Chromium) cho Agent Mode.
// Mỗi phiên = 1 trình duyệt thật chạy trên SERVER (không phải trên máy người dùng), có thể:
//   - điều hướng, click, gõ chữ, cuộn, chụp screenshot
//   - đọc nội dung trang hiện tại
// Người dùng xem lại được toàn bộ diễn biến qua screenshot trả về (kể cả trên điện thoại),
// và MỌI hành động được đánh dấu "nhạy cảm" (submit form, bấm nút mua/gửi/xoá, điền dữ liệu
// vào ô input/password...) sẽ KHÔNG chạy ngay — nó bị giữ lại trong hàng đợi `pendingAction`
// của phiên cho tới khi người dùng gọi API xác nhận (approve) hoặc từ chối (reject).
//
// LƯU Ý QUAN TRỌNG (đọc trước khi deploy):
//   - Cần cài Chromium thật: sau khi `npm install`, chạy thêm:
//       npx playwright install chromium
//       npx playwright install-deps   (trên Linux, cài các thư viện hệ thống Chromium cần)
//   - Đây LÀ trình duyệt thật chạy trên server — có thể tốn RAM/CPU. Nên giới hạn số phiên
//     đồng thời (MAX_SESSIONS) và tự đóng phiên sau khi rảnh quá lâu (SESSION_IDLE_MS).
//   - Vì server tự lái trình duyệt thay người dùng, MỌI thao tác có thể gây hậu quả thật ngoài
//     đời (gửi form thật, đặt hàng thật, đổi mật khẩu thật...). Cơ chế xác nhận dưới đây là
//     bắt buộc phải giữ — không nên tự động approve mọi thứ.

const { chromium } = require('playwright');

const MAX_SESSIONS = 5;
const SESSION_IDLE_MS = 10 * 60 * 1000; // đóng phiên nếu rảnh quá 10 phút
const NAV_TIMEOUT_MS = 30000;

// sessionId -> { browser, context, page, createdAt, lastUsedAt, log: [], pendingAction: null }
const sessions = new Map();

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Các loại action bị coi là "nhạy cảm" -> luôn phải xin phép trước khi thực thi,
// bất kể agent tự quyết định làm gì tiếp theo.
const SENSITIVE_ACTIONS = new Set(['click_submit', 'fill_sensitive', 'checkout', 'delete', 'submit_form']);

function isSensitive(action) {
  if (SENSITIVE_ACTIONS.has(action.type)) return true;
  // Heuristic: click vào phần tử có chữ như "mua", "đặt hàng", "gửi", "xoá", "xác nhận", "thanh toán", "submit", "pay", "delete", "buy"
  if (action.type === 'click' && action.selectorText) {
    const t = action.selectorText.toLowerCase();
    if (/(mua|đặt hàng|thanh toán|xác nhận|gửi|xoá|xóa|submit|buy|checkout|pay|delete|confirm|đăng ký|order)/.test(t)) return true;
  }
  // Điền vào input kiểu password/email/thẻ -> nhạy cảm
  if (action.type === 'fill' && action.inputType && /password|email|tel|number/.test(action.inputType)) return true;
  return false;
}

function pruneIdleSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > SESSION_IDLE_MS) {
      closeSession(id).catch(() => {});
    }
  }
}
setInterval(pruneIdleSessions, 60 * 1000).unref?.();

async function createSession() {
  pruneIdleSessions();
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Đã đạt giới hạn ${MAX_SESSIONS} phiên trình duyệt đồng thời. Đóng bớt phiên cũ rồi thử lại.`);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (compatible; VelocitixAgent/1.0; +agent-mode)',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const id = genId('sess');
  const session = {
    id, browser, context, page,
    createdAt: Date.now(), lastUsedAt: Date.now(),
    log: [], // { type, detail, screenshot, timestamp }
    pendingAction: null, // action đang chờ người dùng approve/reject
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('Không tìm thấy phiên trình duyệt (có thể đã hết hạn hoặc bị đóng).');
  s.lastUsedAt = Date.now();
  return s;
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.context.close(); } catch {}
  try { await s.browser.close(); } catch {}
}

async function screenshot(session) {
  const buf = await session.page.screenshot({ type: 'jpeg', quality: 60 });
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

function pushLog(session, entry) {
  session.log.push({ ...entry, timestamp: new Date().toISOString() });
  // Giữ log không phình quá to
  if (session.log.length > 200) session.log.shift();
}

// Trích văn bản + danh sách phần tử tương tác được (link, button, input) để agent "nhìn thấy" trang.
async function readPageSummary(session) {
  const page = session.page;
  const title = await page.title().catch(() => '');
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 6000) || '').catch(() => '');
  const interactive = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"]')).slice(0, 80);
    return els.map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || null,
    })).filter(e => e.text || e.tag === 'input');
  }).catch(() => []);
  return { title, url, text, interactive };
}

// Thực thi 1 action Playwright thật. Nếu action nhạy cảm và force !== true, action sẽ được
// đưa vào pendingAction của session thay vì chạy ngay, trả về { needsApproval: true }.
async function performAction(session, action, { force = false } = {}) {
  if (!force && isSensitive(action)) {
    session.pendingAction = action;
    pushLog(session, { type: 'awaiting_approval', detail: action });
    return { needsApproval: true, action };
  }
  session.pendingAction = null;
  const page = session.page;
  let result = {};

  switch (action.type) {
    case 'goto': {
      if (!action.url) throw new Error('Thiếu url');
      await page.goto(action.url, { waitUntil: 'domcontentloaded' });
      result = { url: page.url() };
      break;
    }
    case 'click': {
      if (action.selector) {
        await page.click(action.selector, { timeout: NAV_TIMEOUT_MS });
      } else if (action.selectorText) {
        await page.getByText(action.selectorText, { exact: false }).first().click({ timeout: NAV_TIMEOUT_MS });
      } else {
        throw new Error('Thiếu selector hoặc selectorText cho hành động click');
      }
      break;
    }
    case 'fill':
    case 'fill_sensitive': {
      if (!action.selector) throw new Error('Thiếu selector cho hành động fill');
      await page.fill(action.selector, action.value ?? '');
      break;
    }
    case 'submit_form':
    case 'click_submit':
    case 'checkout': {
      if (action.selector) {
        await page.click(action.selector, { timeout: NAV_TIMEOUT_MS });
      } else if (action.selectorText) {
        await page.getByText(action.selectorText, { exact: false }).first().click({ timeout: NAV_TIMEOUT_MS });
      }
      break;
    }
    case 'scroll': {
      await page.mouse.wheel(0, action.deltaY ?? 800);
      break;
    }
    case 'press_key': {
      await page.keyboard.press(action.key || 'Enter');
      break;
    }
    case 'wait': {
      await page.waitForTimeout(Math.min(action.ms || 1000, 8000));
      break;
    }
    case 'go_back': {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      break;
    }
    default:
      throw new Error(`Loại hành động không hỗ trợ: ${action.type}`);
  }

  await page.waitForTimeout(400); // để trang kịp render sau hành động
  pushLog(session, { type: 'action', detail: action, result });
  return { needsApproval: false, action, result };
}

async function approvePending(session) {
  if (!session.pendingAction) throw new Error('Không có hành động nào đang chờ xác nhận.');
  const action = session.pendingAction;
  return performAction(session, action, { force: true });
}

function rejectPending(session) {
  if (!session.pendingAction) throw new Error('Không có hành động nào đang chờ xác nhận.');
  const action = session.pendingAction;
  session.pendingAction = null;
  pushLog(session, { type: 'action_rejected', detail: action });
  return { rejected: true, action };
}

module.exports = {
  createSession, getSession, closeSession,
  screenshot, readPageSummary, performAction,
  approvePending, rejectPending, pushLog, isSensitive,
  listSessions: () => Array.from(sessions.values()).map(s => ({
    id: s.id, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
    url: s.page.url(), pendingAction: s.pendingAction,
  })),
};
