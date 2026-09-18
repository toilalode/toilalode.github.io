// ===================== CẤU HÌNH BACKEND =====================
// PHẢI khai báo ở đầu file (trước mọi đoạn code dùng tới) — vì các biến const/let trong JS
// không thể truy cập trước khi dòng khai báo của chúng được chạy (Temporal Dead Zone), dù
// hàm sử dụng chúng nằm ở phía dưới. Đặt ở cuối file từng gây lỗi cứng "Cannot access
// 'GOOGLE_CLIENT_ID' before initialization" ngay khi trang load, chặn toàn bộ app.js.
const API_BASE = 'https://my-ai-worker.vudanhquy1002.workers.dev';
// Client ID lấy từ Google Cloud Console -> APIs & Services -> Credentials (KHÔNG phải bí mật,
// Client ID luôn lộ công khai trong code frontend, an toàn để để thẳng ở đây).
const GOOGLE_CLIENT_ID = '752017566752-sujjhluldnk408m7cd09g4g4vdfuonte.apps.googleusercontent.com';

// Danh sách hội thoại (sidebar) — PHẢI khai báo sớm vì loadConversations() có thể được gọi ngay
// từ bootAuth() (khi người dùng đã có session lưu sẵn từ trước, F5 vào là đăng nhập luôn), tức là
// trước khi code ở giữa file kịp chạy tới dòng khai báo cũ. Đây là nguyên nhân từng gây lỗi
// "Cannot access 'allConvs' before initialization" — nhưng CHỈ xảy ra ở máy đã từng đăng nhập
// (máy chưa đăng nhập thì bootAuth không gọi tới loadConversations nên không lộ lỗi), giải thích
// vì sao trước đây báo lỗi "chỉ xảy ra ở vài máy".
let allConvs = [];

// ===================== PWA: đăng ký Service Worker =====================
// Cho phép "Cài đặt" app lên màn hình chính (Android/Chrome tự hiện nút cài, iOS Safari dùng
// "Thêm vào Màn hình chính" qua nút Share). Chạy sau khi trang tải xong (event 'load') để không
// làm chậm lần hiển thị đầu tiên.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((e) => {
      console.error('[Velocitix AI] Đăng ký Service Worker thất bại:', e.message);
    });
  });
}

// Bắt lỗi JS toàn cục: nếu 1 đoạn code lỗi, không để nó âm thầm chặn phần script phía sau
// (nguyên nhân phổ biến khiến "F5 xong mất hết chức năng" — 1 lỗi nhỏ đầu file làm dừng cả app.js).
window.addEventListener('error', (e) => {
  console.error('[Velocitix AI] Lỗi JS:', e.message, e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Velocitix AI] Lỗi Promise:', e.reason);
});

// ===================== ĐĂNG NHẬP =====================
// Toàn bộ tính năng lưu lịch sử (conversations, tìm kiếm ngữ nghĩa) yêu cầu đăng nhập —
// mỗi người dùng chỉ thấy đúng dữ liệu của mình.
// - AUTH_KEY / AUTH_USER_KEY: phiên đăng nhập ĐANG hoạt động (mất khi đăng xuất).
// - SAVED_ACCOUNTS_KEY: danh sách MỌI tài khoản từng đăng nhập trên máy này (Google lẫn Velocitix),
//   mỗi mục lưu { provider, name, email, picture, token, savedAt } — token là session token của
//   app (KHÔNG PHẢI mật khẩu), cho phép bấm vào là vào thẳng nếu token còn hạn. Không lưu mật khẩu
//   trong mọi trường hợp — đây là lựa chọn có chủ đích để cân bằng tiện lợi và bảo mật.
const AUTH_KEY = 'myai_session_token';
const AUTH_USER_KEY = 'myai_session_user';
const SAVED_ACCOUNTS_KEY = 'myai_saved_accounts';

function getSessionToken() { return localStorage.getItem(AUTH_KEY) || ''; }
function getSessionUser() { try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null'); } catch { return null; } }
function clearSession() { localStorage.removeItem(AUTH_KEY); localStorage.removeItem(AUTH_USER_KEY); }

function getSavedAccounts() {
  try { return JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || '[]'); } catch { return []; }
}
function accountKey(provider, email) { return provider + ':' + (email || '').toLowerCase(); }

// Lưu/update 1 tài khoản vào danh sách "đã từng đăng nhập" kèm token hiện tại của nó.
function saveAccount(provider, user, token) {
  const list = getSavedAccounts();
  const key = accountKey(provider, user.email);
  const idx = list.findIndex(a => accountKey(a.provider, a.email) === key);
  const entry = { provider, name: user.name, email: user.email, picture: user.picture || null, token, savedAt: Date.now() };
  if (idx >= 0) list[idx] = entry; else list.unshift(entry);
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list));
}
function removeSavedAccount(provider, email) {
  const list = getSavedAccounts().filter(a => accountKey(a.provider, a.email) !== accountKey(provider, email));
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list));
  renderQuickRelogin();
  renderSavedAccountsList();
}
// Nếu tài khoản đang đăng xuất trùng với tài khoản đang active, cập nhật lại token mới nhất
// vào danh sách đã lưu (vd. sau khi đăng nhập lại) — gọi trong completeLogin.

// Wrapper cho fetch: tự gắn header Authorization nếu đã đăng nhập.
function authHeaders(extra = {}) {
  const token = getSessionToken();
  return token ? { ...extra, Authorization: 'Bearer ' + token } : extra;
}

function showLoginOverlay(errorMsg) {
  const overlay = document.getElementById('loginOverlay');
  overlay?.classList.remove('hidden');
  const errEl = document.getElementById('loginError');
  if (errEl) {
    if (errorMsg) { errEl.textContent = errorMsg; errEl.classList.remove('hidden'); }
    else { errEl.classList.add('hidden'); errEl.textContent = ''; }
  }
  renderQuickRelogin();
}
function hideLoginOverlay() { document.getElementById('loginOverlay')?.classList.add('hidden'); }

function updateAccountBox(user) {
  const avatar = document.getElementById('accountAvatar');
  const nameEl = document.getElementById('accountName');
  const signOutBtn = document.getElementById('signOutBtn');
  if (!user) {
    avatar?.classList.add('hidden');
    if (nameEl) nameEl.textContent = 'Chưa đăng nhập';
    signOutBtn?.classList.add('hidden');
    return;
  }
  if (avatar) { avatar.src = user.picture || ''; avatar.classList.remove('hidden'); }
  if (nameEl) nameEl.textContent = user.name || user.email || '';
  signOutBtn?.classList.remove('hidden');
}

// Hoàn tất đăng nhập chung cho mọi cách (Google / email / bấm lại tài khoản đã lưu): lưu token
// của phiên hiện tại, lưu/update tài khoản này vào danh sách đã đăng nhập, cập nhật UI.
function completeLogin(token, user, provider) {
  localStorage.setItem(AUTH_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  saveAccount(provider, user, token);
  updateAccountBox(user);
  hideLoginOverlay();
  if (typeof loadConversations === 'function') loadConversations();
}

function isRememberMeChecked() { return document.getElementById('rememberMeCheckbox')?.checked ?? true; }

// ---------- Đăng nhập Google ----------
async function handleGoogleCredentialResponse(response) {
  try {
    const r = await fetch(API_BASE + '/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential, rememberMe: isRememberMeChecked() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Đăng nhập thất bại');
    completeLogin(data.token, data.user, 'google');
  } catch (e) {
    showLoginOverlay('⚠️ ' + e.message);
  }
}
window.handleGoogleCredentialResponse = handleGoogleCredentialResponse;

function initGoogleSignIn() {
  if (!window.google?.accounts?.id) { setTimeout(initGoogleSignIn, 300); return; } // đợi script gsi tải xong
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('DÁN_CLIENT_ID')) return;
  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredentialResponse,
  });
  const btnContainer = document.getElementById('googleSignInBtn');
  if (btnContainer) {
    window.google.accounts.id.renderButton(btnContainer, { theme: 'outline', size: 'large', text: 'signin_with' });
  }
}

// ---------- Đăng ký / đăng nhập bằng email + mật khẩu ----------
let localAuthMode = 'login'; // 'login' | 'register'

function setLocalAuthMode(mode) {
  localAuthMode = mode;
  document.getElementById('tabLoginBtn')?.classList.toggle('active', mode === 'login');
  document.getElementById('tabRegisterBtn')?.classList.toggle('active', mode === 'register');
  document.getElementById('authNameInput')?.classList.toggle('hidden', mode !== 'register');
  const submitBtn = document.getElementById('localAuthSubmitBtn');
  if (submitBtn) submitBtn.textContent = mode === 'register' ? 'Tạo tài khoản' : 'Đăng nhập';
  const pwInput = document.getElementById('authPasswordInput');
  if (pwInput) pwInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
}
document.getElementById('tabLoginBtn')?.addEventListener('click', () => setLocalAuthMode('login'));
document.getElementById('tabRegisterBtn')?.addEventListener('click', () => setLocalAuthMode('register'));

document.getElementById('localAuthForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('authEmailInput')?.value.trim();
  const password = document.getElementById('authPasswordInput')?.value;
  const name = document.getElementById('authNameInput')?.value.trim();
  const rememberMe = isRememberMeChecked();
  const endpoint = localAuthMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  try {
    const r = await fetch(API_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name, rememberMe }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Thao tác thất bại');
    completeLogin(data.token, data.user, 'local');
  } catch (e) {
    showLoginOverlay('⚠️ ' + e.message);
  }
});

// ---------- "Đăng nhập lại" nhanh với tài khoản gần nhất nhất (hiện ngay trên màn đăng nhập) ----------
// Nếu token của tài khoản đó CÒN HẠN -> bấm vào là vào thẳng luôn (không cần đăng nhập lại).
// Nếu HẾT HẠN (server trả 401) -> tự động rơi về đăng nhập lại đúng tài khoản đó.
async function tryLoginWithSavedAccount(account) {
  if (!account.token) { promptReloginFor(account); return; }
  try {
    // Xác thực token còn dùng được bằng 1 request nhẹ (list conversations) trước khi coi là "vào thẳng".
    const r = await fetch(API_BASE + '/api/conversations', { headers: { Authorization: 'Bearer ' + account.token } });
    if (r.status === 401) throw new Error('expired');
    completeLogin(account.token, account, account.provider);
  } catch (e) {
    promptReloginFor(account);
  }
}
// Token hết hạn/không hợp lệ -> đưa người dùng vào đúng luồng đăng nhập lại cho tài khoản đó.
function promptReloginFor(account) {
  if (account.provider === 'google') {
    showLoginOverlay('Phiên đăng nhập Google đã hết hạn, vui lòng chọn lại tài khoản.');
    window.google?.accounts?.id?.prompt?.();
  } else {
    showLoginOverlay();
    showAuthForm('login');
    setLocalAuthMode('login');
    const emailInput = document.getElementById('authEmailInput');
    if (emailInput) { emailInput.value = account.email; document.getElementById('authPasswordInput')?.focus(); }
  }
}

function renderQuickRelogin() {
  const list = getSavedAccounts();
  const last = list[0];
  const btn = document.getElementById('quickRelogatinBtn');
  const textEl = document.getElementById('quickRelogText');
  const avatarEl = document.getElementById('quickRelogAvatar');
  if (!btn) return;
  if (!last) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  if (textEl) textEl.textContent = `Tiếp tục với ${last.name || last.email}`;
  if (avatarEl) {
    if (last.picture) { avatarEl.src = last.picture; avatarEl.classList.remove('hidden'); }
    else avatarEl.classList.add('hidden');
  }
  btn.onclick = () => tryLoginWithSavedAccount(last);

  // Nút "Xem tất cả tài khoản đã đăng nhập" chỉ hiện khi có từ 2 tài khoản trở lên.
  const switchBtn = document.getElementById('switchAccountBtn');
  switchBtn?.classList.toggle('hidden', list.length < 2);
}

// ---------- Modal "Tài khoản đã đăng nhập" — liệt kê mọi tài khoản (Google + Velocitix), bấm vào
// 1 dòng để chuyển sang tài khoản đó ngay, có nút 🗑 xoá riêng từng tài khoản khỏi danh sách. ----------
function renderSavedAccountsList() {
  const container = document.getElementById('savedAccountsList');
  if (!container) return;
  const list = getSavedAccounts();
  const currentUser = getSessionUser();
  if (list.length === 0) {
    container.innerHTML = '<p class="login-sub" style="margin:8px 0;">Chưa có tài khoản nào được lưu trên máy này.</p>';
    return;
  }
  container.innerHTML = list.map(a => {
    const key = accountKey(a.provider, a.email);
    const isCurrent = currentUser && accountKey(a.provider, currentUser.email) === key;
    const providerLabel = a.provider === 'google' ? 'Google' : 'Velocitix';
    const avatarHtml = a.picture
      ? `<img src="${a.picture}" class="account-avatar" alt="" />`
      : `<span class="saved-account-fallback-avatar">${(a.name || a.email || '?')[0].toUpperCase()}</span>`;
    return `
      <div class="saved-account-row${isCurrent ? ' current' : ''}" data-key="${key}">
        <button type="button" class="saved-account-main" data-action="select">
          ${avatarHtml}
          <span class="saved-account-info">
            <span class="saved-account-name">${a.name || a.email}${isCurrent ? ' · Đang dùng' : ''}</span>
            <span class="saved-account-meta">${providerLabel} · ${a.email}</span>
          </span>
        </button>
        <button type="button" class="saved-account-remove" data-action="remove" title="Xoá tài khoản này khỏi danh sách">🗑</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.saved-account-row').forEach(row => {
    const key = row.dataset.key;
    const account = list.find(a => accountKey(a.provider, a.email) === key);
    row.querySelector('[data-action="select"]')?.addEventListener('click', () => {
      closeSavedAccountsModal();
      tryLoginWithSavedAccount(account);
    });
    row.querySelector('[data-action="remove"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSavedAccount(account.provider, account.email);
    });
  });
}

function openSavedAccountsModal() {
  renderSavedAccountsList();
  document.getElementById('savedAccountsModal')?.classList.remove('hidden');
}
function closeSavedAccountsModal() {
  document.getElementById('savedAccountsModal')?.classList.add('hidden');
}
document.getElementById('switchAccountBtn')?.addEventListener('click', openSavedAccountsModal);
document.getElementById('closeSavedAccountsBtn')?.addEventListener('click', closeSavedAccountsModal);
document.getElementById('savedAccountsModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'savedAccountsModal') closeSavedAccountsModal(); // bấm ra ngoài để đóng
});
// Trong sidebar (khi đã đăng nhập): bấm avatar/tên tài khoản cũng mở được danh sách để chuyển tài khoản.
document.getElementById('accountBox')?.addEventListener('click', (e) => {
  if (e.target.closest('#signOutBtn')) return; // không mở modal nếu bấm đúng nút đăng xuất
  openSavedAccountsModal();
});

document.getElementById('signOutBtn')?.addEventListener('click', () => {
  clearSession();
  updateAccountBox(null);
  window.google?.accounts?.id?.disableAutoSelect?.();
  showLoginOverlay();
});

// ---------- Quên mật khẩu / đặt lại mật khẩu ----------
function showAuthForm(which) {
  // which: 'login' | 'forgot' | 'reset'
  document.getElementById('localAuthForm')?.classList.toggle('hidden', which !== 'login');
  document.getElementById('googleSignInBtn')?.classList.toggle('hidden', which !== 'login');
  document.querySelector('.login-tabs')?.classList.toggle('hidden', which !== 'login');
  document.querySelector('.login-divider')?.classList.toggle('hidden', which !== 'login');
  document.getElementById('forgotPasswordForm')?.classList.toggle('hidden', which !== 'forgot');
  document.getElementById('resetPasswordForm')?.classList.toggle('hidden', which !== 'reset');
}

document.getElementById('forgotPasswordBtn')?.addEventListener('click', () => showAuthForm('forgot'));
document.getElementById('backToLoginBtn')?.addEventListener('click', () => showAuthForm('login'));

document.getElementById('forgotPasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgotEmailInput')?.value.trim();
  try {
    const r = await fetch(API_BASE + '/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // resetUrlBase = URL hiện tại của trang (không kèm query cũ) -> link trong email sẽ mở
      // đúng app này kèm ?resetToken=..., hoạt động dù bạn đổi domain sau này.
      body: JSON.stringify({ email, resetUrlBase: location.origin + location.pathname }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Gửi thất bại');
    showLoginOverlay('✅ Nếu email tồn tại, link đặt lại mật khẩu đã được gửi. Kiểm tra hộp thư (cả mục Spam).');
    showAuthForm('login');
  } catch (e) {
    showLoginOverlay('⚠️ ' + e.message);
  }
});

document.getElementById('resetPasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPassword = document.getElementById('newPasswordInput')?.value;
  const params = new URLSearchParams(location.search);
  const token = params.get('resetToken');
  try {
    const r = await fetch(API_BASE + '/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Đặt lại mật khẩu thất bại');
    // Xoá resetToken khỏi URL để không lỡ dùng lại / lộ trong lịch sử trình duyệt
    history.replaceState({}, '', location.origin + location.pathname);
    showLoginOverlay('✅ Đặt lại mật khẩu thành công! Đăng nhập lại bằng mật khẩu mới.');
    showAuthForm('login');
  } catch (e) {
    showLoginOverlay('⚠️ ' + e.message);
  }
});

// Khởi động: nếu đã có session lưu sẵn -> vào thẳng app; nếu chưa -> hiện màn đăng nhập.
// Trường hợp đặc biệt: nếu URL có ?resetToken=... (người dùng vừa bấm link trong email) thì LUÔN
// hiện màn đăng nhập với form "đặt mật khẩu mới", bất kể đang có phiên đăng nhập hay không.
(function bootAuth() {
  const hasResetToken = new URLSearchParams(location.search).has('resetToken');
  if (hasResetToken) {
    showLoginOverlay();
    showAuthForm('reset');
    initGoogleSignIn();
    return;
  }
  const user = getSessionUser();
  if (user && getSessionToken()) {
    updateAccountBox(user);
    hideLoginOverlay();
  } else {
    updateAccountBox(null);
    showLoginOverlay();
    showAuthForm('login');
  }
  initGoogleSignIn();
})();

// Wrapper fetch dùng cho MỌI gọi tới /api/conversations* và /api/search/semantic (các route yêu
// cầu đăng nhập) — tự gắn header Authorization, và nếu server trả 401 (hết hạn / chưa đăng nhập)
// thì tự bật lại màn hình đăng nhập thay vì lỗi mơ hồ.
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: authHeaders(options.headers || {}) });
  if (res.status === 401) {
    clearSession();
    updateAccountBox(null);
    showLoginOverlay('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.');
  }
  return res;
}

// ===================== STATE =====================
// Đọc dữ liệu đã lưu từ localStorage một cách AN TOÀN: nếu dữ liệu cũ bị hỏng/không hợp lệ
// (vd. lịch sử chat quá lớn bị ghi dở dang), JSON.parse không có try/catch sẽ ném lỗi NGAY
// khi load file này — vì đây là code chạy ở TOP-LEVEL nên lỗi đó chặn đứng toàn bộ phần code
// phía dưới, khiến MỌI nút trong app (chia sẻ, tìm kiếm ngữ nghĩa, agent...) đều "chết" theo,
// dù bản thân các nút đó không có lỗi gì. Đây chính là nguyên nhân "F5 là vỡ cả app".
function safeLoadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Dữ liệu localStorage["${key}"] bị hỏng, đã reset về mặc định:`, e);
    try { localStorage.removeItem(key); } catch (_) {}
    return fallback;
  }
}

