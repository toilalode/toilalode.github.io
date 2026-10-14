// ===================== POPUP MODEL + MỨC SUY LUẬN (kiểu ChatGPT) =====================
// Nạp SAU app.js. Dùng lại các thứ app.js đã có: state, els, MODEL_OPTIONS, modelSheet, modelBackdrop,
// renderModelSheet(), openSheet(), closeSheet() — nên không phải sửa app.js.
//
// Cách hoạt động:
//  - Bấm tên model ở ô nhập -> mở popup này (thay cho popup chọn model cũ).
//  - Góc trên trái: tia sét. Rỗng = TẮT thinking, tô màu = BẬT thinking.
//  - Giữa: tên model, bấm vào để đổi model (mở lại popup chọn model cũ, đã bỏ phần Thinking).
//  - Góc trên phải: nút X đóng popup.
//  - Dưới cùng: thanh gạt Thấp / Trung bình / Cao. Gạt thanh sẽ tự bật thinking.
//  - Mức đã chọn gửi lên server qua trường `thinkingEffort` của /api/chat/stream.
(() => {
  'use strict';

  const LEVELS = [
    { key: 'low', label: 'Thấp' },
    { key: 'medium', label: 'Trung bình' },
    { key: 'high', label: 'Cao' },
  ];
  const EFFORT_KEY = 'myai_thinking_effort';

  let effort = localStorage.getItem(EFFORT_KEY);
  if (!LEVELS.some(l => l.key === effort)) effort = 'medium';

  const BOLT_PATH = 'M13 2 4.5 13.5H11L10 22l9-12h-6.5z';
  const boltSvg = (cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${BOLT_PATH}"/></svg>`;

  // ---------- dựng popup (không cần sửa index.html ngoài 2 thẻ nạp file) ----------
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop hidden';
  backdrop.id = 'effortBackdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet effort-sheet';
  sheet.id = 'effortSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Model và mức suy luận');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="effort-header">
      <button type="button" class="effort-bolt" id="effortBolt" aria-pressed="false" aria-label="Bật hoặc tắt Thinking">${boltSvg('')}</button>
      <button type="button" class="effort-model" id="effortModelBtn" aria-label="Đổi model">
        <span id="effortModelName"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button type="button" class="effort-close" id="effortClose" aria-label="Đóng">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <div class="effort-body" id="effortBody">
      <div class="effort-title">Mức nỗ lực</div>
      <input type="range" class="effort-range" id="effortRange" min="0" max="2" step="1" aria-label="Mức nỗ lực suy luận" />
      <div class="effort-stops" id="effortStops">
        ${LEVELS.map((l, i) => `<button type="button" class="effort-stop" data-i="${i}">${l.label}</button>`).join('')}
      </div>
    </div>`;
  document.body.append(backdrop, sheet);

  const boltBtn = sheet.querySelector('#effortBolt');
  const modelBtn = sheet.querySelector('#effortModelBtn');
  const modelName = sheet.querySelector('#effortModelName');
  const body = sheet.querySelector('#effortBody');
  const range = sheet.querySelector('#effortRange');

  // ---------- trạng thái ----------
  function currentModel() {
    const all = [...MODEL_OPTIONS, CODING_MODEL_OPTION];
    return all.find(m => m.value === state.model) || MODEL_OPTIONS[0];
  }

  function refresh() {
    const on = !!state.thinking;
    const idx = Math.max(0, LEVELS.findIndex(l => l.key === effort));
    boltBtn.classList.toggle('on', on);
    boltBtn.setAttribute('aria-pressed', String(on));
    body.classList.toggle('off', !on);
    range.value = String(idx);
    range.style.setProperty('--pct', (idx * 50) + '%');
    sheet.querySelectorAll('.effort-stop').forEach((b, i) => b.classList.toggle('active', i === idx));
    modelName.textContent = currentModel().label.replace(/^\u26A1\uFE0F?\s*/u, '') || currentModel().label; // bỏ emoji tia sét của nhãn "Auto"
  }

  // Bật/tắt thinking thông qua công tắc cũ (đang ẩn) để app.js tự lưu state + localStorage như trước.
  function setThinking(on) {
    const t = els.thinkingToggle;
    if (t.checked !== on) {
      t.checked = on;
      t.dispatchEvent(new Event('change'));
    }
    refresh();
  }

  function setEffort(i) {
    effort = LEVELS[Math.min(2, Math.max(0, i))].key;
    localStorage.setItem(EFFORT_KEY, effort);
    if (!state.thinking) setThinking(true); // gạt thanh = muốn dùng thinking
    refresh();
  }

  // ---------- sự kiện ----------
  boltBtn.addEventListener('click', () => setThinking(!state.thinking));
  range.addEventListener('input', () => setEffort(parseInt(range.value, 10)));
  sheet.querySelectorAll('.effort-stop').forEach(b => b.addEventListener('click', () => setEffort(parseInt(b.dataset.i, 10))));

  const close = () => closeSheet(sheet, backdrop);
  sheet.querySelector('#effortClose').addEventListener('click', close);
  backdrop.addEventListener('click', close);

  // Bấm tên model trong popup -> đóng popup này, mở popup chọn model cũ.
  modelBtn.addEventListener('click', () => {
    close();
    renderModelSheet();
    openSheet(modelSheet, modelBackdrop);
  });

  // Bấm tên model ở ô nhập: chặn ở pha capture của document để app.js không mở popup cũ nữa.
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#modelPillBtn')) {
      e.stopPropagation();
      e.preventDefault();
      refresh();
      openSheet(sheet, backdrop);
    }
  }, true);

  // ---------- nối với app.js (không sửa app.js) ----------
  // 1) Nhãn trên nút model: thay emoji "🧠" cũ bằng icon tia sét tô màu khi đang bật thinking.
  window.updateModelPillLabel = function () {
    const m = currentModel();
    const lbl = els.modelPillLabel;
    lbl.textContent = '';
    if (state.thinking) lbl.insertAdjacentHTML('beforeend', boltSvg('pill-bolt'));
    lbl.append(m.label);
    refresh();
  };

  // 2) Gửi kèm mức nỗ lực khi chat có bật thinking.
  const origStreamPost = window.streamPost;
  window.streamPost = function (url, payload, handlers, abortSignal) {
    if (payload && payload.thinking && typeof url === 'string' && url.includes('/api/chat/stream')) {
      payload = { ...payload, thinkingEffort: effort };
    }
    return origStreamPost.call(this, url, payload, handlers, abortSignal);
  };

  window.updateModelPillLabel(); // đồng bộ nhãn ngay khi tải trang
})();
