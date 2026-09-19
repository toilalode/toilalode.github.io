// ===================== QUEUE — VIDEO GENERATE CHẠY NỀN =====================
// Vấn đề: tạo video bằng Gemini có thể mất hơn 30s, trong khi 1 request HTTP
// bình thường tới Worker có giới hạn thời gian chờ. Giải pháp:
//   1) Client gọi /api/video/generate-async -> Worker tạo 1 "job" (lưu trạng thái
//      "pending" vào KV), đẩy job đó vào Queue, trả ngay về { jobId } cho client.
//   2) Cloudflare tự động chạy hàm consumer (export "queue" trong index.js) ở
//      NỀN, không liên quan gì tới request HTTP ban đầu -> gọi Gemini thoải mái,
//      không sợ timeout.
//   3) Consumer xong việc thì lưu kết quả (video base64 + đã lưu R2) vào KV với
//      cùng jobId, trạng thái đổi thành "done" (hoặc "error" nếu thất bại).
//   4) Client cứ vài giây gọi /api/video/status/<jobId> để hỏi xong chưa
//      (gọi là "polling") — thấy trạng thái "done" thì lấy video ra dùng.

import { MODELS, isQuotaError } from './models.js';
import { saveBase64ToR2 } from './storage.js';
import { geminiFetch } from './gemini-proxy.js';
import { getGeminiKeyChain } from './geminiKeys.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const JOB_PREFIX = 'video-job:';
const JOB_TTL_SECONDS = 60 * 60 * 6; // giữ kết quả 6 tiếng rồi KV tự xoá

function jobKey(jobId) {
  return `${JOB_PREFIX}${jobId}`;
}

// Gọi từ route HTTP: tạo job mới, đẩy vào queue, trả jobId ngay
async function enqueueVideoJob(env, { prompt, durationSeconds = 5, sourceImage }, userId) {
  if (!env.MY_AI_KV) throw new Error('KV chưa được cấu hình (cần để lưu trạng thái job)');
  if (!env.VIDEO_QUEUE) throw new Error('Queue chưa được cấu hình (thiếu binding VIDEO_QUEUE)');

  const jobId = crypto.randomUUID();
  await env.MY_AI_KV.put(
    jobKey(jobId),
    JSON.stringify({ status: 'pending', createdAt: new Date().toISOString() }),
    { expirationTtl: JOB_TTL_SECONDS }
  );

  // Gửi kèm userId trong job — job này chạy nền ở consumer, KHÔNG còn quyền truy cập request
  // HTTP gốc nữa, nên phải mang userId theo từ lúc enqueue để consumer biết dùng key nào
  // (key riêng của chủ app hay xoay vòng trong pool chung).
  await env.VIDEO_QUEUE.send({ jobId, prompt, durationSeconds, sourceImage, userId });
  return { jobId, status: 'pending' };
}

// Gọi từ route HTTP: client hỏi job xong chưa
async function getVideoJobStatus(env, jobId) {
  if (!env.MY_AI_KV) throw new Error('KV chưa được cấu hình');
  const raw = await env.MY_AI_KV.get(jobKey(jobId));
  if (!raw) return { status: 'not_found' };
  return JSON.parse(raw);
}

