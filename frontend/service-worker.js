// Service Worker tối giản cho Velocitix AI PWA.
// CHỈ cache "app shell" (HTML/CSS/JS/icon tĩnh) để mở app nhanh hơn lần sau — KHÔNG cache bất kỳ
// request nào tới API (/api/...) hay tới worker, để luôn lấy dữ liệu chat/tài khoản mới nhất,
// tránh lặp lại đúng vấn đề "cache cũ khiến UI không cập nhật" từng gặp phải với trình duyệt.
//
// KHÔNG CẦN sửa file này mỗi lần cập nhật frontend nữa: file của app luôn được hỏi lại server
// (cache: 'no-cache'), nên sửa app.js / index.html / style.css / model-popup.* là thấy ngay.
// Chỉ khi muốn XOÁ SẠCH cache cũ (hiếm) thì mới tăng số phiên bản CACHE_NAME.
const CACHE_NAME = 'velocitix-shell-v9';
const SHELL_FILES = ['./', './index.html', './style.css', './model-popup.css', './app.js', './model-popup.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Chỉ xử lý GET (cache không lưu được POST...). Không đụng vào request API/worker —
  // luôn đi thẳng ra mạng, không cache.
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.hostname.includes('workers.dev')) {
    return;
  }

  // Với các file tĩnh của app: network-first (ưu tiên bản mới nhất từ mạng), chỉ dùng cache
  // làm phương án dự phòng khi mất mạng — tránh việc PWA "kẹt" ở bản cache cũ mãi mãi.
  //
  // ⚠️ Lý do trước đây vẫn thấy bản cũ dù đã network-first: fetch() thường vẫn đi qua BỘ NHỚ ĐỆM HTTP
  // của trình duyệt, mà GitHub Pages gửi "Cache-Control: max-age=600" (10 phút) nên file cũ được dùng
  // lại tới 10 phút. cache: 'no-cache' ép trình duyệt luôn hỏi lại server (nếu file không đổi thì
  // server trả 304, gần như không tốn băng thông). Chỉ áp dụng cho file cùng domain với app.
  const sameOrigin = url.origin === self.location.origin;
  event.respondWith(
    fetch(event.request, sameOrigin ? { cache: 'no-cache' } : undefined)
      .then((res) => {
        if (res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
