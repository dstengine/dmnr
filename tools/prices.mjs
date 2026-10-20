// Refreshes data/: what each registrar charges per extension, and where
// each extension's RDAP server is. Run it, look at the diff, commit it —
// the page ships these tables, so a search costs the registrars nothing.
//
//   node tools/prices.mjs            everything
//   node tools/prices.mjs porkbun    one source: porkbun, dynadot, godaddy, rdap, iana
//
// Porkbun publishes its whole price list in one call with no key. GoDaddy
// publishes its extensions but not their prices; its bulk availability
// endpoint has a monthly quota this account has used up, so the price of an
// extension is read off one single check of a name nobody has registered —
// the standard first-year and renewal price, which is what the site quotes.
// Sixty of those a minute, so the GoDaddy pass takes ten minutes and saves
// as it goes. The key is GODADDY_API_KEY in ~/dst/.env and never printed.
//
// Dynadot prints its whole table into its price page, with no key and no
// account: a Nuxt payload, one array in which every object's values are
// indexes into the same array. A sale shows as reg_price with the standard
// price kept in original_reg_price, and the table takes the standard one,
// which is what the page quotes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const only = process.argv[2];
const data = (f) => new URL(`../data/${f}`, import.meta.url);
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function porkbun() {
  const res = await fetch("https://api.porkbun.com/api/json/v3/pricing/get", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  const json = await res.json();
  if (json.status !== "SUCCESS") throw new Error(`porkbun: ${JSON.stringify(json).slice(0, 200)}`);
  const tlds = {};
  for (const [tld, p] of Object.entries(json.pricing)) {
    const reg = Number(p.registration), ren = Number(p.renewal);
    if (Number.isFinite(reg) && Number.isFinite(ren)) tlds[tld.toLowerCase()] = [reg, ren];
  }
  writeFileSync(data("porkbun.json"), JSON.stringify({ asOf: today, currency: "USD", tlds }, null, 1) + "\n");
  console.log(`porkbun: ${Object.keys(tlds).length} extensions`);
}

async function godaddy() {
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const key = env.match(/^GODADDY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("no GODADDY_API_KEY in ~/dst/.env");
  const H = { authorization: `Bearer ${key}`, accept: "application/json" };
  const out = existsSync(data("godaddy.json")) ? JSON.parse(readFileSync(data("godaddy.json"), "utf8")) : { tlds: {} };
  out.currency = "USD";
  const list = await (await fetch("https://api.godaddy.com/v1/domains/tlds", { headers: H })).json();
  if (!Array.isArray(list)) throw new Error(`godaddy tlds: ${JSON.stringify(list).slice(0, 200)}`);
  console.log(`godaddy: ${list.length} extensions listed, ${Object.keys(out.tlds).length} priced already`);
  let n = 0;
  for (const { name } of list) {
    const tld = name.toLowerCase();
    if (out.tlds[tld]?.asOf === today) continue;
    let priced = false;
    for (let attempt = 0; attempt < 2 && !priced; attempt++) {
      const label = `zq${randomBytes(4).toString("hex")}`;
      const res = await fetch(`https://api.godaddy.com/v1/domains/available?domain=${label}.${tld}&checkType=FAST`, { headers: H });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429) {
        console.log(`godaddy: 429 at ${tld} (${json.code ?? ""}) — stopping, ${n} priced this run`);
        writeFileSync(data("godaddy.json"), JSON.stringify(out, null, 1) + "\n");
        return;
      }
      if (json.available && json.price) {
        out.tlds[tld] = { price: [json.price / 1e6, (json.renewalPrice ?? json.price) / 1e6], asOf: today };
        priced = true;
      } else if (json.available === false) {
        continue; // a collision, or an extension that is not open — try one more label
      } else {
        out.tlds[tld] = { unavailable: json.code ?? json.message ?? res.status, asOf: today };
        priced = true;
      }
      await sleep(1100);
    }
    if (!priced) out.tlds[tld] = { unavailable: "no open name found", asOf: today };
    if (++n % 25 === 0) { writeFileSync(data("godaddy.json"), JSON.stringify(out, null, 1) + "\n"); console.log(`godaddy: ${n}…`); }
  }
  out.asOf = today;
  writeFileSync(data("godaddy.json"), JSON.stringify(out, null, 1) + "\n");
  const priced = Object.values(out.tlds).filter((t) => t.price).length;
  console.log(`godaddy: ${priced} extensions priced, ${Object.keys(out.tlds).length - priced} not open`);
}

async function dynadot() {
  const res = await fetch("https://www.dynadot.com/domain/prices", { headers: { "user-agent": "Mozilla/5.0 (Macintosh) dmnr.uk prices", accept: "text/html" } });
  const html = await res.text();
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`dynadot: no price payload in the page (${res.status})`);
  const flat = JSON.parse(m[1]);
  const wrapped = new Set(["Ref", "Reactive", "ShallowRef", "ShallowReactive", "EmptyRef", "EmptyShallowRef"]);
  const seen = new Map();
  const get = (i) => {
    if (i < 0) return undefined;
    if (seen.has(i)) return seen.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && wrapped.has(v[0])) { const r = get(v[1]); seen.set(i, r); return r; }
      const a = []; seen.set(i, a);
      for (const j of v) a.push(get(j));
      return a;
    }
    if (v && typeof v === "object") {
      const o = {}; seen.set(i, o);
      for (const [k, j] of Object.entries(v)) o[k] = get(j);
      return o;
    }
    return v;
  };
  const rows = [];
  (function walk(x, depth) {
    if (!x || typeof x !== "object" || depth > 12) return;
    if (Array.isArray(x)) {
      if (x[0] && typeof x[0] === "object" && "reg_price" in x[0]) { rows.push(...x); return; }
      x.forEach((y) => walk(y, depth + 1));
    } else Object.values(x).forEach((y) => walk(y, depth + 1));
  })(get(0), 0);
  const usd = (s) => { const n = Number(String(s ?? "").replace(/[$,]/g, "")); return n > 0 ? n : null; };
  const tlds = {};
  for (const r of rows) {
    const reg = usd(r.original_reg_price) ?? usd(r.reg_price), ren = usd(r.original_renew_price) ?? usd(r.renew_price);
    if (reg && ren) tlds[String(r.name).toLowerCase()] = [reg, ren];
  }
  if (Object.keys(tlds).length < 500) throw new Error(`dynadot: only ${Object.keys(tlds).length} extensions read — the page has changed`);
  writeFileSync(data("dynadot.json"), JSON.stringify({ asOf: today, currency: "USD", tlds }, null, 1) + "\n");
  console.log(`dynadot: ${Object.keys(tlds).length} extensions`);
}

async function rdap() {
  const json = await (await fetch("https://data.iana.org/rdap/dns.json")).json();
  const tlds = {};
  for (const [names, urls] of json.services) {
    const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
    for (const t of names) tlds[t.toLowerCase()] = url.replace(/\/?$/, "/");
  }
  writeFileSync(data("rdap.json"), JSON.stringify({ asOf: today, publication: json.publication, tlds }, null, 1) + "\n");
  console.log(`rdap: ${Object.keys(tlds).length} extensions with a server`);
}

async function iana() {
  const text = await (await fetch("https://data.iana.org/TLD/tlds-alpha-by-domain.txt")).text();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const version = lines[0].startsWith("#") ? lines[0].replace(/^#\s*/, "") : "";
  const tlds = lines.filter((l) => !l.startsWith("#")).map((l) => l.toLowerCase());
  writeFileSync(data("iana.json"), JSON.stringify({ asOf: today, version, tlds }, null, 1) + "\n");
  console.log(`iana: ${tlds.length} top-level domains in the root zone`);
}

const jobs = { porkbun, dynadot, rdap, iana, godaddy };
for (const [name, job] of Object.entries(jobs)) {
  if (only && only !== name) continue;
  await job();
}
