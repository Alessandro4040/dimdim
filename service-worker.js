const CACHE_NAME = 'financas-v72';
const ASSETS = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './money-icon.png'
];
const TEMPO_LIMITE_REDE_MS = 4000;
const MENSAGEM_OFFLINE = 'Você está offline. Abra novamente quando a conexão voltar.';

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            // Um arquivo ausente não pode impedir a instalação dos demais.
            Promise.all(ASSETS.map(url => cache.add(url).catch(() => null)))
        )
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(chaves => Promise.all(
                chaves.filter(chave => chave !== CACHE_NAME).map(chave => caches.delete(chave))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // A sincronização com o Google Apps Script nunca passa pelo cache.
    if (url.hostname === 'script.google.com' || url.hostname.endsWith('googleusercontent.com')) return;

    event.respondWith(buscarNaRedeOuCache(request));
});

// Rede primeiro: garante que o app sempre abra na versão mais recente.
// Sem internet (ou com rede lenta demais), usa a cópia guardada.
async function buscarNaRedeOuCache(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const resposta = await Promise.race([
            fetch(request),
            new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout')), TEMPO_LIMITE_REDE_MS))
        ]);
        if (resposta && (resposta.ok || resposta.type === 'opaque')) {
            cache.put(request, resposta.clone());
        }
        return resposta;
    } catch (erro) {
        const guardada = await cache.match(request, { ignoreSearch: true });
        if (guardada) return guardada;

        if (request.mode === 'navigate') {
            const inicio = await cache.match('./index.html');
            if (inicio) return inicio;
        }
        return new Response(MENSAGEM_OFFLINE, {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}
