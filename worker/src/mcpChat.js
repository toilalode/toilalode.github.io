// ===================== CHAT CÓ DÙNG CÔNG CỤ MCP (nhiều provider cùng lúc) =====================
// Gom TẤT CẢ MCP server mà người dùng hiện tại đã kết nối (GitHub, Cloudflare...) thành 1 bộ
// công cụ duy nhất đưa cho Gemini — Gemini tự quyết định gọi công cụ nào, gọi bao nhiêu lần.
//
// Vì đây là function-calling nhiều vòng (AI gọi tool -> đọc kết quả -> gọi tiếp hoặc trả lời),
// tính năng này chạy KHÔNG STREAM (chờ xong mới trả lời 1 lần) — đơn giản và chắc chắn đúng hơn
// nhiều so với vừa stream vừa xen kẽ function-calling trong kiến trúc stream hiện tại.
//
// ⚠️ CỔNG XÁC NHẬN cho hành động KHÔNG THỂ HOÀN TÁC: 1 số tool GitHub (xoá repo, thu hồi quyền
// truy cập, merge PR, xoá nhánh/file/webhook, gỡ cộng tác viên...) không được phép tự thực thi
// ngay khi AI quyết định gọi — dừng lại, lưu tạm state hội thoại vào KV, trả về cho frontend biết
// "cần xác nhận", CHỈ thực thi thật khi người dùng bấm đồng ý ở endpoint /api/mcp/chat/confirm.

import { mcpInitialize, mcpListTools, mcpCallTool, mcpToolsToGeminiDeclarations } from './mcpClient.js';
import { GITHUB_NATIVE_TOOLS, callGithubNativeTool } from './githubNativeTools.js';
import { geminiFetch } from './gemini-proxy.js';
import { MODELS, isQuotaError } from './models.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOOL_ROUNDS = 6; // chặn vòng lặp vô hạn nếu AI cứ gọi tool mãi không chịu trả lời
const PENDING_TTL_SECONDS = 600; // 10 phút để người dùng bấm xác nhận, hết hạn thì phải hỏi lại

// Tăng số này mỗi khi sửa schema tool (thêm/bớt/đổi tool trong GITHUB_NATIVE_TOOLS hoặc cách
// mcpToolsToGeminiDeclarations dịch tool) — cache KV cũ (còn tới 30 phút) sẽ tự động bị bỏ qua
// thay vì phục vụ schema cũ cho user cho tới khi hết hạn tự nhiên. Không cần xoá KV thủ công.
const TOOLS_VERSION = 3;

// Tên tool GỐC (chưa có tiền tố provider__) coi là không thể hoàn tác — luôn cần xác nhận thủ
// công trước khi thực thi, bất kể provider nào gọi tới (hiện chỉ GitHub native có các tool này).
const IRREVERSIBLE_TOOLS = new Set([
  'delete_repo',
  'revoke_access',
  'merge_pull_request',
  'delete_branch',
  'delete_file',
  'delete_webhook',
  'remove_collaborator',
]);

// Mô tả ngắn gọn bằng tiếng Việt để hiển thị cho người dùng trong hộp thoại xác nhận — dựa trên
// args thật của lệnh gọi, không phải mô tả chung chung, để người dùng biết chính xác chuyện gì
// sắp xảy ra trước khi bấm đồng ý.
function describeIrreversibleAction(originalName, args = {}) {
  switch (originalName) {
    case 'delete_repo':
      return `XOÁ VĨNH VIỄN repo ${args.owner}/${args.repo}. Không thể hoàn tác.`;
    case 'revoke_access':
      return `THU HỒI quyền truy cập GitHub hiện tại — mọi token đang dùng sẽ bị vô hiệu hoá ngay lập tức, cần kết nối lại mới dùng được tiếp.`;
    case 'merge_pull_request':
      return `MERGE pull request #${args.pull_number} vào nhánh base của repo ${args.owner}/${args.repo}.`;
    case 'delete_branch':
      return `XOÁ nhánh "${args.branch}" khỏi repo ${args.owner}/${args.repo}.`;
    case 'delete_file':
      return `XOÁ file "${args.path}" khỏi repo ${args.owner}/${args.repo}${args.branch ? ` (nhánh ${args.branch})` : ''}.`;
    case 'delete_webhook':
      return `XOÁ webhook #${args.hook_id} khỏi repo ${args.owner}/${args.repo}.`;
    case 'remove_collaborator':
      return `GỠ "${args.username}" khỏi danh sách cộng tác viên của repo ${args.owner}/${args.repo}.`;
    default:
      return `Thực hiện hành động "${originalName}" không thể hoàn tác.`;
  }
}

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

