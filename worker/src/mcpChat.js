// ===================== CHAT CÓ DÙNG CÔNG CỤ MCP (nhiều provider cùng lúc) =====================
// Gom TẤT CẢ MCP server mà người dùng hiện tại đã kết nối (GitHub, Cloudflare...) thành 1 bộ
// công cụ duy nhất đưa cho Gemini — Gemini tự quyết định gọi công cụ nào, gọi bao nhiêu lần.
//
// Vì đây là function-calling nhiều vòng (AI gọi tool -> đọc kết quả -> gọi tiếp hoặc trả lời),
// tính năng này chạy KHÔNG STREAM (chờ xong mới trả lời 1 lần) — đơn giản và chắc chắn đúng hơn
// nhiều so với vừa stream vừa xen kẽ function-calling trong kiến trúc stream hiện tại.

import { mcpInitialize, mcpListTools, mcpCallTool, mcpToolsToGeminiDeclarations } from './mcpClient.js';
import { geminiFetch } from './gemini-proxy.js';
import { MODELS, isQuotaError } from './models.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOOL_ROUNDS = 6; // chặn vòng lặp vô hạn nếu AI cứ gọi tool mãi không chịu trả lời

async function geminiCallWithChain(env, keyChain, body) {
  let lastErr;
  for (const key of keyChain) {
    const r = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.chatSmart}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (r.ok) return data;
    lastErr = new Error(JSON.stringify(data).slice(0, 800));
    if (!isQuotaError(r.status, JSON.stringify(data))) throw lastErr;
  }
  throw lastErr;
}

// servers: [{ provider, url, token }] — danh sách MCP server người dùng NÀY đã kết nối.
// Mỗi tool được đặt tên lại thành "<provider>__<tênToolGốc>" để tránh trùng tên giữa các
// provider khác nhau, và để biết đường định tuyến lại đúng server khi Gemini gọi tool đó.
async function runMcpChat(env, keyChain, servers, userMessage) {
  if (!servers.length) throw new Error('Bạn chưa kết nối MCP server nào trong Cài đặt.');

  const sessions = {}; // provider -> { sessionId, url, token }
  const functionDeclarations = [];
  const toolRouting = {}; // "<provider>__<tool>" -> provider

  for (const s of servers) {
    try {
      const { sessionId } = await mcpInitialize(s.url, s.token);
      sessions[s.provider] = { sessionId, url: s.url, token: s.token };
      const tools = await mcpListTools(s.url, s.token, sessionId);
      for (const decl of mcpToolsToGeminiDeclarations(tools)) {
        const prefixedName = `${s.provider}__${decl.name}`;
        functionDeclarations.push({ ...decl, name: prefixedName });
        toolRouting[prefixedName] = { provider: s.provider, originalName: decl.name };
      }
    } catch (e) {
      // 1 server lỗi (token sai/hết hạn...) không nên làm hỏng cả các server khác đã kết nối tốt.
      functionDeclarations.push(); // no-op giữ chỗ, thực ra không cần — bỏ qua server lỗi
    }
  }

  if (!functionDeclarations.length) throw new Error('Không lấy được công cụ nào từ các MCP server đã kết nối (kiểm tra lại token trong Cài đặt).');

  const contents = [{ role: 'user', parts: [{ text: userMessage }] }];
  const toolCalls = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await geminiCallWithChain(env, keyChain, {
      contents,
      tools: [{ functionDeclarations }],
      systemInstruction: {
        parts: [{ text: 'Bạn có thể dùng các công cụ được cung cấp (GitHub, Cloudflare...) để đọc/tạo/sửa nội dung theo yêu cầu người dùng. Luôn trả lời bằng tiếng Việt sau khi đã có đủ thông tin.' }],
      },
    });

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCall = parts.find(p => p.functionCall)?.functionCall;

    if (!functionCall) {
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      return { text: text || '(AI không trả về nội dung)', toolCalls };
    }

    contents.push({ role: 'model', parts: [{ functionCall }] });
    const route = toolRouting[functionCall.name];
    let toolResult;
    if (!route || !sessions[route.provider]) {
      toolResult = { text: 'Lỗi: không tìm thấy công cụ này (server có thể vừa mất kết nối).', isError: true };
    } else {
      const sess = sessions[route.provider];
      try {
        toolResult = await mcpCallTool(sess.url, sess.token, sess.sessionId, route.originalName, functionCall.args);
      } catch (e) {
        toolResult = { text: 'Lỗi khi gọi công cụ: ' + e.message, isError: true };
      }
    }
    toolCalls.push({ name: functionCall.name, args: functionCall.args, result: toolResult.text?.slice(0, 500) });
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: functionCall.name, response: { result: toolResult.text || '(không có nội dung)' } } }],
    });
  }

  return { text: '⚠️ AI gọi công cụ quá nhiều lần liên tiếp (giới hạn an toàn) mà chưa trả lời xong — thử chia nhỏ yêu cầu.', toolCalls };
}

export { runMcpChat };
