// Danh sách model Gemini cho backend Render (dùng khi chạy localhost) — đồng bộ với worker/src/models.js.
// Nguồn chính thức: https://ai.google.dev/gemini-api/docs/models và /pricing
//
//  - gemini-3.5-flash   : mọi người dùng được. Thinking = thinkingBudget theo mức Thấp/TB/Cao.
//  - gemini-4-hydrogen  : thinkingLevel low/medium/high/xhigh (xhigh tốn nhiều token).
//  - gemma-4-31b-it / gemma-4-26b-a4b-it : chỉ bật/tắt thinking (thinkingLevel 'high' / 'minimal').
//  Đã bỏ: gemini-3.1-flash-lite, gemini-3-flash-preview, gemini-3.1-pro-preview (các khoá chatLite/
//  chatFast/chatSmart/chatCoding được giữ lại cho file khác dùng nhưng đều trỏ về gemini-3.5-flash).
//
// ⚠️ Model ẢNH / VIDEO KHÔNG có free tier -> phải bật billing trên Google AI Studio / Google Cloud.
const MODELS = {
  chatLite:    'gemini-3.5-flash',
  chatFast:    'gemini-3.5-flash',
  chatCoding:  'gemini-3.5-flash',
  chatSmart:   'gemini-3.5-flash',
  chatHydrogen:   'gemini-4-hydrogen',
  chatGemmaLarge: 'gemma-4-31b-it',
  chatGemmaMoe:   'gemma-4-26b-a4b-it',
  imageGen:    'gemini-3.1-flash-image',       // ⚠️ KHÔNG free — Nano Banana 2, cần bật billing
  imageGenPro: 'gemini-3-pro-image',           // ⚠️ KHÔNG free — Nano Banana Pro, cần bật billing
  videoGen:    'gemini-omni-flash-preview',    // ⚠️ KHÔNG free — tạo video ngắn, cần bật billing
  tts:         'gemini-3.1-flash-tts-preview', // free
};

const CHAT_MODEL_ALLOWLIST = new Set([
  'auto',
  MODELS.chatCoding,
  MODELS.chatHydrogen,
  MODELS.chatGemmaLarge,
  MODELS.chatGemmaMoe,
]);
// Tên model không hợp lệ / đã bỏ -> 'auto'.
function normalizeChatModel(model) {
  return CHAT_MODEL_ALLOWLIST.has(model) ? model : 'auto';
}

const isGemmaModel = (m) => typeof m === 'string' && m.startsWith('gemma-');
const isHydrogenModel = (m) => m === MODELS.chatHydrogen;

const FLASH_BUDGETS = { low: 1024, medium: 8192, high: -1 };
const HYDROGEN_LEVELS = ['low', 'medium', 'high', 'xhigh'];
// Trả về thinkingConfig phù hợp từng dòng model, hoặc null nếu không cần gửi.
function buildThinkingConfig(model, thinking, effort) {
  if (isGemmaModel(model)) return { thinkingLevel: thinking ? 'high' : 'minimal' };
  if (isHydrogenModel(model)) return { thinkingLevel: HYDROGEN_LEVELS.includes(effort) ? effort : 'high' };
  if (!thinking) return null;
  return { thinkingBudget: FLASH_BUDGETS[effort] ?? -1 };
}

// Bộ chọn model "Auto": chỉ còn 3.5 Flash là model chính.
function pickAutoModel() {
  return MODELS.chatFast;
}

module.exports = { MODELS, pickAutoModel, normalizeChatModel, buildThinkingConfig };
