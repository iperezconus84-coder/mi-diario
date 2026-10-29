/* Mi Diario — funciona sin conexión. Solo guarda los archivos de la app, nunca tus entradas. */
const CACHE = 'mi-diario-v7';
const SHELL = ['./', 'index.html', 'styles.css', 'core.js', 'ai.js', 'ai-worker.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Aislamiento entre orígenes: permite que la IA use varios núcleos del procesador.
// GitHub Pages no deja configurar estos encabezados, así que los agrega este service worker.
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // GitHub API va directo
  // Red primero (para recibir actualizaciones), caché si no hay conexión
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return isolate(res);
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')).then(isolate))
  );
});
