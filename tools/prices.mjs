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
// Sixty of those a minute, so the GoDaddy pass takes ten minutes, stalest
// rows first, and saves as it goes: a pass cut short (429, 401, 403, ten
// extensions in a row unanswered) keeps the rows it read, each dated, and
// exits 1 so the Action names it, and the next pass starts where this one
// stopped. An extension GoDaddy fails to answer twice (an error status, no
// answer) keeps its price for up to two months, then loses it; either way
// the pass exits 1. One GoDaddy no longer lists loses its price, named. The
// table is never written with fewer than 500 prices, the floor the tests
// hold the page to. The key is GODADDY_API_KEY in ~/dst/.env and never printed.
//
// Dynadot prints its whole table into its price page, with no key and no
// account: a Nuxt payload, one array in which every object's values are
// indexes into the same array. A sale shows as reg_price with the standard
// price kept in original_reg_price, and the table takes the standard one,
// which is what the page quotes. A row is any object in the payload with a
// name and both prices, wherever the page nests it; where two rows name one
// extension at two prices, the one in the longer list wins, and the read is
// turned down unless that list is a whole table (500 rows or more) and the
// other is not, so a promo card never beats the table; a row priced in
// another currency is dropped and named. The page has
// come back without its table (9 Nov 2026, on GitHub's runner, while the
// Internet Archive's copy from 45 minutes earlier held 816 rows), so a
// short read is tried twice more, a minute after the first and three after
// the second, and with PRICES_PAGES set each page it turned down is kept
// there (dynadot-N.html, its status and headers in dynadot-N.txt) for the
// run's artifacts.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const only = process.argv[2];
const data = (f) => new URL(`../data/${f}`, import.meta.url);
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A table is written whole or not at all: the Action stops a source that
// runs too long, and a file cut off mid-write would sink the build.
const put = (f, obj) => {
  const tmp = data(`.${f}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n");
  renameSync(tmp, data(f));
};

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
  if (Object.keys(tlds).length < 500 || !tlds.com) throw new Error(`porkbun: only ${Object.keys(tlds).length} extensions in the answer`);
  put("porkbun.json", { asOf: today, currency: "USD", tlds });
  console.log(`porkbun: ${Object.keys(tlds).length} extensions`);
}

async function godaddy() {
  // The key comes from the environment (the Action's secret) or ~/dst/.env.
  const envFile = new URL("../../.env", import.meta.url);
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const key = process.env.GODADDY_API_KEY || env.match(/^GODADDY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("no GODADDY_API_KEY in the environment or ~/dst/.env");
  const H = { authorization: `Bearer ${key}`, accept: "application/json" };
  const out = existsSync(data("godaddy.json")) ? JSON.parse(readFileSync(data("godaddy.json"), "utf8")) : { tlds: {} };
  out.currency = "USD";
  const count = () => Object.values(out.tlds).filter((r) => r.price).length;
  const floor = count() >= 500 ? 500 : 0;   // a table built from nothing has no floor yet
  const save = () => {
    if (count() < floor) throw new Error(`godaddy: only ${count()} extensions would keep a price; data/godaddy.json keeps its last table`);
    put("godaddy.json", out);
  };

  const res0 = await fetch("https://api.godaddy.com/v1/domains/tlds", { headers: H, signal: AbortSignal.timeout(60_000) });
  const list = await res0.json().catch(() => null);
  if (!res0.ok || !Array.isArray(list)) throw new Error(`godaddy tlds: HTTP ${res0.status} ${JSON.stringify(list)?.slice(0, 200)}`);
  const listed = new Set(list.map(({ name }) => String(name).toLowerCase()));
  const had = Object.keys(out.tlds).length;
  if (listed.size < 400 || listed.size < 0.9 * had || !listed.has("com")) throw new Error(`godaddy tlds: ${listed.size} listed against ${had} in the table, .com ${listed.has("com") ? "among them" : "missing"}: not trusted`);
  console.log(`godaddy: ${listed.size} extensions listed, ${had} in the table`);
  const unlisted = Object.keys(out.tlds).filter((t) => !listed.has(t));
  const delisted = unlisted.filter((t) => out.tlds[t].price);
  for (const t of unlisted) out.tlds[t] = { unavailable: "not listed by GoDaddy", asOf: today };
  if (delisted.length) console.log(`godaddy: no longer listed, price dropped: ${delisted.map((t) => `.${t}`).join(" ")}`);

  // Stalest first, so a pass cut short at the same place every time still
  // moves on; the sort is stable, so GoDaddy's order holds within a day.
  const TROUBLE = "GoDaddy did not answer";
  const age = (t) => out.tlds[t]?.asOf ?? "";
  const queue = [...listed].sort((a, b) => (age(a) < age(b) ? -1 : age(a) > age(b) ? 1 : 0));
  const old = (row) => !row?.asOf || Date.parse(today) - Date.parse(row.asOf) > 62 * 864e5;
  let n = 0, kept = 0, lost = 0, unread = 0;
  let down = [];   // the run of extensions unanswered in a row, each with the row it had
  const stop = (why) => {
    console.log(`godaddy: ${why} — stopping, ${n} read this run`);
    save();
    process.exitCode = 1;
  };
  for (const tld of queue) {
    const row = out.tlds[tld];
    if (row?.asOf === today && row.unavailable !== TROUBLE) continue;
    let priced = false, trouble = false;
    for (let attempt = 0; attempt < 2 && !priced; attempt++) {
      const label = `zq${randomBytes(4).toString("hex")}`;
      let res, json = {};
      try {
        res = await fetch(`https://api.godaddy.com/v1/domains/available?domain=${label}.${tld}&checkType=FAST`, { headers: H, signal: AbortSignal.timeout(30_000) });
        json = await res.json().catch(() => ({}));
      } catch { trouble = true; await sleep(1100); continue; }
      // These speak for the account or the whole API, not for one extension.
      if (res.status === 429 || res.status === 401 || res.status === 403) return stop(`HTTP ${res.status} at ${tld} (${json.code ?? "no code"})`);
      if (!res.ok) trouble = true;
      else if (json.available && json.price) {
        out.tlds[tld] = { price: [json.price / 1e6, (json.renewalPrice ?? json.price) / 1e6], asOf: today };
        priced = true;
      } else if (json.available !== false) {
        out.tlds[tld] = { unavailable: json.code ?? json.message ?? res.status, asOf: today };
        priced = true;
      } // available: false is a collision, or an extension that is not open: one more label
      await sleep(1100);
    }
    n++;
    if (priced || !trouble) {
      if (!priced) out.tlds[tld] = { unavailable: "no open name found", asOf: today };
      down = [];
    } else {
      down.push([tld, row]);
      // Ten in a row is GoDaddy down, not ten extensions: their rows go back
      // as they were, and the pass stops.
      if (down.length >= 10) {
        for (const [t, r] of down) if (r) out.tlds[t] = r; else delete out.tlds[t];
        return stop(`${down.length} extensions in a row unanswered (.${down[0][0]} to .${tld}), GoDaddy looks down; their rows are left as they were`);
      }
      if (row?.price && !old(row)) { kept++; console.log(`godaddy: no answer for .${tld} twice, its price of ${row.asOf} is kept`); }
      else {
        if (row?.price) { lost++; console.log(`godaddy: no answer for .${tld} twice, its price of ${row.asOf ?? "no date"} is over two months old and is dropped`); }
        else unread++;
        out.tlds[tld] = { unavailable: TROUBLE, asOf: today };
      }
    }
    if (n % 25 === 0) { save(); console.log(`godaddy: ${n}…`); }
  }
  if (!kept && !unread) out.asOf = today;
  save();
  const priced = count(), rows = Object.keys(out.tlds).length;
  console.log(`godaddy: ${priced} extensions priced${kept ? ` (${kept} of them kept from an earlier pass, GoDaddy did not answer)` : ""}, ${rows - priced} not${lost ? ` (${lost} of them dropped, unanswered and over two months old)` : ""}${unread ? `, ${unread} never answered` : ""}`);
  if (kept || lost || unread || delisted.length) process.exitCode = 1;
}

