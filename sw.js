/**
 * Trace serving service worker.
 *
 * The embedded trace.playwright.dev viewer needs the trace.zip at a real
 * fetchable URL on this origin. We accept trace blobs from the page via
 * postMessage, keep them in-memory keyed by id, and respond when the trace
 * viewer fetches /__pw_trace/<id>. CORS headers let trace.playwright.dev
 * (cross-origin) consume the response.
 *
 * Blobs are released either explicitly (clear-trace message) or when the
 * worker is terminated by the browser; nothing is persisted to disk.
 */

const TRACE_PATH = '__pw_trace';
const traces = new Map(); // id -> Blob

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;
  const reply = (payload) => event.ports?.[0]?.postMessage(payload);
  if (data.type === 'add-trace') {
    traces.set(data.id, data.blob);
    reply({ ok: true });
  } else if (data.type === 'clear-trace') {
    traces.delete(data.id);
    reply({ ok: true });
  } else if (data.type === 'clear-all') {
    traces.clear();
    reply({ ok: true });
  } else if (data.type === 'ping') {
    reply({ ok: true });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const idx = url.pathname.indexOf(`/${TRACE_PATH}/`);
  if (idx === -1) return;

  const id = url.pathname.slice(idx + TRACE_PATH.length + 2);
  if (!id) return;

  if (event.request.method === 'OPTIONS') {
    event.respondWith(new Response(null, {
      status: 204,
      headers: corsHeaders(),
    }));
    return;
  }

  const blob = traces.get(id);
  if (!blob) {
    event.respondWith(new Response('Trace not found', { status: 404, headers: corsHeaders() }));
    return;
  }
  event.respondWith(new Response(blob, {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/zip' },
  }));
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  };
}
