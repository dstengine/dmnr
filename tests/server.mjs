// Serves dist/ with api/check and api/avail mounted the way Vercel mounts
// them, for the e2e run and for a look in a browser: node tests/server.mjs
// → :4174. The registrars' keys come from ../../.env (KEY=value lines),
// the same file tools/prices.mjs reads; without it api/avail answers with
// no sources, as a deployment without keys does.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import check from "../api/check.js";
import avail from "../api/avail.js";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain",
};

export function serve(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const fn = url.pathname === "/api/check" ? check : url.pathname === "/api/avail" ? avail : null;
    if (fn) {
      const shim = {
        status(code) { res.statusCode = code; return shim; },
        setHeader(k, v) { res.setHeader(k, v); },
        json(body) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); },
      };
      await fn({ query: Object.fromEntries(url.searchParams) }, shim);
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
