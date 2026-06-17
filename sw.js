/* Service Worker - مؤسسة روح المنافسة المحلية */
const CACHE = 'rooh-app-v14';

/* ملفات التطبيق الأساسية + المكتبات الخارجية لتشغيله دون إنترنت */
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon.png',
  './logo.png',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      /* cache.add لكل عنصر على حدة حتى لا يفشل التثبيت إذا تعذّر تحميل أحدها */
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* استراتيجية: الكاش أولاً ثم الشبكة، مع تخزين أي طلب ناجح جديد */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  /* لا تتدخل في طلبات Firebase/Firestore/المصادقة — تدير تخزينها بنفسها */
  const url = req.url;
  if (url.indexOf('firestore.googleapis.com') !== -1 ||
      url.indexOf('identitytoolkit.googleapis.com') !== -1 ||
      url.indexOf('securetoken.googleapis.com') !== -1 ||
      url.indexOf('firebaseinstallations.googleapis.com') !== -1) {
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        try {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        } catch (e) {}
        return res;
      }).catch(() => cached);
    })
  );
});
