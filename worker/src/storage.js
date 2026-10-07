// ===================== LƯU FILE (KV) — KHÔNG CẦN THẺ =====================
// R2 (object storage) yêu cầu phải khai billing/thẻ ngay cả ở free tier —
// nếu bạn chưa có thẻ, dùng luôn Workers KV để lưu file (ảnh/video/audio AI
// tạo ra + file người dùng upload). KV thì KHÔNG cần thẻ, có sẵn free tier
// vĩnh viễn (1GB, không cần nâng cấp).
//
// Đánh đổi so với R2: value 1 key trong KV tối đa 25MB (base64 hoá còn ~18MB
// dữ liệu gốc), và tổng dung lượng free chỉ 1GB (thay vì 10GB của R2) — với
// app cá nhân, dùng bình thường sẽ không chạm giới hạn này. Nếu sau này có
// thẻ và muốn dung lượng lớn hơn, có thể đổi lại sang R2 (bucket.put/get)
// mà không cần sửa các route gọi hàm bên dưới.
//
// Cấu trúc key: file:<folder>/<timestamp>-<random>.<ext>
// Value: base64 của file. Metadata (loại file, tên gốc, thời gian tạo, mimeType)
// lưu kèm qua KV metadata (giới hạn 1024 byte, đủ dùng).

const FILE_PREFIX = 'file:';

// ⚠️ SECURITY FIX: Math.random() không phải nguồn ngẫu nhiên an toàn (dự đoán được nếu biết seed/
// thời điểm) — dùng cho tên file thì kẻ xấu có thể dò (brute-force) ra key của người khác rồi đọc
// trộm nếu lỡ thiếu bước kiểm tra ownership ở nơi khác. crypto.getRandomValues là nguồn ngẫu nhiên
// mật mã học thật sự, không đoán được.
function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function extFromMime(mime = '') {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'application/pdf': 'pdf',
  };
  return map[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
}

// Lưu 1 file base64 vào KV. folder ví dụ: "images", "videos", "uploads", "audio"
// ⚠️ VIDEO cụ thể: Workers KV giới hạn 1 value tối đa 25MB. Video Veo (dù chỉ vài giây,
// 720p) sau khi encode base64 (phình thêm ~33% dung lượng gốc) RẤT dễ vượt mốc này -> kv.put()
// sẽ ném lỗi ngay cả khi phần gọi Veo API đã thành công và tải video về đúng. Nếu vẫn thấy lỗi
// tạo video sau khi đã sửa model/endpoint, kiểm tra thêm lỗi cụ thể ở bước lưu này (kv.put) —
// đó là dấu hiệu cần bật billing + chuyển sang R2 thật (xem hướng dẫn đổi sang R2 ở đầu wrangler.toml)
// vì R2 không giới hạn 25MB/object.
// ⚠️ SECURITY FIX: trước đây key không gắn userId nào -> bất kỳ ai đăng nhập (hoặc chưa đăng nhập,
// do lỗ hổng ở Fix 1) đều liệt kê/xem/xoá được file của người khác nếu đoán hoặc liệt kê được key.
// Giờ bắt buộc truyền userId, lưu vào CẢ metadata lẫn làm tiền tố của key (để list theo
// prefix = userId tự động chỉ thấy file của chính mình, không cần lọc thủ công sau khi list).
async function saveBase64ToR2(env, { base64, mimeType, folder = 'files', filename, userId }) {
  const kv = env.MY_AI_KV;
  if (!kv) throw new Error('KV chưa được cấu hình (thiếu binding MY_AI_KV trong wrangler.toml)');
  if (!userId) throw new Error('Thiếu userId (nội bộ) — không được lưu file không gắn chủ sở hữu');

  const ext = extFromMime(mimeType);
  const key = `${userId}/${folder}/${Date.now()}-${randomId()}.${ext}`;
  const finalFilename = filename || key.split('/').pop();

  await kv.put(FILE_PREFIX + key, base64, {
    metadata: {
      mimeType,
      filename: finalFilename,
      folder,
      userId,
      createdAt: new Date().toISOString(),
    },
  });

  return { key, mimeType, url: `/api/files/${encodeURIComponent(key)}` };
}

// Liệt kê file (lọc theo folder qua prefix). KV list không sort theo thời gian
// sẵn -> lấy metadata rồi tự sort mới nhất lên trước.
// userId bắt buộc -> prefix luôn bị ghim vào đúng thư mục riêng của user đó, không ai liệt kê
// chéo sang thư mục user khác được (kể cả nếu route quên kiểm tra ownership ở nơi khác).
async function listR2Files(env, { prefix = '', cursor, limit = 50, userId } = {}) {
  const kv = env.MY_AI_KV;
  if (!kv) throw new Error('KV chưa được cấu hình');
  if (!userId) throw new Error('Thiếu userId (nội bộ) — không được liệt kê file không rõ chủ sở hữu');

  const listing = await kv.list({ prefix: `${FILE_PREFIX}${userId}/${prefix}`, cursor, limit });
  const files = listing.keys.map(k => {
    const key = k.name.slice(FILE_PREFIX.length);
    const meta = k.metadata || {};
    return {
      key,
      size: undefined, // KV list không trả size, không hiển thị nếu không có
      uploaded: meta.createdAt || null,
      mimeType: meta.mimeType || '',
      filename: meta.filename || key.split('/').pop(),
      folder: meta.folder || key.split('/')[1],
      url: `/api/files/${encodeURIComponent(key)}`,
    };
  });
  files.sort((a, b) => new Date(b.uploaded || 0) - new Date(a.uploaded || 0));

  return { files, cursor: listing.list_complete ? null : listing.cursor };
}

// Lấy 1 file từ KV. Trả về { base64, mimeType } thay vì stream (khác R2) —
// nơi gọi (index.js) tự dựng Response từ đây. Bắt buộc kiểm tra metadata.userId khớp người đang
// gọi TRƯỚC KHI trả dữ liệu — nếu không, ai đoán/biết được 1 key (vd lộ qua link chia sẻ, log,
// lịch sử trình duyệt) vẫn đọc được file của người khác dù đã đăng nhập bằng tài khoản riêng.
async function getR2File(env, key, { userId, isOwnerReq = false } = {}) {
  const kv = env.MY_AI_KV;
  if (!kv) throw new Error('KV chưa được cấu hình');
  const result = await kv.getWithMetadata(FILE_PREFIX + key, 'text');
  if (!result || result.value === null) return null;
  const ownerId = result.metadata?.userId;
  if (ownerId && ownerId !== userId && !isOwnerReq) return 'FORBIDDEN';
  return { base64: result.value, mimeType: result.metadata?.mimeType || 'application/octet-stream' };
}

// Xoá 1 file khỏi KV — cùng lý do, phải xác minh đúng chủ sở hữu trước khi xoá.
async function deleteR2File(env, key, { userId, isOwnerReq = false } = {}) {
  const kv = env.MY_AI_KV;
  if (!kv) throw new Error('KV chưa được cấu hình');
  const existing = await kv.getWithMetadata(FILE_PREFIX + key, 'text');
  const ownerId = existing?.metadata?.userId;
  if (existing && ownerId && ownerId !== userId && !isOwnerReq) return 'FORBIDDEN';
  await kv.delete(FILE_PREFIX + key);
  return 'OK';
}

export { saveBase64ToR2, listR2Files, getR2File, deleteR2File };