// Dynadot's table out of its page: tlds is { tld: [firstYear, renewal] },
// empty when the page carries no payload or no rows; clashes lists the
// extensions two lists price differently, unsettled those of them a whole
// table did not settle, foreign counts the rows dropped for another
// currency, by currency.
export function dynadotTable(html) {
  const none = { tlds: {}, clashes: [], unsettled: [], foreign: {} };
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return none;
  let flat;
  try { flat = JSON.parse(m[1]); } catch { return none; }
  if (!Array.isArray(flat)) return none;
  const wrapped = new Set(["Ref", "Reactive", "ShallowRef", "ShallowReactive", "EmptyRef", "EmptyShallowRef"]);
  const seen = new Map();
  const get = (i) => {
    if (!Number.isInteger(i) || i < 0) return undefined;
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
  const usd = (s) => { const n = Number(String(s ?? "").replace(/[$,]/g, "")); return n > 0 ? n : null; };
  // Each row weighs as much as the longest list that holds it: an array, or
  // an object keyed by extension, either of them through Ref/Reactive.
  const isRow = (v) => v && typeof v === "object" && !Array.isArray(v) && "name" in v && "reg_price" in v && "renew_price" in v;
  const unwrap = (j) => { for (let k = 0; k < 8 && Array.isArray(flat[j]) && typeof flat[j][0] === "string" && wrapped.has(flat[j][0]); k++) j = flat[j][1]; return j; };
  const weight = new Map();
  flat.forEach((v, i) => { if (isRow(v)) weight.set(i, 0); });
  for (const v of flat) {
    if (!v || typeof v !== "object" || isRow(v) || (Array.isArray(v) && typeof v[0] === "string" && wrapped.has(v[0]))) continue;
    const rows = [...new Set((Array.isArray(v) ? v : Object.values(v)).map(unwrap).filter((j) => weight.has(j)))];
    for (const j of rows) if (rows.length > weight.get(j)) weight.set(j, rows.length);
  }
  const best = {}, clashes = new Set(), lost = {}, foreign = {};
  for (const [i, w] of weight) {
    const r = get(i);
    const name = typeof r.name === "string" ? r.name.trim().toLowerCase() : "";
    const currency = r.google_data?.currency == null ? "USD" : String(r.google_data.currency).trim().toUpperCase();
    if (!name) continue;
    if (currency !== "USD") { foreign[currency] = (foreign[currency] ?? 0) + 1; continue; }
    const reg = usd(r.original_reg_price) ?? usd(r.reg_price), ren = usd(r.original_renew_price) ?? usd(r.renew_price);
    if (!reg || !ren) continue;
    const had = best[name];
    if (had && (had.price[0] !== reg || had.price[1] !== ren)) { clashes.add(name); lost[name] = Math.max(lost[name] ?? 0, Math.min(w, had.w)); }
    if (!had || w > had.w) best[name] = { w, price: [reg, ren] };
  }
  const WHOLE = 500;
  const unsettled = [...clashes].filter((name) => !(best[name].w >= WHOLE && lost[name] < WHOLE));
  return { tlds: Object.fromEntries(Object.entries(best).map(([name, b]) => [name, b.price])), clashes: [...clashes], unsettled, foreign };
}

async function dynadot() {
  const url = "https://www.dynadot.com/domain/prices";
  const keep = process.env.PRICES_PAGES;
  let last = "";
  for (const [n, wait] of [0, 60_000, 180_000].entries()) {
    if (wait) { console.log(`dynadot: ${last}; trying again in ${wait / 1000} s`); await sleep(wait); }
    let res, html, failed;
    try {
      res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) dmnr.uk prices", accept: "text/html" }, signal: AbortSignal.timeout(60_000) });
      html = await res.text();
    } catch (e) { failed = `${e.cause?.code ?? e.name}: ${e.cause?.message || e.cause?.errors?.map((x) => x.message).join("; ") || e.message}`; }
    const where = res ? `HTTP ${res.status}${res.redirected ? ` from ${res.url}` : ""}` : "";
    const ray = `cf-ray ${res?.headers.get("cf-ray") ?? "none"}`;
    if (failed) last = res ? `${where}, then the page broke off (${failed}), ${ray}` : `no answer (${failed})`;
    else {
      const { tlds, clashes, unsettled, foreign } = dynadotTable(html);
      const count = Object.keys(tlds).length;
      // What turns the read down; rows in another currency are only reported.
      const why = [
        !res.ok && "an error status",
        count < 500 && `only ${count} extensions`,
        !tlds.com && "no .com row",
        unsettled.length && `${unsettled.length} extensions priced differently in two lists that are not a whole table against a part (${unsettled.slice(0, 3).map((t) => `.${t}`).join(", ")}${unsettled.length > 3 ? " …" : ""})`,
      ].filter(Boolean);
      const dropped = Object.entries(foreign).map(([c, k]) => `${c} ${k}`).join(", ");
      const notes = [
        n && `on try ${n + 1}`,
        clashes.length && `${clashes.length} priced differently in two lists, the longer list taken (${clashes.slice(0, 3).map((t) => `.${t}`).join(", ")})`,
        dropped && `rows dropped for another currency: ${dropped}`,
      ].filter(Boolean);
      if (!why.length) {
        put("dynadot.json", { asOf: today, currency: "USD", tlds });
        console.log(`dynadot: ${count} extensions${notes.length ? ` (${notes.join("; ")})` : ""}`);
        return;
      }
      const title = html.match(/<title[^>]*>([^<]{0,80})/)?.[1]?.trim() ?? "none";
      last = `turned down: ${why.join("; ")}${dropped ? `; rows dropped for another currency: ${dropped}` : ""} — ${where}, ${html.length} characters, ${(html.match(/"reg_price"/g) ?? []).length} reg_price keys, ${/id="__NUXT_DATA__"/.test(html) ? "a" : "no"} payload, title "${title}", ${ray}`;
    }
    if (keep && res) {
      mkdirSync(keep, { recursive: true });
      writeFileSync(`${keep}/dynadot-${n + 1}.txt`, [`${last}`, `HTTP ${res.status} ${res.url}`, ...[...res.headers].map(([k, v]) => `${k}: ${v}`)].join("\n") + "\n");
      if (html !== undefined) writeFileSync(`${keep}/dynadot-${n + 1}.html`, html);
    }
  }
  throw new Error(`dynadot: no table after three tries, the last ${last}; data/dynadot.json is left as it was`);
}

