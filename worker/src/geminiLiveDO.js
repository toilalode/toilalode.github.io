// ===================== VOICE THẬT SỰ "LIVE" (Gemini Live API — BidiGenerateContent) =====================
// Khác hẳn "Voice theo lượt" cũ (ghi âm xong -> gửi cả file -> chờ trả lời -> phát): đây là 1
// KẾT NỐI DUY NHẤT giữ mở suốt cuộc trò chuyện, audio chảy 2 chiều liên tục theo thời gian thực,
// người dùng có thể NGẮT LỜI AI giữa chừng (server tự phát hiện qua VAD - voice activity detection
// tích hợp sẵn của Gemini, không cần code thêm).
//
// VÌ SAO CẦN DURABLE OBJECT: Cloudflare Worker "thường" không giữ được state giữa các lần chạy —
// mỗi request tới Worker chạy độc lập, không có nơi nào để "giữ" 2 WebSocket (1 với browser, 1 với
// Gemini) sống xuyên suốt cả cuộc trò chuyện dài. Durable Object thì có — nó là 1 instance chạy
// liên tục, giữ được biến trong bộ nhớ (this.geminiWs) suốt vòng đời kết nối.
//
// KIẾN TRÚC: Browser <--WebSocket--> Durable Object <--WebSocket--> Gemini Live API
//                                    (relay 2 chiều, gần như trong suốt)
//
// LƯU Ý QUAN TRỌNG VỀ WORKERS RUNTIME: Worker/Durable Object KHÔNG dùng `new WebSocket(url)` để
// mở kết nối RA NGOÀI (constructor đó chỉ có ở trình duyệt) — phải dùng fetch() với header
// Upgrade: websocket rồi lấy response.webSocket, đây là cách riêng của Cloudflare.

const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview'; // free tier, dòng 3.x (không thuộc diện shutdown 16/10/2026 như bản 2.5)
const GEMINI_LIVE_WS_BASE = 'https://generativelanguage.googleapis.com/ws/';

