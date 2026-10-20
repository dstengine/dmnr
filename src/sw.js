// Keeps the page openable without a connection: the shell, the script, the
// stylesheet and the price tables are cached at install under the build's
// version, and a new build replaces them. Nothing about whether a name is
// taken is ever cached: api/check, Cloudflare's resolver and the registries
// are left to the network, so an answer is always today's.
// build.mjs stamps the version into the strings below, so they stay literal.
const CACHE = "dmnr-__VERSION__";
const SHELL = ["./", "app.js?v=__VERSION__", "style.css?v=__VERSION__", "data.json?v=__VERSION__", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/go/")) return;
  if (e.request.mode === "navigate") {
    // The shell answers every address of the page, ?q= included; the
    // network is the fallback, not the other way round, because the shell
    // is versioned and a new build brings a new worker.
    e.respondWith(caches.match("./", { ignoreSearch: true }).then((hit) => hit ?? fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request)));
});
