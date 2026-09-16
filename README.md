# Velocitix-AI
- Mở web tại :
- https://toilalode.github.io

## Cài đặt

```bash
cd Velocitix-AI
npm install
cp .env.example .env
```

Mở file `.env`, dán API key free của bạn (lấy tại https://aistudio.google.com/apikey):

```
GEMINI_API_KEY=AIza...
```

Chạy:

```bash
npm start
```

Mở trình duyệt: `http://localhost:3000`

## Cấu trúc

```
Velocitix-AI/
├── backend/
│   ├── server.js         # Express server, gộp toàn bộ route
│   ├── config/models.js  # Tên model Gemini + logic Auto model
│   ├── routes/
│   │   ├── chat.js         # Chat streaming (SSE), thinking toggle, web search
│   │   ├── image.js        # Tạo ảnh (Nano Banana 2 / Pro)
│   │   ├── video.js        # Tạo video ngắn (Gemini Omni Flash)
│   │   ├── tts.js          # Text -> giọng nói
│   │   ├── search.js       # /browse = mục "Mở web & hỏi AI" (1 URL, chỉ đọc) + /deep-research = Deep Research nhiều bước (chỉ đọc)
│   │   ├── agent.js        # Agent Mode: agent đa công cụ, tự mở trình duyệt THẬT (thao tác được) khi cần
│   │   ├── agentBrowser.js # API cho tab con "🌍 Trình duyệt thật" trong Agent Mode (Playwright)
│   │   ├── files.js        # Danh sách/tải file đã tạo
│   │   └── upload.js       # Upload file/ảnh/video
│   ├── utils/
│   │   ├── browserAgent.js # Quản lý phiên trình duyệt thật (Playwright) + cơ chế xin phép hành động nhạy cảm
│   │   └── storage.js      # Lưu file vào ổ đĩa cục bộ (backend/uploads/)
│   └── uploads/          # File tạm khi upload / file agent tạo ra
├── frontend/
│   ├── index.html        # Toàn bộ giao diện (sidebar + các panel)
│   ├── style.css
│   └── app.js
├── worker/               # Bản deploy free trên Cloudflare Workers (xem phần Deploy bên dưới)
├── .env.example
├── package.json
└── README.md
```

## Các nút / tính năng trong giao diện

| Nút | Hoạt động |
|---|---|
| 💬 Chat | Chat streaming thật, chọn model tay hoặc **Auto**; có thể bật 🔎 Deep Research cho tin nhắn tiếp theo ngay trong Chat |
| 💻 Code Editor | Ô code + ô yêu cầu, nhờ AI viết/sửa code, copy/tải về |
| 🚀 **Agent Mode** | Mục **duy nhất điều khiển trình duyệt THẬT (Playwright)**, có 2 tab con ngay trong panel: <br>• **🚀 Tự động** — bạn chỉ giao nhiệm vụ, agent đa công cụ tự lên kế hoạch nhiều bước, tự chọn công cụ ở từng bước (tìm web, đọc 1 trang, lưu file), và **khi phát hiện cần THAO TÁC thật** (điền form, bấm nút, đặt lịch, mua hàng...) thì tự mở trình duyệt thật ngay tại đây. <br>• **🌍 Trình duyệt thật** — dùng khi **bạn đã biết chắc ngay từ đầu** cần thao tác trên web: nhập URL trang bạn muốn rồi bấm **↪ Đi tới** để điều hướng thẳng tới đó ngay lập tức (dùng được cả khi phiên đang chạy, không chỉ lúc mở đầu), nhập nhiệm vụ rồi bấm 🚀 để agent tự thao tác, và **màn hình sandbox bên cạnh luôn hiện screenshot cập nhật theo từng bước** để bạn xem trực tiếp agent đang làm gì. <br>Cả 2 tab đều luôn dừng lại xin phép trước hành động nhạy cảm (`backend/routes/agent.js`, `backend/routes/agentBrowser.js`) |
| 🧭 **Mở web & hỏi AI** | Mục riêng trong sidebar, **chỉ đọc — không thao tác gì cả**: bạn dán sẵn 1 URL, trang được mở trực tiếp trong khung sandbox (iframe) để bạn tự xem, đồng thời backend tải nội dung trang về cho AI đọc và trả lời câu hỏi của bạn về đúng trang đó. Không tự tìm nhiều trang như Deep Research, không click/điền/gửi gì như Agent Mode (`backend/routes/search.js`, hàm `/browse`) |
| 🔎 Deep Research | **Không có nút riêng trong sidebar** — chỉ đọc/tìm kiếm nhiều trang, tự chia nhỏ câu hỏi, tra cứu web nhiều bước rồi tổng hợp báo cáo. Không bao giờ thao tác trên trang. Xuất hiện dạng widget thu gọn trong Chat và trong tab "Tự động" của Agent Mode |
| 🧩 Artifacts | AI viết 1 trang HTML/CSS/JS (hoặc code khác) độc lập, preview trực tiếp, dùng chung cho Chat / Code Editor / Agent Mode |
| 🖼️ Tạo ảnh | Gọi model ảnh Gemini, có tuỳ chọn "Pro" cho chất lượng cao hơn |
| 🎬 Tạo video | Gọi Gemini Omni Flash — **cần tài khoản có billing/quyền**, free tier có thể báo lỗi |
| 🎙️ Voice | Ghi âm → gửi cho AI → nhận trả lời bằng giọng nói (theo lượt, chưa phải streaming thời gian thực) |
| 📘 Giải bài tập | Dùng chung khung chat, nhưng ép AI giải thích từng bước thay vì chỉ đưa đáp án |
| 🧠 Thinking | Bật/tắt chế độ suy luận sâu (thinkingConfig) |
| 🌐 Web Search | Bật để AI tìm kiếm Google thật trong lúc trả lời (grounding), có trích nguồn |
| 🕶️ Tạm thời | Không lưu cuộc trò chuyện vào máy |
| 📎🖼️📁📷🎥🎤 | Đính kèm file / ảnh-video / cả thư mục / chụp ảnh / quay video / ghi âm hỏi nhanh |
| ⚙️ Connectors | Khung để sau này nối Gmail/Drive/Notion/Slack — hiện là placeholder |

### Agent Mode (2 tab, trong sidebar) vs Mở web & hỏi AI (trong sidebar) vs Deep Research (widget, KHÔNG có trong sidebar) — phân biệt rõ

Dễ nhầm vì cả ba đều "đụng" tới web, nên phân biệt lại theo 2 trục: **có thao tác (click/điền/gửi) hay không**, và **1 trang hay tự tìm nhiều trang**. Lưu ý: chỉ **🚀 Agent Mode** và **🧭 Mở web & hỏi AI** là nút riêng trong sidebar — **🔎 Deep Research không có nút trong sidebar**, xem ghi chú bên dưới bảng.

| Mục | Có ở sidebar? | Thao tác thật trên trang? | Số trang | Khi nào dùng |
|---|---|---|---|---|
| 🧭 **Mở web & hỏi AI** | ✅ Có (nút riêng) | ❌ Không | 1 trang, bạn tự đưa URL | Bạn đã có sẵn 1 URL, chỉ cần xem trực tiếp (sandbox) + hỏi AI về đúng nội dung trang đó |
| 🔎 **Deep Research** | ❌ **Không** — chỉ là widget trong Chat & trong tab "Tự động" của Agent Mode | ❌ Không | Nhiều trang, AI tự tìm | Bạn chỉ có câu hỏi, cần AI tự tra cứu/so sánh/tổng hợp nhiều nguồn |
| 🚀 **Agent Mode → tab 🌍 Trình duyệt thật** | ✅ Có (Agent Mode là 1 nút, tab bên trong) | ✅ Có | 1 phiên trình duyệt thật, bạn giao nhiệm vụ | Bạn **biết chắc ngay từ đầu** cần thao tác thật (điền form, đặt lịch...) và muốn tự theo dõi từng bước |
| 🚀 **Agent Mode → tab 🚀 Tự động** | ✅ Có (Agent Mode là 1 nút, tab bên trong) | ✅ Có, khi cần | Đa công cụ — tự chọn giữa đọc 1 trang / tìm nhiều trang / mở trình duyệt thật | Bạn chỉ giao nhiệm vụ tổng quát, **không cần biết trước** có cần thao tác hay không — Agent tự quyết định ở từng bước |

Ghi chú:
- **Sidebar chỉ có đúng 2 nút liên quan tới web ở mức top-level: 🚀 Agent Mode và 🧭 Mở web & hỏi AI.** 🔎 Deep Research **cố tình không có nút riêng trong sidebar** — nó chỉ là 1 dải nhỏ thu gọn (`researchPill-chat` trong `frontend/index.html`) nằm ngay trong khung Chat, và 1 chip bật/tắt tương tự bên trong tab "Tự động" của Agent Mode. Lý do: Deep Research không phải một "nơi" bạn chuyển tới, mà là 1 chế độ trả lời áp dụng cho tin nhắn tiếp theo, nên gắn liền vào khung chat thay vì có trang riêng.
- **Trình duyệt THẬT có thể thao tác (click/điền/gửi)** chỉ nằm trong **Agent Mode** — dùng chung engine Playwright (`backend/utils/browserAgent.js`) cho cả 2 tab con "Tự động" và "Trình duyệt thật"; khác biệt chỉ là **ai chủ động quyết định** cần mở trình duyệt (agent tự quyết ở tab "Tự động", hay bạn chủ động ở tab "Trình duyệt thật").
- **"Mở web & hỏi AI"** dùng iframe sandbox chỉ để **xem**, cộng với backend fetch nội dung trang (không phải trình duyệt thật, không click/điền được gì) — nhẹ và nhanh hơn hẳn, phù hợp khi chỉ cần đọc 1 trang cụ thể.
- Cả 2 tab của Agent Mode đều **bắt buộc dừng lại xin phép người dùng** trước bất kỳ hành động nào có thể ảnh hưởng dữ liệu thật (gửi form, mua hàng, xoá, đăng ký, thanh toán, điền thông tin nhạy cảm...) — xem `backend/utils/browserAgent.js` (hàm `isSensitive`). "Mở web & hỏi AI" và "Deep Research" không cần bước này vì không bao giờ thao tác.

## Vài điều cần biết trước khi dùng thật

- **Antigravity và Gemini Spark là sản phẩm riêng của Google** (chạy trên hạ tầng cloud/VM riêng, tích hợp sâu Gmail/Workspace) — không có API public để nhúng y hệt. "Agent Mode" trong app này là bản tự làm, lấy cảm hứng tương tự (tự lên kế hoạch, tự chọn công cụ, kể cả điều khiển trình duyệt thật khi cần), chạy hoàn toàn qua Gemini API công khai.
- **Agent Mode (2 tab con) có 2 bản chạy song song, tuỳ bạn deploy kiểu nào**:
  - **Bản Node (`backend/`)**: dùng **Playwright** thật — cần cài Chromium trên máy chạy backend (xem hướng dẫn `npx playwright install chromium` bên dưới). Phù hợp khi bạn tự chạy server/VPS riêng.
  - **Bản Cloudflare Worker (`worker/`)**: dùng **Cloudflare Browser Rendering** (`@cloudflare/puppeteer`) — trình duyệt Chrome thật chạy ngay trên hạ tầng Cloudflare, **không cần cài Chromium/Playwright ở đâu cả**, không cần VPS. Đây là lựa chọn hợp lý nếu bạn deploy qua Git integration (không có server riêng để cài Playwright). Free plan giới hạn vài phiên đồng thời/phút và tối đa ~10 phút "browser time"/ngày — đủ dùng thử cá nhân, cần nhiều hơn thì nâng lên Workers Paid. Cả 2 bản đều giữ nguyên nguyên tắc **luôn xin phép trước hành động nhạy cảm**.
- **Tạo video** cần tài khoản Google AI có billing/quyền tính năng video — nếu API trả lỗi 400/403, đó là giới hạn phía tài khoản Google, không phải lỗi trong code.
- **Voice** hiện là "theo lượt": ghi âm xong mới gửi, không phải nói chuyện ngắt lời thời gian thực như Gemini Live thật (cái đó cần WebSocket streaming audio hai chiều — có thể nâng cấp sau).
- **Tên model Gemini đổi khá thường xuyên.** Nếu gặp lỗi "model not found", sửa lại tên model trong `backend/config/models.js` theo danh sách mới nhất tại https://ai.google.dev/gemini-api/docs/models

## Deploy bằng Cloudflare Workers + GitHub Pages

Đây là cách deploy **miễn phí, không cần server riêng**. Kiến trúc:

- **Cloudflare Worker** = backend (thay cho `backend/` chạy Node) — nằm ở thư mục `worker/`
- **GitHub Pages** = host tĩnh cho `frontend/`

### Bước 1 — Deploy Worker (backend)

```bash
cd worker
npm install                  # cài @cloudflare/puppeteer (Browser Rendering) + wrangler
npm install -g wrangler      # nếu chưa có bản global
wrangler login
wrangler secret put GEMINI_API_KEY   # dán API key free vào khi được hỏi
wrangler deploy
```

> Không cần bước cài Chromium/Playwright riêng nào cho Worker — Browser Rendering (`[browser]` binding `MYBROWSER` trong `wrangler.toml`) chạy sẵn trên hạ tầng Cloudflare, tự động có khi deploy.

Sau khi deploy xong, Wrangler in ra 1 URL dạng:
`https://my-ai-worker.<ten-subdomain-cua-ban>.workers.dev`
→ copy URL này lại, dùng ở bước 2.

### Bước 2 — Deploy frontend (GitHub Pages)

1. Mở `frontend/app.js`, sửa dòng:
   ```js
   const API_BASE = '';
   ```
   thành:
   ```js
   const API_BASE = 'https://my-ai-worker.<ten-subdomain-cua-ban>.workers.dev';
   ```
2. Đẩy toàn bộ nội dung thư mục `frontend/` lên 1 repo GitHub (có thể để ở nhánh `main`, thư mục gốc hoặc `/docs`).
3. Vào **Settings → Pages** của repo, chọn nhánh/thư mục chứa `index.html`, bấm Save.
4. Sau vài phút, trang chạy tại `https://<username>.github.io/<ten-repo>/`.

### Các dịch vụ Cloudflare đang dùng (và có thể dùng thêm)

| Loại | Dịch vụ | Dùng để làm gì | Trạng thái trong project |
|---|---|---|---|
| Key-value storage | **Workers KV** | Cấu hình app, metadata định tuyến, A/B testing | ✅ Đã dùng — `worker/src/kv.js` (`/api/config`, rate-limit) |
| Object / blob storage | **R2** | File ảnh/video AI tạo ra, file người dùng upload, dataset | ⛔ Không dùng — Cloudflare bắt buộc khai thẻ/billing để bật R2 kể cả free tier. Đã thay bằng lưu file trong **Workers KV** (không cần thẻ) — xem `worker/src/storage.js` |
| Lightweight SQL database | **D1** | Lịch sử hội thoại, tin nhắn, hồ sơ người dùng | ✅ Đã dùng — `worker/src/db.js` + `worker/schema.sql` |
| Task processing / messaging | **Queues** | Xử lý video generate chạy nền, tránh timeout 30s | ✅ Đã dùng — `worker/src/queue-video.js` (`/api/video/generate-async`) |
| Vector search & embeddings | **Vectorize** | Embedding tin nhắn qua Gemini, tìm kiếm ngữ nghĩa trong lịch sử chat | ✅ Đã dùng — `worker/src/vectorize.js` (`/api/search/semantic`) |
| Accelerate Postgres/MySQL | **Hyperdrive** | Kết nối tới database Postgres/MySQL có sẵn (cloud/on-prem) qua driver/ORM quen thuộc | ⛔ Chưa dùng — project hiện chỉ cần D1, không có DB ngoài để tăng tốc |
| Global coordination / stateful serverless | **Durable Objects** | App cộng tác, đồng bộ nhiều client, WebSocket real-time, lưu trữ transactional nhất quán mạnh | ⛔ Chưa dùng — chỉ cần nếu sau này làm chat đa người dùng real-time (voice streaming 2 chiều kiểu Gemini Live cũng có thể cần cái này) |
| Streaming ingestion | **Pipelines** | Ingest dữ liệu dạng stream: clickstream, telemetry/log, dữ liệu có cấu trúc để query | ⛔ Chưa dùng — chưa có nhu cầu thu log/clickstream ở quy mô lớn |
| Time-series metrics | **Analytics Engine** | Ghi/truy vấn metric high-cardinality, số liệu sử dụng, service-level telemetry | ✅ Đã dùng — `worker/src/analytics.js`, ghi số request/model/lỗi ở các endpoint chat/image/video/tts, xem tại dashboard Cloudflare (Workers & Pages → Analytics Engine) |
| Headless browser tại edge | **Browser Rendering** (Browser Run) | Điều khiển Chrome thật (screenshot, click, điền form...) cho cả 2 tab con của Agent Mode | ✅ Đã dùng — `worker/src/browserAgent.js` (binding `MYBROWSER`), thay thế Playwright cho bản deploy Cloudflare |

Ghi chú: **Hyperdrive**, **Durable Objects**, **Pipelines** chưa cần thiết cho quy mô app cá nhân hiện tại (D1 + KV + R2 + Queues + Vectorize đã đủ). Có thể bổ sung sau nếu: mở rộng ra nhiều người dùng cộng tác real-time (→ Durable Objects), cần dashboard theo dõi usage/lỗi theo thời gian (→ Analytics Engine), hoặc phải nối vào một Postgres/MySQL có sẵn ở nơi khác (→ Hyperdrive).

### Khác biệt so với bản Node ở trên

- Worker **không có ổ đĩa**, nên nút đính kèm file giờ đọc file thành base64 **ngay trên trình duyệt** rồi gửi thẳng — route `backend/routes/upload.js` của bản Node giờ không còn được frontend gọi tới nữa (vẫn để đó nếu bạn muốn dùng riêng bản Node).
- File quá lớn (khoảng >15–20MB) có thể vượt giới hạn request — nếu cần upload file lớn thật (video dài), nên dùng Gemini File API riêng thay vì gửi base64 trực tiếp.
- CORS trong `worker/src/index.js` đang để `Access-Control-Allow-Origin: '*'` cho dễ test. Muốn an toàn hơn, sửa lại thành đúng domain GitHub Pages của bạn.
- Muốn xem log lỗi khi Worker chạy: `wrangler tail`.

## Phát triển tiếp

Vì bạn quen sửa file trực tiếp và test bằng Node.js: mọi endpoint backend đều tách file riêng trong `backend/routes/`, sửa xong chạy `node --check backend/routes/<file>.js` để kiểm tra cú pháp trước khi chạy lại `npm start`.