const state = {
  mode: 'chat',
  history: safeLoadJSON('myai_history', []),
  pendingAttachments: [],
  temp: false,
  conversationId: localStorage.getItem('myai_last_conv') || null,
  model: localStorage.getItem('myai_model') || 'auto',
  thinking: localStorage.getItem('myai_thinking') === '1',
};

const MODEL_OPTIONS = [
  { value: 'auto', label: '⚡ Auto', desc: 'Tự chọn model phù hợp nhất cho từng câu hỏi' },
  { value: 'gemini-3.1-flash-lite', label: '3.1 Flash-Lite', desc: 'Nhanh nhất, phù hợp câu hỏi đơn giản' },
  { value: 'gemini-3-flash-preview', label: '3 Flash', desc: 'Cân bằng giữa tốc độ và chất lượng' },
  { value: 'gemini-3.5-flash', label: '3.5 Flash', desc: 'Tối ưu cho việc viết/sửa code' },
  { value: 'gemini-3.1-pro-preview', label: '3.1 Pro', desc: 'Thông minh nhất, cho tác vụ phức tạp' },
];

const els = {
  sidebar: document.getElementById('sidebar'),
  hamburger: document.getElementById('hamburger'),
  modeTitle: document.getElementById('modeTitle'),
  modelPillBtn: document.getElementById('modelPillBtn'),
  modelPillLabel: document.getElementById('modelPillLabel'),
  tempBanner: document.getElementById('tempBanner'),
  newChatBtn: document.getElementById('newChatBtn'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendBtn: document.getElementById('sendBtn'),
  attachPreview: document.getElementById('attachPreview'),
  convList: document.getElementById('convList'),
  convSearchInput: document.getElementById('convSearchInput'),
  semSearchInput: document.getElementById('semSearchInput'),
  semSearchBtn: document.getElementById('semSearchBtn'),
  semSearchCloseBtn: document.getElementById('semSearchCloseBtn'),
  semSearchResults: document.getElementById('semSearchResults'),
  thinkingToggle: document.getElementById('thinkingToggle'),
  webSearchToggle: document.getElementById('webSearchToggle'),
  tempChatToggle: document.getElementById('tempChatToggle'),
};

const modeTitles = {
  chat: 'Chat', homework: 'Giải bài tập', image: 'Tạo ảnh', video: 'Tạo video',
  artifacts: '🧩 Artifacts', code: 'Code Editor', voice: 'Voice', agent: 'Agent Mode',
  webask: '🧭 Mở web & hỏi AI',
  library: '🗂️ Thư viện', settings: 'Cài đặt',
};

// ===================== NAV / MODE SWITCH =====================
document.querySelectorAll('.nav-btn[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

// Menu "⋯ Thêm" — xổ xuống danh sách các mục ít dùng hơn (Giải bài tập, Tạo ảnh...).
document.getElementById('navMoreBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('navMoreMenu')?.classList.toggle('hidden');
});
// Chọn 1 mục trong menu Thêm xong thì tự đóng lại luôn.
document.getElementById('navMoreMenu')?.querySelectorAll('.nav-btn[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => document.getElementById('navMoreMenu')?.classList.add('hidden'));
});
// Bấm ra ngoài menu thì tự đóng.
document.addEventListener('click', (e) => {
  const menu = document.getElementById('navMoreMenu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'navMoreBtn') {
    menu.classList.add('hidden');
  }
});

function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.nav-btn[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + mode)?.classList.add('active');
  els.modeTitle.textContent = modeTitles[mode] || mode;
  els.sidebar.classList.remove('open');
  // Hành vi bổ sung khi chuyển sang Thư viện / Artifacts (định nghĩa muộn hơn trong file, nhưng
  // an toàn để gọi ở đây vì switchMode() chỉ THỰC THI khi được người dùng bấm — luôn sau khi toàn
  // bộ app.js đã tải xong, không phải lúc file đang được parse).
  if (typeof onModeSwitchExtra === 'function') onModeSwitchExtra(mode);
}
els.hamburger.addEventListener('click', () => els.sidebar.classList.toggle('open'));

// ---- Agent Mode: chuyển giữa 2 tab con "Tự động" (agentView-research) và
// "Trình duyệt thật" (agentView-browser) — trước đây là 2 mục riêng trong sidebar, giờ gộp
// thành 1 mục Agent Mode duy nhất với 2 cách dùng. ----
document.querySelectorAll('.agent-tab-btn[data-agent-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.agentTab;
    document.querySelectorAll('.agent-tab-btn[data-agent-tab]').forEach(b => b.classList.toggle('active', b.dataset.agentTab === tab));
    document.getElementById('agentView-research')?.classList.toggle('active', tab === 'research');
    document.getElementById('agentView-browser')?.classList.toggle('active', tab === 'browser');
  });
});

// ---- Vuốt sang trái để đóng sidebar (không can thiệp vuốt dọc để cuộn danh sách chat) ----
(function setupSidebarSwipeClose() {
  let startX = 0, startY = 0, tracking = false;
  els.sidebar.addEventListener('touchstart', (e) => {
    if (!els.sidebar.classList.contains('open') && window.innerWidth > 820) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  els.sidebar.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Chỉ đóng khi vuốt NGANG rõ ràng sang trái (đủ xa + ngang nhiều hơn dọc hẳn),
    // để không đụng vào thao tác cuộn dọc bình thường trong danh sách chat.
    if (dx < -70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      els.sidebar.classList.remove('open');
    }
  }, { passive: true });
})();

// ===================== BOTTOM SHEETS (Attach / Model) — kiểu Claude =====================
function openSheet(sheetEl, backdropEl) { sheetEl.classList.add('open'); backdropEl.classList.remove('hidden'); backdropEl.classList.add('open'); }
function closeSheet(sheetEl, backdropEl) { sheetEl.classList.remove('open'); backdropEl.classList.remove('open'); setTimeout(() => backdropEl.classList.add('hidden'), 200); }

const attachSheet = document.getElementById('attachSheet');
const attachBackdrop = document.getElementById('attachBackdrop');
document.getElementById('btnPlus').addEventListener('click', () => openSheet(attachSheet, attachBackdrop));
document.getElementById('attachCloseBtn').addEventListener('click', () => closeSheet(attachSheet, attachBackdrop));
attachBackdrop.addEventListener('click', () => closeSheet(attachSheet, attachBackdrop));

function wireSheetFile(btnId, inputId) {
  const btn = document.getElementById(btnId), input = document.getElementById(inputId);
  btn.addEventListener('click', () => { closeSheet(attachSheet, attachBackdrop); input.click(); });
  input.addEventListener('change', async () => {
    for (const f of input.files) await uploadFile(f);
    input.value = '';
  });
}
wireSheetFile('sheetFiles', 'fileInput');
wireSheetFile('sheetPhotos', 'mediaInput');
wireSheetFile('sheetFolder', 'folderInput');
wireSheetFile('sheetCamera', 'cameraInput');
wireSheetFile('sheetVideoCap', 'videoCaptureInput');
// (nút "Deep Research" trong sheet "＋" giờ được nối ở phần DEEP RESEARCH phía dưới — không
// còn switchMode('research') nữa vì trang Deep Research riêng đã bị bỏ.)

const modelSheet = document.getElementById('modelSheet');
const modelBackdrop = document.getElementById('modelBackdrop');
const modelListEl = document.getElementById('modelList');
function renderModelSheet() {
  modelListEl.innerHTML = '';
  MODEL_OPTIONS.forEach(m => {
    const div = document.createElement('button');
    div.className = 'model-item' + (m.value === state.model ? ' selected' : '');
    div.innerHTML = `<span class="model-item-text"><span class="model-name">${m.label}</span><span class="model-desc">${m.desc}</span></span>
      <span class="model-check">${m.value === state.model ? '✓' : ''}</span>`;
    div.addEventListener('click', () => {
      state.model = m.value;
      localStorage.setItem('myai_model', m.value);
      updateModelPillLabel();
      closeSheet(modelSheet, modelBackdrop);
    });
    modelListEl.appendChild(div);
  });
}
els.modelPillBtn.addEventListener('click', () => { renderModelSheet(); openSheet(modelSheet, modelBackdrop); });
document.getElementById('modelCloseBtn').addEventListener('click', () => closeSheet(modelSheet, modelBackdrop));
modelBackdrop.addEventListener('click', () => closeSheet(modelSheet, modelBackdrop));

function updateModelPillLabel() {
  const m = MODEL_OPTIONS.find(m => m.value === state.model) || MODEL_OPTIONS[0];
  els.modelPillLabel.textContent = (state.thinking ? '🧠 ' : '') + m.label;
}
// Thinking giờ nằm trong Model sheet (không còn toggle riêng ở Attach sheet)
els.thinkingToggle.checked = state.thinking;
els.thinkingToggle.addEventListener('change', e => {
  state.thinking = e.target.checked;
  localStorage.setItem('myai_thinking', state.thinking ? '1' : '0');
  updateModelPillLabel();
});
// hiện đúng model đã lưu từ lần trước ngay khi tải trang
updateModelPillLabel();

// ===================== SSE HELPER =====================
async function streamPost(url, payload, handlers, abortSignal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: abortSignal });
  } catch (e) {
    if (e.name === 'AbortError') { handlers.aborted?.(); return; }
    handlers.error?.('Không kết nối được server (kiểm tra mạng hoặc worker chưa deploy)');
    return;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) {}
    handlers.error?.(`Server lỗi ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
    return;
  }
  if (!res.body) { handlers.error?.('Không kết nối được server'); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (e.name === 'AbortError' || abortSignal?.aborted) { handlers.aborted?.(); return; }
      throw e;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const evt of events) {
      let eventName = 'message', data = '';
      for (const line of evt.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      handlers[eventName]?.(parsed);
    }
  }
}

// ===================== ĐỌC TO (Text-to-Speech) =====================
// Ưu tiên gọi Gemini TTS thật qua backend (/api/tts/speak, giọng chọn ở Settings).
// Nếu lỗi (thiếu API key, hết quota, mất mạng...) tự động chuyển sang Web Speech
// API có sẵn trong trình duyệt để không bị "câm" hoàn toàn.
let currentAudioEl = null;
function stopSpeaking() {
  if (currentAudioEl) { currentAudioEl.pause(); currentAudioEl = null; }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  document.querySelectorAll('.msg-action-btn.speaking').forEach(b => { b.classList.remove('speaking'); b.textContent = '🔊 Đọc to'; });
}
function speakWithBrowser(text, btnEl, onEnd) {
  if (!('speechSynthesis' in window)) { alert('Trình duyệt này không hỗ trợ đọc to.'); onEnd?.(); return; }
  const utter = new SpeechSynthesisUtterance(text || '');
  utter.lang = localStorage.getItem('myai_tts_lang') || 'vi-VN';
  utter.rate = Number(localStorage.getItem('myai_tts_rate') || '1');
  if (btnEl) { btnEl.classList.add('speaking'); btnEl.textContent = '⏹️ Dừng đọc'; }
  utter.onend = () => { if (btnEl) { btnEl.classList.remove('speaking'); btnEl.textContent = '🔊 Đọc to'; } onEnd?.(); };
  utter.onerror = () => { if (btnEl) { btnEl.classList.remove('speaking'); btnEl.textContent = '🔊 Đọc to'; } onEnd?.(); };
  window.speechSynthesis.speak(utter);
}
// speakText() là nơi DUY NHẤT nói chuyện với TTS — dùng chung cho nút "🔊 Đọc to" ở mỗi
// tin nhắn LẪN cho Voice panel, để cả 2 nơi luôn tôn trọng engine/giọng/tốc độ đã chọn ở Settings.
// opts.onEnd: callback khi đọc xong (dùng cho Voice panel cập nhật trạng thái).
// opts.audioEl: nếu truyền vào 1 thẻ <audio> có sẵn (vd voiceAudioPlayer), sẽ phát qua thẻ đó
// để hiện player trực quan, thay vì tạo Audio() ẩn.
async function speakText(text, btnEl, opts = {}) {
  const { onEnd, audioEl } = opts;
  // Đang đọc (dù bằng cách nào) -> bấm lại để dừng
  if (currentAudioEl || window.speechSynthesis?.speaking) {
    const wasThisBtn = btnEl?.classList.contains('speaking');
    stopSpeaking();
    if (wasThisBtn) return;
  }
  const voice = localStorage.getItem('myai_gemini_voice') || 'Kore';
  const useGemini = localStorage.getItem('myai_tts_engine') !== 'browser'; // mặc định ưu tiên Gemini
  if (!useGemini) { speakWithBrowser(text, btnEl, onEnd); return; }

  if (btnEl) { btnEl.classList.add('speaking'); btnEl.textContent = '⏳ Đang tạo giọng...'; }
  try {
    const r = await fetch(API_BASE + '/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    const data = await r.json();
    if (!r.ok || !data.base64) throw new Error(data.error?.message || data.error || 'TTS lỗi');

    // Gemini TTS trả PCM thô (16-bit, 24kHz, mono) — cần bọc header WAV mới phát được bằng <audio>/Web Audio.
    const wavBlob = pcmBase64ToWavBlob(data.base64, 24000);
    const url = URL.createObjectURL(wavBlob);
    const audio = audioEl || new Audio();
    audio.src = url;
    if (audioEl) audioEl.classList.remove('hidden');
    currentAudioEl = audio;
    if (btnEl) btnEl.textContent = '⏹️ Dừng đọc';
    audio.onended = () => { if (btnEl) { btnEl.classList.remove('speaking'); btnEl.textContent = '🔊 Đọc to'; } currentAudioEl = null; URL.revokeObjectURL(url); onEnd?.(); };
    audio.onerror = () => { if (btnEl) { btnEl.classList.remove('speaking'); btnEl.textContent = '🔊 Đọc to'; } currentAudioEl = null; onEnd?.(); };
    await audio.play();
  } catch (e) {
    // Fallback: giọng trình duyệt
    if (btnEl) { btnEl.classList.remove('speaking'); btnEl.textContent = '🔊 Đọc to'; }
    speakWithBrowser(text, btnEl, onEnd);
  }
}
// Gemini TTS trả PCM 16-bit little-endian không header — tự bọc thành file WAV hợp lệ.
function pcmBase64ToWavBlob(base64, sampleRate) {
  const binary = atob(base64);
  const pcmLen = binary.length;
  const buffer = new ArrayBuffer(44 + pcmLen);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + pcmLen, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, pcmLen, true);
  for (let i = 0; i < pcmLen; i++) view.setUint8(44 + i, binary.charCodeAt(i));
  return new Blob([buffer], { type: 'audio/wav' });
}

// ===================== CHAT =====================
// ===================== CHAT =====================
// ArtifactStore được khai báo NGAY TỪ ĐÂY (thay vì ở chỗ khác xa phía dưới trong file) vì
// appendMsgToDOM() dùng nó, và appendMsgToDOM() được gọi ngay khi trang tải xong (qua
// renderHistory() ở dưới) — nếu để ArtifactStore khai báo bằng `const` ở phía SAU trong file,
// sẽ bị lỗi "Cannot access 'ArtifactStore' before initialization" (temporal dead zone của const)
// mỗi khi lịch sử chat có sẵn 1 tin nhắn chứa code block, làm VỠ toàn bộ phần script phía sau
// đó — mọi nút định nghĩa sau điểm vỡ (gửi tin, mic, agent, artifacts...) sẽ không hoạt động.
const ArtifactStore = {
  KEY: 'myai_artifacts',
  all() { return safeLoadJSON(this.KEY, []); },
  save(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); },
  add({ title, code, source }) {
    const list = this.all();
    const artifact = { id: 'art_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), title: title || 'Artifact không tên', code, source: source || 'chat', createdAt: new Date().toISOString() };
    list.unshift(artifact);
    this.save(list);
    return artifact;
  },
  get(id) { return this.all().find(a => a.id === id); },
  remove(id) { this.save(this.all().filter(a => a.id !== id)); },
  clearAll() { this.save([]); },
};

function saveHistory() {
  if (!state.temp) localStorage.setItem('myai_history', JSON.stringify(state.history));
}
function renderHistory() {
  els.chatMessages.innerHTML = '';
  state.history.forEach((m, i) => appendMsgToDOM(m.role, m.text, m.grounding, i));
}
// ===================== RENDER MARKDOWN (giống cách Claude hiển thị) =====================
// Dùng marked (chuyển markdown -> HTML) + DOMPurify (khử trùng HTML, chặn XSS) để tin nhắn AI
// hiện đúng **đậm**, *nghiêng*, danh sách, tiêu đề, ```code block```, `inline code`, link...
// thay vì in thô ký tự markdown ra màn hình như trước.
if (window.marked) {
  window.marked.setOptions({ breaks: true, gfm: true });
}
function renderMarkdown(text) {
  if (!text) return '';
  if (!window.marked || !window.DOMPurify) return escapeHtmlText(text); // fallback nếu CDN lỗi/chưa tải kịp
  const rawHtml = window.marked.parse(text);
  return window.DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] });
}
function escapeHtmlText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
// Render công thức LaTeX ($...$ inline, $$...$$ khối) bằng KaTeX sau khi đã có HTML trong container.
function renderMathInEl(container) {
  if (!window.renderMathInElement) return;
  try {
    window.renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    });
  } catch (e) { /* bỏ qua nếu công thức lỗi, không làm vỡ giao diện */ }
}
// Gắn nút "📋 Copy" vào góc mỗi khối code (giống Claude) sau khi đã render markdown vào 1 element
function enhanceCodeBlocks(container) {
  renderMathInEl(container);
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.dataset.enhanced) return;
    pre.dataset.enhanced = '1';
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '📋 Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent;
      navigator.clipboard?.writeText(code || '');
      btn.textContent = '✅ Đã chép';
      setTimeout(() => btn.textContent = '📋 Copy', 1500);
    });
    pre.appendChild(btn);
  });
}

function appendMsgToDOM(role, text, grounding, index) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + role;
  if (typeof index === 'number') wrap.dataset.index = index;

  const div = document.createElement('div');
  div.className = 'msg ' + role;

  // Tin nhắn AI: nếu chứa 1 khối code đáng kể (HTML trang riêng, hoặc >=6 dòng code),
  // tách ra thành Artifact card thay vì in thô cả khối ``` trong bong bóng chat.
  let artifactInfo = null;
  if (role === 'assistant') {
    artifactInfo = extractArtifactFromText(text);
  }
  let before = '';
  if (artifactInfo) {
    before = text.slice(0, text.indexOf('```')).trim();
    div.innerHTML = renderMarkdown(before);
  } else {
    div.innerHTML = renderMarkdown(text);
  }
  enhanceCodeBlocks(div);

  if (grounding?.groundingChunks?.length) {
    const g = document.createElement('div');
    g.className = 'grounding';
    g.innerHTML = '🔗 Nguồn: ' + grounding.groundingChunks.slice(0, 5)
      .map(c => c.web ? `<a href="${c.web.uri}" target="_blank">${c.web.title || c.web.uri}</a>` : '')
      .filter(Boolean).join(' · ');
    div.appendChild(g);
  }
  wrap.appendChild(div);

  // Nếu tách được artifact, tạo (hoặc tái sử dụng) và chèn card bên dưới nội dung
  if (artifactInfo) {
    const title = (before || text).replace(/\s+/g, ' ').slice(0, 60) || 'Artifact từ Chat';
    const artifact = ArtifactStore.add({ title, code: artifactInfo.code, source: 'chat' });
    wrap.appendChild(artifactCardEl(artifact));
  }

  // Hàng nút: sao chép + đọc to (mọi tin nhắn) + sửa (chỉ tin nhắn của bạn)
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn'; copyBtn.textContent = '📋 Sao chép';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard?.writeText(text || '');
    copyBtn.textContent = '✅ Đã chép';
    setTimeout(() => copyBtn.textContent = '📋 Sao chép', 1500);
  });
  actions.appendChild(copyBtn);

  const speakBtn = document.createElement('button');
  speakBtn.className = 'msg-action-btn'; speakBtn.textContent = '🔊 Đọc to';
  speakBtn.addEventListener('click', () => speakText(text, speakBtn));
  actions.appendChild(speakBtn);

  if (role === 'user' && typeof index === 'number') {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn'; editBtn.textContent = '✏️ Sửa';
    editBtn.addEventListener('click', () => startEditMessage(wrap, index, text));
    actions.appendChild(editBtn);
  }
  wrap.appendChild(actions);

  els.chatMessages.appendChild(wrap);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return div;
}
renderHistory();

