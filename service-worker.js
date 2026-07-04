const CACHE_NAME = 'financas-v65'; // ← incremente sempre que alterar os arquivos
const ASSETS = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './money-icon.png'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => 
            Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim()) // ← assume o controle imediatamente
    );
});

self.addEventListener('fetch', event => {
    // Ignora requisições para a API (não devem ser cacheadas)
    if (event.request.url.includes('script.google.com')) {
        event.respondWith(fetch(event.request).catch(() => 
            new Response('Erro de conexão com a API.', { status: 503 })
        ));
        return;
    }

    // Estratégia: cache-first, com fallback para rede e atualização assíncrona
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                // Atualiza o cache em background (stale-while-revalidate)
                fetch(event.request).then(networkResponse => {
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, networkResponse);
                    });
                }).catch(() => { /* falha silenciosa */ });
                return cachedResponse;
            }
            // Se não estiver no cache, busca na rede
            return fetch(event.request).then(networkResponse => {
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, networkResponse.clone());
                    return networkResponse;
                });
            }).catch(() => {
                return new Response('Você está offline. Acesse novamente quando a conexão retornar.', { status: 503 });
            });
        })
    );
});