// Cache danh sách tool 30 phút/provider (không cache riêng theo user vì schema tool KHÔNG phụ
// thuộc vào ai gọi, chỉ phụ thuộc vào chính server đó) — tránh phải initialize + list lại từ đầu
// ở MỌI tin nhắn, vừa nhanh hơn vừa đỡ bị lỗi vặt (timeout, rớt mạng...) mỗi lần chat.
async function getCachedToolDeclarations(env, provider, url, token, isNative) {
  const cacheKey = `mcp-tools-cache:${provider}:v${TOOLS_VERSION}`;
  const kv = env.MY_AI_KV;
  if (kv) {
    const cached = await kv.get(cacheKey, 'json');
    if (cached) return cached;
  }
  let declarations;
  if (isNative) {
    declarations = GITHUB_NATIVE_TOOLS;
  } else {
    const { sessionId } = await mcpInitialize(url, token);
    const tools = await mcpListTools(url, token, sessionId);
    declarations = mcpToolsToGeminiDeclarations(tools);
  }
  if (kv) await kv.put(cacheKey, JSON.stringify(declarations), { expirationTtl: 1800 });
  return declarations;
}

// Dựng lại { sessions, functionDeclarations, toolRouting } từ danh sách server đã kết nối —
// dùng chung cho cả lượt chat đầu tiên (runMcpChat) và lượt tiếp tục sau xác nhận (resumeMcpChat).
async function buildToolContext(env, servers) {
  const sessions = {};
  const functionDeclarations = [];
  const toolRouting = {};
  const initErrors = [];

  for (const s of servers) {
    try {
      sessions[s.provider] = { native: !!s.native, url: s.url, token: s.token };
      const declarations = await getCachedToolDeclarations(env, s.provider, s.url, s.token, s.native);
      for (const decl of declarations) {
        const prefixedName = `${s.provider}__${decl.name}`;
        functionDeclarations.push({ ...decl, name: prefixedName });
        toolRouting[prefixedName] = { provider: s.provider, originalName: decl.name };
      }
    } catch (e) {
      // 1 server lỗi (token sai/hết hạn...) không nên làm hỏng cả các server khác đã kết nối tốt,
      // nhưng vẫn phải GIỮ LẠI lỗi thật để báo cho người dùng biết chính xác — trước đây bỏ qua
      // hoàn toàn khiến lỗi "biến mất", chỉ còn thông báo chung chung không biết sửa gì.
      initErrors.push(`${s.provider}: ${e.message}`);
    }
  }

  if (!functionDeclarations.length) {
    const detail = initErrors.length ? '\n\nChi tiết lỗi:\n' + initErrors.join('\n') : '';
    throw new Error('Không lấy được công cụ nào từ các MCP server đã kết nối.' + detail);
  }

  return { sessions, functionDeclarations, toolRouting };
}

// Thực thi 1 lệnh gọi tool THẬT (đã qua cổng xác nhận nếu cần) và trả về { text, isError }.
async function executeToolCall(env, sessions, route, functionCall) {
  const sess = sessions[route?.provider];
  if (!route || !sess) {
    return { text: 'Lỗi: không tìm thấy công cụ này (server có thể vừa mất kết nối).', isError: true };
  }
  if (sess.native) {
    return await callGithubNativeTool(sess.token, route.originalName, functionCall.args, env);
  }
  try {
    // Khởi tạo phiên MỚI ngay trước khi gọi tool thật (không dùng lại session cũ) — vì phần
    // liệt kê tool giờ được cache (có thể từ lần chat trước, session cũ đã hết hạn từ lâu).
    // Việc này chỉ tốn 1 lượt gọi HTTP tới MCP server, không tốn thêm token Gemini nào.
    const { sessionId } = await mcpInitialize(sess.url, sess.token);
    return await mcpCallTool(sess.url, sess.token, sessionId, route.originalName, functionCall.args);
  } catch (e) {
    return { text: 'Lỗi khi gọi công cụ: ' + e.message, isError: true };
  }
}