// ===================== Ẩn tính năng chỉ dành cho chủ app (Agent Mode, Mở web & hỏi AI, model coding) =====================
// Chỉ để đỡ rối giao diện cho người dùng khác — chặn THẬT SỰ nằm ở worker (server luôn từ chối
// nếu không phải chủ app, kể cả khi ai đó sửa HTML/JS để cố hiện lại mấy nút này).
(async function applyOwnerRestrictions() {
  try {
    const r = await apiFetch(API_BASE + '/api/me');
    const data = await r.json();
    if (data.isOwner) return; // chủ app -> giữ nguyên, không ẩn gì cả

    document.querySelector('.nav-btn[data-mode="agent"]')?.remove();
    document.querySelector('.nav-btn[data-mode="webask"]')?.remove();

    // Xoá lựa chọn model coding (gemini-3.5-flash) khỏi bảng chọn model, và nếu người dùng
    // đang lỡ chọn sẵn model đó (lưu từ trước trong localStorage) thì trả về Auto.
    const codingValue = 'gemini-3.5-flash';
    const idx = MODEL_OPTIONS.findIndex(m => m.value === codingValue);
    if (idx !== -1) MODEL_OPTIONS.splice(idx, 1);
    if (state.model === codingValue) {
      state.model = 'auto';
      localStorage.setItem('myai_model', 'auto');
      if (typeof updateModelPillLabel === 'function') updateModelPillLabel();
    }
  } catch (e) {
    // Không tải được /api/me (mất mạng, chưa deploy...) -> cứ để nguyên UI, server vẫn tự chặn.
  }
})();

// ---- Sửa tin nhắn: bấm "✏️ Sửa" -> hiện textarea inline -> Lưu sẽ xoá các tin
// nhắn sau đó và gửi lại như 1 tin nhắn mới (giống cách Claude/ChatGPT xử lý edit) ----
function startEditMessage(wrap, index, currentText) {
  if (wrap.classList.contains('editing')) return;
  wrap.classList.add('editing');
  const msgDiv = wrap.querySelector('.msg');
  const original = msgDiv.style.display;
  msgDiv.style.display = 'none';

  const box = document.createElement('div');
  box.className = 'msg-edit-box';
  box.innerHTML = `<textarea>${currentText.replace(/</g, '&lt;')}</textarea>
    <div class="msg-edit-actions">
      <button class="msg-edit-cancel">Huỷ</button>
      <button class="msg-edit-save">Lưu &amp; gửi lại</button>
    </div>`;
  wrap.insertBefore(box, msgDiv);
  const ta = box.querySelector('textarea');
  ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
  ta.focus();

  box.querySelector('.msg-edit-cancel').addEventListener('click', () => {
    box.remove(); msgDiv.style.display = original; wrap.classList.remove('editing');
  });
  box.querySelector('.msg-edit-save').addEventListener('click', () => {
    const newText = ta.value.trim();
    if (!newText) return;
    box.remove(); wrap.classList.remove('editing');
    editMessage(index, newText);
  });
}
function editMessage(index, newText) {
  // Xoá tin nhắn này và mọi tin nhắn sau nó, rồi gửi lại như tin nhắn mới
  state.history = state.history.slice(0, index);
  saveHistory();
  renderHistory();
  submitUserMessage(newText, []);
}

els.newChatBtn.addEventListener('click', () => {
  state.history = [];
  state.conversationId = null;
  localStorage.removeItem('myai_last_conv');
  saveHistory();
  renderHistory();
  loadConversations();
  switchMode('chat');
});

// Nút "🕶️ Tạm thời" ở góc trái sidebar — đồng bộ 2 chiều với toggle trong Attach sheet
const tempChatBtnTop = document.getElementById('tempChatBtnTop');
function setTempMode(on) {
  state.temp = on;
  els.tempChatToggle.checked = on;
  tempChatBtnTop.classList.toggle('active', on);
  els.tempBanner.classList.toggle('hidden', !on);
}
tempChatBtnTop.addEventListener('click', () => setTempMode(!state.temp));
els.tempChatToggle.addEventListener('change', e => setTempMode(e.target.checked));
els.chatInput.addEventListener('input', () => {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = Math.min(220, els.chatInput.scrollHeight) + 'px';
});
const isMobileDevice = () => window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
// ===================== DỪNG PHẢN HỒI ĐANG STREAM (nút Gửi <-> nút Dừng, giống Claude) =====================
// Chỉ 1 luồng stream chạy tại 1 thời điểm trong khung chat chính (chat thường HOẶC deep research).
// currentStreamAbort giữ AbortController của luồng đang chạy để nút Dừng có thể huỷ nó bất kỳ lúc nào.
let currentStreamAbort = null;
function setSendButtonToStopMode(isStreaming) {
  if (!els.sendBtn) return;
  els.sendBtn.classList.toggle('is-stop', isStreaming);
  els.sendBtn.title = isStreaming ? 'Dừng' : 'Gửi';
  els.sendBtn.setAttribute('aria-label', isStreaming ? 'Dừng' : 'Gửi');
}
function stopCurrentStream() {
  currentStreamAbort?.abort();
  currentStreamAbort = null;
  setSendButtonToStopMode(false);
}

els.chatInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  // Trên mobile: Enter luôn xuống dòng (không có phím Shift vật lý), phải bấm nút Gửi.
  if (isMobileDevice()) return;
  // Trên desktop: Enter gửi, Shift+Enter xuống dòng.
  if (!e.shiftKey) { e.preventDefault(); sendChat(); }
});
els.sendBtn.addEventListener('click', () => {
  if (currentStreamAbort) { stopCurrentStream(); return; }
  sendChat();
});

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text && state.pendingAttachments.length === 0) return;
  els.chatInput.value = ''; els.chatInput.style.height = 'auto';
  if (state.deepResearchMode) {
    setDeepResearchMode(false);
    runDeepResearchAsChatMessage(text);
    return;
  }
  const attachments = state.pendingAttachments.map(a => ({ mimeType: a.mimeType, base64: a.base64 }));
  clearAttachments();
  submitUserMessage(text, attachments);
}

async function submitUserMessage(text, attachments) {
  const index = state.history.length;
  appendMsgToDOM('user', text || '[đính kèm]', null, index);
  state.history.push({ role: 'user', text });

  // Lưu vào D1 (trừ khi đang ở chế độ tạm thời) — tự tạo hội thoại mới nếu chưa có
  if (!state.temp) {
    await ensureConversation(text);
    if (state.conversationId) saveMessageToServer('user', text);
  }

  const assistantDiv = appendMsgToDOM('assistant', '', null, index + 1);
  assistantDiv.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  let fullText = '';
  let lastGrounding = null;
  let firstChunkReceived = false;

  const isHomework = state.mode === 'homework';
  const systemInstruction = isHomework
    ? 'Bạn là gia sư. Khi được hỏi bài tập, đừng chỉ đưa đáp án — hãy giải thích từng bước, chỉ ra cách tư duy, rồi mới chốt đáp án cuối cùng. Trả lời bằng tiếng Việt, rõ ràng, dễ hiểu.'
    : 'Bạn là Velocitix AI, một trợ lý AI hữu ích, trả lời bằng tiếng Việt trừ khi người dùng dùng ngôn ngữ khác.';

  const abortCtrl = new AbortController();
  currentStreamAbort = abortCtrl;
  setSendButtonToStopMode(true);

  await streamPost(API_BASE + '/api/chat/stream', {
    messages: [...state.history.map(m => ({ role: m.role, parts: [{ text: m.text }] }))],
    model: state.model,
    thinking: state.thinking,
    webSearch: els.webSearchToggle.checked,
    systemInstruction,
    attachments,
  }, {
    chunk: (t) => { firstChunkReceived = true; fullText += t; assistantDiv.innerHTML = renderMarkdown(fullText); els.chatMessages.scrollTop = els.chatMessages.scrollHeight; },
    thought: () => {},
    grounding: (g) => { lastGrounding = g; },
    fallback: (f) => { toastMsg?.(`⚡ ${f.from} hết hạn mức, đã tự chuyển sang ${f.to}`); },
    error: (e) => { assistantDiv.innerHTML = renderMarkdown('⚠️ Lỗi: ' + (typeof e === 'string' ? e : JSON.stringify(e))); },
    aborted: () => {
      // Người dùng bấm Dừng giữa chừng: giữ lại phần đã nhận được, đánh dấu là đã dừng, vẫn lưu lại.
      if (fullText) {
        enhanceCodeBlocks(assistantDiv);
        state.history.push({ role: 'assistant', text: fullText, grounding: lastGrounding, stopped: true });
        saveHistory();
        if (!state.temp && state.conversationId) saveMessageToServer('assistant', fullText, state.model);
      } else {
        assistantDiv.closest('.msg-row')?.remove();
      }
    },
    done: () => {
      enhanceCodeBlocks(assistantDiv);
      state.history.push({ role: 'assistant', text: fullText, grounding: lastGrounding });
      saveHistory();
      if (lastGrounding) renderHistory();
      if (!state.temp && state.conversationId) {
        saveMessageToServer('assistant', fullText, state.model);
        // Nếu đây là tin nhắn đầu tiên trong hội thoại -> để AI tự đặt tên (thay vì chỉ cắt bớt câu hỏi)
        if (state.history.length === 2) autoTitleConversation(state.conversationId, text, fullText);
      }
    },
  }, abortCtrl.signal);

  currentStreamAbort = null;
  setSendButtonToStopMode(false);
}

// ===================== LỊCH SỬ CHAT (D1) =====================
// Hội thoại hiện tại được lưu ở state.conversationId. Khi gửi tin nhắn đầu tiên
// (không ở chế độ tạm thời) mà chưa có hội thoại, tự tạo 1 hội thoại mới trong D1.
async function ensureConversation(firstText) {
  if (state.conversationId) return;
  try {
    const title = (firstText || 'Cuộc trò chuyện mới').slice(0, 60);
    const r = await apiFetch(API_BASE + '/api/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    const data = await r.json();
    if (data.id) {
      state.conversationId = data.id;
      localStorage.setItem('myai_last_conv', data.id);
      loadConversations();
    }
  } catch (e) { /* D1 chưa cấu hình hoặc lỗi mạng -> chat vẫn hoạt động, chỉ không lưu server */ }
}
async function saveMessageToServer(role, content, model) {
  try {
    await apiFetch(API_BASE + `/api/conversations/${state.conversationId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, content, model }),
    });
  } catch (e) { /* bỏ qua nếu lỗi mạng/D1 */ }
}
async function autoTitleConversation(convId, userText, assistantText) {
  try {
    await apiFetch(API_BASE + `/api/conversations/${convId}/auto-title`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText, assistantText }),
    });
    loadConversations(); // refresh sidebar để thấy tên mới AI vừa đặt
  } catch (e) { /* không sao — hội thoại vẫn giữ tên tạm (câu hỏi đầu tiên) */ }
}

// ---- Menu nhỏ hiện khi giữ tay (long-press) vào 1 chat trong sidebar ----
function showConvContextMenu(conv) {
  document.querySelectorAll('.conv-context-menu').forEach(m => m.remove());
  const backdrop = document.createElement('div');
  backdrop.className = 'conv-context-backdrop';
  const menu = document.createElement('div');
  menu.className = 'conv-context-menu';
  menu.innerHTML = `
    <div class="conv-context-title">${(conv.title || 'Cuộc trò chuyện').replace(/</g, '&lt;')}</div>
    <button class="conv-context-item" data-act="rename">✏️ Đổi tên</button>
    <button class="conv-context-item" data-act="delete">🗑️ Xoá</button>
    <button class="conv-context-item" data-act="cancel">Huỷ</button>`;
  const close = () => { backdrop.remove(); menu.remove(); };
  // QUAN TRỌNG: sau long-press, trình duyệt mobile thường phát sinh thêm 1 sự kiện "click" giả
  // lập ngay khi nhấc ngón tay ra — sự kiện đó rơi trúng backdrop vừa thêm vào DOM và đóng menu
  // ngay lập tức (menu "hiện rồi ẩn liền", không bấm được gì). Trì hoãn việc gắn listener đóng
  // 1 khung hình để sự kiện click dội đó trôi qua trước khi backdrop bắt đầu lắng nghe.
  requestAnimationFrame(() => {
    backdrop.addEventListener('click', close);
  });
  menu.querySelector('[data-act="cancel"]').addEventListener('click', close);
  menu.querySelector('[data-act="rename"]').addEventListener('click', async () => {
    close();
    const title = prompt('Tên mới cho hội thoại:', conv.title || '');
    if (!title) return;
    await apiFetch(API_BASE + `/api/conversations/${conv.id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    loadConversations();
  });
  menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    close();
    if (!confirm('Xoá hội thoại này (và toàn bộ tin nhắn)?')) return;
    await apiFetch(API_BASE + `/api/conversations/${conv.id}`, { method: 'DELETE' });
    if (state.conversationId === conv.id) { state.conversationId = null; localStorage.removeItem('myai_last_conv'); state.history = []; saveHistory(); renderHistory(); }
    loadConversations();
  });
  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
}

