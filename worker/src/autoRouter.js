// Bộ định tuyến cho chế độ Auto: AI chạy trên Cloudflare Workers AI (binding `AI`) đọc câu hỏi rồi
// chọn model Gemini + mức nỗ lực phù hợp. Nhẹ, nhanh, và KHÔNG tốn hạn mức Gemini.
//
// Độ khó -> lựa chọn:
//   trivial : 3.5 Flash, tắt suy luận
//   easy    : 3.5 Flash, nỗ lực thấp
//   medium  : 3.5 Flash, nỗ lực trung bình
//   hard    : 3.5 Flash, nỗ lực cao
//   expert  : 4 Hydrogen, nỗ lực cao (KHÔNG BAO GIỜ tự chọn Xhigh để khỏi đốt token)
// Lỗi / quá 3 giây -> dùng luật đoán nhanh theo độ dài và từ khoá, không bao giờ làm hỏng chat.
import { MODELS } from './models.js';

const ROUTER_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const ROUTER_TIMEOUT_MS = 3000;

const PLAN = {
  trivial: { model: MODELS.chatFast, thinking: false, effort: 'low' },
  easy:    { model: MODELS.chatFast, thinking: true,  effort: 'low' },
  medium:  { model: MODELS.chatFast, thinking: true,  effort: 'medium' },
  hard:    { model: MODELS.chatFast, thinking: true,  effort: 'high' },
  expert:  { model: MODELS.chatHydrogen, thinking: true, effort: 'high' },
};

const SYSTEM = 'Bạn là bộ phân loại độ khó của câu hỏi gửi cho một AI. Chỉ trả lời DUY NHẤT một từ trong: '
  + 'trivial, easy, medium, hard, expert.\n'
  + '- trivial: chào hỏi, câu hỏi một dòng, dịch/sửa câu ngắn.\n'
  + '- easy: hỏi đáp kiến thức thông thường, viết ngắn.\n'
  + '- medium: giải thích khái niệm, viết/sửa đoạn code nhỏ, bài tập cơ bản.\n'
  + '- hard: lập trình nhiều bước, debug, bài toán/lý nhiều bước, phân tích dài.\n'
  + '- expert: chứng minh toán, thuật toán/kiến trúc phức tạp, lập luận rất sâu hoặc nhiều ràng buộc.';

function heuristic(text, { hasAttachments, webSearch }) {
  const len = text.length;
  const codey = /```|function |class |def |bug|lỗi|debug|thuật toán|algorithm|chứng minh|tích phân|đạo hàm|phương trình/i.test(text);
  if (len < 40 && !codey && !hasAttachments) return 'trivial';
  if (/chứng minh|thuật toán|kiến trúc|tối ưu|độ phức tạp/i.test(text) && len > 400) return 'expert';
  if (codey && len > 300) return 'hard';
  if (codey || hasAttachments || webSearch || len > 400) return 'medium';
  return 'easy';
}

async function classify(env, text) {
  const run = env.AI.run(ROUTER_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: text.slice(0, 1500) },
    ],
    max_tokens: 6,
    temperature: 0,
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('router timeout')), ROUTER_TIMEOUT_MS));
  const out = await Promise.race([run, timeout]);
  const word = String(out?.response || '').toLowerCase().match(/trivial|easy|medium|hard|expert/);
  return word ? word[0] : null;
}

// Trả về { model, thinking, effort, level, source }.
export async function routeAuto(env, { text = '', hasAttachments = false, webSearch = false } = {}) {
  let level = null, source = 'cloudflare-ai';
  if (env.AI) {
    try { level = await classify(env, text); } catch (e) { console.warn('[autoRouter]', e.message); }
  }
  if (!level) { level = heuristic(text, { hasAttachments, webSearch }); source = 'heuristic'; }
  return { ...PLAN[level], level, source };
}
