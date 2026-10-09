const CACHE_NAME = "rivocity-lane-v2";
const SHELL_URLS = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("rivocity-lane-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;

  const requestUrl = new URL(event.request.url);
  const isNavigation = event.request.mode === "navigate";
  const isManifest = requestUrl.pathname === "/manifest.webmanifest";
  if (!isNavigation && !isManifest) return;

  const cacheKey = isNavigation ? "/" : event.request;
  const networkResponse = fetch(event.request).then(async (response) => {
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  });

  event.respondWith(
    networkResponse.catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(cacheKey)) || Response.error();
    })
  );
});
