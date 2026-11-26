// Cài đặt -> "🔑 API Key": phần "🧪 Thử gọi API" và "📄 Xuất code gắn vào file khác".
// Chạy SAU app.js. Thay 2 handler cũ (chỉ gửi { prompt, model }) bằng bản hỗ trợ đúng API mới:
//   - model:    smart | fast | lite | hydrogen | gemma | gemma-moe  (+ coding, chỉ chủ app — app.js tự thêm option này)
//   - effort:   3.5 Flash = low|medium|high (có effort => tự bật thinking) | Hydrogen = low|medium|high|xhigh
//   - thinking: Gemma chỉ có bật/tắt (true/false), không có effort
(function () {
  const $ = (id) => document.getElementById(id);
  const modelSel = $('apiKeyTestModel');
  const effortSel = $('apiKeyTestEffort');
  const thinkingChk = $('apiKeyTestThinking');
  const effortRow = $('apiKeyEffortRow');
  const thinkingRow = $('apiKeyThinkingRow');
  if (!modelSel || !effortSel || !thinkingChk || !effortRow || !thinkingRow) return;

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
    const kind = kindOf(p.model);
    const defaults = Object.entries(p)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`)
      .join(', ');
    const effortNote = {
      flash: "// effort: 'low' | 'medium' | 'high' (gửi effort = tự bật thinking; bỏ trống = không thinking)",
      hydrogen: "// effort: 'low' | 'medium' | 'high' | 'xhigh' (mặc định 'high'; xhigh suy luận rất sâu, tốn nhiều token)",
      gemma: '// thinking: true | false (Gemma chỉ có bật/tắt, không có effort)',
    }[kind];

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

// model: 'smart' (mặc định) | 'fast' | 'lite' | 'hydrogen' (Gemini 4 Hydrogen) | 'gemma' | 'gemma-moe'
${effortNote}
// Ví dụ: await askVelocitix('xin chào')  hoặc  await askVelocitix('xin chào', { model: 'hydrogen', effort: 'low' })
</script>`;

    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
})();
