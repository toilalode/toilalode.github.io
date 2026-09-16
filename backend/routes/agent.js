// backend/routes/agent.js
//
// AGENT MODE (khác Deep Research):
//   - Deep Research (routes/search.js /deep-research): CHỈ đọc/tìm kiếm web nhiều bước rồi tổng hợp
//     báo cáo. Không đụng vào trang, không có hành động nào cần xin phép.
//   - Agent Mode (file này): một agent ĐA CÔNG CỤ thật sự — tự lên kế hoạch, tự chọn công cụ cho
//     từng bước (tìm web, đọc 1 trang cụ thể, lưu file kết quả, HOẶC điều khiển trình duyệt THẬT
//     để thao tác trên trang khi nhiệm vụ cần "làm" chứ không chỉ "đọc"). Khi cần điều khiển trình
//     duyệt, nó tái sử dụng session Playwright thật (utils/browserAgent.js) — và bất kỳ hành động
//     nhạy cảm nào (gửi form, mua hàng, xoá, điền thông tin...) LUÔN dừng lại xin phép người dùng,
//     y hệt cơ chế ở mục "Điều khiển trình duyệt thật" riêng.
//
// API:
//   POST /api/agent/run           body: { task }              -> SSE, chạy tới khi xong / cần xin phép
//   POST /api/agent/:id/resume    body: { approve: boolean }  -> SSE, tiếp tục sau khi user quyết định
//   DELETE /api/agent/:id                                      -> dọn dẹp task (đóng browser nếu có)

const express = require('express');
const router = express.Router();
const browserAgent = require('../utils/browserAgent');
const { saveBase64ToDisk } = require('../utils/storage');
const { MODELS } = require('../config/models');

const API_KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_STEPS = 15;

// taskId -> { task, steps: [], browserSessionId: null, awaitingApproval: null, done: false }
const tasks = new Map();

function genId() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

async function askJson(prompt, extraParts = []) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...extraParts] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const r = await fetch(`${BASE}/${MODELS.chatSmart}:generateContent?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 800));
  const raw = (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function askWithSearch(query) {
  const body = { contents: [{ role: 'user', parts: [{ text: query }] }], tools: [{ google_search: {} }] };
  const r = await fetch(`${BASE}/${MODELS.chatSmart}:generateContent?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 800));
  return (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('\n');
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
}

function historyText(steps) {
  if (!steps.length) return '(chưa có bước nào)';
  return steps.map((s, i) => `Bước ${i + 1} — công cụ: ${s.tool}\nKết quả: ${s.resultSummary}`).join('\n\n');
}

// Quyết định bước tiếp theo (không kèm ảnh) — chọn 1 trong các công cụ.
async function decideNextStep(taskState) {
  const prompt = `Bạn là Agent Mode — một AI agent ĐA CÔNG CỤ, khác với Deep Research (Deep Research chỉ tìm & đọc web).
Bạn có thể: tìm kiếm web, đọc kỹ 1 trang cụ thể, LƯU FILE kết quả cho người dùng, hoặc — khi nhiệm vụ cần
thao tác thật trên 1 trang web (điền form, bấm nút, điều hướng nhiều bước, mua hàng, đặt lịch...) — điều
khiển một TRÌNH DUYỆT THẬT trên server.

Nhiệm vụ người dùng giao: "${taskState.task}"

Lịch sử các bước đã làm:
${historyText(taskState.steps)}

Chọn CHÍNH XÁC MỘT hành động tiếp theo. Trả về JSON thuần theo schema:
{
  "thought": "suy nghĩ ngắn gọn bằng tiếng Việt",
  "done": false,
  "finalAnswer": null,
  "tool": "search_web|browse_url|browser_control|save_file|none",
  "args": {
    "query": "...",          // nếu tool=search_web
    "url": "...",            // nếu tool=browse_url hoặc browser_control (url bắt đầu, có thể để trống nếu đã có phiên)
    "question": "...",       // nếu tool=browse_url, câu hỏi cụ thể cần trả lời từ trang
    "subtask": "...",        // nếu tool=browser_control, mô tả CHÍNH XÁC việc cần làm trên trình duyệt
    "filename": "...",       // nếu tool=save_file
    "content": "..."         // nếu tool=save_file, nội dung văn bản cần lưu
  }
}
Nếu nhiệm vụ đã đủ thông tin để trả lời xong, set "done": true, điền "finalAnswer" đầy đủ bằng tiếng Việt,
"tool": "none". CHỈ dùng "browser_control" khi thực sự cần THAO TÁC trên trang (không chỉ đọc) — nếu chỉ
cần đọc/tra cứu thông tin, hãy dùng "search_web" hoặc "browse_url".`;
  return askJson(prompt);
}

