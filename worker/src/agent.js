// worker/src/agent.js — AGENT MODE (bản Worker): agent đa công cụ, khác Deep Research.
// Deep Research (search.js/deep-research trong index.js) chỉ đọc/tổng hợp web.
// Agent Mode tự chọn công cụ mỗi bước: search_web, browse_url, save_file, hoặc browser_control
// (mở trình duyệt thật qua Cloudflare Browser Rendering — dùng chung engine với browserAgent.js —
// và LUÔN dừng lại xin phép trước hành động nhạy cảm).
import * as browserAgent from './browserAgent.js';
import { saveBase64ToR2 } from './storage.js';
import { MODELS } from './models.js';
import { geminiFetch } from './gemini-proxy.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_STEPS = 15;
const KV_PREFIX = 'agent-task:';
const TASK_TTL_SECONDS = 30 * 60;

async function loadTask(env, id) {
  const raw = await env.MY_AI_KV.get(KV_PREFIX + id);
  if (!raw) throw new Error('Không tìm thấy task (có thể đã hết hạn).');
  return JSON.parse(raw);
}
async function saveTask(env, taskState) {
  await env.MY_AI_KV.put(KV_PREFIX + taskState.id, JSON.stringify(taskState), { expirationTtl: TASK_TTL_SECONDS });
}
function genId() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

