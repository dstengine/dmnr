// The registrars' own availability APIs, asked for a batch of names at
// once, with the keys the deployment holds (src/providers.js names them).
// One call per twenty names from the page, the answer cached at the edge
// for ten minutes.
//
//   GET /api/avail?domains=example.com,example.co.uk
//   → { "sources": ["godaddy", "namesilo"],
//       "votes": { "example.com": { "godaddy": "taken", "namesilo": "taken" }, … } }
//
// A vote is free, taken, premium, silent or na (see providers.js). With
// no keys configured `sources` is empty and the page counts the browser's
// own checks alone. GET and not POST so the edge can cache it; the list
// is sorted so the same names make the same key.
import { askAll, enabled } from "../src/providers.js";

const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MAX = 25;

export default async function handler(req, res, env = process.env, fetcher = fetch) {
  const raw = String(req.query?.domains ?? "").trim().toLowerCase();
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!raw) {
    // What is configured, for a page that wants to know before it asks.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ sources: enabled(env).map((p) => p.id), votes: {} });
    return;
  }
  const domains = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].sort();
  if (domains.length > MAX || domains.some((d) => !DOMAIN.test(d))) {
    res.status(400).json({ error: `domains: up to ${MAX} lower-case ASCII domain names, comma-separated` });
    return;
  }
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  res.status(200).json(await askAll(domains, env, fetcher));
}
