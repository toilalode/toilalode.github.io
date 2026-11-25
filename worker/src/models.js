// Danh sách model Gemini — cập nhật 25/11/2026.
// Nguồn chính thức: https://ai.google.dev/gemini-api/docs/models và /pricing
// Google đổi tên/khai tử model khá thường xuyên, nếu gặp lỗi 404 model not found
// hãy vào 2 link trên kiểm tra tên mới nhất rồi sửa lại các giá trị bên dưới.
//
// Model chat đang dùng trong app (chọn tay ở popup model):
//  - gemini-3.5-flash   : mọi người dùng được (trước đây chỉ chủ app). Thinking theo "mức nỗ lực"
//                         Thấp/Trung bình/Cao -> thinkingBudget.
//  - gemini-4-hydrogen  : Gemini 4 Hydrogen. Thinking theo thinkingLevel low/medium/high/xhigh
//                         (xhigh suy luận rất sâu => tốn nhiều token, FE có cảnh báo trước khi chọn).
//  - gemma-4-31b-it / gemma-4-26b-a4b-it : Gemma 4 chạy qua Gemini API. Thinking chỉ có BẬT/TẮT:
//                         thinkingLevel 'high' = bật, 'minimal' = tắt.
//  Đã BỎ khỏi app: gemini-3.1-flash-lite, gemini-3-flash-preview, gemini-3.1-pro-preview.
//  Các khoá chatLite/chatFast/chatSmart/chatCoding được giữ lại (nhiều file khác đang dùng) nhưng
//  đều trỏ về gemini-3.5-flash.
//
// ⚠️ Free tier: 3.5 Flash và TTS là free; model ẢNH / VIDEO KHÔNG free (cần bật billing).
//    Gemma 4 và Gemini 4 Hydrogen: kiểm tra bảng giá hiện hành trước khi mở rộng cho nhiều người dùng.
export const MODELS = {
  chatLite:    'gemini-3.5-flash',   // (cũ: gemini-3.1-flash-lite — đã bỏ)
  chatFast:    'gemini-3.5-flash',   // (cũ: gemini-3-flash-preview — đã bỏ)
  chatCoding:  'gemini-3.5-flash',   // mọi người dùng được
  chatSmart:   'gemini-3.5-flash',   // (cũ: gemini-3-flash-preview / 3.1 Pro — đã bỏ)
  chatHydrogen:   'gemini-4-hydrogen',
  chatGemmaLarge: 'gemma-4-31b-it',
  chatGemmaMoe:   'gemma-4-26b-a4b-it',
  imageGen:    'gemini-3.1-flash-image',      // ⚠️ KHÔNG free — cần bật billing (Nano Banana 2)
  imageGenPro: 'gemini-3-pro-image',          // ⚠️ KHÔNG free — cần bật billing (Nano Banana Pro)
  videoGen:    'veo-3.1-generate-001',      // ⚠️ KHÔNG free — cần bật billing. Model VIDEO thật (Veo), gọi qua
                                              // endpoint riêng :predictLongRunning (KHÔNG dùng chung endpoint
                                              // generateContent với chat/ảnh). Tên cũ "gemini-omni-flash-preview"
                                              // không tồn tại trong API của Google -> mọi request tạo video
                                              // trước đây chắc chắn lỗi 404 model not found.
  videoGenFast: 'veo-3.1-fast-generate-001', // rẻ/nhanh hơn, chất lượng thấp hơn 1 chút — dùng khi cần tốc độ
  tts:         'gemini-3.1-flash-tts-preview', // free — sửa từ tên sai "gemini-2.5-flash-tts-preview"
};

