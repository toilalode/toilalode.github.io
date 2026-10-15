// ===================== TÌM KIẾM NGỮ NGHĨA THEO TỪNG CHAT =====================
// Nạp SAU app.js. Trước đây ô tìm kiếm luôn tìm trong TOÀN BỘ lịch sử, dù server đã hỗ trợ lọc theo
// conversationId. Giờ có nút chọn phạm vi cạnh nút "Tìm":
//   "Chat này" (mặc định) = chỉ tìm trong hội thoại đang mở
//   "Tất cả"              = tìm trong mọi hội thoại
// Nếu chưa mở hội thoại nào (chat mới/tạm thời) thì tự tìm trong tất cả.
// Dùng lại state, els, apiFetch, API_BASE, semResultEl của app.js nên không phải sửa app.js.
(() => {
  'use strict';

  const SCOPE_KEY = 'myai_sem_scope';
  let scope = localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'chat';

  const style = document.createElement('style');
  style.textContent = `
    #semScopeBtn { flex-shrink: 0; padding: 0 12px; height: 38px; border-radius: var(--radius-pill);
      border: 1px solid var(--border-strong); background: var(--bg-card); color: var(--text-secondary);
      font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    #semScopeBtn.chat { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }`;
  document.head.appendChild(style);

  const searchBtn = document.getElementById('semSearchBtn');
  const scopeBtn = document.createElement('button');
  scopeBtn.type = 'button';
  scopeBtn.id = 'semScopeBtn';
  searchBtn.before(scopeBtn);

  function renderScope() {
    scopeBtn.textContent = scope === 'chat' ? 'Chat này' : 'Tất cả';
    scopeBtn.classList.toggle('chat', scope === 'chat');
    scopeBtn.title = scope === 'chat' ? 'Đang tìm trong chat đang mở — bấm để tìm trong tất cả chat'
                                      : 'Đang tìm trong tất cả chat — bấm để chỉ tìm trong chat đang mở';
  }
  scopeBtn.addEventListener('click', () => {
    scope = scope === 'chat' ? 'all' : 'chat';
    localStorage.setItem(SCOPE_KEY, scope);
    renderScope();
  });
  renderScope();

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  async function runScopedSearch() {
    const q = els.semSearchInput.value.trim();
    if (!q) return;
    const convId = scope === 'chat' ? state.conversationId : null;
    const where = convId ? 'trong chat này'
      : (scope === 'chat' ? 'trong tất cả chat (chưa mở chat nào)' : 'trong tất cả chat');

    els.semSearchResults.classList.remove('hidden');
    els.semSearchCloseBtn.classList.remove('hidden');
    els.semSearchResults.innerHTML = '<p class="hint">Đang tìm ' + where + '...</p>';
    try {
      const url = API_BASE + '/api/search/semantic?q=' + encodeURIComponent(q)
        + (convId ? '&conversationId=' + encodeURIComponent(convId) : '');
      const r = await apiFetch(url);
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
      const results = Array.isArray(data) ? data : (data.results || []);

      els.semSearchResults.innerHTML = '<p class="hint">Kết quả ' + where + '</p>';
      if (!results.length) {
        els.semSearchResults.insertAdjacentHTML('beforeend',
          '<p class="hint">Không tìm thấy kết quả nào.' + (convId ? ' Thử bấm "Chat này" để đổi sang "Tất cả".' : '') + '</p>'
          + (data.debug ? '<pre class="hint" style="white-space:pre-wrap;font-size:11px">Chẩn đoán: ' + esc(JSON.stringify(data.debug, null, 1)) + '</pre>' : ''));
        return;
      }
      results.forEach(x => els.semSearchResults.appendChild(semResultEl(x)));
    } catch (e) {
      els.semSearchResults.innerHTML = '<p class="hint">⚠️ Lỗi tìm kiếm: ' + esc(e.message) + '</p>';
    }
  }

  // Chặn ở pha capture để hàm tìm kiếm cũ của app.js không chạy nữa (nó không biết phạm vi chat).
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#semSearchBtn')) {
      e.stopPropagation();
      e.preventDefault();
      runScopedSearch();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.target && e.target.id === 'semSearchInput') {
      e.stopPropagation();
      e.preventDefault();
      runScopedSearch();
    }
  }, true);
})();