function convItemEl(conv) {
  const div = document.createElement('div');
  div.className = 'conv-item' + (conv.id === state.conversationId ? ' active' : '');
  div.innerHTML = `<span class="conv-title">${conv.title || 'Cuộc trò chuyện'}</span>
    <span class="conv-actions">
      <button class="conv-share" title="Chia sẻ">🔗</button>
      <button class="conv-rename" title="Đổi tên">✏️</button>
      <button class="conv-delete" title="Xoá">🗑️</button>
    </span>`;
  div.addEventListener('click', (e) => { if (!e.target.closest('.conv-actions')) selectConversation(conv.id); });
  // ---- Giữ tay (long-press) trên mobile -> hiện menu Đổi tên / Xoá, không cần bấm icon nhỏ ----
  let pressTimer = null;
  let longPressFired = false;
  const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  div.addEventListener('touchstart', () => {
    clearPress();
    longPressFired = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressFired = true;
      if (navigator.vibrate) navigator.vibrate(15);
      showConvContextMenu(conv);
    }, 500);
  }, { passive: true });
  div.addEventListener('touchend', (e) => {
    clearPress();
    // Nếu long-press vừa kích hoạt, chặn sự kiện "click" giả lập mà trình duyệt sắp phát sinh
    // ngay sau touchend — nếu không, nó sẽ lọt vào listener click của chính div này và mở luôn
    // hội thoại (selectConversation) ngay dưới menu vừa mở, gây rối UI.
    if (longPressFired) e.preventDefault();
  });
  div.addEventListener('touchmove', clearPress);
  div.querySelector('.conv-share').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await apiFetch(API_BASE + `/api/conversations/${conv.id}/messages`);
      const msgs = await r.json();
      const text = Array.isArray(msgs) ? msgs.map(m => `${m.role === 'user' ? '🧑 Bạn' : '🤖 AI'}: ${m.content}`).join('\n\n') : '';
      openShareSheet(`💬 ${conv.title || 'Cuộc trò chuyện'}\n\n${text}`);
    } catch { alert('Không tải được nội dung để chia sẻ.'); }
  });
  div.querySelector('.conv-rename').addEventListener('click', async (e) => {
    e.stopPropagation();
    const title = prompt('Tên mới cho hội thoại:', conv.title || '');
    if (!title) return;
    await apiFetch(API_BASE + `/api/conversations/${conv.id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    loadConversations();
  });
  div.querySelector('.conv-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Xoá hội thoại này (và toàn bộ tin nhắn)?')) return;
    await apiFetch(API_BASE + `/api/conversations/${conv.id}`, { method: 'DELETE' });
    if (state.conversationId === conv.id) { state.conversationId = null; localStorage.removeItem('myai_last_conv'); state.history = []; saveHistory(); renderHistory(); }
    loadConversations();
  });
  return div;
}
async function loadConversations() {
  try {
    const r = await apiFetch(API_BASE + '/api/conversations');
    const list = await r.json();
    if (!Array.isArray(list)) { els.convList.innerHTML = ''; return; }
    allConvs = list;
    renderConvList(allConvs);
  } catch (e) { /* D1 chưa cấu hình -> bỏ qua, sidebar lịch sử để trống */ }
}
function renderConvList(list) {
  els.convList.innerHTML = '';
  if (!list.length) { els.convList.innerHTML = '<p class="hint" style="padding:6px 10px">Không tìm thấy hội thoại nào.</p>'; return; }
  list.forEach(c => els.convList.appendChild(convItemEl(c)));
}
els.convSearchInput.addEventListener('input', () => {
  const q = els.convSearchInput.value.trim().toLowerCase();
  const filtered = q ? allConvs.filter(c => (c.title || '').toLowerCase().includes(q)) : allConvs;
  renderConvList(filtered);
});
async function selectConversation(id) {
  try {
    const r = await apiFetch(API_BASE + `/api/conversations/${id}/messages`);
    const msgs = await r.json();
    if (!Array.isArray(msgs)) return;
    state.conversationId = id;
    localStorage.setItem('myai_last_conv', id);
    state.history = msgs.map(m => ({ role: m.role, text: m.content }));
    saveHistory();
    renderHistory();
    switchMode('chat');
    renderConvList(els.convSearchInput.value.trim() ? allConvs.filter(c => (c.title || '').toLowerCase().includes(els.convSearchInput.value.trim().toLowerCase())) : allConvs);
  } catch (e) { alert('Không tải được hội thoại này.'); }
}
loadConversations();

// ===================== TÌM KIẾM NGỮ NGHĨA (Vectorize) =====================
function semResultEl(r) {
  const div = document.createElement('div');
  div.className = 'sem-result';
  div.innerHTML = `<div class="sem-meta">${r.role === 'user' ? '🧑 Bạn' : '🤖 AI'} · điểm khớp ${(r.score ?? 0).toFixed(2)}</div>
    <div class="sem-text">${(r.content || r.text || r.preview || '').slice(0, 300)}</div>`;
  div.addEventListener('click', () => {
    if (r.conversationId) selectConversation(r.conversationId);
    els.semSearchResults.classList.add('hidden');
    els.semSearchCloseBtn.classList.add('hidden');
  });
  return div;
}
async function runSemSearch() {
  const q = els.semSearchInput.value.trim();
  if (!q) return;
  els.semSearchResults.classList.remove('hidden');
  els.semSearchCloseBtn.classList.remove('hidden');
  els.semSearchResults.innerHTML = '<p class="hint">Đang tìm...</p>';
  try {
    const r = await apiFetch(API_BASE + '/api/search/semantic?q=' + encodeURIComponent(q));
    const data = await r.json();
    const results = Array.isArray(data) ? data : (data.results || data.matches || []);
    els.semSearchResults.innerHTML = '';
    if (!results.length) { els.semSearchResults.innerHTML = '<p class="hint">Không tìm thấy kết quả nào (cần Vectorize đã được cấu hình và có tin nhắn đã lưu).</p>'; return; }
    results.forEach(r2 => els.semSearchResults.appendChild(semResultEl(r2)));
  } catch (e) {
    els.semSearchResults.innerHTML = '<p class="hint">⚠️ Lỗi tìm kiếm: ' + e.message + '</p>';
  }
}
els.semSearchBtn.addEventListener('click', runSemSearch);
els.semSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSemSearch(); });
document.getElementById('semSearchToggleBtn').addEventListener('click', () => {
  const bar = document.getElementById('chatSearchBar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) els.semSearchInput.focus();
});
els.semSearchCloseBtn.addEventListener('click', () => {
  els.semSearchResults.classList.add('hidden');
  els.semSearchCloseBtn.classList.add('hidden');
  els.semSearchInput.value = '';
});

// ===================== ATTACHMENTS =====================
function clearAttachments() { state.pendingAttachments = []; renderAttachPreview(); }
function renderAttachPreview() {
  els.attachPreview.innerHTML = '';
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `<span>${a.mimeType.startsWith('image') ? '🖼️' : a.mimeType.startsWith('video') ? '🎥' : '📎'} ${a.filename}</span>`;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.onclick = () => { state.pendingAttachments.splice(i, 1); renderAttachPreview(); };
    chip.appendChild(btn);
    els.attachPreview.appendChild(chip);
  });
}
// Đọc file thẳng thành base64 trên trình duyệt (không cần server lưu file —
// phù hợp cả khi backend là Cloudflare Worker, vốn không có ổ đĩa).
// Lưu ý: file quá lớn (>~15-20MB) có thể vượt giới hạn request của Gemini API/Worker.
function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const data = { filename: file.name, mimeType: file.type || 'application/octet-stream', base64, size: file.size };
      state.pendingAttachments.push(data);
      renderAttachPreview();
      resolve(data);
    };
    reader.onerror = () => { alert('Không đọc được file: ' + file.name); reject(reader.error); };
    reader.readAsDataURL(file);
  });
}
function wireFileInput(btnId, inputId, multiple) {
  const btn = document.getElementById(btnId), input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    for (const f of input.files) await uploadFile(f);
    input.value = '';
  });
}
// (nút đính kèm giờ nằm trong sheet "＋", xem phần BOTTOM SHEETS phía trên)

// mic quick-attach (record short clip, attach as audio to chat)
document.getElementById('btnMic').addEventListener('click', async () => {
  const micBtn = document.getElementById('btnMic');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.start();
    micBtn.classList.add('recording'); micBtn.textContent = '⏺️';
    setTimeout(() => recorder.stop(), 5000); // ghi 5s, bấm lại chưa hỗ trợ dừng sớm ở bản này
    recorder.onstop = async () => {
      micBtn.classList.remove('recording'); micBtn.textContent = '🎤';
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
      await uploadFile(file);
    };
  } catch (e) { alert('Không truy cập được micro: ' + e.message); }
});

// ===================== GIẢI BÀI TẬP (Homework) — trang RIÊNG, không còn dùng chung Chat =====================
// AI sẽ tự suy nghĩ (không stream từng chữ kiểu chat) rồi đưa ra lời giải cụ thể từng bước,
// hiển thị dạng tài liệu. Sau đó có thể chuyển sang Flashcard / Đố câu hỏi để ôn lại đúng
// nội dung vừa giải (AI tự tạo từ đề bài + lời giải, không phải hỏi lại người dùng).
const hw = {
  els: {
    input: document.getElementById('hwInput'),
    sendBtn: document.getElementById('hwSendBtn'),
    plusBtn: document.getElementById('hwPlusBtn'),
    imageInput: document.getElementById('hwImageInput'),
    attachPreview: document.getElementById('hwAttachPreview'),
    emptyHint: document.getElementById('hwEmptyHint'),
    tabs: document.getElementById('hwModeTabs'),
    solutionView: document.getElementById('hwSolutionView'),
    solutionBody: document.getElementById('hwSolutionBody'),
    flashcardView: document.getElementById('hwFlashcardView'),
    flipCard: document.getElementById('hwFlipCard'),
    cardFront: document.getElementById('hwCardFront'),
    cardBack: document.getElementById('hwCardBack'),
    cardCounter: document.getElementById('hwCardCounter'),
    cardPrevBtn: document.getElementById('hwCardPrevBtn'),
    cardNextBtn: document.getElementById('hwCardNextBtn'),
    quizView: document.getElementById('hwQuizView'),
    quizProgress: document.getElementById('hwQuizProgress'),
    quizQuestion: document.getElementById('hwQuizQuestion'),
    quizOptions: document.getElementById('hwQuizOptions'),
    quizExplain: document.getElementById('hwQuizExplain'),
    quizNextBtn: document.getElementById('hwQuizNextBtn'),
  },
  attachments: [],
  topic: '', solution: '',
  flashcards: [], cardIndex: 0,
  quiz: [], quizIndex: 0, quizScore: 0,
};

hw.els.input.addEventListener('input', () => {
  hw.els.input.style.height = 'auto';
  hw.els.input.style.height = Math.min(220, hw.els.input.scrollHeight) + 'px';
});
hw.els.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); hwSolve(); } });
hw.els.sendBtn.addEventListener('click', hwSolve);
hw.els.plusBtn.addEventListener('click', () => hw.els.imageInput.click());
hw.els.imageInput.addEventListener('change', async () => {
  for (const f of hw.els.imageInput.files) {
    await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        hw.attachments.push({ filename: f.name, mimeType: f.type || 'image/*', base64: reader.result.split(',')[1] });
        renderHwAttachPreview();
        resolve();
      };
      reader.readAsDataURL(f);
    });
  }
  hw.els.imageInput.value = '';
});
function renderHwAttachPreview() {
  hw.els.attachPreview.innerHTML = '';
  hw.attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `<span>🖼️ ${a.filename}</span>`;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.onclick = () => { hw.attachments.splice(i, 1); renderHwAttachPreview(); };
    chip.appendChild(btn);
    hw.els.attachPreview.appendChild(chip);
  });
}

function setHwMode(mode) {
  document.querySelectorAll('.hw-mode-tab').forEach(b => b.classList.toggle('active', b.dataset.hwmode === mode));
  hw.els.solutionView.classList.toggle('hidden', mode !== 'solution');
  hw.els.flashcardView.classList.toggle('hidden', mode !== 'flashcard');
  hw.els.quizView.classList.toggle('hidden', mode !== 'quiz');
  if (mode === 'flashcard' && !hw.flashcards.length) hwGenerateFlashcards();
  if (mode === 'quiz' && !hw.quiz.length) hwGenerateQuiz();
}
document.querySelectorAll('.hw-mode-tab').forEach(btn => btn.addEventListener('click', () => setHwMode(btn.dataset.hwmode)));

async function hwSolve() {
  const text = hw.els.input.value.trim();
  if (!text && !hw.attachments.length) return;
  hw.els.input.value = ''; hw.els.input.style.height = 'auto';
  hw.topic = text;
  hw.flashcards = []; hw.quiz = []; hw.cardIndex = 0; hw.quizIndex = 0; hw.quizScore = 0;

  hw.els.emptyHint.classList.add('hidden');
  hw.els.tabs.classList.remove('hidden');
  setHwMode('solution');
  hw.els.solutionBody.innerHTML = '<p class="hint">⏳ AI đang suy nghĩ từng bước...</p>';

  const attachments = hw.attachments.map(a => ({ mimeType: a.mimeType, base64: a.base64 }));
  hw.attachments = [];
  renderHwAttachPreview();

  let full = '';
  await streamPost(API_BASE + '/api/chat/stream', {
    messages: [{ role: 'user', parts: [{ text: text || 'Giải bài tập trong ảnh đính kèm.' }] }],
    model: 'auto',
    thinking: true,
    webSearch: false,
    systemInstruction: 'Bạn là gia sư giỏi. Đây KHÔNG phải chat — hãy trình bày lời giải như 1 tài liệu hoàn chỉnh: '
      + 'trước tiên nêu tóm tắt đề bài, sau đó "Các bước giải" đánh số rõ ràng kèm giải thích cách tư duy ở mỗi bước, '
      + 'cuối cùng nêu "Đáp số" nổi bật. Dùng markdown (tiêu đề, danh sách, công thức trong code/inline nếu cần). Trả lời bằng tiếng Việt.',
    attachments,
  }, {
    chunk: (t) => { full += t; hw.els.solutionBody.innerHTML = renderMarkdown(full); },
    error: (e) => { hw.els.solutionBody.innerHTML = renderMarkdown('⚠️ Lỗi: ' + (typeof e === 'string' ? e : JSON.stringify(e))); },
    done: () => { hw.solution = full; enhanceCodeBlocks(hw.els.solutionBody); },
  });
}

// Gọi AI, yêu cầu trả lời DUY NHẤT bằng JSON hợp lệ, tự dọn code-fence nếu AI lỡ bọc ```json.
async function hwAskJSON(prompt) {
  let full = '';
  await streamPost(API_BASE + '/api/chat/stream', {
    messages: [{ role: 'user', parts: [{ text: prompt }] }],
    model: 'auto', thinking: false, webSearch: false,
    systemInstruction: 'Trả lời DUY NHẤT bằng 1 JSON hợp lệ theo đúng cấu trúc được yêu cầu — không markdown, không code fence, không giải thích thêm.',
  }, { chunk: (t) => { full += t; }, error: () => {} });
  const cleaned = full.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { return null; }
}

async function hwGenerateFlashcards() {
  hw.els.flipCard.classList.add('hidden');
  hw.els.cardCounter.textContent = '';
  hw.els.cardFront.textContent = '⏳ Đang tạo flashcard...';
  const prompt = `Dựa trên đề bài và lời giải sau, tạo 6-10 flashcard ôn tập (mặt trước là câu hỏi/khái niệm ngắn, mặt sau là câu trả lời ngắn gọn).\n`
    + `Đề bài: ${hw.topic}\nLời giải: ${hw.solution.slice(0, 4000)}\n`
    + `Trả về JSON dạng: [{"front":"...","back":"..."}, ...]`;
  const data = await hwAskJSON(prompt);
  hw.flashcards = Array.isArray(data) ? data.filter(c => c && c.front && c.back) : [];
  hw.cardIndex = 0;
  hw.els.flipCard.classList.remove('hidden');
  renderHwFlashcard();
}
function renderHwFlashcard() {
  if (!hw.flashcards.length) { hw.els.cardFront.textContent = '⚠️ Không tạo được flashcard, thử lại.'; hw.els.cardBack.textContent = ''; hw.els.cardCounter.textContent = ''; return; }
  const c = hw.flashcards[hw.cardIndex];
  hw.els.flipCard.classList.remove('flipped');
  hw.els.cardFront.textContent = c.front;
  hw.els.cardBack.textContent = c.back;
  hw.els.cardCounter.textContent = `${hw.cardIndex + 1} / ${hw.flashcards.length}`;
}
hw.els.flipCard.addEventListener('click', () => hw.els.flipCard.classList.toggle('flipped'));
hw.els.cardPrevBtn.addEventListener('click', () => { if (hw.flashcards.length) { hw.cardIndex = (hw.cardIndex - 1 + hw.flashcards.length) % hw.flashcards.length; renderHwFlashcard(); } });
hw.els.cardNextBtn.addEventListener('click', () => { if (hw.flashcards.length) { hw.cardIndex = (hw.cardIndex + 1) % hw.flashcards.length; renderHwFlashcard(); } });

async function hwGenerateQuiz() {
  hw.els.quizQuestion.textContent = '⏳ Đang tạo câu hỏi...';
  hw.els.quizOptions.innerHTML = '';
  hw.els.quizExplain.classList.add('hidden');
  hw.els.quizNextBtn.classList.add('hidden');
  const prompt = `Dựa trên đề bài và lời giải sau, tạo 5 câu hỏi trắc nghiệm (mỗi câu 4 lựa chọn, chỉ 1 đáp án đúng) để kiểm tra hiểu bài.\n`
    + `Đề bài: ${hw.topic}\nLời giải: ${hw.solution.slice(0, 4000)}\n`
    + `Trả về JSON dạng: [{"question":"...","options":["A","B","C","D"],"answerIndex":0,"explanation":"..."}]`;
  const data = await hwAskJSON(prompt);
  hw.quiz = Array.isArray(data) ? data.filter(q => q && q.question && Array.isArray(q.options)) : [];
  hw.quizIndex = 0; hw.quizScore = 0;
  renderHwQuiz();
}
function renderHwQuiz() {
  hw.els.quizExplain.classList.add('hidden');
  hw.els.quizNextBtn.classList.add('hidden');
  if (!hw.quiz.length) { hw.els.quizQuestion.textContent = '⚠️ Không tạo được câu hỏi, thử lại.'; hw.els.quizOptions.innerHTML = ''; hw.els.quizProgress.textContent = ''; return; }
  if (hw.quizIndex >= hw.quiz.length) {
    hw.els.quizProgress.textContent = 'Hoàn thành';
    hw.els.quizQuestion.textContent = `🎉 Bạn đạt ${hw.quizScore} / ${hw.quiz.length} câu đúng.`;
    hw.els.quizOptions.innerHTML = '';
    return;
  }
  const q = hw.quiz[hw.quizIndex];
  hw.els.quizProgress.textContent = `Câu ${hw.quizIndex + 1} / ${hw.quiz.length} · Điểm: ${hw.quizScore}`;
  hw.els.quizQuestion.textContent = q.question;
  hw.els.quizOptions.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'hw-quiz-option';
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hw-quiz-option').forEach(b => b.disabled = true);
      const correctIdx = Number(q.answerIndex);
      if (i === correctIdx) { btn.classList.add('correct'); hw.quizScore++; }
      else { btn.classList.add('wrong'); const correctBtn = hw.els.quizOptions.children[correctIdx]; correctBtn?.classList.add('correct'); }
      if (q.explanation) { hw.els.quizExplain.textContent = '💡 ' + q.explanation; hw.els.quizExplain.classList.remove('hidden'); }
      hw.els.quizNextBtn.classList.remove('hidden');
    });
    hw.els.quizOptions.appendChild(btn);
  });
}
hw.els.quizNextBtn.addEventListener('click', () => { hw.quizIndex++; renderHwQuiz(); });

