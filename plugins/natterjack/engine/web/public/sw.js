/*
 * The dashboard's service worker: what makes it installable as an app (server/src/pwa.ts
 * serves the manifest). It caches nothing: every request goes to the server as before, and
 * only a page load that can't reach it gets a small "can't reach the dashboard" page.
 */
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard unreachable</title>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:36rem;margin:auto;color:#0F172A">
<h1 style="font-size:1.3rem">Can't reach the dashboard</h1>
<p>It isn't answering. On your own computer, start it again (<code>node &lt;engine&gt;/bin/dashboard.mjs start</code>);
for a hosted dashboard, check your connection.</p>
<p><button onclick="location.reload()">Try again</button></p>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  );
});
