const CACHE_NAME = 'financas-v26';
const assets = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './money-icon.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(assets))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', e => {
  // Ignora chamadas de API ou requisições que não sejam GET
  if (e.request.method !== 'GET' || e.request.url.includes('script.google.com')) return;
  
  e.respondWith(
    caches.match(e.request).then(cachedResponse => {
      if (cachedResponse) return cachedResponse;
      
      return fetch(e.request).then(res => {
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(e.request, res.clone());
          return res;
        });
      });
    }).catch(() => {
      // Fallback básico
      return new Response('Offline de forma inesperada.');
    })
  );
});
