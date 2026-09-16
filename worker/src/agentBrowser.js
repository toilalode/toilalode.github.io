// worker/src/agentBrowser.js — API cho mục riêng "Điều khiển trình duyệt thật" (bản Worker,
// dùng Cloudflare Browser Rendering thay Playwright — xem browserAgent.js để biết chi tiết).
import * as agent from './browserAgent.js';
import { MODELS } from './models.js';
import { geminiFetch } from './gemini-proxy.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function askJsonWithImage(env, prompt, base64Image) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64Image } }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const r = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.chatSmart}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 800));
  const raw = (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// POST /api/agent-browser/session  { url? } -> mở phiên mới
export async function handleCreateSession(body, env, json, cors) {
  try {
    const session = await agent.createSession(env, { url: body?.url });
    return json(session, cors);
  } catch (err) { return json({ error: err.message }, cors, 500); }
}

// GET /api/agent-browser/:id/state
export async function handleGetState(id, env, json, cors) {
  try {
    const state = await agent.getPublicState(env, id);
    const screenshot = await agent.screenshot(env, id);
    return json({ ...state, screenshot }, cors);
  } catch (err) { return json({ error: err.message }, cors, 404); }
}

// POST /api/agent-browser/:id/act  { action, force? }
export async function handleAct(id, body, env, json, cors) {
  try {
    const { action, force } = body || {};
    if (!action || !action.type) return json({ error: 'Thiếu action.type' }, cors, 400);
    const result = await agent.performAction(env, id, action, { force: !!force });
    const state = await agent.getPublicState(env, id);
    const screenshot = await agent.screenshot(env, id);
    return json({ ...state, screenshot, result }, cors);
  } catch (err) { return json({ error: err.message }, cors, 500); }
}

// POST /api/agent-browser/:id/approve
export async function handleApprove(id, env, json, cors) {
  try {
    const result = await agent.approvePending(env, id);
    const state = await agent.getPublicState(env, id);
    const screenshot = await agent.screenshot(env, id);
    return json({ ...state, screenshot, result }, cors);
  } catch (err) { return json({ error: err.message }, cors, 400); }
}

// POST /api/agent-browser/:id/reject
export async function handleReject(id, env, json, cors) {
  try {
    const result = await agent.rejectPending(env, id);
    return json({ result }, cors);
  } catch (err) { return json({ error: err.message }, cors, 400); }
}

// DELETE /api/agent-browser/:id
export async function handleClose(id, env, json, cors) {
  await agent.closeSession(env, id);
  return json({ closed: true }, cors);
}

// POST /api/agent-browser/:id/step  { task }
// AI tự nhìn ảnh chụp trang hiện tại + quyết định 1 hành động tiếp theo.
export async function handleStep(id, body, env, json, cors) {
  try {
    if (!env.GEMINI_API_KEY) return json({ error: 'Thiếu GEMINI_API_KEY' }, cors, 400);
    const { task } = body || {};
    if (!task) return json({ error: 'Thiếu task' }, cors, 400);

    const summary = await agent.readPageSummary(env, id);
    const shot = await agent.screenshot(env, id);
    const base64Data = shot.split(',')[1];

    const prompt = `Bạn là AI agent điều khiển trình duyệt thật để hoàn thành nhiệm vụ được giao.
Bạn ĐANG NHÌN THẤY ảnh chụp màn hình trang web hiện tại (đính kèm) và nội dung text trích xuất.
Nhiệm vụ: "${task}"

Trang hiện tại: ${summary.url}
Tiêu đề: ${summary.title}
Các phần tử có thể tương tác (index để tham chiếu):
${summary.interactive.map(e => `[${e.index}] <${e.tag}${e.type ? ' type=' + e.type : ''}> "${e.text}"`).join('\n').slice(0, 3000)}

Nội dung text trang (rút gọn):
"""${summary.text.slice(0, 2500)}"""

Hãy quyết định MỘT hành động tiếp theo để tiến gần hơn tới hoàn thành nhiệm vụ.
CHỈ trả về JSON thuần theo đúng schema:
{
  "thought": "suy nghĩ ngắn gọn bằng tiếng Việt",
  "done": false,
  "finalAnswer": null,
  "action": {"type":"goto|click|fill|scroll|press_key|wait|go_back","url":null,"selectorText":null,"selector":null,"value":null,"inputType":null,"deltaY":800}
}
Nếu nhiệm vụ ĐÃ hoàn thành, set "done": true, điền "finalAnswer", "action": null.
Nếu hành động tiếp theo có thể thay đổi dữ liệu thật (gửi form, mua hàng, xoá, đăng ký, thanh
toán...) vẫn cứ đề xuất bình thường — hệ thống sẽ tự hỏi người dùng xác nhận.`;

    const decision = await askJsonWithImage(env, prompt, base64Data);
    if (decision.done || !decision.action) {
      return json({ thought: decision.thought, done: true, finalAnswer: decision.finalAnswer, screenshot: shot }, cors);
    }
    const result = await agent.performAction(env, id, decision.action, { force: false });
    const newShot = await agent.screenshot(env, id);
    const state = await agent.getPublicState(env, id);
    return json({ thought: decision.thought, done: false, action: decision.action, needsApproval: result.needsApproval, screenshot: newShot, url: state.url }, cors);
  } catch (err) { return json({ error: err.message }, cors, 500); }
}
