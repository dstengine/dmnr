// The browser asks the registry's RDAP server itself; this is the way round
// for the registries that answer without CORS headers. One domain per call,
// the answer cached at the edge for ten minutes.
//
//   GET /api/check?domain=example.co.uk
//   → { "domain": "example.co.uk", "registered": false, "server": "https://rdap.nominet.uk/uk/" }
//
// registered is true, false, or null when no server answers for the
// extension (nothing is guessed from that).
import { readFileSync } from "node:fs";

const servers = JSON.parse(readFileSync(new URL("../data/rdap.json", import.meta.url), "utf8")).tlds;
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function serverFor(domain) {
  const parts = domain.split(".").slice(1);
  for (let i = 0; i < parts.length; i++) {
    const s = servers[parts.slice(i).join(".")];
    if (s) return s;
  }
  return null;
}

export default async function handler(req, res) {
  const domain = String(req.query?.domain ?? "").trim().toLowerCase();
  if (!DOMAIN.test(domain)) {
    res.status(400).json({ error: "domain: a lower-case ASCII domain name" });
    return;
  }
  const server = serverFor(domain);
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!server) {
    res.status(200).json({ domain, registered: null, server: null });
    return;
  }
  try {
    const r = await fetch(`${server}domain/${domain}`, {
      headers: { accept: "application/rdap+json, application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 200) res.status(200).json({ domain, registered: true, server });
    else if (r.status === 404) res.status(200).json({ domain, registered: false, server });
    else res.status(200).json({ domain, registered: null, server, status: r.status });
  } catch (e) {
    res.status(200).json({ domain, registered: null, server, error: String(e?.name ?? e) });
  }
}
