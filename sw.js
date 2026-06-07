// VocabApp Service Worker — 离线缓存
const CACHE_NAME = 'vocabapp-v1';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg'
];

// 安装：缓存所有静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch((err) => {
        console.warn('SW: cache addAll partial failure', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 请求：缓存优先，离线回退
self.addEventListener('fetch', (event) => {
  // 跳过非 HTTP 请求
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // 返回缓存，同时在后台更新
      const fetchPromise = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