// ===================== IMAGE GEN =====================
document.getElementById('imgGenBtn').addEventListener('click', async () => {
  const prompt = document.getElementById('imgPrompt').value.trim();
  if (!prompt) return;
  const pro = document.getElementById('imgProToggle').checked;
  const box = document.getElementById('imgResults');
  box.innerHTML = '<p class="hint">Đang tạo ảnh...</p>';
  try {
    const r = await fetch(API_BASE + '/api/image/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, pro }) });
    const data = await r.json();
    box.innerHTML = '';
    if (data.error) { box.innerHTML = `<p class="hint">⚠️ ${JSON.stringify(data.error)}</p>`; return; }
    if (!data.images?.length) { box.innerHTML = '<p class="hint">Không nhận được ảnh nào.</p>'; return; }
    data.images.forEach(img => {
      const el = document.createElement('img');
      el.src = `data:${img.mimeType};base64,${img.base64}`;
      box.appendChild(el);
    });
    if (data.images.some(img => img.savedUrl)) {
      box.insertAdjacentHTML('beforeend', '<p class="hint">✅ Đã lưu vào 🗂️ Thư viện.</p>');
    }
  } catch (e) { box.innerHTML = '<p class="hint">Lỗi: ' + e.message + '</p>'; }
});

// ===================== MỞ WEB & HỎI AI (panel-webask) =====================
// Khác Deep Research (tự tìm nhiều trang) và khác "Điều khiển trình duyệt thật" (tự thao tác):
// mục này chỉ mở ĐÚNG 1 URL người dùng đưa vào khung sandbox để xem trực tiếp, và gọi
// /api/search/browse (chỉ đọc, không thao tác) để AI trả lời câu hỏi về nội dung trang đó.
(function setupWebAsk() {
  const urlInput = document.getElementById('webaskUrl');
  const questionInput = document.getElementById('webaskQuestion');
  const frame = document.getElementById('webaskFrame');
  const urlLabel = document.getElementById('webaskUrlLabel');
  const emptyHint = document.getElementById('webaskEmptyHint');
  const openTabBtn = document.getElementById('webaskOpenTabBtn');
  const openBtn = document.getElementById('webaskOpenBtn');
  const askBtn = document.getElementById('webaskAskBtn');
  const results = document.getElementById('webaskResults');
  if (!urlInput || !askBtn) return;

  function normalizeUrl(raw) {
    const v = raw.trim();
    if (!v) return '';
    return /^https?:\/\//i.test(v) ? v : 'https://' + v;
  }

  let frameLoaded = false;
  frame.addEventListener('load', () => { frameLoaded = true; });

  function openInFrame() {
    const url = normalizeUrl(urlInput.value);
    if (!url) return;
    frameLoaded = false;
    frame.src = url;
    frame.classList.add('has-src');
    emptyHint.style.display = 'none';
    urlLabel.textContent = url;
    urlLabel.title = url;
    // Nhiều trang (Google, Facebook, báo lớn...) tự chặn bị nhúng iframe (X-Frame-Options /
    // CSP frame-ancestors) — trình duyệt sẽ không báo lỗi gì (không có sự kiện 'error' cho
    // trường hợp này), khung chỉ trắng mãi. Sau 4s nếu vẫn chưa load được, báo cho người dùng
    // biết đây là giới hạn của trang đích chứ không phải app bị lỗi.
    setTimeout(() => {
      if (!frameLoaded && frame.src) {
        toastMsg?.('Trang này có thể chặn hiển thị trong khung sandbox — thử "↗ Mở tab riêng"');
      }
    }, 4000);
  }

  openBtn.addEventListener('click', openInFrame);
  openTabBtn.addEventListener('click', () => {
    const url = normalizeUrl(urlInput.value);
    if (url) window.open(url, '_blank', 'noopener');
  });

  askBtn.addEventListener('click', async () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) { urlInput.focus(); return; }
    const question = questionInput.value.trim();
    // Mở luôn trong sandbox nếu chưa mở, để người dùng xem song song lúc AI đang đọc.
    if (!frame.classList.contains('has-src')) openInFrame();

    const card = document.createElement('div');
    card.className = 'webask-answer';
    card.innerHTML = `<div class="webask-src">🔗 ${url}</div><p class="hint">Đang tải & đọc trang...</p>`;
    results.prepend(card);

    // Timeout 25s: nếu trang đích chặn bot/quá chậm, worker có thể "treo" — đừng để card kẹt
    // mãi ở "Đang tải..." không rõ lý do.
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 25000);

    try {
      const r = await fetch(API_BASE + '/api/search/browse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, question: question || undefined }),
        signal: abortCtrl.signal,
      });
      clearTimeout(timeoutId);
      let data;
      try {
        data = await r.json();
      } catch (parseErr) {
        card.innerHTML = `<div class="webask-src">🔗 ${url}</div><p class="hint">⚠️ Server trả về dữ liệu không hợp lệ (HTTP ${r.status}). Kiểm tra lại worker/API_BASE.</p>`;
        return;
      }
      if (!r.ok || data.error) {
        card.innerHTML = `<div class="webask-src">🔗 ${url}</div><p class="hint">⚠️ ${data.error || ('Lỗi server (HTTP ' + r.status + ')')}</p>`;
        return;
      }
      card.innerHTML = `<div class="webask-src">🔗 ${data.sourceUrl || url}</div>${renderMarkdown(data.answer || '(AI không trả về nội dung)')}`;
    } catch (e) {
      clearTimeout(timeoutId);
      const msg = e.name === 'AbortError'
        ? 'Quá thời gian chờ (trang đích tải quá lâu hoặc chặn bot đọc nội dung).'
        : ('Lỗi: ' + e.message + ' — kiểm tra kết nối mạng hoặc API_BASE của worker.');
      card.innerHTML = `<div class="webask-src">🔗 ${url}</div><p class="hint">⚠️ ${msg}</p>`;
      console.error('webask askBtn error:', e);
    }
  });
})();

// ===================== VIDEO GEN (chạy nền qua Queue, có polling) =====================
const vidJobsEl = document.getElementById('vidJobs');
const VID_POLL_MS = 4000;

function renderVideoResult(box, v) {
  const src = v.savedUrl ? (API_BASE + v.savedUrl) : `data:${v.mimeType};base64,${v.base64}`;
  const el = document.createElement('video');
  el.src = src;
  el.controls = true;
  box.appendChild(el);
}

function pollVideoJob(jobId, cardEl) {
  const statusEl = cardEl.querySelector('.vid-job-status');
  const timer = setInterval(async () => {
    try {
      const r = await fetch(API_BASE + '/api/video/status/' + jobId);
      const data = await r.json();
      if (data.status === 'pending') {
        statusEl.textContent = '⏳ Đang xử lý ở nền... (job vẫn còn trong hàng đợi)';
      } else if (data.status === 'done') {
        clearInterval(timer);
        cardEl.classList.add('status-done');
        statusEl.textContent = '✅ Xong!';
        const box = document.getElementById('vidResults');
        (data.videos || []).forEach(v => renderVideoResult(box, v));
        if ((data.videos || []).some(v => v.savedUrl)) {
          statusEl.insertAdjacentHTML('afterend', '<p class="hint">✅ Đã lưu vào 🗂️ Thư viện.</p>');
        }
      } else if (data.status === 'error') {
        clearInterval(timer);
        cardEl.classList.add('status-error');
        statusEl.textContent = '⚠️ Lỗi: ' + (data.error || 'không rõ nguyên nhân') + ' (video thường cần tài khoản Google AI có billing/quyền tính năng video)';
      } else if (data.status === 'not_found') {
        clearInterval(timer);
        statusEl.textContent = '⚠️ Không tìm thấy job (có thể KV chưa cấu hình hoặc job đã hết hạn).';
      }
    } catch (e) {
      statusEl.textContent = '⚠️ Lỗi khi kiểm tra tiến trình: ' + e.message;
    }
  }, VID_POLL_MS);
}

document.getElementById('vidGenBtn').addEventListener('click', async () => {
  const prompt = document.getElementById('vidPrompt').value.trim();
  if (!prompt) return;
  const durationSeconds = Number(document.getElementById('vidDuration').value) || 5;

  const card = document.createElement('div');
  card.className = 'vid-job';
  card.innerHTML = `<div><b>${prompt.slice(0, 80)}</b></div><div class="vid-job-status hint">Đang gửi job vào hàng đợi...</div>`;
  vidJobsEl.prepend(card);

  try {
    const r = await fetch(API_BASE + '/api/video/generate-async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, durationSeconds }) });
    const data = await r.json();
    if (data.error || !data.jobId) {
      card.classList.add('status-error');
      card.querySelector('.vid-job-status').textContent = '⚠️ ' + (data.error || 'Không tạo được job (kiểm tra Queue/KV đã cấu hình chưa)');
      return;
    }
    card.querySelector('.vid-job-status').textContent = '⏳ Đã vào hàng đợi, đang chờ xử lý...';
    pollVideoJob(data.jobId, card);
  } catch (e) {
    card.classList.add('status-error');
    card.querySelector('.vid-job-status').textContent = '⚠️ Lỗi: ' + e.message;
  }
});

// ===================== THƯ VIỆN (R2) =====================
const libEls = {
  folderFilter: document.getElementById('libFolderFilter'),
  refreshBtn: document.getElementById('libRefreshBtn'),
  results: document.getElementById('libResults'),
  loadMoreBtn: document.getElementById('libLoadMoreBtn'),
};
let libCursor = null;

function libFileCard(f) {
  const wrap = document.createElement('div');
  wrap.className = 'lib-card';
  let preview = '';
  if (f.mimeType.startsWith('image/')) preview = `<img src="${API_BASE}${f.url}" loading="lazy" />`;
  else if (f.mimeType.startsWith('video/')) preview = `<video src="${API_BASE}${f.url}" controls></video>`;
  else if (f.mimeType.startsWith('audio/')) preview = `<audio src="${API_BASE}${f.url}" controls></audio>`;
  else preview = `<div class="lib-file-icon">📄</div>`;

  wrap.innerHTML = `
    ${preview}
    <div class="lib-meta">
      <span class="lib-name" title="${f.filename}">${f.filename}</span>
      <div class="lib-actions">
        <a href="${API_BASE}${f.url}" target="_blank" download="${f.filename}">⬇️ Tải</a>
        <button class="lib-del" data-key="${f.key}">🗑️ Xoá</button>
      </div>
    </div>`;
  wrap.querySelector('.lib-del').addEventListener('click', async (e) => {
    const key = e.target.dataset.key;
    if (!confirm('Xoá file này khỏi thư viện?')) return;
    await fetch(API_BASE + '/api/files/' + encodeURIComponent(key), { method: 'DELETE' });
    wrap.remove();
  });
  return wrap;
}

async function loadLibrary(reset = true) {
  if (reset) { libEls.results.innerHTML = '<p class="hint">Đang tải...</p>'; libCursor = null; }
  const folder = libEls.folderFilter.value;
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  if (!reset && libCursor) params.set('cursor', libCursor);
  try {
    const r = await fetch(API_BASE + '/api/files?' + params.toString());
    const data = await r.json();
    if (data.error) { libEls.results.innerHTML = `<p class="hint">⚠️ ${data.error}</p>`; return; }
    if (reset) libEls.results.innerHTML = '';
    if (!data.files.length && reset) { libEls.results.innerHTML = '<p class="hint">Chưa có file nào được lưu.</p>'; }
    data.files.forEach(f => libEls.results.appendChild(libFileCard(f)));
    libCursor = data.cursor;
    libEls.loadMoreBtn.style.display = libCursor ? 'block' : 'none';
  } catch (e) {
    libEls.results.innerHTML = '<p class="hint">Lỗi tải thư viện: ' + e.message + '</p>';
  }
}
libEls.refreshBtn.addEventListener('click', () => loadLibrary(true));
libEls.folderFilter.addEventListener('change', () => loadLibrary(true));
libEls.loadMoreBtn.addEventListener('click', () => loadLibrary(false));

// Móc thêm hành vi cho switchMode khi chuyển sang Thư viện / Artifacts, mà không ghi đè trực tiếp
// function switchMode gốc (ghi đè tên trùng với 1 function declaration dễ gây nhầm lẫn khi debug).
function onModeSwitchExtra(mode) {
  if (mode === 'library' && !libEls.results.dataset.loaded) {
    libEls.results.dataset.loaded = '1';
    loadLibrary(true);
  }
  if (mode === 'artifacts') {
    renderArtifactsGrid();
  }
}

// ===================== CANVAS =====================
// ===================== ARTIFACTS (hợp nhất, dùng chung Chat / Code Editor / Agent Mode) =====================
// Một "artifact" = 1 khối code/HTML độc lập mà AI tạo ra, có thể preview trực tiếp.
// Lưu trong localStorage để còn xem lại sau khi tải lại trang.
const artifactEls = {
  listView: document.getElementById('artifactsListView'),
  grid: document.getElementById('artifactsGrid'),
  detail: document.getElementById('artifactDetail'),
  detailTitle: document.getElementById('artifactDetailTitle'),
  backBtn: document.getElementById('artifactBackBtn'),
  copyBtn: document.getElementById('artifactCopyBtn'),
  shareBtn: document.getElementById('artifactShareBtn'),
  downloadBtn: document.getElementById('artifactDownloadBtn'),
  deleteBtn: document.getElementById('artifactDeleteBtn'),
  clearAllBtn: document.getElementById('artifactsClearAllBtn'),
  codeArea: document.getElementById('artifactCode'),
  frame: document.getElementById('artifactFrame'),
  runBtn: document.getElementById('artifactRunBtn'),
  genBtn: document.getElementById('artifactGenBtn'),
  prompt: document.getElementById('artifactPrompt'),
};

// Nhận diện block code trong 1 câu trả lời của AI và tách ra thành artifact nếu đáng (HTML đầy đủ trang, hoặc code >6 dòng).
function extractArtifactFromText(text) {
  const htmlMatch = text.match(/```html([\s\S]*?)```/i);
  if (htmlMatch) return { code: htmlMatch[1].trim(), lang: 'html' };
  const anyMatch = text.match(/```(\w*)\n?([\s\S]*?)```/);
  if (anyMatch && anyMatch[2].trim().split('\n').length >= 6) {
    return { code: anyMatch[2].trim(), lang: anyMatch[1] || 'code' };
  }
  return null;
}

function openArtifact(id) {
  const artifact = ArtifactStore.get(id);
  if (!artifact) return;
  switchMode('artifacts');
  artifactEls.listView.classList.add('hidden');
  artifactEls.detail.classList.remove('hidden');
  artifactEls.detailTitle.textContent = artifact.title;
  artifactEls.codeArea.value = artifact.code;
  artifactEls.detail.dataset.artifactId = id;
  runArtifactPreview();
  setArtifactTab('preview');
}
function closeArtifactDetail() {
  artifactEls.detail.classList.add('hidden');
  artifactEls.listView.classList.remove('hidden');
  renderArtifactsGrid();
}
artifactEls.backBtn.addEventListener('click', closeArtifactDetail);

function setArtifactTab(tab) {
  document.querySelectorAll('.artifact-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('artifactPreviewView').classList.toggle('active', tab === 'preview');
  document.getElementById('artifactCodeView').classList.toggle('active', tab === 'code');
}
document.querySelectorAll('.artifact-tab').forEach(btn => {
  btn.addEventListener('click', () => setArtifactTab(btn.dataset.tab));
});

function runArtifactPreview() {
  const code = artifactEls.codeArea.value;
  artifactEls.frame.srcdoc = code || '<p style="font-family:sans-serif;padding:20px;color:#888">Artifact trống.</p>';
}
artifactEls.runBtn.addEventListener('click', () => {
  runArtifactPreview();
  const id = artifactEls.detail.dataset.artifactId;
  if (id) { const list = ArtifactStore.all(); const a = list.find(x => x.id === id); if (a) { a.code = artifactEls.codeArea.value; ArtifactStore.save(list); } }
});

artifactEls.copyBtn.addEventListener('click', () => {
  navigator.clipboard?.writeText(artifactEls.codeArea.value || '');
  artifactEls.copyBtn.textContent = '✅ Đã chép';
  setTimeout(() => artifactEls.copyBtn.textContent = '📋 Copy', 1500);
});
artifactEls.downloadBtn.addEventListener('click', () => {
  const blob = new Blob([artifactEls.codeArea.value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (artifactEls.detailTitle.textContent || 'artifact').replace(/[^\w\-]+/g, '_') + '.html';
  a.click();
});
artifactEls.shareBtn.addEventListener('click', () => {
  const id = artifactEls.detail.dataset.artifactId;
  const artifact = id ? ArtifactStore.get(id) : null;
  openShareSheet(`🧩 ${artifact?.title || 'Artifact'}\n\n${artifactEls.codeArea.value}`);
});

function artifactCardEl(artifact) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  const sourceLabel = { chat: '💬 Chat', code: '💻 Code Editor', agent: '🚀 Agent', artifacts: '🧩 Artifacts' }[artifact.source] || artifact.source;
  card.innerHTML = `
    <div class="artifact-card-icon">🧩</div>
    <div class="artifact-card-body">
      <div class="artifact-card-title">${artifact.title}</div>
      <div class="artifact-card-meta">${sourceLabel} · ${new Date(artifact.createdAt).toLocaleString('vi-VN')}</div>
    </div>
    <div class="artifact-card-actions">
      <button class="ac-preview" title="Preview">👁️</button>
      <button class="ac-code" title="Xem code">💻</button>
      <button class="ac-copy" title="Copy">📋</button>
      <button class="ac-share" title="Share">🔗</button>
      <button class="ac-delete" title="Xóa artifact này">🗑️</button>
    </div>`;
  card.querySelector('.ac-preview').addEventListener('click', (e) => { e.stopPropagation(); openArtifact(artifact.id); setArtifactTab('preview'); });
  card.querySelector('.ac-code').addEventListener('click', (e) => { e.stopPropagation(); openArtifact(artifact.id); setArtifactTab('code'); });
  card.querySelector('.ac-copy').addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(artifact.code || '');
    e.target.textContent = '✅';
    setTimeout(() => e.target.textContent = '📋', 1200);
  });
  card.querySelector('.ac-share').addEventListener('click', (e) => { e.stopPropagation(); openShareSheet(`🧩 ${artifact.title}\n\n${artifact.code}`); });
  card.querySelector('.ac-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(`Xóa artifact "${artifact.title}"? Không thể hoàn tác.`)) return;
    ArtifactStore.remove(artifact.id);
    renderArtifactsGrid();
  });
  card.addEventListener('click', () => openArtifact(artifact.id));
  return card;
}
function renderArtifactsGrid() {
  const list = ArtifactStore.all();
  artifactEls.grid.innerHTML = '';
  if (artifactEls.clearAllBtn) artifactEls.clearAllBtn.style.display = list.length ? '' : 'none';
  if (!list.length) { artifactEls.grid.innerHTML = '<p class="hint">Chưa có artifact nào. Tạo mới ở trên, hoặc nhờ AI viết code/HTML trong Chat, Code Editor hay Agent Mode — artifact sẽ tự xuất hiện ở đây.</p>'; return; }
  list.forEach(a => artifactEls.grid.appendChild(artifactCardEl(a)));
}
document.querySelector('.nav-btn[data-mode="artifacts"]').addEventListener('click', () => {
  closeArtifactDetail();
});

