// ===================== POPUP MODEL + MỨC SUY LUẬN (kiểu ChatGPT) =====================
// Nạp SAU app.js. Dùng lại các thứ app.js đã có: state, els, MODEL_OPTIONS, modelSheet, modelBackdrop,
// renderModelSheet(), openSheet(), closeSheet() — nên không phải sửa app.js.
//
// Danh sách model (ghi đè MODEL_OPTIONS của app.js ngay khi file này nạp):
//   Auto · 3.5 Flash · 4 Hydrogen · Gemma 4 31B · Gemma 4 26B A4B
//   (đã bỏ 3.1 Flash-Lite, 3 Flash, 3.1 Pro; 3.5 Flash giờ mọi người dùng được)
//
// Cách popup hoạt động theo từng loại model:
//  - Auto            : tia sét Deep Think (bật/tắt) + thanh nỗ lực Thấp / Trung bình / Cao (như cũ).
//  - 3.5 Flash       : ẨN tia sét, luôn suy luận; chỉ có thanh nỗ lực Thấp / Trung bình / Cao (giữ nguyên).
//  - 4 Hydrogen      : ẨN tia sét, luôn suy luận; thanh nỗ lực có thêm mức Xhigh. Chọn Xhigh sẽ hiện
//                      cảnh báo tốn token và phải bấm đồng ý trước khi dùng.
//  - Gemma 4 (2 bản) : KHÔNG có thanh nỗ lực (Gemma chỉ có bật/tắt suy luận) — chỉ dùng tia sét để
//                      bật/tắt thinking.
//  - Giữa: tên model, bấm vào để đổi model. Góc trên phải: nút X đóng popup.
//  - Mức đã chọn gửi lên server qua trường `thinkingEffort` của /api/chat/stream.
(() => {
  'use strict';

  // ---------- danh sách model ----------
  const MODEL_LIST = [
    { value: 'auto', label: '⚡ Auto', desc: 'Tự chọn model phù hợp nhất cho từng câu hỏi' },
    { value: 'gemini-3.5-flash', label: '3.5 Flash', desc: 'Nhanh, mạnh cho cả chat lẫn viết/sửa code' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen', desc: 'Gemini 4 mới nhất — nhanh, suy luận sâu (mức Xhigh tốn nhiều token)' },
    { value: 'gemma-4-31b-it', label: 'Gemma 4 31B', desc: 'Model mở của Google, bản lớn nhất' },
    { value: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B', desc: 'Model mở dạng MoE, nhẹ và nhanh hơn' },
  ];
  MODEL_OPTIONS.splice(0, MODEL_OPTIONS.length, ...MODEL_LIST);

  // Người dùng cũ có thể còn lưu model đã bỏ (Flash-Lite / 3 Flash / 3.1 Pro) -> về Auto.
  if (!MODEL_OPTIONS.some(m => m.value === state.model)) {
    state.model = 'auto';
    try { localStorage.setItem('myai_model', 'auto'); } catch (_) {}
  }

  // Dropdown "Thử gọi API bằng key" trong Cài đặt: cập nhật theo model mới.
  // (giữ value="coding" cho 3.5 Flash vì app.js kiểm tra option này khi xác minh chủ app)
  const testSel = document.getElementById('apiKeyTestModel');
  if (testSel) {
    testSel.innerHTML = [
      ['coding', '3.5 Flash (mặc định)'],
      ['gemma-31b', 'Gemma 4 31B'],
      ['gemma-26b', 'Gemma 4 26B A4B'],
    ].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  }

  // ---------- loại model & các mức nỗ lực ----------
  const BASE_LEVELS = [
    { key: 'low', label: 'Thấp' },
    { key: 'medium', label: 'Trung bình' },
    { key: 'high', label: 'Cao' },
  ];
  const HYDROGEN_LEVELS = [...BASE_LEVELS, { key: 'xhigh', label: 'Xhigh' }];
  const EFFORT_KEY = 'myai_thinking_effort';
  const DEEP_THINK_LABEL = 'Deep Think';
  const XHIGH_WARNING = '⚠️ Mức Xhigh của Gemini 4 Hydrogen suy luận rất sâu nên tốn nhiều token hơn hẳn các mức khác '
    + '(dễ chạm giới hạn hạn mức nhanh hơn). Bạn vẫn muốn dùng mức này?';

  const kindOf = (v) => v === 'auto' ? 'auto'
    : /^gemma-/i.test(v) ? 'gemma'
    : v === 'gemini-4-hydrogen' ? 'hydrogen'
    : 'flash'; // gemini-3.5-flash
  const levelsFor = (kind) => kind === 'hydrogen' ? HYDROGEN_LEVELS : BASE_LEVELS;

  let effort = localStorage.getItem(EFFORT_KEY);
  if (!HYDROGEN_LEVELS.some(l => l.key === effort)) effort = 'medium';
  function saveEffort(key) {
    effort = key;
    try { localStorage.setItem(EFFORT_KEY, key); } catch (_) {}
  }
  // Mức nỗ lực thực sự áp dụng cho 1 model (xhigh chỉ có ở Hydrogen, model khác tự hạ về high).
  function effortFor(modelValue) {
    return levelsFor(kindOf(modelValue)).some(l => l.key === effort) ? effort : 'high';
  }

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
      <button type="button" class="effort-bolt" id="effortBolt" aria-pressed="false" aria-label="Bật hoặc tắt ${DEEP_THINK_LABEL}" title="${DEEP_THINK_LABEL}">${boltSvg('')}</button>
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
      <div class="effort-stops" id="effortStops"></div>
      <div class="effort-warn" id="effortWarn" style="display:none">⚠️ Xhigh suy luận rất sâu nên tốn nhiều token hơn hẳn các mức khác.</div>
    </div>
    <div class="effort-hint" id="effortHint" style="display:none">Gemma chỉ có bật/tắt suy luận — dùng nút tia sét ở góc trên bên trái.</div>`;
  document.body.append(backdrop, sheet);

  const boltBtn = sheet.querySelector('#effortBolt');
  const modelBtn = sheet.querySelector('#effortModelBtn');
  const modelName = sheet.querySelector('#effortModelName');
  const bodyEl = sheet.querySelector('#effortBody');
  const range = sheet.querySelector('#effortRange');
  const stopsEl = sheet.querySelector('#effortStops');
  const warnEl = sheet.querySelector('#effortWarn');
  const hintEl = sheet.querySelector('#effortHint');

  // ---------- trạng thái ----------
  function currentModel() {
    return MODEL_OPTIONS.find(m => m.value === state.model) || MODEL_OPTIONS[0];
  }
  const currentKind = () => kindOf(currentModel().value);

  // Tô thanh + nhãn đang chọn ở vị trí idx (dùng cả lúc đang kéo thử, chưa lưu).
  function paint(idx, n) {
    range.style.setProperty('--pct', (n > 1 ? (idx / (n - 1)) * 100 : 0) + '%');
    stopsEl.querySelectorAll('.effort-stop').forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  function refresh() {
    const m = currentModel();
    const kind = kindOf(m.value);
    const levels = levelsFor(kind);

    // Xhigh chỉ có ở Hydrogen: sang model khác thì hạ về Cao (và lần sau chọn lại Xhigh sẽ hỏi lại).
    if (!levels.some(l => l.key === effort)) saveEffort('high');

    // Tia sét chỉ dùng cho Auto và Gemma. 3.5 Flash / Hydrogen luôn suy luận nên ẩn đi
    // (visibility để tên model vẫn nằm giữa header). Gemma không có thanh nỗ lực.
    const hasBolt = kind === 'auto' || kind === 'gemma';
    const hasSlider = kind !== 'gemma';
    const on = hasBolt && !!state.thinking;
    boltBtn.style.visibility = hasBolt ? '' : 'hidden';
    boltBtn.disabled = !hasBolt;
    boltBtn.tabIndex = hasBolt ? 0 : -1;
    boltBtn.setAttribute('aria-hidden', String(!hasBolt));
    boltBtn.classList.toggle('on', on);
    boltBtn.setAttribute('aria-pressed', String(on));
    bodyEl.style.display = hasSlider ? '' : 'none';
    hintEl.style.display = kind === 'gemma' ? '' : 'none';

    const idx = Math.max(0, levels.findIndex(l => l.key === effort));
    stopsEl.innerHTML = levels.map((l, i) => `<button type="button" class="effort-stop" data-i="${i}">${l.label}</button>`).join('');
    stopsEl.style.setProperty('--n', String(levels.length));
    range.max = String(levels.length - 1);
    range.value = String(idx);
    paint(idx, levels.length);
    warnEl.style.display = (kind === 'hydrogen' && effort === 'xhigh') ? '' : 'none';

    modelName.textContent = m.label.replace(/^\u26A1\uFE0F?\s*/u, '') || m.label; // bỏ emoji tia sét của nhãn "Auto"
  }

  // Bật/tắt Deep Think thông qua công tắc cũ (đang ẩn) để app.js tự lưu state + localStorage như trước.
  function setThinking(on) {
    const t = els.thinkingToggle;
    if (t.checked !== on) {
      t.checked = on;
      t.dispatchEvent(new Event('change'));
    }
    refresh();
  }

  // Chốt mức nỗ lực. Chọn Xhigh (Hydrogen) -> cảnh báo tốn token, không đồng ý thì giữ mức cũ.
  function commit(i) {
    const levels = levelsFor(currentKind());
    const next = levels[Math.min(levels.length - 1, Math.max(0, i))].key;
    if (next === 'xhigh' && effort !== 'xhigh' && !window.confirm(XHIGH_WARNING)) {
      refresh(); // trả thanh gạt về mức cũ
      return;
    }
    saveEffort(next);
    refresh();
  }

  // ---------- sự kiện ----------
  boltBtn.addEventListener('click', () => { if (!boltBtn.disabled) setThinking(!state.thinking); });
  // Đang kéo: chỉ xem trước (chưa lưu, chưa cảnh báo). Thả tay ('change') mới chốt.
  range.addEventListener('input', () => paint(parseInt(range.value, 10), levelsFor(currentKind()).length));
  range.addEventListener('change', () => commit(parseInt(range.value, 10)));
  stopsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.effort-stop');
    if (b) commit(parseInt(b.dataset.i, 10));
  });

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
  // 1) Nhãn trên nút model: icon tia sét tô màu khi đang bật Deep Think (chỉ Auto / Gemma có tia sét).
  window.updateModelPillLabel = function () {
    const m = currentModel();
    const kind = kindOf(m.value);
    const lbl = els.modelPillLabel;
    lbl.textContent = '';
    if (state.thinking && (kind === 'auto' || kind === 'gemma')) lbl.insertAdjacentHTML('beforeend', boltSvg('pill-bolt'));
    lbl.append(m.label);
    refresh();
  };

  // 2) Gửi kèm mức nỗ lực. 3.5 Flash và Hydrogen không có tia sét nên LUÔN suy luận (thinking = true).
  const origStreamPost = window.streamPost;
  window.streamPost = function (url, payload, handlers, abortSignal) {
    if (payload && typeof url === 'string' && url.includes('/api/chat/stream')) {
      const kind = kindOf(payload.model);
      if (kind === 'flash' || kind === 'hydrogen') {
        payload = { ...payload, thinking: true, thinkingEffort: effortFor(payload.model) };
      } else if (payload.thinking) {
        payload = { ...payload, thinkingEffort: effortFor(payload.model) };
      }
    }
    return origStreamPost.call(this, url, payload, handlers, abortSignal);
  };

  window.updateModelPillLabel(); // đồng bộ nhãn ngay khi tải trang
})();