async function askJson(env, prompt) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } };
  const r = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.chatSmart}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 800));
  const raw = (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

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

async function askWithSearch(env, query) {
  const body = { contents: [{ role: 'user', parts: [{ text: query }] }], tools: [{ google_search: {} }] };
  const r = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.chatSmart}:generateContent?key=${env.GEMINI_API_KEY}`, {
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

async function decideNextStep(env, taskState) {
  const prompt = `Bạn là Agent Mode — AI agent ĐA CÔNG CỤ, khác Deep Research (Deep Research chỉ tìm & đọc web).
Bạn có thể: tìm kiếm web, đọc kỹ 1 trang cụ thể, LƯU FILE kết quả, hoặc — khi nhiệm vụ cần thao
tác thật trên 1 trang (điền form, bấm nút, đặt lịch, mua hàng...) — điều khiển 1 TRÌNH DUYỆT THẬT.

Nhiệm vụ: "${taskState.task}"
Lịch sử các bước đã làm:
${historyText(taskState.steps)}

Chọn CHÍNH XÁC MỘT hành động tiếp theo. Trả về JSON thuần:
{
  "thought": "...", "done": false, "finalAnswer": null,
  "tool": "search_web|browse_url|browser_control|save_file|none",
  "args": {"query":"...", "url":"...", "question":"...", "subtask":"...", "filename":"...", "content":"..."}
}
Nếu đã đủ thông tin để trả lời, "done": true, điền "finalAnswer" đầy đủ bằng tiếng Việt, "tool": "none".
CHỈ dùng "browser_control" khi thực sự cần THAO TÁC trên trang, không chỉ đọc.`;
  return askJson(env, prompt);
}

async function decideBrowserAction(env, sessionId, subtask) {
  const summary = await browserAgent.readPageSummary(env, sessionId);
  const shot = await browserAgent.screenshot(env, sessionId);
  const base64Data = shot.split(',')[1];
  const prompt = `Bạn đang điều khiển 1 trình duyệt thật để thực hiện: "${subtask}"
Trang hiện tại: ${summary.url} — Tiêu đề: ${summary.title}
Phần tử tương tác được:
${summary.interactive.map(e => `[${e.index}] <${e.tag}${e.type ? ' type=' + e.type : ''}> "${e.text}"`).join('\n').slice(0, 3000)}
Nội dung trang (rút gọn): """${summary.text.slice(0, 2000)}"""

Trả về JSON thuần:
{"thought":"...", "done": false, "finalAnswer": null,
 "action": {"type":"goto|click|fill|scroll|press_key|wait|go_back","url":null,"selectorText":null,"selector":null,"value":null,"inputType":null,"deltaY":800}}
Nếu việc con này đã xong, "done": true, điền "finalAnswer", "action": null.`;
  const decision = await askJsonWithImage(env, prompt, base64Data);
  return { decision, shot };
}

async function runLoop(taskState, env, send) {
  let steps = taskState.steps.length;
  while (steps < MAX_STEPS) {
    steps++;
    const decision = await decideNextStep(env, taskState);
    await send('thought', decision.thought || '');

    if (decision.done || decision.tool === 'none') {
      taskState.done = true;
      await send('final', decision.finalAnswer || '(không có câu trả lời cụ thể)');
      if (taskState.browserSessionId) await browserAgent.closeSession(env, taskState.browserSessionId).catch(() => {});
      await saveTask(env, taskState);
      await send('done', {});
      return;
    }

    if (decision.tool === 'search_web') {
      await send('tool_start', { tool: 'search_web', args: decision.args });
      const text = await askWithSearch(env, decision.args?.query || taskState.task);
      taskState.steps.push({ tool: 'search_web', resultSummary: text.slice(0, 1500) });
      await send('tool_result', { tool: 'search_web', text });
      continue;
    }

    if (decision.tool === 'browse_url') {
      await send('tool_start', { tool: 'browse_url', args: decision.args });
      const url = decision.args?.url;
      if (!url) { taskState.steps.push({ tool: 'browse_url', resultSummary: 'Lỗi: thiếu url' }); await send('tool_result', { tool: 'browse_url', error: 'Thiếu url' }); continue; }
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (My-AI Bot)' } });
      const html = await pageRes.text();
      const text = stripHtml(html);
      const answer = await askWithSearch(env, `Nội dung trang ${url}:\n"""${text}"""\n\nCâu hỏi: ${decision.args?.question || 'Tóm tắt nội dung chính.'}`);
      taskState.steps.push({ tool: 'browse_url', resultSummary: answer.slice(0, 1500) });
      await send('tool_result', { tool: 'browse_url', text: answer, sourceUrl: url });
      continue;
    }

    if (decision.tool === 'save_file') {
      await send('tool_start', { tool: 'save_file', args: decision.args });
      const content = decision.args?.content || '';
      const filename = decision.args?.filename || 'agent-output.txt';
      const base64 = btoa(unescape(encodeURIComponent(content)));
      const saved = await saveBase64ToR2(env, { base64, mimeType: 'text/plain', filename, folder: 'agent-files' });
      taskState.steps.push({ tool: 'save_file', resultSummary: `Đã lưu file: ${filename}` });
      await send('tool_result', { tool: 'save_file', file: saved });
      continue;
    }

    if (decision.tool === 'browser_control') {
      await send('tool_start', { tool: 'browser_control', args: decision.args });
      if (!taskState.browserSessionId) {
        const session = await browserAgent.createSession(env, { url: decision.args?.url });
        taskState.browserSessionId = session.id;
      }
      const subtask = decision.args?.subtask || taskState.task;
      const { decision: bdec, shot } = await decideBrowserAction(env, taskState.browserSessionId, subtask);
      await send('browser_thought', bdec.thought || '');
      await send('browser_screenshot', { screenshot: shot });

      if (bdec.done || !bdec.action) {
        taskState.steps.push({ tool: 'browser_control', resultSummary: bdec.finalAnswer || 'Đã hoàn thành thao tác trên trình duyệt.' });
        await send('tool_result', { tool: 'browser_control', text: bdec.finalAnswer });
        continue;
      }

      const result = await browserAgent.performAction(env, taskState.browserSessionId, bdec.action, { force: false });
      if (result.needsApproval) {
        taskState.awaitingApproval = { action: bdec.action, subtask };
        await saveTask(env, taskState);
        await send('needsApproval', { taskId: taskState.id, action: bdec.action, sessionId: taskState.browserSessionId });
        return;
      }
      const newShot = await browserAgent.screenshot(env, taskState.browserSessionId);
      await send('browser_screenshot', { screenshot: newShot });
      taskState.steps.push({ tool: 'browser_control', resultSummary: `Đã thực hiện hành động ${bdec.action.type}` });
      continue;
    }

    taskState.steps.push({ tool: decision.tool, resultSummary: 'Công cụ không hỗ trợ, bỏ qua bước này.' });
    await send('tool_result', { tool: decision.tool, error: 'Công cụ không hỗ trợ' });
  }
  await send('final', '⚠️ Agent đã dừng: chạy quá số bước cho phép (giới hạn an toàn).');
  await saveTask(env, taskState);
  await send('done', {});
}

function sseResponse(cors, work, ctx) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event, data) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const job = (async () => {
    try { await work(send); } catch (err) { try { await send('error', err.message); } catch (_) {} }
    try { await writer.close(); } catch (_) {}
  })();
  ctx.waitUntil(job);
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors } });
}

// POST /api/agent/run { task }
export function handleRun(body, env, cors, ctx) {
  return sseResponse(cors, async (send) => {
    if (!env.GEMINI_API_KEY) { await send('error', 'Thiếu GEMINI_API_KEY'); return; }
    const { task } = body || {};
    if (!task) { await send('error', 'Thiếu task'); return; }
    const id = genId();
    const taskState = { id, task, steps: [], browserSessionId: null, awaitingApproval: null, done: false };
    await saveTask(env, taskState);
    await send('started', { taskId: id });
    await runLoop(taskState, env, send);
  }, ctx);
}

// POST /api/agent/:id/resume { approve }
export function handleResume(id, body, env, cors, ctx) {
  return sseResponse(cors, async (send) => {
    let taskState;
    try { taskState = await loadTask(env, id); } catch (e) { await send('error', e.message); return; }
    if (!taskState.awaitingApproval) { await send('error', 'Task này không có hành động nào đang chờ xác nhận.'); return; }
    const { approve } = body || {};
    if (approve) {
      const result = await browserAgent.approvePending(env, taskState.browserSessionId);
      const shot = await browserAgent.screenshot(env, taskState.browserSessionId);
      await send('browser_screenshot', { screenshot: shot });
      taskState.steps.push({ tool: 'browser_control', resultSummary: `Người dùng đã cho phép — đã thực hiện ${result.action?.type}` });
    } else {
      await browserAgent.rejectPending(env, taskState.browserSessionId);
      taskState.steps.push({ tool: 'browser_control', resultSummary: 'Người dùng đã TỪ CHỐI hành động này. Hãy thử cách khác hoặc kết thúc.' });
    }
    taskState.awaitingApproval = null;
    await runLoop(taskState, env, send);
  }, ctx);
}

// DELETE /api/agent/:id
export async function handleDeleteTask(id, env, json, cors) {
  try {
    const taskState = await loadTask(env, id);
    if (taskState.browserSessionId) await browserAgent.closeSession(env, taskState.browserSessionId).catch(() => {});
  } catch (_) {}
  await env.MY_AI_KV.delete(KV_PREFIX + id);
  return json({ closed: true }, cors);
}
