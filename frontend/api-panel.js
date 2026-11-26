// Cài đặt -> "🔑 API Key": phần "🧪 Thử gọi API" và "📄 Xuất code gắn vào file khác".
// Chạy SAU app.js. Thay 2 handler cũ (chỉ gửi { prompt, model }) bằng bản hỗ trợ đúng API mới:
//   - model:    smart (= Gemini 3.5 Flash) | hydrogen (= Gemini 4 Hydrogen) | gemma | gemma-moe
//               (+ coding, chỉ chủ app — app.js tự thêm option này). fast / lite / flash là tên cũ, cùng trỏ về 3.5 Flash.
//   - effort:   Gemini 3.5 Flash = low|medium|high (có effort => tự bật thinking)
//               Gemini 4 Hydrogen = low|medium|high|xhigh
//   - thinking: Gemma chỉ có bật/tắt (true/false), không có effort
(function () {
  const $ = (id) => document.getElementById(id);
  const modelSel = $('apiKeyTestModel');
  const effortSel = $('apiKeyTestEffort');
  const thinkingChk = $('apiKeyTestThinking');
  const effortRow = $('apiKeyEffortRow');
  const thinkingRow = $('apiKeyThinkingRow');
  if (!modelSel || !effortSel || !thinkingChk || !effortRow || !thinkingRow) return;

  // Ghi rõ tên model thật trong dropdown (trước đây chỉ ghi Smart/Fast/Lite, không nói là Gemini).
  // Smart / Fast / Lite đều là Gemini 3.5 Flash nên gộp còn 1 lựa chọn.
  const MODEL_LABELS = {
    smart: 'Gemini 3.5 Flash (mặc định)',
    hydrogen: 'Gemini 4 Hydrogen',
    gemma: 'Gemma 4 31B',
    'gemma-moe': 'Gemma 4 26B-A4B',
    coding: 'Gemini 3.5 Flash — tối ưu viết/sửa code (chỉ chủ app)',
  };
  function relabelModels() {
    for (const opt of Array.from(modelSel.options)) {
      if (opt.value === 'fast' || opt.value === 'lite') { opt.remove(); continue; }
      const label = MODEL_LABELS[opt.value];
      if (label && opt.textContent !== label) opt.textContent = label;
    }
  }
  relabelModels();
  // app.js thêm option "coding" cho chủ app muộn hơn (sau khi tải /api/me) -> gắn nhãn lại khi có thay đổi.
  new MutationObserver(relabelModels).observe(modelSel, { childList: true });

  const kindOf = (m) => (m === 'hydrogen' ? 'hydrogen' : (m === 'gemma' || m === 'gemma-moe') ? 'gemma' : 'flash');

  const EFFORT_OPTIONS = {
    flash: [['', 'Không thinking (mặc định)'], ['low', 'Thấp'], ['medium', 'Trung bình'], ['high', 'Cao']],
    hydrogen: [['low', 'Thấp'], ['medium', 'Trung bình'], ['high', 'Cao (mặc định)'], ['xhigh', 'Rất cao (xhigh) — tốn nhiều token']],
  };

  let shownKind = null;
  function refreshControls() {
    const kind = kindOf(modelSel.value);
    if (kind === shownKind) return;
    shownKind = kind;
    if (kind === 'gemma') {
      effortRow.style.display = 'none';
      thinkingRow.style.display = '';
      return;
    }
    thinkingRow.style.display = 'none';
    effortRow.style.display = '';
    effortSel.innerHTML = '';
    for (const [value, label] of EFFORT_OPTIONS[kind]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      effortSel.appendChild(o);
    }
    effortSel.value = kind === 'hydrogen' ? 'high' : '';
  }
  modelSel.addEventListener('change', refreshControls);
  refreshControls();

  // Tham số gửi lên API theo đúng model đang chọn.
  function currentParams() {
    const model = modelSel.value || 'smart';
    const kind = kindOf(model);
    const p = { model };
    if (kind === 'gemma') { if (thinkingChk.checked) p.thinking = true; }
    else if (effortSel.value) p.effort = effortSel.value;
    return p;
  }

  // Bỏ handler cũ của app.js bằng cách thay nút bằng bản sao (bản sao không mang listener).
  function fresh(id) {
    const b = $(id);
    if (!b) return null;
    const c = b.cloneNode(true);
    b.replaceWith(c);
    return c;
  }

  const sendBtn = fresh('apiKeyTestSendBtn');
  sendBtn?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const apiKey = $('apiKeyDisplay')?.value?.trim();
    const prompt = $('apiKeyTestPrompt')?.value?.trim();
    const out = $('apiKeyTestResult');
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
        body: JSON.stringify({ prompt, ...currentParams() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('Lỗi HTTP ' + r.status));
      out.textContent = (data.text || JSON.stringify(data, null, 2)) + (data.model ? '\n\n— model: ' + data.model : '');
    } catch (err) {
      out.textContent = '❌ ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  const snippetBtn = fresh('apiKeyGenSnippetBtn');
  snippetBtn?.addEventListener('click', () => {
    const apiKey = $('apiKeyDisplay')?.value?.trim();
    const box = $('apiKeySnippetBox');
    const code = $('apiKeySnippetCode');
    if (!box || !code) return;
    if (!apiKey) { alert('Chưa có API key (đợi tải xong ở trên).'); return; }

    const p = currentParams();
    const defaults = Object.entries(p)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`)
      .join(', ');

    code.textContent =
`<script>
const VELOCITIX_DEFAULTS = { ${defaults} };

async function askVelocitix(prompt, options = {}) {
  const r = await fetch('${API_BASE}/api/external/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': '${apiKey}' },
    body: JSON.stringify({ prompt, ...VELOCITIX_DEFAULTS, ...options })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Lỗi gọi Velocitix AI');
  return data.text;
}

// ---- model ----
//   'smart'     : Gemini 3.5 Flash (mặc định) — 'fast' / 'lite' / 'flash' là tên cũ, cũng ra Gemini 3.5 Flash
//   'hydrogen'  : Gemini 4 Hydrogen
//   'gemma'     : Gemma 4 31B
//   'gemma-moe' : Gemma 4 26B-A4B
// ---- thinking / mức nỗ lực (tuỳ model) ----
//   Gemini 3.5 Flash  : effort: 'low' | 'medium' | 'high' (gửi effort = tự bật thinking; bỏ trống = không thinking)
//   Gemini 4 Hydrogen : effort: 'low' | 'medium' | 'high' | 'xhigh' (luôn suy luận, mặc định 'high'; xhigh tốn nhiều token)
//   Gemma 4           : thinking: true | false (chỉ có bật/tắt, KHÔNG có effort)
// Ví dụ:
//   await askVelocitix('xin chào')
//   await askVelocitix('xin chào', { model: 'hydrogen', effort: 'low' })
//   await askVelocitix('xin chào', { model: 'gemma', thinking: true })
</script>`;

    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
})();
