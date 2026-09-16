// backend/routes/agentBrowser.js
//
// API cho Agent Mode "điều khiển trình duyệt thật":
//   POST /api/agent-browser/session          -> mở 1 phiên trình duyệt mới, trả sessionId
//   POST /api/agent-browser/:id/step         -> AI tự nhìn trang hiện tại (qua screenshot + nội dung)
//                                                và quyết định 1 hành động tiếp theo cho nhiệm vụ đã giao.
//                                                Nếu hành động đó nhạy cảm, KHÔNG chạy ngay mà trả về
//                                                pendingAction để người dùng xác nhận.
//   POST /api/agent-browser/:id/act          -> thực thi 1 hành động cụ thể do người dùng chỉ định trực tiếp
//   POST /api/agent-browser/:id/approve      -> đồng ý cho hành động đang chờ (pendingAction) chạy
//   POST /api/agent-browser/:id/reject       -> từ chối hành động đang chờ
//   GET  /api/agent-browser/:id/state        -> lấy screenshot + tóm tắt trang hiện tại
//   DELETE /api/agent-browser/:id            -> đóng phiên (đóng trình duyệt thật trên server)
//   GET  /api/agent-browser                  -> liệt kê các phiên đang mở (để hiện trên điện thoại)

const express = require('express');
const router = express.Router();
const agent = require('../utils/browserAgent');
const { MODELS } = require('../config/models');

const API_KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function sessionPublicState(session, extra = {}) {
  return {
    id: session.id,
    url: session.page.url(),
    pendingAction: session.pendingAction,
    log: session.log.slice(-30),
    ...extra,
  };
}

router.get('/', (req, res) => {
  res.json({ sessions: agent.listSessions() });
});

router.post('/session', async (req, res) => {
  try {
    const session = await agent.createSession();
    const { url } = req.body || {};
    if (url) await agent.performAction(session, { type: 'goto', url });
    const shot = await agent.screenshot(session);
    res.json(sessionPublicState(session, { screenshot: shot }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/state', async (req, res) => {
  try {
    const session = agent.getSession(req.params.id);
    const shot = await agent.screenshot(session);
    const summary = await agent.readPageSummary(session);
    res.json(sessionPublicState(session, { screenshot: shot, page: summary }));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Thực thi 1 hành động cụ thể (người dùng hoặc UI chỉ định trực tiếp, vd bấm nút "Mở trang").
// Nếu hành động nhạy cảm, sẽ dừng lại chờ xác nhận (needsApproval:true) thay vì tự chạy.
router.post('/:id/act', async (req, res) => {
  try {
    const session = agent.getSession(req.params.id);
    const { action, force } = req.body || {};
    if (!action || !action.type) return res.status(400).json({ error: 'Thiếu action.type' });
    const result = await agent.performAction(session, action, { force: !!force });
    const shot = await agent.screenshot(session);
    res.json(sessionPublicState(session, { screenshot: shot, result }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const session = agent.getSession(req.params.id);
    const result = await agent.approvePending(session);
    const shot = await agent.screenshot(session);
    res.json(sessionPublicState(session, { screenshot: shot, result }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reject', (req, res) => {
  try {
    const session = agent.getSession(req.params.id);
    const result = agent.rejectPending(session);
    res.json(sessionPublicState(session, { result }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  await agent.closeSession(req.params.id);
  res.json({ closed: true });
});

// ---- Vòng lặp agent thật: AI tự quyết định bước tiếp theo dựa trên ảnh chụp trang hiện tại ----
// POST /api/agent-browser/:id/step  body: { task, history? }
// Trả về { thought, action, needsApproval, screenshot, done }
router.post('/:id/step', async (req, res) => {
  try {
    if (!API_KEY) return res.status(400).json({ error: 'Thiếu GEMINI_API_KEY' });
    const session = agent.getSession(req.params.id);
    const { task, history } = req.body || {};
    if (!task) return res.status(400).json({ error: 'Thiếu task (nhiệm vụ giao cho agent)' });

    const summary = await agent.readPageSummary(session);
    const shot = await agent.screenshot(session); // data:image/jpeg;base64,...
    const base64Data = shot.split(',')[1];

    const systemPrompt = `Bạn là AI agent điều khiển trình duyệt thật để hoàn thành nhiệm vụ được giao.
Bạn ĐANG NHÌN THẤY ảnh chụp màn hình trang web hiện tại (đính kèm) và nội dung text trích xuất.
Nhiệm vụ: "${task}"

Trang hiện tại: ${summary.url}
Tiêu đề: ${summary.title}
Các phần tử có thể tương tác (index để tham chiếu):
${summary.interactive.map(e => `[${e.index}] <${e.tag}${e.type ? ' type=' + e.type : ''}> "${e.text}"`).join('\n').slice(0, 3000)}

Nội dung text trang (rút gọn):
"""${summary.text.slice(0, 2500)}"""

Hãy quyết định MỘT hành động tiếp theo để tiến gần hơn tới hoàn thành nhiệm vụ.
CHỈ trả về JSON thuần (không markdown, không giải thích thêm) theo đúng schema:
{
  "thought": "suy nghĩ ngắn gọn bằng tiếng Việt về bước này",
  "done": false,
  "finalAnswer": null,
  "action": {
    "type": "goto|click|fill|scroll|press_key|wait|go_back",
    "url": "...",            // nếu type=goto
    "selectorText": "...",   // nếu type=click, dùng đúng text hiển thị của phần tử muốn bấm
    "selector": null,
    "value": "...",          // nếu type=fill
    "inputType": "text|email|password|...",  // nếu type=fill, giúp hệ thống biết có nhạy cảm không
    "deltaY": 800             // nếu type=scroll
  }
}
Nếu nhiệm vụ ĐÃ hoàn thành (đủ thông tin để trả lời người dùng), set "done": true, điền "finalAnswer"
bằng câu trả lời đầy đủ, và "action": null.
Nếu hành động tiếp theo có khả năng thay đổi dữ liệu thật (gửi form, mua hàng, xoá, đăng ký, thanh
toán, điền thông tin cá nhân...) vẫn cứ đề xuất bình thường — hệ thống sẽ tự hỏi người dùng xác nhận,
bạn không cần tự chặn.`;

    const body = {
      contents: [{
        role: 'user',
        parts: [
          { text: systemPrompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    };

    const r = await fetch(`${BASE}/${MODELS.chatSmart}:generateContent?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 800));
    const rawText = (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('');

    let decision;
    try {
      decision = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      throw new Error('AI trả về JSON không hợp lệ: ' + rawText.slice(0, 300));
    }

    agent.pushLog(session, { type: 'agent_thought', detail: decision.thought });

    if (decision.done || !decision.action) {
      return res.json({ thought: decision.thought, done: true, finalAnswer: decision.finalAnswer, screenshot: shot });
    }

    const result = await agent.performAction(session, decision.action, { force: false });
    const newShot = await agent.screenshot(session);

    res.json({
      thought: decision.thought,
      done: false,
      action: decision.action,
      needsApproval: result.needsApproval,
      screenshot: newShot,
      url: session.page.url(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