// Xóa 1 artifact đang mở ở trang chi tiết
if (artifactEls.deleteBtn) {
  artifactEls.deleteBtn.addEventListener('click', () => {
    const id = artifactEls.detail.dataset.artifactId;
    if (!id) return;
    const a = ArtifactStore.get(id);
    if (!confirm(`Xóa artifact "${a?.title || ''}"? Không thể hoàn tác.`)) return;
    ArtifactStore.remove(id);
    closeArtifactDetail();
  });
}

// Xóa toàn bộ artifacts
if (artifactEls.clearAllBtn) {
  artifactEls.clearAllBtn.addEventListener('click', () => {
    const list = ArtifactStore.all();
    if (!list.length) return;
    if (!confirm(`Xóa TẤT CẢ ${list.length} artifact? Không thể hoàn tác.`)) return;
    ArtifactStore.clearAll();
    renderArtifactsGrid();
  });
}

// Tạo artifact mới trực tiếp từ panel Artifacts (giống Canvas cũ)
artifactEls.genBtn.addEventListener('click', async () => {
  const prompt = artifactEls.prompt.value.trim();
  if (!prompt) return;
  artifactEls.genBtn.disabled = true;
  artifactEls.genBtn.textContent = '⏳ Đang tạo...';
  let full = '';
  await streamPost(API_BASE + '/api/chat/stream', {
    messages: [{ role: 'user', parts: [{ text: prompt }] }],
    model: 'auto',
    thinking: false,
    webSearch: false,
    systemInstruction: 'Trả lời DUY NHẤT một khối code HTML độc lập (đầy đủ CSS+JS trong 1 file, không cần thư viện ngoài trừ khi thật cần), bên trong ```html ... ```. Không giải thích thêm gì khác.',
  }, {
    chunk: t => { full += t; },
    done: () => {
      const match = full.match(/```html([\s\S]*?)```/i) || full.match(/```([\s\S]*?)```/);
      const code = (match ? match[1] : full).trim();
      const artifact = ArtifactStore.add({ title: prompt.slice(0, 60), code, source: 'artifacts' });
      artifactEls.genBtn.disabled = false;
      artifactEls.genBtn.textContent = '⚡ Tạo Artifact mới';
      artifactEls.prompt.value = '';
      openArtifact(artifact.id);
    },
    error: e => {
      artifactEls.genBtn.disabled = false;
      artifactEls.genBtn.textContent = '⚡ Tạo Artifact mới';
      alert('⚠️ Lỗi: ' + e);
    },
  });
});

// ===================== SHARE SHEET (dùng chung: đoạn chat + artifact) =====================
const shareSheetEl = document.getElementById('shareSheet');
const shareBackdropEl = document.getElementById('shareBackdrop');
function openShareSheet(text) {
  document.getElementById('shareTextArea').value = text;
  openSheet(shareSheetEl, shareBackdropEl);
}
document.getElementById('shareCloseBtn').addEventListener('click', () => closeSheet(shareSheetEl, shareBackdropEl));
shareBackdropEl.addEventListener('click', () => closeSheet(shareSheetEl, shareBackdropEl));
document.getElementById('shareCopyBtn').addEventListener('click', () => {
  navigator.clipboard?.writeText(document.getElementById('shareTextArea').value || '');
  const btn = document.getElementById('shareCopyBtn');
  btn.textContent = '✅ Đã chép';
  setTimeout(() => btn.textContent = '📋 Sao chép nội dung chia sẻ', 1500);
});
function shareConversation() {
  const text = state.history.map(m => `${m.role === 'user' ? '🧑 Bạn' : '🤖 AI'}: ${m.text}`).join('\n\n');
  openShareSheet(text || 'Chưa có nội dung để chia sẻ.');
}
document.getElementById('shareChatBtn').addEventListener('click', shareConversation);

// ===================== CODE EDITOR =====================
// ===================== CODE EDITOR: 2 khung riêng =====================
// Khung trái (codeChatMessages) hiển thị lời giải thích/hội thoại của AI, giống hệt Chat thường.
// Khung phải (codeEditor) chỉ chứa code — AI được yêu cầu bọc code trong khối ```; phần TRONG
// khối đó đổ vào codeEditor, phần NGOÀI khối (giải thích) hiện ở khung trái. Nếu AI không trả
// code (chỉ trả lời câu hỏi thường), khung phải giữ nguyên không bị ghi đè.
let codeEditorHistory = [];

function appendCodeChatMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg-wrap ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'msg ' + role;
  bubble.innerHTML = renderMarkdown(text);
  div.appendChild(bubble);
  document.getElementById('codeChatMessages').appendChild(div);
  document.getElementById('codeChatMessages').scrollTop = 999999;
  return bubble;
}

// Tách khối code (```...```) ra khỏi phần văn bản còn lại. Trả về { explanation, code }.
// code = null nếu AI không trả về khối code nào (trường hợp chỉ hỏi/trả lời thường).
function splitCodeAndExplanation(fullText) {
  const match = fullText.match(/```[\w]*\n?([\s\S]*?)```/);
  if (!match) return { explanation: fullText.trim(), code: null };
  const code = match[1].trim();
  const explanation = (fullText.slice(0, match.index) + fullText.slice(match.index + match[0].length)).trim();
  return { explanation: explanation || '(Đã cập nhật code bên phải)', code };
}

document.getElementById('codeAskBtn').addEventListener('click', async () => {
  const instruction = document.getElementById('codeInstruction').value.trim();
  if (!instruction) return;
  document.getElementById('codeInstruction').value = '';
  const editor = document.getElementById('codeEditor');
  const currentCode = editor.value;

  appendCodeChatMsg('user', instruction);
  codeEditorHistory.push({ role: 'user', text: instruction });

  const contextNote = currentCode
    ? `Code hiện tại trong editor:\n\`\`\`\n${currentCode}\n\`\`\`\n\n`
    : '';
  const prompt = `${contextNote}Yêu cầu: ${instruction}\n\n` +
    `Nếu yêu cầu cần viết/sửa code: trả lời ngắn gọn phần giải thích trước, rồi đặt TOÀN BỘ code trong DUY NHẤT một khối \`\`\`. ` +
    `Nếu chỉ là câu hỏi thường (không cần code): trả lời bình thường, không cần khối \`\`\`.`;

  const assistantBubble = appendCodeChatMsg('assistant', '');
  assistantBubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  let fullText = '';

  const abortCtrl = new AbortController();
  currentStreamAbort = abortCtrl;
  setSendButtonToStopMode(true); // dùng chung cơ chế Gửi<->Dừng với Chat chính

  await streamPost(API_BASE + '/api/chat/stream', {
    messages: [...codeEditorHistory.slice(0, -1).map(m => ({ role: m.role, parts: [{ text: m.text }] })), { role: 'user', parts: [{ text: prompt }] }],
    model: state.model,
    thinking: true,
    webSearch: false,
    systemInstruction: 'Bạn là trợ lý lập trình trong 1 code editor có 2 khung: khung trái hiện lời giải thích của bạn, khung phải là code thật. Luôn đặt code (nếu có) trong đúng 1 khối ``` duy nhất.',
  }, {
    chunk: (t) => { fullText += t; assistantBubble.innerHTML = renderMarkdown(fullText); },
    fallback: (f) => { toastMsg?.(`⚡ ${f.from} hết hạn mức, đã tự chuyển sang ${f.to}`); },
    error: (e) => { assistantBubble.innerHTML = renderMarkdown('⚠️ Lỗi: ' + e); },
    aborted: () => {
      const { explanation, code } = splitCodeAndExplanation(fullText);
      assistantBubble.innerHTML = renderMarkdown(explanation + '\n\n_(đã dừng)_');
      if (code) editor.value = code;
    },
    done: () => {
      const { explanation, code } = splitCodeAndExplanation(fullText);
      assistantBubble.innerHTML = renderMarkdown(explanation);
      codeEditorHistory.push({ role: 'assistant', text: fullText });
      if (code) {
        editor.value = code;
        // Code đủ dài -> tự lưu thành Artifact (file riêng, không lẫn với code nhỏ chỉ hiện tại đây)
        if (code.split('\n').length >= 6) ArtifactStore.add({ title: instruction.slice(0, 60), code, source: 'code' });
        refreshCodePreview();
      }
    },
  }, abortCtrl.signal);

  currentStreamAbort = null;
  setSendButtonToStopMode(false);
});

// ---- 4 nút toolbar (Copy / Tải xuống / Lưu Artifact / tab Code-Preview) — bọc try/catch + fallback
// riêng cho từng nút, để 1 API bị WebView chặn (clipboard, tải file...) không khiến nút "im re" mà
// không rõ lý do; luôn báo cho người dùng biết kết quả qua toastMsg() thay vì im lặng. ----

// Toast nhỏ, không phụ thuộc thư viện ngoài — để xác nhận 1 nút vừa được bấm và làm gì.
function toastMsg(text) {
  let el = document.getElementById('codeToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'codeToast';
    el.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(20,20,20,.9);color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;z-index:2000;max-width:86vw;text-align:center;pointer-events:none;transition:opacity .25s ease;opacity:0;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

document.getElementById('codeToArtifactBtn')?.addEventListener('click', () => {
  try {
    const code = document.getElementById('codeEditor').value;
    if (!code.trim()) { toastMsg('Chưa có code để lưu'); return; }
    const artifact = ArtifactStore.add({ title: 'Code từ Code Editor', code, source: 'code' });
    toastMsg('Đã lưu vào Artifacts');
    switchMode('artifacts');
    openArtifact?.(artifact.id);
  } catch (err) {
    console.error('codeToArtifactBtn error:', err);
    toastMsg('Lỗi khi lưu Artifact');
  }
});

document.getElementById('codeCopyBtn').addEventListener('click', async () => {
  const code = document.getElementById('codeEditor').value;
  if (!code.trim()) { toastMsg('Chưa có code để sao chép'); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(code);
    } else {
      throw new Error('clipboard API không khả dụng');
    }
    toastMsg('Đã sao chép code');
  } catch (err) {
    // Fallback cho WebView không cấp quyền Clipboard API / không phải HTTPS: dùng textarea ẩn + execCommand.
    try {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toastMsg(ok ? 'Đã sao chép code' : 'Không thể sao chép — hãy chọn & copy thủ công');
    } catch (err2) {
      console.error('codeCopyBtn fallback error:', err2);
      toastMsg('Không thể sao chép — hãy chọn & copy thủ công');
    }
  }
});

document.getElementById('codeDownloadBtn').addEventListener('click', () => {
  const code = document.getElementById('codeEditor').value;
  if (!code.trim()) { toastMsg('Chưa có code để tải xuống'); return; }
  try {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'code.txt';
    // Nhiều WebView (app nhúng) cần thẻ <a> thực sự nằm trong DOM mới cho phép click tải xuống.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toastMsg('Đang tải code.txt...');
  } catch (err) {
    console.error('codeDownloadBtn error:', err);
    // Fallback cuối: mở nội dung trong tab mới để người dùng tự lưu bằng "Lưu trang" của trình duyệt.
    try {
      const win = window.open('', '_blank');
      if (win) {
        win.document.write('<pre style="white-space:pre-wrap;word-break:break-word;font-family:monospace;padding:16px">' +
          code.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>');
        toastMsg('Trình duyệt chặn tải file — đã mở code ở tab mới, tự lưu lại nhé');
      } else {
        toastMsg('Không thể tải xuống trong app này — hãy mở Velocitix bằng trình duyệt (Chrome) rồi thử lại');
      }
    } catch (err2) {
      console.error('codeDownloadBtn fallback error:', err2);
      toastMsg('Không thể tải xuống trong app này');
    }
  }
});

// ---- Sandbox Preview cho Code Editor (khung dưới) — chạy trực tiếp HTML/CSS/JS trong iframe cô lập ----
function refreshCodePreview() {
  try {
    const code = document.getElementById('codeEditor').value;
    const frame = document.getElementById('codePreviewFrame');
    frame.srcdoc = code.trim()
      ? code
      : '<p style="font-family:sans-serif;padding:20px;color:#888">Chưa có code để chạy thử. Viết/dán code HTML ở tab Code rồi quay lại đây.</p>';
  } catch (err) {
    console.error('refreshCodePreview error:', err);
  }
}
document.querySelectorAll('.code-editor-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    try {
      document.querySelectorAll('.code-editor-tab').forEach(b => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.ctab;
      document.getElementById('codeEditView').classList.toggle('active', tab === 'edit');
      document.getElementById('codePreviewView').classList.toggle('active', tab === 'preview');
      if (tab === 'preview') refreshCodePreview();
    } catch (err) {
      console.error('code-editor-tab click error:', err);
    }
  });
});

// ===================== VOICE (turn-based) =====================
let voiceRecorder, voiceChunks = [];
const voiceBtn = document.getElementById('voiceBigBtn');
const voiceStatus = document.getElementById('voiceStatus');
const voiceTranscript = document.getElementById('voiceTranscript');
const voiceAudio = document.getElementById('voiceAudioPlayer');