// Vòng lặp function-calling chính, dùng chung cho cả lượt đầu và lượt tiếp tục sau xác nhận.
// approvedCallId: id của lệnh gọi VỪA được người dùng đồng ý ở vòng này (bỏ qua cổng xác nhận
// cho đúng 1 lệnh đó) — mọi lệnh irreversible KHÁC xuất hiện sau đó trong cùng phiên vẫn phải
// hỏi lại, không "tự động đồng ý" hàng loạt.
async function runToolLoop(env, keyChain, ctx, contents, toolCalls, startRound, approvedCallId) {
  const { sessions, functionDeclarations, toolRouting } = ctx;

  for (let round = startRound; round < MAX_TOOL_ROUNDS; round++) {
    const data = await geminiCallWithChain(env, keyChain, {
      contents,
      tools: [{ functionDeclarations }],
      systemInstruction: {
        parts: [{ text: 'Bạn có thể dùng các công cụ được cung cấp (GitHub, Cloudflare...) để đọc/tạo/sửa nội dung theo yêu cầu người dùng. Luôn trả lời bằng tiếng Việt sau khi đã có đủ thông tin.' }],
      },
    });

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCallPart = parts.find(p => p.functionCall);
    const functionCall = functionCallPart?.functionCall;

    if (!functionCall) {
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      return { done: true, result: { text: text || '(AI không trả về nội dung)', toolCalls } };
    }

    // ⚠️ Phải đẩy lại NGUYÊN VẸN cả part (gồm cả "thoughtSignature" nếu Gemini có kèm theo), chứ
    // không chỉ mỗi functionCall — model 3.x mới bắt buộc phải thấy lại đúng thoughtSignature ở
    // lượt sau, thiếu là bị lỗi 400 "Function call is missing a thought_signature".
    contents.push({ role: 'model', parts: [functionCallPart] });
    const route = toolRouting[functionCall.name];

    const callId = `${round}:${functionCall.name}`;
    const needsGate = route && IRREVERSIBLE_TOOLS.has(route.originalName) && callId !== approvedCallId;
    if (needsGate) {
      // Dừng NGAY tại đây — chưa thêm functionResponse, chưa gọi tool thật. Lưu lại toàn bộ
      // "contents" (đã có sẵn functionCallPart vừa push ở trên) để lượt xác nhận sau tiếp tục
      // đúng ngay chỗ này mà không cần Gemini "nghĩ lại" từ đầu.
      return {
        done: false,
        pending: {
          callId,
          toolLabel: functionCall.name,
          originalName: route.originalName,
          args: functionCall.args,
          description: describeIrreversibleAction(route.originalName, functionCall.args),
          round,
          contents,
          toolCalls,
        },
      };
    }

    const toolResult = await executeToolCall(env, sessions, route, functionCall);
    toolCalls.push({ name: functionCall.name, args: functionCall.args, result: toolResult.text?.slice(0, 500) });
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: functionCall.name, response: { result: toolResult.text || '(không có nội dung)' } } }],
    });
  }

  return { done: true, result: { text: '⚠️ AI gọi công cụ quá nhiều lần liên tiếp (giới hạn an toàn) mà chưa trả lời xong — thử chia nhỏ yêu cầu.', toolCalls } };
}

// servers: [{ provider, url, token }] — danh sách MCP server người dùng NÀY đã kết nối.
// Mỗi tool được đặt tên lại thành "<provider>__<tênToolGốc>" để tránh trùng tên giữa các
// provider khác nhau, và để biết đường định tuyến lại đúng server khi Gemini gọi tool đó.
//
// Trả về MỘT trong hai dạng:
//   { text, toolCalls }                          — đã trả lời xong, không cần xác nhận gì thêm
//   { needsConfirmation: true, confirmId, ... }   — có lệnh nguy hiểm đang chờ người dùng đồng ý
async function runMcpChat(env, keyChain, servers, userMessage, userId) {
  if (!servers.length) throw new Error('Bạn chưa kết nối MCP server nào trong Cài đặt.');

  const ctx = await buildToolContext(env, servers);
  const contents = [{ role: 'user', parts: [{ text: userMessage }] }];

  const outcome = await runToolLoop(env, keyChain, ctx, contents, [], 0, null);
  if (outcome.done) return outcome.result;

  return await stashPendingAndRespond(env, userId, servers, outcome.pending);
}