// Một bước "nhìn + quyết định hành động Playwright cụ thể" khi tool=browser_control (tái dùng ý tưởng
// từ routes/agentBrowser.js /step, nhưng gọi trực tiếp qua hàm dùng chung thay vì qua HTTP).
async function decideBrowserAction(session, subtask) {
  const summary = await browserAgent.readPageSummary(session);
  const shot = await browserAgent.screenshot(session);
  const base64Data = shot.split(',')[1];
  const prompt = `Bạn đang điều khiển 1 trình duyệt thật để thực hiện: "${subtask}"
Trang hiện tại: ${summary.url} — Tiêu đề: ${summary.title}
Phần tử tương tác được:
${summary.interactive.map(e => `[${e.index}] <${e.tag}${e.type ? ' type=' + e.type : ''}> "${e.text}"`).join('\n').slice(0, 3000)}
Nội dung trang (rút gọn): """${summary.text.slice(0, 2000)}"""

Trả về JSON thuần:
{"thought":"...", "done": false, "finalAnswer": null,
 "action": {"type":"goto|click|fill|scroll|press_key|wait|go_back","url":null,"selectorText":null,"selector":null,"value":null,"inputType":null,"deltaY":800}}
Nếu việc con này đã xong, "done": true và điền "finalAnswer" tóm tắt kết quả, "action": null.`;
  const decision = await askJson(prompt, [{ inline_data: { mime_type: 'image/jpeg', data: base64Data } }]);
  return { decision, shot };
}

function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Vòng lặp chính — chạy tới khi done, cần xin phép, hết bước, hoặc lỗi.
async function runLoop(taskState, send, res) {
  let steps = taskState.steps.length;
  try {
    while (steps < MAX_STEPS) {
      steps++;
      const decision = await decideNextStep(taskState);
      send('thought', decision.thought || '');

      if (decision.done || decision.tool === 'none') {
        taskState.done = true;
        send('final', decision.finalAnswer || '(không có câu trả lời cụ thể)');
        if (taskState.browserSessionId) { await browserAgent.closeSession(taskState.browserSessionId).catch(() => {}); }
        send('done', {});
        return res.end();
      }

      if (decision.tool === 'search_web') {
        send('tool_start', { tool: 'search_web', args: decision.args });
        const text = await askWithSearch(decision.args?.query || taskState.task);
        taskState.steps.push({ tool: 'search_web', resultSummary: text.slice(0, 1500) });
        send('tool_result', { tool: 'search_web', text });
        continue;
      }

      if (decision.tool === 'browse_url') {
        send('tool_start', { tool: 'browse_url', args: decision.args });
        const url = decision.args?.url;
        if (!url) { taskState.steps.push({ tool: 'browse_url', resultSummary: 'Lỗi: thiếu url' }); send('tool_result', { tool: 'browse_url', error: 'Thiếu url' }); continue; }
        const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (My-AI Bot)' } });
        const html = await pageRes.text();
        const text = stripHtml(html);
        const answer = await askWithSearch(`Nội dung trang ${url}:\n"""${text}"""\n\nCâu hỏi: ${decision.args?.question || 'Tóm tắt nội dung chính.'}`);
        taskState.steps.push({ tool: 'browse_url', resultSummary: answer.slice(0, 1500) });
        send('tool_result', { tool: 'browse_url', text: answer, sourceUrl: url });
        continue;
      }

      if (decision.tool === 'save_file') {
        send('tool_start', { tool: 'save_file', args: decision.args });
        const content = decision.args?.content || '';
        const filename = decision.args?.filename || 'agent-output.txt';
        const base64 = Buffer.from(content, 'utf-8').toString('base64');
        const saved = saveBase64ToDisk({ base64, mimeType: 'text/plain', folder: 'agent-files', filename });
        taskState.steps.push({ tool: 'save_file', resultSummary: `Đã lưu file: ${filename}` });
        send('tool_result', { tool: 'save_file', file: saved });
        continue;
      }

      if (decision.tool === 'browser_control') {
        send('tool_start', { tool: 'browser_control', args: decision.args });
        // Mở phiên trình duyệt thật cho task này nếu chưa có (dùng chung xuyên suốt các bước sau).
        if (!taskState.browserSessionId) {
          const session = await browserAgent.createSession();
          taskState.browserSessionId = session.id;
          if (decision.args?.url) await browserAgent.performAction(session, { type: 'goto', url: decision.args.url });
        }
        const session = browserAgent.getSession(taskState.browserSessionId);
        const subtask = decision.args?.subtask || taskState.task;
        const { decision: bdec, shot } = await decideBrowserAction(session, subtask);
        send('browser_thought', bdec.thought || '');
        send('browser_screenshot', { screenshot: shot, url: session.page.url() });

        if (bdec.done || !bdec.action) {
          taskState.steps.push({ tool: 'browser_control', resultSummary: bdec.finalAnswer || 'Đã hoàn thành thao tác trên trình duyệt.' });
          send('tool_result', { tool: 'browser_control', text: bdec.finalAnswer });
          continue;
        }

        const result = await browserAgent.performAction(session, bdec.action, { force: false });
        if (result.needsApproval) {
          taskState.awaitingApproval = { action: bdec.action, subtask };
          send('needsApproval', { taskId: taskState.id, action: bdec.action, sessionId: session.id });
          return res.end(); // dừng hẳn stream — chờ người dùng gọi /resume
        }
        const newShot = await browserAgent.screenshot(session);
        send('browser_screenshot', { screenshot: newShot, url: session.page.url() });
        taskState.steps.push({ tool: 'browser_control', resultSummary: `Đã thực hiện hành động ${bdec.action.type} trên ${session.page.url()}` });
        continue;
      }

      // tool lạ không nhận diện được -> ghi log và dừng an toàn
      taskState.steps.push({ tool: decision.tool, resultSummary: 'Công cụ không hỗ trợ, bỏ qua bước này.' });
      send('tool_result', { tool: decision.tool, error: 'Công cụ không hỗ trợ' });
    }
    send('final', '⚠️ Agent đã dừng: chạy quá số bước cho phép (giới hạn an toàn).');
    send('done', {});
    res.end();
  } catch (err) {
    send('error', err.message);
    res.end();
  }
}