voiceBtn.addEventListener('click', async () => {
  if (voiceBtn.classList.contains('recording')) {
    voiceRecorder.stop();
    voiceBtn.classList.remove('recording');
    voiceStatus.textContent = 'Đang xử lý...';
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  voiceChunks = [];
  voiceRecorder = new MediaRecorder(stream);
  voiceRecorder.ondataavailable = e => voiceChunks.push(e.data);
  voiceRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(voiceChunks, { type: 'audio/webm' });
    const base64 = await blobToBase64(blob);

    const userLine = document.createElement('div');
    userLine.className = 'log-line';
    userLine.textContent = '🎤 Bạn: ⏳ đang nhận diện giọng nói...';
    voiceTranscript.appendChild(userLine);

    // ⚠️ FIX "voice giờ sẽ hiện lời kèm lời nói": trước đây chỉ hiện placeholder cố định
    // "(đoạn ghi âm)" cho phần người dùng nói — giờ yêu cầu AI TỰ phiên âm lại đúng câu người
    // dùng vừa nói ở dòng đầu tiên (đánh dấu bằng "BẠN_NÓI:"), rồi mới đến câu trả lời — để cả
    // lời người dùng LẪN lời AI đều hiện thành chữ song song với giọng nói.
    let full = '';
    await streamPost(API_BASE + '/api/chat/stream', {
      messages: [{ role: 'user', parts: [{ text: 'Hãy nghe đoạn ghi âm sau và trả lời.' }] }],
      model: 'auto', thinking: false, webSearch: false,
      systemInstruction: 'Nghe đoạn ghi âm. Dòng đầu tiên BẮT BUỘC viết đúng theo định dạng '
        + '"BẠN_NÓI: <phiên âm lại chính xác những gì người dùng vừa nói>" — không thêm gì khác vào dòng này. '
        + 'Từ dòng thứ hai trở đi, trả lời ngắn gọn, tự nhiên như đang trò chuyện bằng giọng nói. Tiếng Việt.',
      attachments: [{ mimeType: 'audio/webm', base64 }],
    }, {
      chunk: t => { full += t; },
      done: async () => {
        let userText = '(không nhận diện được)', replyText = full;
        const m = full.match(/^BẠN_NÓI:\s*(.*?)\n([\s\S]*)$/i);
        if (m) { userText = m[1].trim(); replyText = m[2].trim(); }
        userLine.textContent = '🎤 Bạn: ' + userText;
        const reply = document.createElement('div');
        reply.className = 'log-line';
        reply.textContent = '🤖 AI: ' + replyText;
        voiceTranscript.appendChild(reply);
        voiceTranscript.scrollTop = voiceTranscript.scrollHeight;
        voiceStatus.textContent = 'Đang tạo giọng nói...';
        // Dùng chung speakText() để tôn trọng đúng engine (Gemini/trình duyệt), giọng và tốc độ
        // đã chọn ở Settings, kèm tự fallback sang giọng trình duyệt nếu Gemini lỗi/hết quota.
        // Chữ (replyText) đã hiện SẴN ở trên trước khi audio phát — đúng yêu cầu "hiện lời kèm lời nói".
        speakText(replyText, null, {
          audioEl: voiceAudio,
          onEnd: () => { voiceStatus.textContent = 'Nhấn để nói tiếp'; },
        });
      },
      error: e => { userLine.textContent = '🎤 Bạn: (đoạn ghi âm)'; voiceStatus.textContent = '⚠️ Lỗi: ' + e; },
    });
  };
  voiceRecorder.start();
  voiceBtn.classList.add('recording');
  voiceStatus.textContent = 'Đang nghe... nhấn lại để dừng';
});
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

// ===================== DEEP RESEARCH (widget thu gọn — dùng chung cho Chat & Agent Mode) =====================
// Không còn là 1 trang riêng nữa. Mặc định thu gọn thành 1 dải nhỏ "🔎 Deep Research".
// Bấm vào dải đó để xem AI đang làm gì; vuốt xuống trên phần mở rộng để ẩn lại; và nó sẽ
// TỰ thu gọn ngay khi có kết quả cuối cùng được đưa ra Chat / Agent Log.
function setupResearchWidget(key) {
  const pill = document.getElementById('researchPill-' + key);
  const body = document.getElementById('researchBody-' + key);
  if (!pill || !body) return;
  pill.addEventListener('click', () => body.classList.toggle('hidden'));
  let startY = 0, tracking = false;
  body.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; tracking = true; }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dy = e.changedTouches[0].clientY - startY;
    // Vuốt xuống rõ ràng trên phần mở rộng -> ẩn lại (không cần bấm lại dải nhỏ)
    if (dy > 60) body.classList.add('hidden');
  }, { passive: true });
}
setupResearchWidget('chat');
setupResearchWidget('agent');

// currentResearchAbort riêng biệt với currentStreamAbort (chat) vì deep research chạy trong widget
// độc lập, không đi qua nút Gửi/Dừng chính — nó có nút dừng riêng ngay trên widget.
let currentResearchAbort = null;
function runResearchInWidget(key, query, { onDone } = {}) {
  const widget = document.getElementById('researchWidget-' + key);
  const body = document.getElementById('researchBody-' + key);
  const stateEl = document.getElementById('researchState-' + key);
  widget.classList.remove('hidden');
  body.classList.remove('hidden');
  body.innerHTML = '';
  stateEl.textContent = '· ⏳ đang chạy...';
  let finalReport = '';

  const abortCtrl = new AbortController();
  currentResearchAbort = abortCtrl;
  const stopBtn = document.getElementById('researchStopBtn-' + key);
  stopBtn?.classList.remove('hidden');

  streamPost(API_BASE + '/api/search/deep-research', { query }, {
    progress: (t) => addLog(body, '⏳ ' + t),
    plan: (arr) => addLog(body, '📋 Kế hoạch: ' + arr.join(' | ')),
    finding: (f) => addLog(body, `🔍 ${f.question}\n${f.answer}`),
    report: (r) => { finalReport = r; addLog(body, '📄 Báo cáo:\n' + r, true); },
    error: (e) => { addLog(body, '⚠️ Lỗi: ' + e); stateEl.textContent = '· ⚠️ lỗi'; stopBtn?.classList.add('hidden'); onDone?.(null); },
    aborted: () => {
      stateEl.textContent = '· ⏹️ đã dừng';
      stopBtn?.classList.add('hidden');
      currentResearchAbort = null;
      // Vẫn đưa những gì đã thu thập được ra ngoài (báo cáo có thể chưa hoàn chỉnh) thay vì mất trắng.
      onDone?.(finalReport || null);
    },
    done: () => {
      stopBtn?.classList.add('hidden');
      currentResearchAbort = null;
      if (finalReport) {
        stateEl.textContent = '· ✅ xong · bấm để xem lại';
        // Kết quả đã được đưa ra Chat/Agent Log -> tự thu gọn widget lại
        setTimeout(() => body.classList.add('hidden'), 300);
        onDone?.(finalReport);
      }
    },
  }, abortCtrl.signal);
}
// Nút dừng riêng cho mỗi widget (chat / agent) — bấm là huỷ ngay request deep research đang chạy.
document.getElementById('researchStopBtn-chat')?.addEventListener('click', (e) => { e.stopPropagation(); currentResearchAbort?.abort(); });
document.getElementById('researchStopBtn-agent')?.addEventListener('click', (e) => { e.stopPropagation(); currentResearchAbort?.abort(); });

// ===================== AGENT MODE =====================
// KHÁC Deep Research: đây là agent đa công cụ (tìm web, đọc trang, lưu file, và khi cần THAO TÁC
// thật trên trang thì tự mở trình duyệt thật ngay trong panel này — luôn xin phép trước hành động
// nhạy cảm). Deep Research (widget riêng ở trên) chỉ đọc/tổng hợp, không đụng vào trang.
const agentModeState = { currentTaskId: null };

function agentModeShowBrowser(screenshot, url) {
  const wrap = document.getElementById('agentInlineBrowserWrap');
  const img = document.getElementById('agentInlineBrowserScreen');
  const urlEl = document.getElementById('agentInlineBrowserUrl');
  wrap.classList.remove('hidden');
  if (screenshot) img.src = screenshot;
  if (url) urlEl.textContent = url;
}

function agentModeSetApproval(action) {
  const bar = document.getElementById('agentInlineApprovalBar');
  const text = document.getElementById('agentInlineApprovalText');
  if (!action) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const desc = action.type === 'goto' ? `mở trang ${action.url}`
    : action.type === 'click' ? `bấm vào "${action.selectorText || action.selector}"`
    : action.type === 'fill' ? `điền dữ liệu vào ô "${action.selector}"`
    : `thực hiện hành động "${action.type}"`;
  text.textContent = `⚠️ Agent muốn ${desc} — hành động này có thể ảnh hưởng dữ liệu thật. Cho phép?`;
}

function agentModeHandleStream(log, runBtn) {
  return {
    started: (d) => { agentModeState.currentTaskId = d.taskId; },
    thought: (t) => t && addLog(log, '💭 ' + t),
    tool_start: (d) => addLog(log, '▶️ Đang dùng công cụ: ' + d.tool),
    tool_result: (d) => {
      if (d.error) return addLog(log, '⚠️ ' + d.tool + ': ' + d.error);
      if (d.tool === 'save_file') return addLog(log, '💾 Đã lưu file: ' + (d.file?.key || ''));
      addLog(log, `✅ Kết quả (${d.tool}):\n` + (d.text || ''));
    },
    browser_thought: (t) => t && addLog(log, '🌍💭 ' + t),
    browser_screenshot: (d) => agentModeShowBrowser(d.screenshot, d.url),
    needsApproval: (d) => {
      agentModeSetApproval(d.action);
      addLog(log, '⏸️ Agent đang chờ bạn xác nhận 1 hành động trên trình duyệt.');
      runBtn.disabled = false;
    },
    final: (text) => addLog(log, '🏁 Kết quả cuối cùng:\n' + (text || '⚠️ Không có kết quả.'), true),
    error: (e) => addLog(log, '⚠️ Lỗi: ' + e),
    done: () => {
      runBtn.disabled = false;
      document.getElementById('agentInlineBrowserWrap').classList.add('hidden');
      agentModeSetApproval(null);
      agentModeState.currentTaskId = null;
    },
  };
}

document.getElementById('agentRunBtn').addEventListener('click', () => {
  const taskInput = document.getElementById('agentTask');
  const task = taskInput.value.trim();
  if (!task) return;
  taskInput.value = '';
  const log = document.getElementById('agentLog');
  const runBtn = document.getElementById('agentRunBtn');
  runBtn.disabled = true;
  addLog(log, '🧭 Nhiệm vụ: ' + task);
  streamPost(API_BASE + '/api/agent/run', { task }, agentModeHandleStream(log, runBtn));
});

document.getElementById('agentInlineApproveBtn').addEventListener('click', () => {
  if (!agentModeState.currentTaskId) return;
  const log = document.getElementById('agentLog');
  const runBtn = document.getElementById('agentRunBtn');
  agentModeSetApproval(null);
  addLog(log, '✅ Đã cho phép — Agent tiếp tục...');
  streamPost(API_BASE + `/api/agent/${agentModeState.currentTaskId}/resume`, { approve: true }, agentModeHandleStream(log, runBtn));
});

document.getElementById('agentInlineRejectBtn').addEventListener('click', () => {
  if (!agentModeState.currentTaskId) return;
  const log = document.getElementById('agentLog');
  const runBtn = document.getElementById('agentRunBtn');
  agentModeSetApproval(null);
  addLog(log, '❌ Đã từ chối — Agent sẽ thử cách khác.');
  streamPost(API_BASE + `/api/agent/${agentModeState.currentTaskId}/resume`, { approve: false }, agentModeHandleStream(log, runBtn));
});

// ===================== DEEP RESEARCH TỪ CHAT =====================
// Bật bằng toggle trong sheet "＋" (rõ ràng, có trạng thái bật/tắt hẳn hoi — trước đây chỉ là
// 1 nút bấm mù mờ, đổi mỗi placeholder ô nhập nên rất dễ bị bỏ sót không biết đang bật/tắt).
// Khi bật: hiện chip "🔎 Deep Research đang bật" ngay trên ô nhập, có nút ✕ tắt nhanh không cần
// mở lại sheet. Gõ chủ đề vào ô chat -> gửi như bình thường -> tự tắt lại sau khi gửi xong.
function setDeepResearchMode(on) {
  state.deepResearchMode = on;
  document.getElementById('deepResearchToggle').checked = on;
  document.getElementById('deepResearchChip')?.classList.toggle('hidden', !on);
  els.chatInput.placeholder = on ? '🔎 Nhập chủ đề muốn Deep Research...' : 'Nhắn gì đó cho Velocitix AI...';
}
document.getElementById('deepResearchToggle').addEventListener('change', (e) => {
  setDeepResearchMode(e.target.checked);
  if (e.target.checked) { closeSheet(attachSheet, attachBackdrop); els.chatInput.focus(); }
});
document.getElementById('deepResearchChipOff')?.addEventListener('click', () => setDeepResearchMode(false));
async function runDeepResearchAsChatMessage(query) {
  const label = '🔎 Deep Research: ' + query;
  const index = state.history.length;
  appendMsgToDOM('user', label, null, index);
  state.history.push({ role: 'user', text: label });
  saveHistory();
  if (!state.temp) {
    await ensureConversation(query);
    if (state.conversationId) saveMessageToServer('user', label);
  }
  runResearchInWidget('chat', query, {
    onDone: (finalReport) => {
      const idx2 = state.history.length;
      const text = finalReport || '⚠️ Không có kết quả.';
      appendMsgToDOM('assistant', text, null, idx2);
      state.history.push({ role: 'assistant', text });
      saveHistory();
      if (!state.temp && state.conversationId) {
        saveMessageToServer('assistant', text);
        if (state.history.length === 2) autoTitleConversation(state.conversationId, query, text);
      }
    },
  });
}

function addLog(container, text, isReport) {
  const div = document.createElement('div');
  div.className = 'log-line' + (isReport ? ' report' : '');
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Nếu đây là báo cáo cuối cùng và chứa 1 khối code đáng kể, tự tạo Artifact để xem/preview lại
  if (isReport) {
    const info = extractArtifactFromText(text);
    if (info) {
      const artifact = ArtifactStore.add({ title: text.slice(0, 60).replace(/\s+/g, ' '), code: info.code, source: 'agent' });
      container.appendChild(artifactCardEl(artifact));
    }
  }
}

// browse URL + ask
// ===================== ĐÃ XOÁ GẦN ĐÂY (soft-delete, 7 ngày) =====================
const trashEls = {
  list: document.getElementById('trashList'),
  refreshBtn: document.getElementById('trashRefreshBtn'),
};

function trashItemEl(conv) {
  const div = document.createElement('div');
  div.className = 'trash-item';
  const daysLeft = Number.isFinite(conv.days_left) ? conv.days_left : '?';
  div.innerHTML = `
    <div class="trash-item-info">
      <span class="conv-title">${conv.title || 'Cuộc trò chuyện'}</span>
      <span class="trash-days-left">Còn ${daysLeft} ngày trước khi xoá vĩnh viễn</span>
    </div>
    <span class="conv-actions">
      <button class="trash-restore" title="Khôi phục">↩️ Khôi phục</button>
      <button class="trash-purge" title="Xoá vĩnh viễn ngay">🗑️ Xoá hẳn</button>
    </span>`;
  div.querySelector('.trash-restore').addEventListener('click', async () => {
    await apiFetch(API_BASE + `/api/conversations/${conv.id}/restore`, { method: 'POST' });
    loadTrash();
    loadConversations();
  });
  div.querySelector('.trash-purge').addEventListener('click', async () => {
    if (!confirm('Xoá VĨNH VIỄN hội thoại này? Không thể hoàn tác.')) return;
    await apiFetch(API_BASE + `/api/conversations/${conv.id}/purge`, { method: 'DELETE' });
    loadTrash();
  });
  return div;
}

async function loadTrash() {
  if (!trashEls.list) return;
  trashEls.list.innerHTML = '<p class="hint">Đang tải...</p>';
  try {
    const r = await apiFetch(API_BASE + '/api/conversations/trash');
    const list = await r.json();
    if (!Array.isArray(list)) { trashEls.list.innerHTML = '<p class="hint">D1 chưa được cấu hình.</p>'; return; }
    trashEls.list.innerHTML = '';
    if (!list.length) { trashEls.list.innerHTML = '<p class="hint">Thùng rác trống.</p>'; return; }
    list.forEach(c => trashEls.list.appendChild(trashItemEl(c)));
  } catch (e) {
    trashEls.list.innerHTML = '<p class="hint">Không tải được — kiểm tra kết nối backend.</p>';
  }
}
trashEls.refreshBtn?.addEventListener('click', loadTrash);
// Tự tải khi mở panel Cài đặt
document.querySelector('.nav-btn[data-mode="settings"]')?.addEventListener('click', loadTrash);

// ===================== API KEY (gắn Velocitix AI vào file HTML/app ngoài) =====================
async function loadApiKey() {
  const input = document.getElementById('apiKeyDisplay');
  const msg = document.getElementById('apiKeyMsg');
  if (!input) return;
  input.value = '';
  input.placeholder = 'Đang tải...';
  if (msg) msg.textContent = '';
  try {
    const r = await apiFetch(API_BASE + '/api/apikey');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi tải API key');
    input.value = data.apiKey || '';
  } catch (e) {
    input.placeholder = 'Không tải được (kiểm tra đăng nhập / kết nối backend)';
  }
}
document.querySelector('.nav-btn[data-mode="settings"]')?.addEventListener('click', loadApiKey);

document.getElementById('copyApiKeyBtn')?.addEventListener('click', (e) => {
  const input = document.getElementById('apiKeyDisplay');
  if (!input?.value) return;
  navigator.clipboard?.writeText(input.value);
  const btn = e.currentTarget;
  const original = btn.textContent;
  btn.textContent = '✅ Đã chép';
  setTimeout(() => btn.textContent = original, 1500);
});