// Gọi từ consumer (export "queue" trong index.js): thực sự xử lý 1 job video.
//
// Veo (model tạo video thật của Google) KHÔNG dùng chung endpoint generateContent với
// chat/ảnh. Nó là 1 "long-running operation" gồm 2 bước:
//   1) POST .../models/{model}:predictLongRunning  -> trả về { name: "operations/xxxxx" }
//      ngay lập tức (chưa có video), 1 khi request được Google NHẬN, không phải làm xong.
//   2) GET  .../{operation name}  (lặp lại nhiều lần, cách nhau vài giây) cho tới khi
//      response có "done": true -> lúc đó mới lấy được video trong response.generateVideoResponse.
// Vì bước 2 có thể mất 20-60+ giây (video thường lâu hơn ảnh nhiều), ta poll ngay bên trong
// consumer (Cloudflare Queue consumer không bị giới hạn timeout ngắn như 1 request HTTP thường).
async function processVideoJob(env, job) {
  const { jobId, prompt, durationSeconds, sourceImage, userId } = job;
  const keyChain = await getGeminiKeyChain(env, userId);

  try {
    if (keyChain.length === 0) throw new Error('Thiếu GEMINI_API_KEY (chưa cấu hình key nào cho tài khoản này)');

    const instance = { prompt };
    if (sourceImage) instance.image = { bytesBase64Encoded: sourceImage.base64, mimeType: sourceImage.mimeType };

    // Chọn 1 key để dùng XUYÊN SUỐT cả 2 bước (khởi tạo + poll) — operation Veo gắn với đúng
    // key/project đã khởi tạo nó, không thể đổi key giữa chừng khi đang poll. Chỉ được phép
    // đổi sang key khác trong pool nếu lỗi NGAY Ở BƯỚC KHỞI TẠO (predictLongRunning) và đúng
    // là lỗi hết hạn mức — từ bước poll trở đi phải giữ nguyên 1 key.
    let API_KEY, startData, operationName;
    let lastStartErr;
    for (const candidateKey of keyChain) {
      const startRes = await geminiFetch(env, `${GEMINI_BASE}/${MODELS.videoGen}:predictLongRunning?key=${candidateKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [instance],
          parameters: { durationSeconds: durationSeconds || 8 }, // Veo hiện chỉ nhận 4/6/8s tuỳ model, Google tự làm tròn nếu lệch
        }),
      });
      startData = await startRes.json();
      if (startRes.ok && startData.name) { API_KEY = candidateKey; operationName = startData.name; break; }
      lastStartErr = new Error(JSON.stringify(startData).slice(0, 800));
      if (!isQuotaError(startRes.status, JSON.stringify(startData))) throw lastStartErr; // lỗi khác hết hạn mức -> đổi key vô ích
      // hết hạn mức ở key này -> thử key kế tiếp trong chain
    }
    if (!operationName) throw lastStartErr || new Error('Không nhận được operation name từ Veo API: ' + JSON.stringify(startData).slice(0, 400));

    // Bước 2: poll cho tới khi xong. Veo thường mất 20-90s, tối đa đợi ~5 phút rồi báo timeout
    // để job không treo mãi (Cloudflare Queue cũng có giới hạn thời gian xử lý 1 message).
    const POLL_INTERVAL_MS = 8000;
    const MAX_WAIT_MS = 5 * 60 * 1000;
    const startedAt = Date.now();
    let opData = null;
    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
      const pollRes = await geminiFetch(env, `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${API_KEY}`, { method: 'GET' });
      opData = await pollRes.json();
      if (!pollRes.ok) throw new Error(JSON.stringify(opData).slice(0, 800));
      if (opData.done) break;
    }
    if (!opData?.done) throw new Error('Hết thời gian chờ Veo tạo video (quá 5 phút) — thử lại sau.');
    if (opData.error) throw new Error(JSON.stringify(opData.error).slice(0, 800));

    // Kết quả nằm trong opData.response.generateVideoResponse.generatedSamples[].video.uri
    // (Veo trả về URI để tải, KHÔNG trả trực tiếp base64 như model ảnh) -> cần tải về rồi encode base64.
    const samples = opData.response?.generateVideoResponse?.generatedSamples || [];
    if (!samples.length) throw new Error('Veo không trả về video nào: ' + JSON.stringify(opData).slice(0, 400));

    const videos = [];
    for (const s of samples) {
      const videoUri = s.video?.uri;
      if (!videoUri) continue;
      // File URI của Gemini cần kèm API key mới tải được
      const sep = videoUri.includes('?') ? '&' : '?';
      const fileRes = await geminiFetch(env, `${videoUri}${sep}key=${API_KEY}`, { method: 'GET' });
      if (!fileRes.ok) continue;
      const buf = await fileRes.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      videos.push({ mimeType: 'video/mp4', base64 });
    }
    if (!videos.length) throw new Error('Không tải được video nào từ URI Veo trả về.');

    for (const v of videos) {
      try {
        const saved = await saveBase64ToR2(env, { base64: v.base64, mimeType: v.mimeType, folder: 'videos' });
        v.savedUrl = saved.url;
        v.key = saved.key;
        delete v.base64; // đã lưu R2 rồi, không cần giữ base64 nặng trong KV nữa -> dùng savedUrl để tải lại
      } catch (e) { /* vẫn giữ base64 nếu lưu R2 lỗi, để client còn dùng được */ }
    }

    await env.MY_AI_KV.put(
      jobKey(jobId),
      JSON.stringify({ status: 'done', videos, model: MODELS.videoGen, finishedAt: new Date().toISOString() }),
      { expirationTtl: JOB_TTL_SECONDS }
    );
  } catch (err) {
    await env.MY_AI_KV.put(
      jobKey(jobId),
      JSON.stringify({ status: 'error', error: String(err.message || err), finishedAt: new Date().toISOString() }),
      { expirationTtl: JOB_TTL_SECONDS }
    );
    throw err; // ném lại để Cloudflare Queue tự retry theo cấu hình max_retries trong wrangler.toml
  }
}

// Chuyển ArrayBuffer (video tải về) sang base64 — làm theo khối nhỏ để tránh
// tràn stack với "String.fromCharCode(...bytes)" trên file lớn.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export { enqueueVideoJob, getVideoJobStatus, processVideoJob };
