// ===================== MCP CLIENT (Streamable HTTP transport) =====================
// Client MCP tối giản, đủ dùng để nói chuyện với 1 MCP server từ xa qua HTTP (không phải qua
// stdio/Docker — Cloudflare Worker không chạy được tiến trình con, nên CHỈ dùng được các MCP
// server hỗ trợ "remote" qua HTTP như GitHub, không dùng được các MCP server chỉ chạy qua
// Docker/npx ở máy local.
//
// Giao thức (rút gọn từ spec MCP "Streamable HTTP"):
//   1. POST { method: "initialize", ... } -> server trả về header "Mcp-Session-Id"
//   2. POST { method: "notifications/initialized" } kèm header đó (không cần đợi phản hồi có ý nghĩa)
//   3. Từ đó gọi "tools/list" / "tools/call" đều kèm header Mcp-Session-Id
// Server có thể trả JSON thường HOẶC 1 dòng SSE ("data: {...}") — hàm bên dưới xử lý cả 2 kiểu.

async function mcpRawRequest(url, token, sessionId, method, params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = { jsonrpc: '2.0', id: Date.now(), method, params: params || {} };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const newSessionId = r.headers.get('Mcp-Session-Id') || sessionId;

  const raw = await r.text();
  let data;
  if (raw.trim().startsWith('data:')) {
    // Phản hồi kiểu SSE: lấy dòng "data: {...}" cuối cùng có nội dung
    const lines = raw.split('\n').filter(l => l.startsWith('data:'));
    data = JSON.parse(lines[lines.length - 1].slice(5).trim());
  } else if (raw.trim()) {
    data = JSON.parse(raw);
  } else {
    data = {};
  }

  if (!r.ok) throw new Error(`MCP lỗi HTTP ${r.status}: ${raw.slice(0, 300)}`);
  if (data.error) throw new Error(`MCP lỗi: ${JSON.stringify(data.error).slice(0, 300)}`);
  return { result: data.result, sessionId: newSessionId };
}

// Khởi tạo phiên làm việc với 1 MCP server, trả về sessionId dùng cho các lệnh sau.
async function mcpInitialize(url, token) {
  const { result, sessionId } = await mcpRawRequest(url, token, null, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'velocitix-ai', version: '1.0.0' },
  });
  // Gửi notification xác nhận đã khởi tạo xong — 1 số server yêu cầu bước này trước khi cho gọi tiếp.
  try { await mcpRawRequest(url, token, sessionId, 'notifications/initialized', {}); } catch (e) { /* không sao nếu server không cần */ }
  return { sessionId, serverInfo: result?.serverInfo };
}

async function mcpListTools(url, token, sessionId) {
  const { result } = await mcpRawRequest(url, token, sessionId, 'tools/list', {});
  return result?.tools || [];
}

async function mcpCallTool(url, token, sessionId, name, args) {
  const { result } = await mcpRawRequest(url, token, sessionId, 'tools/call', { name, arguments: args || {} });
  // Kết quả tool trả về dạng { content: [{type:'text', text:'...'}, ...], isError?: bool }
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { text, isError: !!result?.isError, raw: result };
}

// Chuyển 1 JSON Schema (kiểu MCP dùng, chữ thường: "object","string"...) sang Schema mà Gemini
// function-calling cần (chữ HOA: "OBJECT","STRING"...) — đệ quy vì có thể lồng nhau (properties, items).
function schemaToGeminiFormat(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') { out[k] = v.toUpperCase(); continue; }
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, schemaToGeminiFormat(pv)]));
      continue;
    }
    if (k === 'items') { out[k] = schemaToGeminiFormat(v); continue; }
    // Gemini function schema không hỗ trợ 1 số ràng buộc JSON Schema nâng cao (oneOf, $ref...) —
    // bỏ qua các khoá lạ thay vì giữ nguyên để tránh Gemini từ chối cả function vì schema không hiểu.
    if (['additionalProperties', '$schema', 'oneOf', 'anyOf', 'allOf', '$ref'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// Đổi danh sách tool MCP thành "functionDeclarations" để nhét vào field `tools` của request Gemini.
function mcpToolsToGeminiDeclarations(mcpTools) {
  return mcpTools.map(t => ({
    name: t.name,
    description: (t.description || '').slice(0, 1000), // Gemini giới hạn độ dài mô tả function
    parameters: schemaToGeminiFormat(t.inputSchema || { type: 'object', properties: {} }),
  }));
}

export { mcpInitialize, mcpListTools, mcpCallTool, mcpToolsToGeminiDeclarations };
