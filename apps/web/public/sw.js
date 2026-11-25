// OpenHuddle Lightweight PWA Service Worker
// Satisfies Chromium WebAPK installability criteria while strictly bypassing
// all /api/* endpoints and Server-Sent Events (SSE) streams.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (
    url.pathname.startsWith("/api/") ||
    request.headers.get("accept")?.includes("text/event-stream")
  ) {
    return;
  }
  // Network-first passthrough for same-origin static/navigation requests
  event.respondWith(fetch(request));
});