router.post('/run', async (req, res) => {
  const send = sseSetup(res);
  try {
    if (!API_KEY) { send('error', 'Thiếu GEMINI_API_KEY'); return res.end(); }
    const { task } = req.body || {};
    if (!task) { send('error', 'Thiếu task'); return res.end(); }
    const id = genId();
    const taskState = { id, task, steps: [], browserSessionId: null, awaitingApproval: null, done: false };
    tasks.set(id, taskState);
    send('started', { taskId: id });
    await runLoop(taskState, send, res);
  } catch (err) {
    send('error', err.message);
    res.end();
  }
});

router.post('/:id/resume', async (req, res) => {
  const send = sseSetup(res);
  try {
    const taskState = tasks.get(req.params.id);
    if (!taskState) { send('error', 'Không tìm thấy task (có thể đã hết hạn).'); return res.end(); }
    if (!taskState.awaitingApproval) { send('error', 'Task này không có hành động nào đang chờ xác nhận.'); return res.end(); }
    const { approve } = req.body || {};
    const session = browserAgent.getSession(taskState.browserSessionId);

    if (approve) {
      const result = await browserAgent.approvePending(session);
      const shot = await browserAgent.screenshot(session);
      send('browser_screenshot', { screenshot: shot, url: session.page.url() });
      taskState.steps.push({ tool: 'browser_control', resultSummary: `Người dùng đã cho phép — đã thực hiện ${result.action?.type} trên ${session.page.url()}` });
    } else {
      browserAgent.rejectPending(session);
      taskState.steps.push({ tool: 'browser_control', resultSummary: 'Người dùng đã TỪ CHỐI hành động này. Hãy thử cách khác hoặc kết thúc.' });
    }
    taskState.awaitingApproval = null;
    await runLoop(taskState, send, res);
  } catch (err) {
    send('error', err.message);
    res.end();
  }
});

router.delete('/:id', async (req, res) => {
  const taskState = tasks.get(req.params.id);
  if (taskState?.browserSessionId) await browserAgent.closeSession(taskState.browserSessionId).catch(() => {});
  tasks.delete(req.params.id);
  res.json({ closed: true });
});

module.exports = router;
