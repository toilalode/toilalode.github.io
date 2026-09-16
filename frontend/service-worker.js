// Service Worker tối giản cho Velocitix AI PWA.
// CHỈ cache "app shell" (HTML/CSS/JS/icon tĩnh) để mở app nhanh hơn lần sau — KHÔNG cache bất kỳ
// request nào tới API (/api/...) hay tới worker, để luôn lấy dữ liệu chat/tài khoản mới nhất,
// tránh lặp lại đúng vấn đề "cache cũ khiến UI không cập nhật" từng gặp phải với trình duyệt.
const CACHE_NAME = 'velocitix-shell-v4';
const SHELL_FILES = ['./', './index.html', './style.css', './app.js', './manifest.json'];

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

  // Không đụng vào request API/worker — luôn đi thẳng ra mạng, không cache.
  if (url.pathname.startsWith('/api/') || url.hostname.includes('workers.dev')) {
    return;
  }

  // Với các file tĩnh của app: network-first (ưu tiên bản mới nhất từ mạng), chỉ dùng cache
  // làm phương án dự phòng khi mất mạng — tránh việc PWA "kẹt" ở bản cache cũ mãi mãi.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