async function rdap() {
  const res = await fetch("https://data.iana.org/rdap/dns.json");
  if (!res.ok) throw new Error(`rdap: HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.services)) throw new Error("rdap: no services in the bootstrap file");
  const tlds = {};
  for (const [names, urls] of json.services) {
    const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
    for (const t of names) tlds[t.toLowerCase()] = url.replace(/\/?$/, "/");
  }
  if (Object.keys(tlds).length < 500 || !tlds.com) throw new Error(`rdap: only ${Object.keys(tlds).length} extensions in the bootstrap file`);
  put("rdap.json", { asOf: today, publication: json.publication, tlds });
  console.log(`rdap: ${Object.keys(tlds).length} extensions with a server`);
}

async function iana() {
  const res = await fetch("https://data.iana.org/TLD/tlds-alpha-by-domain.txt");
  if (!res.ok) throw new Error(`iana: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const version = lines[0]?.startsWith("#") ? lines[0].replace(/^#\s*/, "") : "";
  const tlds = lines.filter((l) => !l.startsWith("#")).map((l) => l.toLowerCase());
  if (!version || tlds.length < 1000 || !tlds.includes("com")) throw new Error(`iana: ${tlds.length} lines, not the root zone list`);
  put("iana.json", { asOf: today, version, tlds });
  console.log(`iana: ${tlds.length} top-level domains in the root zone`);
}

// Run as a script, not when the tests import dynadotTable.
const jobs = { porkbun, dynadot, rdap, iana, godaddy };
const script = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (script) {
  if (only && !Object.hasOwn(jobs, only)) throw new Error(`no source "${only}": ${Object.keys(jobs).join(", ")}`);
  for (const [name, job] of Object.entries(jobs)) {
    if (only && only !== name) continue;
    await job();
  }
}
