// Serves dist/ with api/check mounted the way Vercel mounts it, for the
// e2e run and for a look in a browser: node tests/server.mjs → :4174.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import check from "../api/check.js";

const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain",
};

export function serve(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/check") {
      const shim = {
        status(code) { res.statusCode = code; return shim; },
        setHeader(k, v) { res.setHeader(k, v); },
        json(body) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); },
      };
      await check({ query: Object.fromEntries(url.searchParams) }, shim);
      return;
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const body = await readFile(new URL(`../dist${path}`, import.meta.url));
      res.setHeader("content-type", types[extname(path)] ?? "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, "/"))) {
  const port = Number(process.env.PORT || 4174);
  await serve(port);
  console.log(`http://localhost:${port}/`);
}