// Ghi 1 dòng vào mcp_tool_audit_log — best-effort: lỗi ghi log KHÔNG được làm hỏng luồng chat
// chính (người dùng vẫn cần thấy kết quả tool dù việc log có trục trặc), nên chỉ log lỗi ra
// console chứ không throw.
async function writeAuditLog(env, userId, provider, toolName, args, decision, resultText, isError) {
  if (!env.MY_AI_DB) return;
  try {
    await env.MY_AI_DB.prepare(
      `INSERT INTO mcp_tool_audit_log (id, user_id, provider, tool_name, args_json, decision, result_text, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), userId, provider, toolName,
      JSON.stringify(args || {}), decision,
      resultText ? String(resultText).slice(0, 2000) : null,
      isError ? 1 : 0,
    ).run();
  } catch (e) {
    console.error('Ghi audit log thất bại (không ảnh hưởng chat):', e.message);
  }
}

// Được gọi khi người dùng bấm "Đồng ý" / "Huỷ" trên hộp xác nhận ở frontend.
//   approve = true  -> thực thi đúng lệnh đang chờ, rồi cho Gemini tiếp tục như bình thường
//   approve = false -> KHÔNG gọi tool, báo cho Gemini biết người dùng đã từ chối, để nó tự phản hồi
async function resumeMcpChat(env, keyChain, userId, confirmId, approve) {
  const kv = env.MY_AI_KV;
  const raw = kv && (await kv.get(`mcp-pending-tool:${confirmId}`));
  if (!raw) throw new Error('Yêu cầu xác nhận đã hết hạn hoặc không tồn tại — hãy thử lại thao tác từ đầu.');
  await kv.delete(`mcp-pending-tool:${confirmId}`);

  const saved = JSON.parse(raw);
  if (saved.userId !== userId) throw new Error('Không có quyền xác nhận yêu cầu này.');

  const ctx = await buildToolContext(env, saved.servers);
  const { contents, toolCalls, callId, round } = saved.pending;
  const route = ctx.toolRouting[saved.pending.toolLabel];

  if (!approve) {
    await writeAuditLog(env, userId, route?.provider || '?', saved.pending.originalName, saved.pending.args, 'rejected', null, false);
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: saved.pending.toolLabel, response: { result: 'Người dùng đã TỪ CHỐI thực hiện hành động này. Không được thử gọi lại công cụ này nữa trong lượt trả lời này — hãy giải thích ngắn gọn cho người dùng rằng hành động đã bị huỷ.' } } }],
    });
    const outcome = await runToolLoop(env, keyChain, ctx, contents, round + 1, null);
    if (outcome.done) return outcome.result;
    return await stashPendingAndRespond(env, userId, saved.servers, outcome.pending);
  }

  // Đồng ý: chạy lại đúng vòng lặp bắt đầu từ round hiện tại, với callId được đánh dấu "đã duyệt"
  // để executeToolCall lần này KHÔNG bị cổng xác nhận chặn lại nữa — nhưng mọi lệnh nguy hiểm
  // tiếp theo (nếu AI gọi thêm) vẫn phải hỏi lại từ đầu, không tự động lan sang lệnh khác.
  const functionCall = { name: saved.pending.toolLabel, args: saved.pending.args };
  const toolResult = await executeToolCall(env, ctx.sessions, route, functionCall);
  await writeAuditLog(env, userId, route?.provider || '?', saved.pending.originalName, saved.pending.args, 'approved', toolResult.text, !!toolResult.isError);
  toolCalls.push({ name: functionCall.name, args: functionCall.args, result: toolResult.text?.slice(0, 500) });
  contents.push({
    role: 'user',
    parts: [{ functionResponse: { name: functionCall.name, response: { result: toolResult.text || '(không có nội dung)' } } }],
  });

  const outcome = await runToolLoop(env, keyChain, ctx, contents, round + 1, null);
  if (outcome.done) return outcome.result;
  return await stashPendingAndRespond(env, userId, saved.servers, outcome.pending);
}

async function stashPendingAndRespond(env, userId, servers, pending) {
  const kv = env.MY_AI_KV;
  const confirmId = crypto.randomUUID();
  if (kv) {
    await kv.put(
      `mcp-pending-tool:${confirmId}`,
      JSON.stringify({ userId, servers, pending }),
      { expirationTtl: PENDING_TTL_SECONDS },
    );
  }
  return {
    needsConfirmation: true,
    confirmId,
    tool: pending.toolLabel,
    description: pending.description,
    args: pending.args,
    toolCalls: pending.toolCalls,
  };
}

export { runMcpChat, resumeMcpChat };