// Các model chat người dùng được phép chọn. Tên không nằm trong danh sách (kể cả tên đã bỏ mà bản
// frontend cũ còn nhớ trong localStorage) sẽ được đổi về 'auto' thay vì báo lỗi.
const CHAT_MODEL_ALLOWLIST = new Set([
  'auto',
  MODELS.chatCoding,
  MODELS.chatHydrogen,
  MODELS.chatGemmaLarge,
  MODELS.chatGemmaMoe,
]);
export function normalizeChatModel(model) {
  return CHAT_MODEL_ALLOWLIST.has(model) ? model : 'auto';
}

export const isGemmaModel = (m) => typeof m === 'string' && m.startsWith('gemma-');
export const isHydrogenModel = (m) => m === MODELS.chatHydrogen;

// Cấu hình thinking riêng cho từng dòng model (mỗi dòng dùng 1 kiểu tham số khác nhau):
//  - Gemma 4      : chỉ bật/tắt -> thinkingLevel 'high' / 'minimal'. Luôn gửi (Gemma mặc định có thể tự nghĩ,
//                   muốn tắt phải gửi 'minimal' chứ không phải bỏ trống).
//  - 4 Hydrogen   : luôn suy luận, mức do thanh nỗ lực quyết định: low | medium | high | xhigh (mặc định high).
//  - 3.5 Flash/…  : thinkingBudget theo mức Thấp/TB/Cao; chỉ gửi khi thinking bật (tránh lỗi 400 ở Auto).
// Trả về null nếu không cần gửi thinkingConfig.
const FLASH_BUDGETS = { low: 1024, medium: 8192, high: -1 };
const HYDROGEN_LEVELS = ['low', 'medium', 'high', 'xhigh'];
export function buildThinkingConfig(model, thinking, effort) {
  if (isGemmaModel(model)) return { thinkingLevel: thinking ? 'high' : 'minimal' };
  if (isHydrogenModel(model)) return { thinkingLevel: HYDROGEN_LEVELS.includes(effort) ? effort : 'high' };
  if (!thinking) return null;
  return { thinkingBudget: FLASH_BUDGETS[effort] ?? -1 }; // 'high' (hoặc giá trị lạ) = -1: model tự quyết
}

// Chế độ Auto: giờ chỉ còn 3.5 Flash là model chính (các model Lite/3 Flash/Pro đã bỏ).
export function pickAutoModel() {
  return MODELS.chatFast;
}

// ---- Fallback khi hết hạn mức (quota) ----
// Mỗi model Gemini có hạn mức request/phút + request/ngày RIÊNG, nên khi 3.5 Flash báo hết hạn mức,
// Gemma 4 rất có thể VẪN CÒN hạn mức. Auto thử lần lượt theo thứ tự dưới đây.
// KHÔNG đưa Hydrogen vào đây (tránh Auto tự tiêu token ở model đắt hơn) và không đưa model ảnh/video/TTS.
export const AUTO_FALLBACK_CHAIN = [
  MODELS.chatFast,
  MODELS.chatGemmaLarge,
  MODELS.chatGemmaMoe,
];

// Trả về danh sách model để THỬ LẦN LƯỢT ở chế độ Auto: bắt đầu bằng model pickAutoModel() chọn,
// sau đó tới các model còn lại trong AUTO_FALLBACK_CHAIN (bỏ trùng).
export function buildAutoFallbackList(firstChoice) {
  const list = [firstChoice, ...AUTO_FALLBACK_CHAIN];
  return [...new Set(list)]; // bỏ model trùng, giữ đúng thứ tự ưu tiên
}

// Nhận diện lỗi "hết hạn mức / bị giới hạn tần suất" từ phản hồi lỗi của Gemini API — để biết khi
// nào nên tự động thử model khác (khác với lỗi thật sự cần dừng lại ngay, ví dụ sai định dạng
// request, API key sai...).
export function isQuotaError(status, errBodyText = '') {
  if (status === 429) return true;
  const t = (errBodyText || '').toLowerCase();
  return t.includes('resource_exhausted') || t.includes('quota') || t.includes('rate limit')
    || t.includes('rate_limit') || t.includes('exceeded your current quota');
}