export class GeminiLiveDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.geminiWs = null;   // WebSocket outbound tới Gemini (server đóng vai "client" của Gemini)
    this.browserWs = null;  // WebSocket với trình duyệt (server đóng vai "server" cho browser)
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Chỉ chấp nhận kết nối WebSocket.', { status: 426 });
    }

    // Lấy API key TRƯỚC khi accept — nếu chưa cấu hình, trả lỗi rõ ràng thay vì mở socket rồi mới báo lỗi giữa chừng.
    const apiKey = this.env.GEMINI_API_KEY_OWNER || this.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response('Server chưa cấu hình GEMINI_API_KEY.', { status: 500 });
    }

    const url = new URL(request.url);
    const voiceName = url.searchParams.get('voice') || 'Kore';
    const systemInstruction = url.searchParams.get('systemInstruction') || '';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.browserWs = server;

    // Không "await" việc kết nối Gemini trước khi trả response — phải trả 101 Switching Protocols
    // ngay để browser thấy kết nối thành công, rồi mới kết nối Gemini ở nền. Nếu Gemini lỗi, báo
    // lỗi qua chính kênh WebSocket đã mở với browser (browser luôn phải nghe được kết quả, kể cả lỗi).
    this.connectToGemini(apiKey, voiceName, systemInstruction).catch(err => {
      this.safeSendToBrowser({ type: 'error', message: 'Không kết nối được Gemini Live: ' + err.message });
      this.safeCloseBrowser();
    });

    this.browserWs.addEventListener('message', (event) => this.onBrowserMessage(event));
    this.browserWs.addEventListener('close', () => this.cleanup());
    this.browserWs.addEventListener('error', () => this.cleanup());

    return new Response(null, { status: 101, webSocket: client });
  }

  async connectToGemini(apiKey, voiceName, systemInstruction) {
    const wsUrl = `${GEMINI_LIVE_WS_BASE}?key=${apiKey}`;
    // Cách DUY NHẤT để Worker/DO mở WebSocket ra bên ngoài — không phải `new WebSocket()`.
    const resp = await fetch(wsUrl, { headers: { Upgrade: 'websocket' } });
    if (!resp.webSocket) {
      throw new Error('Gemini không chấp nhận nâng cấp WebSocket (có thể sai API key hoặc model không hỗ trợ Live).');
    }
    const geminiWs = resp.webSocket;
    geminiWs.accept();
    this.geminiWs = geminiWs;

    // Message đầu tiên BẮT BUỘC phải là setup — không thể đổi config sau khi đã gửi message này.
    const setupMessage = {
      setup: {
        model: `models/${GEMINI_LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        // VAD (voice activity detection) tích hợp sẵn của Gemini tự phát hiện khi nào người dùng
        // nói xong (end of turn) VÀ tự phát hiện khi người dùng ngắt lời AI đang nói (barge-in) —
        // đây chính là thứ giúp "nói chuyện ngắt lời được" mà README ghi là bản cũ chưa làm được.
        realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      },
    };
    geminiWs.send(JSON.stringify(setupMessage));

    geminiWs.addEventListener('message', (event) => this.onGeminiMessage(event));
    geminiWs.addEventListener('close', (event) => {
      this.safeSendToBrowser({ type: 'gemini_closed', code: event.code, reason: event.reason });
      this.safeCloseBrowser();
    });
    geminiWs.addEventListener('error', () => {
      this.safeSendToBrowser({ type: 'error', message: 'Kết nối tới Gemini Live bị lỗi.' });
    });
  }

  // Browser gửi lên: { type: 'audio', data: '<base64 PCM 16-bit 16kHz mono>' }
  //               hoặc { type: 'text', text: '...' } (cho phép gõ chữ thay vì nói, nếu frontend muốn)
  //               hoặc { type: 'end_turn' } (báo đã nói xong lượt này, hiếm khi cần vì VAD tự lo)
  onBrowserMessage(event) {
    if (!this.geminiWs || this.geminiWs.readyState !== 1) return; // 1 = OPEN — Gemini chưa sẵn sàng thì bỏ qua, tránh crash
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'audio' && msg.data) {
      this.geminiWs.send(JSON.stringify({
        realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: msg.data }] },
      }));
    } else if (msg.type === 'text' && msg.text) {
      this.geminiWs.send(JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text: msg.text }] }], turnComplete: true },
      }));
    } else if (msg.type === 'end_turn') {
      this.geminiWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }
  }

  // Gemini gửi xuống (BidiGenerateContentServerMessage) — chuyển tiếp lại cho browser ở dạng gọn
  // hơn, chỉ trích ra đúng phần audio/text cần, để frontend không phải tự parse cấu trúc phức tạp
  // gốc của Google.
  onGeminiMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.setupComplete) {
      this.safeSendToBrowser({ type: 'ready' });
      return;
    }
    const parts = data.serverContent?.modelTurn?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/')) {
        this.safeSendToBrowser({ type: 'audio', data: p.inlineData.data }); // base64 PCM 16-bit 24kHz mono
      }
      if (p.text) {
        this.safeSendToBrowser({ type: 'text', text: p.text });
      }
    }
    // Gemini tự phát hiện người dùng NGẮT LỜI AI đang nói -> báo interrupted=true, không kèm gì
    // khác — frontend cần dừng phát audio đang phát ngay khi thấy tín hiệu này.
    if (data.serverContent?.interrupted) {
      this.safeSendToBrowser({ type: 'interrupted' });
    }
    if (data.serverContent?.turnComplete) {
      this.safeSendToBrowser({ type: 'turn_complete' });
    }
  }

  safeSendToBrowser(obj) {
    if (this.browserWs && this.browserWs.readyState === 1) {
      try { this.browserWs.send(JSON.stringify(obj)); } catch { /* socket vừa đóng giữa lúc gửi, bỏ qua */ }
    }
  }
  safeCloseBrowser() {
    if (this.browserWs && this.browserWs.readyState === 1) {
      try { this.browserWs.close(1011, 'Gemini Live session ended'); } catch { /* đã đóng rồi */ }
    }
  }
  cleanup() {
    if (this.geminiWs && this.geminiWs.readyState === 1) {
      try { this.geminiWs.close(); } catch { /* đã đóng rồi */ }
    }
  }
}
