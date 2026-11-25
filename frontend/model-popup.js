// ===================== POPUP MODEL + MỨC SUY LUẬN =====================
// Nạp SAU app.js. Dùng lại các thứ app.js đã có: state, els, MODEL_OPTIONS, modelSheet, modelBackdrop,
// renderModelSheet(), openSheet(), closeSheet() — nên không phải sửa app.js.
//
// Cách popup hoạt động theo từng loại model:
//  - Auto            : KHÔNG còn tia sét và thanh nỗ lực. AI của Cloudflare đọc câu hỏi rồi TỰ chọn model
//                      + mức nỗ lực phù hợp (xem worker/src/autoRouter.js).
//  - 3.5 Flash       : ẨN tia sét, luôn suy luận; thanh nỗ lực Thấp / Trung bình / Cao.
//  - 4 Hydrogen      : ẨN tia sét, luôn suy luận; thanh nỗ lực có thêm Xhigh (có cảnh báo tốn token).
//  - Gemma 4 (2 bản) : KHÔNG có thanh nỗ lực — chỉ dùng tia sét để bật/tắt thinking.
//
// Code Editor, Giải bài tập, Artifacts có nút chọn model riêng (dùng chung popup này).
// Mở web & hỏi AI, Agent Mode chạy model cố định phía server; Voice dùng Gemini Live.
//
// Gỡ khỏi giao diện: Tạo ảnh, Tạo video, Deep Research (xem removeDroppedFeatures()).
// Mở lại hội thoại cũ: về đúng mục đã tạo ra nó (Code, Agent, Giải bài tập...) thay vì nhảy sang Chat.
(() => {
  'use strict';

  // ---------- danh sách model ----------
  const MODEL_LIST = [
    { value: 'auto', label: '⚡ Auto', desc: 'AI tự chọn model và mức nỗ lực cho từng câu hỏi' },
    { value: 'gemini-3.5-flash', label: '3.5 Flash', desc: 'Nhanh, mạnh cho cả chat lẫn viết/sửa code' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen', desc: 'Gemini 4 mới nhất — nhanh, suy luận sâu (mức Xhigh tốn nhiều token)' },
    { value: 'gemma-4-31b-it', label: 'Gemma 4 31B', desc: 'Model mở của Google, bản lớn nhất' },
    { value: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B', desc: 'Model mở dạng MoE, nhẹ và nhanh hơn' },
  ];
  MODEL_OPTIONS.splice(0, MODEL_OPTIONS.length, ...MODEL_LIST);

  if (!MODEL_OPTIONS.some(m => m.value === state.model)) {
    state.model = 'auto';
    try { localStorage.setItem('myai_model', 'auto'); } catch (_) {}
  }

  const testSel = document.getElementById('apiKeyTestModel');
  if (testSel) {
    testSel.innerHTML = [
      ['coding', '3.5 Flash (mặc định)'],
      ['gemma-31b', 'Gemma 4 31B'],
      ['gemma-26b', 'Gemma 4 26B A4B'],
    ].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  }

  // ---------- gỡ Tạo ảnh / Tạo video / Deep Research khỏi giao diện ----------
  // app.js đã gắn sự kiện vào các phần tử này lúc tải, nên gỡ SAU khi app.js chạy xong (an toàn, không lỗi).
  function removeDroppedFeatures() {
    document.querySelectorAll('.nav-btn[data-mode="image"], .nav-btn[data-mode="video"]').forEach(el => el.remove());
    ['panel-image', 'panel-video', 'researchWidget-chat', 'deepResearchChip'].forEach(id => document.getElementById(id)?.remove());
    document.getElementById('deepResearchToggle')?.closest('label')?.remove();
    state.deepResearchMode = false;
  }
  removeDroppedFeatures();

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
  const HINT_AUTO = 'Auto: AI của Cloudflare đọc câu hỏi rồi tự chọn model và mức nỗ lực phù hợp.';
  const HINT_GEMMA = 'Gemma chỉ có bật/tắt suy luận — dùng nút tia sét ở góc trên bên trái.';

  const kindOf = (v) => v === 'auto' ? 'auto'
    : /^gemma-/i.test(v) ? 'gemma'
    : v === 'gemini-4-hydrogen' ? 'hydrogen'
    : 'flash';
  const levelsFor = (kind) => kind === 'hydrogen' ? HYDROGEN_LEVELS : BASE_LEVELS;

  let effort = localStorage.getItem(EFFORT_KEY);
  if (!HYDROGEN_LEVELS.some(l => l.key === effort)) effort = 'medium';
  function saveEffort(key) {
    effort = key;
    try { localStorage.setItem(EFFORT_KEY, key); } catch (_) {}
  }
  function effortFor(modelValue) {
    return levelsFor(kindOf(modelValue)).some(l => l.key === effort) ? effort : 'high';
  }

  const BOLT_PATH = 'M13 2 4.5 13.5H11L10 22l9-12h-6.5z';
  const boltSvg = (cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${BOLT_PATH}"/></svg>`;

  // ---------- dựng popup ----------
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
    <div class="effort-hint" id="effortHint" style="display:none"></div>`;
  document.body.append(backdrop, sheet);

  const boltBtn = sheet.querySelector('#effortBolt');
  const modelBtn = sheet.querySelector('#effortModelBtn');
  const modelName = sheet.querySelector('#effortModelName');
  const bodyEl = sheet.querySelector('#effortBody');
  const range = sheet.querySelector('#effortRange');
  const stopsEl = sheet.querySelector('#effortStops');
  const warnEl = sheet.querySelector('#effortWarn');
  const hintEl = sheet.querySelector('#effortHint');

  function currentModel() {
    return MODEL_OPTIONS.find(m => m.value === state.model) || MODEL_OPTIONS[0];
  }
  const currentKind = () => kindOf(currentModel().value);

  function paint(idx, n) {
    range.style.setProperty('--pct', (n > 1 ? (idx / (n - 1)) * 100 : 0) + '%');
    stopsEl.querySelectorAll('.effort-stop').forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  function refresh() {
    const m = currentModel();
    const kind = kindOf(m.value);
    const levels = levelsFor(kind);
    if (!levels.some(l => l.key === effort)) saveEffort('high');

    // Tia sét: chỉ còn ở Gemma. Thanh nỗ lực: chỉ ở 3.5 Flash và Hydrogen (Auto tự chọn, Gemma chỉ bật/tắt).
    const hasBolt = kind === 'gemma';
    const hasSlider = kind === 'flash' || kind === 'hydrogen';
    const on = hasBolt && !!state.thinking;
    boltBtn.style.visibility = hasBolt ? '' : 'hidden';
    boltBtn.disabled = !hasBolt;
    boltBtn.tabIndex = hasBolt ? 0 : -1;
    boltBtn.setAttribute('aria-hidden', String(!hasBolt));
    boltBtn.classList.toggle('on', on);
    boltBtn.setAttribute('aria-pressed', String(on));
    bodyEl.style.display = hasSlider ? '' : 'none';
    hintEl.style.display = (kind === 'auto' || kind === 'gemma') ? '' : 'none';
    hintEl.textContent = kind === 'auto' ? HINT_AUTO : HINT_GEMMA;

    const idx = Math.max(0, levels.findIndex(l => l.key === effort));
    stopsEl.innerHTML = levels.map((l, i) => `<button type="button" class="effort-stop" data-i="${i}">${l.label}</button>`).join('');
    stopsEl.style.setProperty('--n', String(levels.length));
    range.max = String(levels.length - 1);
    range.value = String(idx);
    paint(idx, levels.length);
    warnEl.style.display = (kind === 'hydrogen' && effort === 'xhigh') ? '' : 'none';

    modelName.textContent = m.label.replace(/^\u26A1\uFE0F?\s*/u, '') || m.label;
  }

  function setThinking(on) {
    const t = els.thinkingToggle;
    if (t.checked !== on) {
      t.checked = on;
      t.dispatchEvent(new Event('change'));
    }
    refresh();
  }

  function commit(i) {
    const levels = levelsFor(currentKind());
    const next = levels[Math.min(levels.length - 1, Math.max(0, i))].key;
    if (next === 'xhigh' && effort !== 'xhigh' && !window.confirm(XHIGH_WARNING)) {
      refresh();
      return;
    }
    saveEffort(next);
    refresh();
  }

  boltBtn.addEventListener('click', () => { if (!boltBtn.disabled) setThinking(!state.thinking); });
  range.addEventListener('input', () => paint(parseInt(range.value, 10), levelsFor(currentKind()).length));
  range.addEventListener('change', () => commit(parseInt(range.value, 10)));
  stopsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.effort-stop');
    if (b) commit(parseInt(b.dataset.i, 10));
  });

  const close = () => closeSheet(sheet, backdrop);
  sheet.querySelector('#effortClose').addEventListener('click', close);
  backdrop.addEventListener('click', close);

  modelBtn.addEventListener('click', () => {
    close();
    renderModelSheet();
    openSheet(modelSheet, modelBackdrop);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#modelPillBtn, .model-pill-extra')) {
      e.stopPropagation();
      e.preventDefault();
      refresh();
      openSheet(sheet, backdrop);
    }
  }, true);

  // ---------- nối với app.js (không sửa app.js) ----------
  window.updateModelPillLabel = function () {
    const m = currentModel();
    const kind = kindOf(m.value);
    const lbl = els.modelPillLabel;
    lbl.textContent = '';
    if (state.thinking && kind === 'gemma') lbl.insertAdjacentHTML('beforeend', boltSvg('pill-bolt'));
    lbl.append(m.label);
    document.querySelectorAll('.model-pill-extra .pill-label').forEach(x => { x.innerHTML = lbl.innerHTML; });
    refresh();
  };

  // Nút chọn model cho Code Editor, Giải bài tập, Artifacts (giống nút ở Chat, dùng chung popup + state.model).
  const EXTRA_PILL_HOSTS = ['#panel-code .composer-toolbar-left', '#panel-homework .composer-toolbar-left', '#artifactsListView .composer-toolbar-left'];
  EXTRA_PILL_HOSTS.forEach(sel => {
    const host = document.querySelector(sel);
    if (!host || host.querySelector('.model-pill-extra')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'topbar-controls model-pill-extra';
    b.title = 'Chọn model';
    b.innerHTML = '<span class="pill-label"></span> <span class="chev">▾</span>';
    host.prepend(b);
  });

  // Gửi kèm model + mức nỗ lực.
  //  - Code Editor / Giải bài tập / Artifacts: dùng model đang chọn (có nút chọn model riêng).
  //  - Auto: không gửi thinking/effort — server (Cloudflare AI) tự quyết.
  //  - 3.5 Flash / Hydrogen: luôn suy luận kèm mức nỗ lực đã chọn.
  const origStreamPost = window.streamPost;
  window.streamPost = function (url, payload, handlers, abortSignal) {
    if (payload && typeof url === 'string' && url.includes('/api/chat/stream')) {
      if (['code', 'homework', 'artifacts'].includes(state.mode)) payload = { ...payload, model: state.model };
      const kind = kindOf(payload.model);
      if (kind === 'auto') {
        const { thinkingEffort, ...rest } = payload;
        payload = { ...rest, thinking: false };
      } else if (kind === 'flash' || kind === 'hydrogen') {
        payload = { ...payload, thinking: true, thinkingEffort: effortFor(payload.model) };
      } else if (payload.thinking) {
        payload = { ...payload, thinkingEffort: effortFor(payload.model) };
      }
    }
    return origStreamPost.call(this, url, payload, handlers, abortSignal);
  };

  // ---------- MỖI MỤC CÓ HỘI THOẠI RIÊNG + mở lại chat cũ về đúng mục ----------
  const CONV_MODES_KEY = 'myai_conv_modes';   // { convId: mode }
  const MODE_CONV_KEY = 'myai_mode_conv';     // { mode: convId đang dùng }
  const SCOPED = ['chat', 'code', 'homework', 'webask', 'agent', 'artifacts'];
  const PREFIX_MODE = [['📘', 'homework'], ['🧭', 'webask'], ['🧩', 'artifacts'], ['💻', 'code'], ['🚀', 'agent']];
  const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (_) { return {}; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  function modeOfConv(id) {
    const saved = readJSON(CONV_MODES_KEY)[id];
    if (saved && SCOPED.includes(saved)) return saved;
    const title = (allConvs.find(c => c.id === id)?.title || '').trim();
    const hit = PREFIX_MODE.find(([p]) => title.startsWith(p));
    return hit ? hit[1] : 'chat';
  }
  function rememberConvMode(id, mode) {
    const map = readJSON(CONV_MODES_KEY);
    if (!map[id]) { map[id] = mode; writeJSON(CONV_MODES_KEY, map); }
  }
  function setCurrentConv(id) {
    state.conversationId = id || null;
    try { id ? localStorage.setItem('myai_last_conv', id) : localStorage.removeItem('myai_last_conv'); } catch (_) {}
  }

  // Ghi nhớ mục nào đã tạo hội thoại nào.
  const origEnsure = window.ensureConversation;
  window.ensureConversation = async function (firstText) {
    const had = state.conversationId;
    const res = await origEnsure.call(this, firstText);
    if (!had && state.conversationId) {
      rememberConvMode(state.conversationId, state.mode);
      const mc = readJSON(MODE_CONV_KEY); mc[state.mode] = state.conversationId; writeJSON(MODE_CONV_KEY, mc);
    }
    return res;
  };

  // Chuyển mục: cất hội thoại của mục cũ, lấy lại hội thoại của mục mới (không để Code ghi nhầm vào chat Chat).
  const origSwitchMode = window.switchMode;
  window.switchMode = function (mode) {
    if (SCOPED.includes(mode) && SCOPED.includes(state.mode) && mode !== state.mode) {
      const mc = readJSON(MODE_CONV_KEY);
      if (state.conversationId) mc[state.mode] = state.conversationId; else delete mc[state.mode];
      setCurrentConv(mc[mode] || null);
      writeJSON(MODE_CONV_KEY, mc);
    }
    return origSwitchMode.call(this, mode);
  };

  // Lúc tải trang: hội thoại cuối cùng có thể thuộc Code/Agent... -> không để Chat dùng chung.
  (function fixInitialConv() {
    const id = state.conversationId;
    if (!id) return;
    const mode = readJSON(CONV_MODES_KEY)[id];
    if (mode && mode !== 'chat' && SCOPED.includes(mode)) {
      const mc = readJSON(MODE_CONV_KEY); mc[mode] = id; writeJSON(MODE_CONV_KEY, mc);
      setCurrentConv(null);
    }
  })();

  const codeOf = (t) => { const m = (t || '').match(/```[\w]*\n?([\s\S]*?)```/); return m ? m[1].trim() : null; };

  function restoreIntoMode(mode, msgs) {
    if (mode === 'chat') {
      state.history = msgs.map(m => ({ role: m.role, text: m.content }));
      saveHistory();
      renderHistory();
    } else if (mode === 'code') {
      document.getElementById('codeChatMessages').innerHTML = '';
      codeEditorHistory.length = 0;
      let lastCode = null;
      msgs.forEach(m => {
        if (m.role === 'user') { appendCodeChatMsg('user', m.content); }
        else {
          const { explanation, code } = splitCodeAndExplanation(m.content || '');
          appendCodeChatMsg('assistant', explanation);
          if (code) lastCode = code;
        }
        codeEditorHistory.push({ role: m.role === 'user' ? 'user' : 'assistant', text: m.content });
      });
      if (lastCode !== null) { document.getElementById('codeEditor').value = lastCode; try { refreshCodePreview(); } catch (_) {} }
    } else if (mode === 'homework') {
      const u = [...msgs].reverse().find(m => m.role === 'user');
      const a = [...msgs].reverse().find(m => m.role !== 'user');
      hw.topic = u ? u.content : '';
      hw.solution = a ? a.content : '';
      hw.flashcards = []; hw.quiz = []; hw.cardIndex = 0; hw.quizIndex = 0; hw.quizScore = 0;
      hw.els.emptyHint.classList.add('hidden');
      hw.els.tabs.classList.remove('hidden');
      setHwMode('solution');
      hw.els.solutionBody.innerHTML = renderMarkdown(hw.solution || '');
      try { enhanceCodeBlocks(hw.els.solutionBody); } catch (_) {}
    } else if (mode === 'webask') {
      const box = document.getElementById('webaskResults');
      box.innerHTML = '';
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role !== 'user') continue;
        const q = msgs[i].content || '';
        const url = (q.match(/https?:\/\/\S+/) || [''])[0];
        const ans = msgs[i + 1] && msgs[i + 1].role !== 'user' ? msgs[i + 1].content : '';
        const card = document.createElement('div');
        card.className = 'webask-answer';
        card.innerHTML = `<div class="webask-src">🔗 ${url.replace(/</g, '&lt;')}</div>` + (ans ? renderMarkdown(ans) : '<p class="hint">(chưa có câu trả lời được lưu)</p>');
        box.prepend(card);
      }
    } else if (mode === 'agent') {
      const log = document.getElementById('agentLog');
      log.innerHTML = '';
      document.querySelector('.agent-tab-btn[data-agent-tab="research"]')?.click();
      msgs.forEach(m => {
        if (m.role === 'user') addLog(log, '🧭 Nhiệm vụ: ' + m.content);
        else { const d = document.createElement('div'); d.className = 'agent-final'; d.innerHTML = renderMarkdown(m.content || ''); log.appendChild(d); }
      });
    } else if (mode === 'artifacts') {
      const a = [...msgs].reverse().find(m => m.role !== 'user');
      const u = [...msgs].reverse().find(m => m.role === 'user');
      const code = codeOf(a && a.content);
      if (code) {
        const art = ArtifactStore.add({ title: ((u && u.content) || 'Artifact').slice(0, 60), code, source: 'artifacts' });
        openArtifact(art.id);
      }
    }
  }

  // Mở lại 1 hội thoại: về ĐÚNG mục của nó (trước đây luôn nhảy sang Chat).
  window.selectConversation = async function (id) {
    try {
      const r = await apiFetch(API_BASE + `/api/conversations/${id}/messages`);
      const msgs = await r.json();
      if (!Array.isArray(msgs)) return;
      const mode = modeOfConv(id);
      switchMode(mode);              // cất hội thoại của mục cũ trước
      setCurrentConv(id);
      const mc = readJSON(MODE_CONV_KEY); mc[mode] = id; writeJSON(MODE_CONV_KEY, mc);
      rememberConvMode(id, mode);
      restoreIntoMode(mode, msgs);
      const q = els.convSearchInput.value.trim().toLowerCase();
      renderConvList(q ? allConvs.filter(c => (c.title || '').toLowerCase().includes(q)) : allConvs);
    } catch (e) { alert('Không tải được hội thoại này.'); }
  };

  window.updateModelPillLabel(); // đồng bộ nhãn ngay khi tải trang
})();