document.getElementById('regenApiKeyBtn')?.addEventListener('click', async () => {
  if (!confirm('Key cũ sẽ ngừng hoạt động ngay. File HTML/app nào đang dùng key cũ sẽ phải cập nhật lại. Tiếp tục?')) return;
  const msg = document.getElementById('apiKeyMsg');
  try {
    const r = await apiFetch(API_BASE + '/api/apikey/regenerate', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi tạo key mới');
    document.getElementById('apiKeyDisplay').value = data.apiKey || '';
    if (msg) msg.textContent = '✅ Đã tạo key mới.';
  } catch (e) {
    if (msg) msg.textContent = '⚠️ ' + e.message;
  }
});

// ---- Test nhanh + xuất code gắn AI ngay trong panel Cài đặt (không cần file HTML riêng) ----
document.getElementById('apiKeyTestSendBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const apiKey = document.getElementById('apiKeyDisplay')?.value?.trim();
  const prompt = document.getElementById('apiKeyTestPrompt')?.value?.trim();
  const out = document.getElementById('apiKeyTestResult');
  if (!out) return;
  out.style.display = 'block';
  if (!apiKey) { out.textContent = '⚠️ Chưa có API key (đợi tải xong ở trên).'; return; }
  if (!prompt) { out.textContent = '⚠️ Nhập câu hỏi để test.'; return; }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Đang gửi...';
  out.textContent = 'Đang chờ AI trả lời...';
  try {
    const r = await fetch(API_BASE + '/api/external/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ prompt }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('Lỗi HTTP ' + r.status));
    out.textContent = data.text || JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('apiKeyGenSnippetBtn')?.addEventListener('click', () => {
  const apiKey = document.getElementById('apiKeyDisplay')?.value?.trim();
  const box = document.getElementById('apiKeySnippetBox');
  const code = document.getElementById('apiKeySnippetCode');
  if (!box || !code) return;
  if (!apiKey) { alert('Chưa có API key (đợi tải xong ở trên).'); return; }

  code.textContent =
`<script>
async function askVelocitix(prompt) {
  const r = await fetch('${API_BASE}/api/external/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': '${apiKey}' },
    body: JSON.stringify({ prompt })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Lỗi gọi Velocitix AI');
  return data.text;
}
<\/script>`;

  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('apiKeyCopySnippetBtn')?.addEventListener('click', (e) => {
  const code = document.getElementById('apiKeySnippetCode')?.textContent;
  if (!code) return;
  navigator.clipboard?.writeText(code);
  const btn = e.currentTarget;
  const original = btn.textContent;
  btn.textContent = '✅ Đã copy';
  setTimeout(() => btn.textContent = original, 1500);
});

// ===================== AGENT MODE: điều khiển trình duyệt THẬT (Playwright ở backend) =====================
// Luồng: tạo 1 phiên trình duyệt thật trên server -> vòng lặp gọi /step để AI tự nhìn screenshot +
// nội dung trang và quyết định hành động tiếp theo -> nếu hành động nhạy cảm, dừng lại chờ người
// dùng bấm Cho phép/Từ chối -> lặp lại tới khi agent báo done hoặc người dùng bấm Dừng.
const agentBrowserState = {
  sessionId: null,
  running: false,
  stopRequested: false,
};

// Ghi chú: "Trình duyệt thật" giờ là 1 TAB CON bên trong Agent Mode (panel-agent, agentView-browser),
// đã gộp chung với tab "Tự động" — không còn là mục riêng ngoài sidebar nữa (xem setup chuyển tab
// .agent-tab-btn[data-agent-tab] phía trên).

function agentBrowserAddLog(text) {
  const log = document.getElementById('agentBrowserLog');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function agentBrowserShowScreenshot(dataUrl) {
  const img = document.getElementById('agentBrowserScreen');
  const emptyHint = document.getElementById('agentBrowserEmptyHint');
  if (!dataUrl) return;
  img.src = dataUrl;
  img.classList.add('has-image');
  emptyHint.style.display = 'none';
}

function agentBrowserUpdateUrl(url) {
  document.getElementById('agentBrowserUrl').textContent = url || 'Chưa mở phiên nào';
}

// Điều hướng THẲNG tới URL người dùng nhập — dùng /act (không qua AI quyết định), nên chạy ngay lập
// tức và dùng được cả khi chưa có phiên (tự tạo) lẫn khi phiên đang có sẵn (điều hướng sang trang khác).
// Đây là cách để bạn "điều khiển trang web mình muốn" thay vì phải chờ agent tự chọn.
async function agentBrowserGotoUrl(url) {
  if (!url) return;
  const normalized = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  try {
    if (!agentBrowserState.sessionId) {
      await agentBrowserEnsureSession(normalized);
      return;
    }
    agentBrowserAddLog('↪ Đang đi tới: ' + normalized);
    const r = await apiFetch(API_BASE + `/api/agent-browser/${agentBrowserState.sessionId}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: { type: 'goto', url: normalized } }),
    });
    const data = await r.json();
    if (data.error) { agentBrowserAddLog('⚠️ ' + data.error); return; }
    if (data.screenshot) agentBrowserShowScreenshot(data.screenshot);
    agentBrowserUpdateUrl(data.url || normalized);
    agentBrowserAddLog('✅ Đã mở: ' + (data.url || normalized));
  } catch (e) {
    agentBrowserAddLog('⚠️ Lỗi: ' + e.message);
  }
}

document.getElementById('agentBrowserGotoBtn').addEventListener('click', () => {
  const url = document.getElementById('agentBrowserStartUrl').value.trim();
  agentBrowserGotoUrl(url);
});

function agentBrowserSetApprovalUI(pendingAction) {
  const bar = document.getElementById('agentApprovalBar');
  const text = document.getElementById('agentApprovalText');
  if (!pendingAction) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const desc = pendingAction.type === 'goto' ? `mở trang ${pendingAction.url}`
    : pendingAction.type === 'click' ? `bấm vào "${pendingAction.selectorText || pendingAction.selector}"`
    : pendingAction.type === 'fill' ? `điền dữ liệu vào ô "${pendingAction.selector}"`
    : `thực hiện hành động "${pendingAction.type}"`;
  text.textContent = `⚠️ Agent muốn ${desc} — hành động này có thể ảnh hưởng dữ liệu thật. Cho phép?`;
}

async function agentBrowserEnsureSession(startUrl) {
  if (agentBrowserState.sessionId) return agentBrowserState.sessionId;
  agentBrowserAddLog('🧭 Đang mở phiên trình duyệt thật trên server...');
  const r = await apiFetch(API_BASE + '/api/agent-browser/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: startUrl || undefined }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  agentBrowserState.sessionId = data.id;
  agentBrowserShowScreenshot(data.screenshot);
  agentBrowserUpdateUrl(data.url);
  agentBrowserAddLog('✅ Đã mở phiên: ' + data.id);
  return data.id;
}

// Một bước của agent: gọi /step, xử lý kết quả (done / cần xin phép / đã chạy xong 1 hành động)
async function agentBrowserRunLoop(task) {
  agentBrowserState.running = true;
  agentBrowserState.stopRequested = false;
  document.getElementById('agentBrowserStopBtn').classList.remove('hidden');
  document.getElementById('agentBrowserRunBtn').disabled = true;

  let steps = 0;
  const MAX_STEPS = 25; // chặn vòng lặp vô hạn nếu agent không bao giờ báo done
  try {
    while (agentBrowserState.running && !agentBrowserState.stopRequested && steps < MAX_STEPS) {
      steps++;
      const r = await apiFetch(API_BASE + `/api/agent-browser/${agentBrowserState.sessionId}/step`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task }),
      });
      const data = await r.json();
      if (data.error) { agentBrowserAddLog('⚠️ Lỗi: ' + data.error); break; }

      if (data.thought) agentBrowserAddLog('💭 ' + data.thought);
      if (data.screenshot) agentBrowserShowScreenshot(data.screenshot);
      if (data.url) agentBrowserUpdateUrl(data.url);

      if (data.done) {
        agentBrowserAddLog('✅ Hoàn thành:\n' + (data.finalAnswer || '(không có câu trả lời cụ thể)'));
        break;
      }

      if (data.needsApproval) {
        agentBrowserAddLog('⏸️ Đang chờ bạn xác nhận hành động: ' + JSON.stringify(data.action));
        agentBrowserSetApprovalUI(data.action);
        // Dừng vòng lặp tại đây — sẽ được resume lại từ nút Cho phép/Từ chối bên dưới.
        agentBrowserState.pendingTask = task;
        return;
      } else {
        agentBrowserAddLog('▶️ Đã thực hiện: ' + (data.action?.type || '?'));
      }
    }
    if (steps >= MAX_STEPS) agentBrowserAddLog('⚠️ Đã dừng: agent chạy quá nhiều bước (giới hạn an toàn).');
  } catch (e) {
    agentBrowserAddLog('⚠️ Lỗi: ' + e.message);
  } finally {
    agentBrowserState.running = false;
    document.getElementById('agentBrowserStopBtn').classList.add('hidden');
    document.getElementById('agentBrowserRunBtn').disabled = false;
  }
}

document.getElementById('agentBrowserRunBtn').addEventListener('click', async () => {
  const taskInput = document.getElementById('agentBrowserTask');
  const task = taskInput.value.trim();
  const startUrl = document.getElementById('agentBrowserStartUrl').value.trim();
  if (!task) return;
  taskInput.value = '';
  try {
    await agentBrowserEnsureSession(startUrl);
    await agentBrowserRunLoop(task);
  } catch (e) {
    agentBrowserAddLog('⚠️ Lỗi: ' + e.message);
  }
});

document.getElementById('agentBrowserStopBtn').addEventListener('click', () => {
  agentBrowserState.stopRequested = true;
  agentBrowserAddLog('⏹️ Đã yêu cầu dừng agent.');
});

document.getElementById('agentApproveBtn').addEventListener('click', async () => {
  if (!agentBrowserState.sessionId) return;
  agentBrowserSetApprovalUI(null);
  agentBrowserAddLog('✅ Đã cho phép — đang thực hiện...');
  try {
    const r = await apiFetch(API_BASE + `/api/agent-browser/${agentBrowserState.sessionId}/approve`, { method: 'POST' });
    const data = await r.json();
    if (data.error) { agentBrowserAddLog('⚠️ ' + data.error); return; }
    if (data.screenshot) agentBrowserShowScreenshot(data.screenshot);
    if (data.url) agentBrowserUpdateUrl(data.url);
    // Tiếp tục vòng lặp agent với nhiệm vụ cũ
    if (agentBrowserState.pendingTask) await agentBrowserRunLoop(agentBrowserState.pendingTask);
  } catch (e) { agentBrowserAddLog('⚠️ Lỗi: ' + e.message); }
});

document.getElementById('agentRejectBtn').addEventListener('click', async () => {
  if (!agentBrowserState.sessionId) return;
  agentBrowserSetApprovalUI(null);
  agentBrowserAddLog('❌ Đã từ chối hành động. Agent dừng lại — bạn có thể giao nhiệm vụ khác hoặc tiếp tục thủ công.');
  try {
    await apiFetch(API_BASE + `/api/agent-browser/${agentBrowserState.sessionId}/reject`, { method: 'POST' });
  } catch (e) { agentBrowserAddLog('⚠️ Lỗi: ' + e.message); }
});

document.getElementById('agentCloseSessionBtn').addEventListener('click', async () => {
  if (!agentBrowserState.sessionId) return;
  if (!confirm('Đóng phiên trình duyệt agent đang mở?')) return;
  try {
    await apiFetch(API_BASE + `/api/agent-browser/${agentBrowserState.sessionId}`, { method: 'DELETE' });
  } catch {}
  agentBrowserState.sessionId = null;
  agentBrowserState.pendingTask = null;
  agentBrowserSetApprovalUI(null);
  document.getElementById('agentBrowserScreen').classList.remove('has-image');
  document.getElementById('agentBrowserEmptyHint').style.display = '';
  agentBrowserUpdateUrl(null);
  agentBrowserAddLog('🔒 Đã đóng phiên trình duyệt.');
});

// Mở đúng URL agent đang xem trong 1 tab trình duyệt thật của người dùng (không phải server)
document.getElementById('agentOpenTabBtn').addEventListener('click', async () => {
  if (!agentBrowserState.sessionId) { agentBrowserAddLog('⚠️ Chưa có phiên nào đang mở.'); return; }
  try {
    const r = await apiFetch(API_BASE + `/api/agent-browser/${agentBrowserState.sessionId}/state`);
    const data = await r.json();
    if (data.url) window.open(data.url, '_blank', 'noopener');
  } catch (e) { agentBrowserAddLog('⚠️ Lỗi: ' + e.message); }
});

// ===================== SETTINGS: TUỲ CHỈNH GIỌNG NÓI AI (TTS) =====================
// 8 giọng prebuilt cố định của Gemini TTS (gemini-3.1-flash-tts-preview) — đây là toàn bộ
// danh sách Google công bố, API không có endpoint liệt kê động nên phải khai cứng ở đây.
// Nguồn: https://ai.google.dev/gemini-api/docs/speech-generation
const GEMINI_VOICES = [
  { name: 'Kore', desc: 'Nữ, chắc chắn, rõ ràng' },
  { name: 'Puck', desc: 'Nam, tươi vui, năng động' },
  { name: 'Charon', desc: 'Nam, trầm, thông tin' },
  { name: 'Fenrir', desc: 'Nam, mạnh mẽ, dứt khoát' },
  { name: 'Aoede', desc: 'Nữ, nhẹ nhàng, du dương' },
  { name: 'Leda', desc: 'Nữ, trẻ trung' },
  { name: 'Orus', desc: 'Nam, vững chãi' },
  { name: 'Zephyr', desc: 'Nữ, sáng, thân thiện' },
];

const ttsEls = {
  engineToggle: document.getElementById('ttsEngineToggle'),
  geminiSection: document.getElementById('geminiVoiceSection'),
  geminiGrid: document.getElementById('geminiVoiceGrid'),
  browserSection: document.getElementById('browserVoiceSection'),
  voiceSelect: document.getElementById('ttsVoiceSelect'),
  rateRange: document.getElementById('ttsRateRange'),
  rateLabel: document.getElementById('ttsRateLabel'),
};

function renderGeminiVoiceGrid() {
  if (!ttsEls.geminiGrid) return;
  const selected = localStorage.getItem('myai_gemini_voice') || 'Kore';
  ttsEls.geminiGrid.innerHTML = '';
  GEMINI_VOICES.forEach(v => {
    const card = document.createElement('div');
    card.className = 'tts-voice-card' + (v.name === selected ? ' selected' : '');
    card.innerHTML = `
      <div class="tts-voice-info">
        <span class="tts-voice-name">${v.name}</span>
        <span class="tts-voice-desc">${v.desc}</span>
      </div>
      <button class="tts-voice-play" title="Nghe thử giọng ${v.name}">▶</button>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.tts-voice-play')) return;
      localStorage.setItem('myai_gemini_voice', v.name);
      renderGeminiVoiceGrid();
    });
    card.querySelector('.tts-voice-play').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const original = btn.textContent;
      btn.textContent = '⏳';
      btn.disabled = true;
      try {
        const r = await fetch(API_BASE + '/api/tts/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Xin chào, đây là giọng ${v.name} của Gemini.`, voice: v.name }),
        });
        const data = await r.json();
        if (!r.ok || !data.base64) throw new Error(data.error?.message || data.error || 'Lỗi TTS');
        const blob = pcmBase64ToWavBlob(data.base64, 24000);
        const audio = new Audio(URL.createObjectURL(blob));
        await audio.play();
      } catch (err) {
        alert('⚠️ Không nghe thử được: ' + err.message + '\n(Kiểm tra GEMINI_API_KEY trong .env)');
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });
    ttsEls.geminiGrid.appendChild(card);
  });
}
renderGeminiVoiceGrid();

function updateTtsEngineUI() {
  const useGemini = ttsEls.engineToggle?.checked;
  ttsEls.geminiSection?.classList.toggle('hidden', !useGemini);
  ttsEls.browserSection?.classList.toggle('hidden', useGemini);
}
if (ttsEls.engineToggle) {
  ttsEls.engineToggle.checked = localStorage.getItem('myai_tts_engine') !== 'browser';
  updateTtsEngineUI();
  ttsEls.engineToggle.addEventListener('change', () => {
    localStorage.setItem('myai_tts_engine', ttsEls.engineToggle.checked ? 'gemini' : 'browser');
    updateTtsEngineUI();
  });
}

function populateVoiceList() {
  if (typeof window.speechSynthesis === 'undefined' || !window.speechSynthesis || !ttsEls.voiceSelect) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return; // sẽ được gọi lại qua onvoiceschanged
  const savedVoice = localStorage.getItem('myai_browser_voice');
  ttsEls.voiceSelect.innerHTML = '<option value="">Mặc định trình duyệt</option>' +
    voices.map(v => `<option value="${v.name}" ${v.name === savedVoice ? 'selected' : ''}>${v.name} (${v.lang})</option>`).join('');
}
if (typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis) {
  populateVoiceList();
  window.speechSynthesis.onvoiceschanged = populateVoiceList;
}
ttsEls.voiceSelect?.addEventListener('change', () => {
  const v = ttsEls.voiceSelect.value;
  if (v) {
    localStorage.setItem('myai_browser_voice', v);
    const voice = window.speechSynthesis.getVoices().find(x => x.name === v);
    if (voice) localStorage.setItem('myai_tts_lang', voice.lang);
  } else {
    localStorage.removeItem('myai_browser_voice');
  }
});
const savedRate = localStorage.getItem('myai_tts_rate') || '1';
if (ttsEls.rateRange) { ttsEls.rateRange.value = savedRate; ttsEls.rateLabel.textContent = Number(savedRate).toFixed(1) + 'x'; }
ttsEls.rateRange?.addEventListener('input', () => {
  ttsEls.rateLabel.textContent = Number(ttsEls.rateRange.value).toFixed(1) + 'x';
  localStorage.setItem('myai_tts_rate', ttsEls.rateRange.value);
});

// init — bọc try/catch để nếu có lỗi (vd. mạng chậm khi F5), các nút/chức năng khác
// đã gắn listener ở phía trên vẫn hoạt động bình thường thay vì bị "đơ" toàn bộ.
try {
  if (state.conversationId) selectConversation(state.conversationId);
  switchMode('chat');
} catch (e) {
  console.error('[Velocitix AI] Lỗi khởi tạo:', e);
  try { switchMode('chat'); } catch (_) {}
}
