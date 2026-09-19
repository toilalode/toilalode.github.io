// Danh sách model Gemini — cập nhật 11/09/2026, tra cứu trực tiếp từ
// https://ai.google.dev/gemini-api/docs/models và
// https://ai.google.dev/gemini-api/docs/pricing (nguồn chính thức Google).
// Nếu gặp lỗi 404 model not found, kiểm tra tên mới nhất tại 2 link trên rồi sửa lại ở đây.
//
// ⚠️ QUAN TRỌNG — model nào FREE, model nào KHÔNG:
//  - Toàn bộ dòng Flash / Flash-Lite (chat) + TTS: FREE, không cần thẻ/billing.
//  - gemini-3.1-pro-preview (Pro): Google xác nhận KHÔNG có free tier từ 04/2026,
//    trả phí ngay từ request đầu tiên -> đã đổi model mặc định cho "chatSmart"
//    sang gemini-3.8-flash (free) để tránh lỗi/billing ngoài ý muốn.
//    Muốn dùng Pro thật, tự đổi lại giá trị "chatSmart" bên dưới và bật billing
//    cho project trong Google Cloud/AI Studio trước.
//  - Toàn bộ model ẢNH (Nano Banana / Nano Banana Pro) và VIDEO (Veo, Omni Flash):
//    KHÔNG có free tier -> phải bật billing (thẻ) trên Google AI Studio /
//    Google Cloud thì mới gọi được, nếu không sẽ báo lỗi 400/403.
export const MODELS = {
  chatLite:    'gemini-3.1-flash-lite',   // free — trả lời ngắn, nhanh
  chatFast:    'gemini-3-flash-preview',  // free — SỬA: model này đã xác nhận chạy được qua lựa chọn thủ công;
                                            // trước đó Auto dùng "gemini-3.8-flash" (tên chưa test, không có trong
                                            // danh sách chọn tay) khiến chỉ riêng chế độ Auto bị lỗi không trả lời.
  chatCoding:  'gemini-3.5-flash',        // free — tốt cho code
  chatSmart:   'gemini-3-flash-preview',  // free — SỬA cùng lý do như chatFast ở trên
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

export function pickAutoModel(promptText = '', { webSearch = false } = {}) {
  const t = (promptText || '').toLowerCase();
  const codingHints = ['code', 'lập trình', 'sửa lỗi', 'debug', 'hàm ', 'function',
    'html', 'css', 'javascript', 'python', 'script', 'api', 'json', 'sql'];
  const deepHints = ['phân tích', 'so sánh', 'giải thích chi tiết', 'lý luận',
    'chứng minh', 'nghiên cứu', 'chiến lược', 'đánh giá'];

  if (codingHints.some(k => t.includes(k))) return MODELS.chatCoding;
  if (webSearch || deepHints.some(k => t.includes(k)) || promptText.length > 600) return MODELS.chatSmart;
  if (promptText.length > 0 && promptText.length < 40) return MODELS.chatLite;
  return MODELS.chatFast;
}

// ---- Fallback khi hết hạn mức (quota) ----
// Mỗi model Gemini có hạn mức request/phút + request/ngày RIÊNG (không dùng chung 1 "bể" hạn mức),
// nên khi model A báo hết hạn mức, model B (khác tên) rất có thể VẪN CÒN hạn mức bình thường.
// Danh sách dưới đây là thứ tự "thử lần lượt" khi ở chế độ Auto và model đang chọn bị từ chối vì
// hết hạn mức — ưu tiên các model FREE, xếp từ "chất lượng cao -> thấp" để câu trả lời vẫn tốt
// nhất có thể trong giới hạn còn hạn mức. KHÔNG đưa model ảnh/video/TTS vào đây (khác mục đích).
export const AUTO_FALLBACK_CHAIN = [
  MODELS.chatSmart,
  MODELS.chatCoding,
  MODELS.chatFast,
  MODELS.chatLite,
];

// Trả về danh sách model để THỬ LẦN LƯỢT ở chế độ Auto: bắt đầu bằng model pickAutoModel() chọn
// (phù hợp nhất với câu hỏi), sau đó tới các model còn lại trong AUTO_FALLBACK_CHAIN (bỏ trùng).
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
