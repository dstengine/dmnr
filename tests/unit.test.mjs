// The parts with no browser in them: what typed text means, how rows are
// ordered, how the votes make a verdict, how prices print, where an
// extension's RDAP server is, what the registrars' answers mean, what the
// api/check and api/avail handlers refuse, and what the service worker
// precaches. Run: npm run build && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { best, explain, icannReserved, lengthBucket, money, order, parse, rdapFor, rdapVote, shortLabelHint, verdict } from "../src/model.ts";
import { answer404, refusal } from "../src/refusal.js";
import { askAll, enabled, parseDynadot, parseGandi, parseGodaddy, parseNamecom, parseNamesilo, parsePorkbun, parseSpaceship } from "../src/providers.js";
import check from "../api/check.js";
import avail, { MAX } from "../api/avail.js";

const known = ["com", "uk", "co.uk", "xyz", "co"];

test("parse: a bare name", () => {
  assert.deepEqual(parse("  Coffee ", known), { name: "coffee", pinned: null, unknownTld: undefined });
});
test("parse: a name with a known extension pins it, the longest suffix winning", () => {
  assert.equal(parse("my-shop.co.uk", known).pinned, "co.uk");
  assert.equal(parse("my-shop.co.uk", known).name, "my-shop");
  assert.equal(parse("thing.co", known).pinned, "co");
});
test("parse: a URL is stripped to its name", () => {
  const q = parse("https://www.dmnr.uk/path?x=1", known);
  assert.equal(q.name, "dmnr");
  assert.equal(q.pinned, "uk");
});
test("parse: an unknown extension is named and the first label searched", () => {
  const q = parse("shop.somethingelse", known);
  assert.equal(q.name, "shop");
  assert.equal(q.unknownTld, "somethingelse");
  assert.equal(q.error, undefined);
});
test("parse: spaces become hyphens, case is dropped", () => {
  assert.equal(parse("My Shop", known).name, "my-shop");
});
test("parse: errors say why", () => {
  assert.match(parse("héllo", known).error, /Letters/);
  assert.match(parse("-abc", known).error, /hyphen/);
  assert.match(parse("a".repeat(64), known).error, /63/);
  assert.equal(parse("", known).name, "");
  assert.equal(parse("...", known).name, "");
});

const ext = (tld, pb, gd, dd = null) => ({ tld, pb, gd, dd, rdap: null });
test("best: the cheaper registrar, by first year or by renewal", () => {
  const e = ext("xyz", [1.11, 11.44], [0.99, 14.99]);
  assert.deepEqual(best(e), { price: 0.99, who: "gd" });
  assert.deepEqual(best(e, "renewal"), { price: 11.44, who: "pb" });
  assert.equal(best(ext("none", null, null)), null);
  assert.deepEqual(best(ext("tie", [5, 5], [5, 5])), { price: 5, who: "pb" });
  assert.deepEqual(best(ext("three", [5, 5], [4, 9], [3, 3])), { price: 3, who: "dd" });
  assert.deepEqual(best(ext("three", [5, 5], [4, 9], [3, 30]), "renewal"), { price: 5, who: "pb" });
  assert.deepEqual(best(ext("only", null, null, [2, 2])), { price: 2, who: "dd" });
});
test("order: cheapest first, the pinned extension before everything, unpriced last", () => {
  const rows = [
    { domain: "a.com", ext: ext("com", [9.73, 9.73], [12.99, 22.99]), state: "idle" },
    { domain: "a.xyz", ext: ext("xyz", [1.11, 11.44], null), state: "idle" },
    { domain: "a.uk", ext: ext("uk", [6.5, 6.5], null), state: "idle" },
    { domain: "a.zz", ext: ext("zz", null, null), state: "idle" },
  ];
  assert.deepEqual(order(rows, "cheapest", null).map((r) => r.ext.tld), ["xyz", "uk", "com", "zz"]);
  assert.deepEqual(order(rows, "renewal", null).map((r) => r.ext.tld), ["uk", "com", "xyz", "zz"]);
  assert.deepEqual(order(rows, "alpha", null).map((r) => r.ext.tld), ["com", "uk", "xyz", "zz"]);
  assert.deepEqual(order(rows, "cheapest", "com").map((r) => r.ext.tld), ["com", "xyz", "uk", "zz"]);
  assert.equal(rows[0].ext.tld, "com", "order does not reorder its input");
});
test("money", () => {
  assert.equal(money(5.66), "$5.66");
  assert.equal(money(1234.5), "$1,234.50");
  assert.equal(money(0.99), "$0.99");
  assert.equal(money(7), "$7.00");
});
test("rdapFor walks up to the registry", () => {
  const servers = { uk: "https://rdap.nominet.uk/uk/", com: "https://rdap.verisign.com/com/v1/" };
  assert.equal(rdapFor("co.uk", servers), "https://rdap.nominet.uk/uk/");
  assert.equal(rdapFor("uk", servers), "https://rdap.nominet.uk/uk/");
  assert.equal(rdapFor("io", servers), null);
});
test("verdict: one taken settles it, reserved next, then the share of sources that said free", () => {
  assert.deepEqual(verdict({ dns: "taken", dns2: "free", rdap: "free", godaddy: "free" }), { state: "taken", sure: 100 });
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "reserved" }), { state: "reserved", sure: 100 });
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "free", godaddy: "free" }), { state: "available", sure: 100 });
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "free", godaddy: "premium" }), { state: "available", sure: 100 });
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "silent", godaddy: "silent", namesilo: "free" }), { state: "maybe", sure: 60 });
  // Sources that do not deal in the extension were never asked.
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "na", godaddy: "na" }), { state: "available", sure: 100 });
  assert.deepEqual(verdict({ dns: "silent", dns2: "silent", rdap: "silent" }), { state: "unknown", sure: 0 });
  assert.deepEqual(verdict({ dns: "na", rdap: "na" }), { state: "unknown", sure: 0 });
  assert.deepEqual(verdict({}), { state: "unknown", sure: 0 });
});
test("rdapVote and lengthBucket", () => {
  assert.equal(rdapVote("found"), "taken");
  assert.equal(rdapVote("not-found"), "free");
  assert.equal(rdapVote("reserved"), "reserved");
  assert.equal(rdapVote("unavailable"), "silent");
  assert.equal(rdapVote("none"), "na");
  assert.equal(lengthBucket("uk"), "2");
  assert.equal(lengthBucket("com"), "3");
  assert.equal(lengthBucket("co.uk"), "4");
  assert.equal(lengthBucket("agency"), "4");
});
test("explain names who said what, in words a tooltip can carry", () => {
  const words = explain({ dns: "free", dns2: "silent", rdap: "free", godaddy: "premium", namesilo: "taken", gandi: "na" });
  assert.equal(words, "NameSilo: taken · Cloudflare DNS, the registry: free · GoDaddy: free at a premium price · Google DNS: no answer");
  assert.equal(explain({}), "");
});

// ---- the registrars' answers, as their documentation shows them
test("parseGodaddy: available, taken, an unsupported extension, a name it never answered", () => {
  const got = parseGodaddy({
    domains: [{ domain: "A.com", available: true, definitive: true }, { domain: "b.com", available: false }],
    errors: [{ domain: "c.zz", code: "UNSUPPORTED_TLD", message: "TLD zz is not supported" }],
  }, ["a.com", "b.com", "c.zz", "d.com"]);
  assert.deepEqual(got, { "a.com": "free", "b.com": "taken", "c.zz": "na", "d.com": "silent" });
});
test("parsePorkbun: yes/no with premium, unresolved is silence, invalid is not sold", () => {
  const got = parsePorkbun({
    status: "SUCCESS", checked: 3,
    domains: { "a.com": { avail: "yes", premium: "no" }, "b.com": { response: { avail: "no" } }, "p.com": { avail: "yes", premium: "yes" } },
    unresolved: ["u.com"], invalid: [{ domain: "x.zz", reason: "unsupported" }],
  }, ["a.com", "b.com", "p.com", "u.com", "x.zz", "n.com"]);
  assert.deepEqual(got, { "a.com": "free", "b.com": "taken", "p.com": "premium", "u.com": "silent", "x.zz": "na", "n.com": "silent" });
});
test("parseNamesilo: lists as arrays or as one object", () => {
  assert.deepEqual(parseNamesilo({ reply: { code: 300, available: [{ domain: "a.com", price: 9.99 }], unavailable: ["b.com"], invalid: [{ domain: "c.zz" }] } }, ["a.com", "b.com", "c.zz", "d.com"]),
    { "a.com": "free", "b.com": "taken", "c.zz": "na", "d.com": "silent" });
  assert.deepEqual(parseNamesilo({ reply: { available: { domain: "a.com", price: 9.99, premium: 1 }, unavailable: { domain: "b.com" } } }, ["a.com", "b.com"]),
    { "a.com": "premium", "b.com": "taken" });
});
test("parseNamecom: purchasable with premium, a reason that says the extension is not sold", () => {
  const got = parseNamecom({ results: [
    { domainName: "a.com", purchasable: true, premium: false }, { domainName: "p.com", purchasable: true, premium: true },
    { domainName: "b.com", purchasable: false, reason: "already registered" }, { domainName: "c.zz", purchasable: false, reason: "TLD not supported" },
  ] }, ["a.com", "p.com", "b.com", "c.zz", "d.com"]);
  assert.deepEqual(got, { "a.com": "free", "p.com": "premium", "b.com": "taken", "c.zz": "na", "d.com": "silent" });
});
test("parseSpaceship reads the answer loosely", () => {
  assert.deepEqual(parseSpaceship({ items: [{ domain: "a.com", available: true }, { domain: "b.com", available: false }, { name: "c.com", status: "available", isPremium: true }] }, ["a.com", "b.com", "c.com", "d.com"]),
    { "a.com": "free", "b.com": "taken", "c.com": "premium", "d.com": "silent" });
  assert.deepEqual(parseSpaceship([{ domain: "a.com", availability: "unavailable" }], ["a.com"]), { "a.com": "taken" });
});
test("parseGandi: the create product's status", () => {
  assert.equal(parseGandi({ products: [{ name: "a.com", process: "create", status: "available" }] }), "free");
  assert.equal(parseGandi({ products: [{ name: "a.com", process: "create", status: "unavailable" }] }), "taken");
  assert.equal(parseGandi({ products: [{ name: "a.com", process: "create", status: "unavailable_premium" }] }), "premium");
  assert.equal(parseGandi({ products: [{ name: "a.com", process: "create", status: "pending" }] }), "silent");
  assert.equal(parseGandi({ products: [{ name: "a.com", process: "create", status: "reserved_corporate" }] }), "na");
  assert.equal(parseGandi({}), "silent");
});
test("parseDynadot: yes/no, and the busy answers are silence", () => {
  assert.deepEqual(parseDynadot({ SearchResponse: { ResponseCode: "0", SearchResults: [
    { DomainName: "a.com", Available: "yes", Price: "9.99 in USD" }, { DomainName: "b.com", Available: "no" }, { DomainName: "c.com", Available: "over_quota" },
  ] } }, ["a.com", "b.com", "c.com", "d.com"]), { "a.com": "free", "b.com": "taken", "c.com": "silent", "d.com": "silent" });
});
test("GoDaddy: when the bulk call is over its monthly quota, the names are asked one by one", async () => {
  const calls = [];
  const fetcher = async (url) => {
    const u = String(url);
    calls.push(u);
    if (!u.includes("domain=")) return new Response(JSON.stringify({ code: "QUOTA_EXCEEDED", message: "The monthly quota for requests has been exceeded." }), { status: 429 });
    const d = new URL(u).searchParams.get("domain");
    if (d === "slow.com") return new Response("", { status: 429 });
    if (d === "dmnr.uk") return new Response(JSON.stringify({ code: "UNSUPPORTED_TLD", message: "Invalid tld error: No config for dmnr.uk" }), { status: 422 });
    return new Response(JSON.stringify({ domain: d, available: d.startsWith("free"), definitive: true }), { status: 200 });
  };
  const godaddy = enabled({ GODADDY_API_KEY: "k" })[0];
  const got = await godaddy.ask(["free1.com", "taken1.com", "slow.com", "dmnr.uk"], { GODADDY_API_KEY: "k" }, fetcher);
  assert.deepEqual(got, { "free1.com": "free", "taken1.com": "taken", "slow.com": "silent", "dmnr.uk": "na" });
  assert.equal(calls.length, 5);
});
test("enabled: a provider is on when every key it names is set", () => {
  assert.deepEqual(enabled({}), []);
  assert.deepEqual(enabled({ GODADDY_API_KEY: "k", PORKBUN_API_KEY: "k" }).map((p) => p.id), ["godaddy"]);
  assert.deepEqual(enabled({ PORKBUN_API_KEY: "k", PORKBUN_SECRET_KEY: "s", NAMESILO_API_KEY: "k" }).map((p) => p.id), ["namesilo", "porkbun"]);
});
test("askAll: every enabled provider asked in its batches, a failure is silence, keys never in the answer", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("godaddy")) return new Response(JSON.stringify({ domains: JSON.parse(init.body).map((d) => ({ domain: d, available: d.startsWith("free") })) }), { status: 200 });
    if (u.includes("namesilo")) return new Response("oops", { status: 500 });
    if (u.includes("gandi")) return new Response(JSON.stringify({ products: [{ process: "create", status: "available" }] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const env = { GODADDY_API_KEY: "secret-g", NAMESILO_API_KEY: "secret-n", GANDI_PAT: "secret-p" };
  const out = await askAll(["free1.com", "taken1.com", "free2.com"], env, fetcher);
  assert.deepEqual(out.sources, ["godaddy", "namesilo", "gandi"]);
  assert.deepEqual(out.votes, {
    "free1.com": { godaddy: "free", namesilo: "silent", gandi: "free" },
    "taken1.com": { godaddy: "taken", namesilo: "silent", gandi: "free" },
    "free2.com": { godaddy: "free", namesilo: "silent", gandi: "free" },
  });
  assert.equal(calls.filter((u) => u.includes("gandi")).length, 3, "Gandi takes one name per call");
  assert.equal(calls.filter((u) => u.includes("godaddy")).length, 1, "GoDaddy takes the batch in one call");
  assert.doesNotMatch(JSON.stringify(out), /secret-/);
});

// Real 404 bodies, as the registries sent them on 21 Oct 2026.
test("refusal: a registry's reason for withholding a name", () => {
  assert.equal(refusal({ errorCode: 404, title: "Not Found", description: ["Domain Name: coffee.bar", "This name is not available for registration:", "This domain has been reserved for future strategic use.\nIf you represent a brand or partner with a unique opportunity, we’d love to hear from you — contact info@ideas.bar"] }),
    "This domain has been reserved for future strategic use. If you represent a brand or partner with a unique opportunity, we’d love to hear from you — contact…");
  assert.equal(refusal({ errorCode: 404, title: "Not Found", description: ["Domain Name: example.pw", "This name is not available for registration:", "Registry Blocked"] }), "Registry Blocked");
  assert.equal(refusal({ errorCode: 404, title: "Not Found", description: ["Domain Name: example.bar", "This name is not available for registration:", "IANA Reserved"] }), "IANA Reserved");
  assert.equal(refusal({ errorCode: 404, title: "Error in processing request", description: ["example.shop is a reserved name"] }), "example.shop is a reserved name");
  assert.equal(refusal({ errorCode: 404, title: "01044", description: ["The domain name requested has usage restrictions applied to it. Please see your Registrar for more details."] }),
    "The domain name requested has usage restrictions applied to it. Please see your Registrar for more details.");
  assert.equal(refusal({ errorCode: 404, title: "Object not found", description: ["The domain you request is prohibited.\r\n"] }), "The domain you request is prohibited.");
  assert.equal(refusal({ errorCode: 404, title: "Object not found", description: ["??????? ????????????   \r\nThe name you are trying to register is reserved by the Registry. Please visit the Registry?s Reserved Names Policy at http://en.nic.wang/policy.html or contact your registrar for further information. \r\n  "] }),
    "The name you are trying to register is reserved by the Registry. Please visit the Registry’s Reserved Names Policy at http://en.nic.wang/policy.html or…");
});
test("answer404: an RDAP error, an empty body, or a web server's page", () => {
  assert.deepEqual(answer404('{"errorCode":404,"title":"Object not found","description":["Object not found"]}'), { state: "not-found" });
  assert.deepEqual(answer404(""), { state: "not-found" });
  assert.deepEqual(answer404('{"errorCode":404,"title":"Error in processing request","description":["example.shop is a reserved name"]}'), { state: "reserved", note: "example.shop is a reserved name" });
  assert.deepEqual(answer404("<!doctype html><html lang=\"en\"><head><title>HTTP Status 404 – Not Found</title>"), { state: "unavailable" });
  assert.deepEqual(answer404("{}"), { state: "not-found" });
  assert.deepEqual(answer404("404 Not found"), { state: "not-found" });
});
test("icannReserved: the Specification 5 labels, in generic extensions only", () => {
  assert.match(icannReserved("example", "info"), /ICANN/);
  assert.match(icannReserved("www", "xyz"), /reserved/i);
  assert.equal(icannReserved("example", "uk"), null);
  assert.equal(icannReserved("example", "co.uk"), null);
  assert.equal(icannReserved("coffee", "bar"), null);
});
test("shortLabelHint: one and two characters, in generic extensions only", () => {
  assert.match(shortLabelHint("ab", "xyz"), /premium/);
  assert.match(shortLabelHint("x", "lol"), /premium/);
  assert.equal(shortLabelHint("x", "co.bz"), null);
  assert.equal(shortLabelHint("ab", "uk"), null);
  assert.equal(shortLabelHint("abc", "xyz"), null);
});
test("refusal: a plain 'no such domain' is not a reason", () => {
  assert.equal(refusal({ errorCode: 404, title: "Object not found", description: ["Object not found"] }), null);
  assert.equal(refusal({ errorCode: 404, title: "Not found", description: ["No data found"] }), null);
  assert.equal(refusal({ errorCode: 404, description: ["Domain zq84f42092.bar is available for registration", "Please visit https://rdap.registry.bar/registrars/ for a list of accredited registrars"] }), null);
  assert.equal(refusal({ errorCode: 404, title: "Not Found", description: ["Domain Not Found", "zqc73b0324.id"] }), null);
  assert.equal(refusal({ errorCode: 404, title: "Not Found", description: ["© 2026 Example Registry. All rights reserved."] }), null);
  assert.equal(refusal({ errorCode: 404 }), null);
  assert.equal(refusal({}), null);
  assert.equal(refusal(null), null);
  assert.equal(refusal("<!doctype html><title>404</title>"), null);
});

const call = async (query) => {
  const out = { code: 200, headers: {}, body: null };
  const res = { status(c) { out.code = c; return res; }, setHeader(k, v) { out.headers[k] = v; }, json(b) { out.body = b; } };
  await check({ query }, res);
  return out;
};
test("api/check refuses what is not a domain", async () => {
  for (const domain of ["", "nodots", "-bad.com", "a b.com", "x".repeat(64) + ".com", "../etc"]) {
    assert.equal((await call({ domain })).code, 400, domain);
  }
});
test("api/check knows the servers the bootstrap lacks", async () => {
  // nic.io is registered; a 200 from Identity Digital says so (network).
  const out = await call({ domain: "nic.io" });
  assert.equal(out.body.server, "https://rdap.identitydigital.services/rdap/");
  assert.equal(out.body.registered, true);
});
test("api/check answers null where no registry publishes RDAP", async () => {
  const out = await call({ domain: "example.no-such-tld-zz" });
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, { domain: "example.no-such-tld-zz", registered: null, server: null });
  assert.match(out.headers["Cache-Control"], /s-maxage=600/);
});

const callAvail = async (query, env = {}, fetcher) => {
  const headers = {};
  let code = 200, body;
  const res = { status(c) { code = c; return res; }, setHeader(k, v) { headers[k] = v; }, json(b) { body = b; } };
  await avail({ query }, res, env, fetcher);
  return { code, body, headers };
};
test("api/avail refuses what is not a short list of domains", async () => {
  for (const domains of ["nodots", "a.com,-bad.com", "a b.com", Array.from({ length: MAX + 1 }, (_, i) => `d${i}.com`).join(",")]) {
    assert.equal((await callAvail({ domains })).code, 400, domains.slice(0, 40));
  }
});
test("api/avail with no keys names no sources, and says so without a list too", async () => {
  const bare = await callAvail({});
  assert.deepEqual(bare.body, { sources: [], votes: {} });
  const out = await callAvail({ domains: "B.com,a.com,a.com" });
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, { sources: [], votes: { "a.com": {}, "b.com": {} } });
  assert.match(out.headers["Cache-Control"], /s-maxage=600/);
});
test("api/avail asks the configured registrars and hands the votes back", async () => {
  const fetcher = async (url, init) => new Response(JSON.stringify({ domains: JSON.parse(init.body).map((d) => ({ domain: d, available: d === "a.com" })) }), { status: 200 });
  const out = await callAvail({ domains: "a.com,b.com" }, { GODADDY_API_KEY: "k" }, fetcher);
  assert.deepEqual(out.body, { sources: ["godaddy"], votes: { "a.com": { godaddy: "free" }, "b.com": { godaddy: "taken" } } });
});

// ---- the service worker agrees with the page it caches (needs dist/)
const built = (f) => new URL(`../dist/${f}`, import.meta.url);
test("the service worker precaches what the page loads, stamped with the build's version", () => {
  const sw = readFileSync(built("sw.js"), "utf8");
  const html = readFileSync(built("index.html"), "utf8");
  const version = html.match(/app\.js\?v=([0-9a-f]{10})/)?.[1];
  assert.ok(version, "the page does not name a version");
  assert.ok(!sw.includes("__VERSION__") && sw.includes(`"dmnr-${version}"`), "the worker is not stamped with the page's version");
  for (const f of [`app.js?v=${version}`, `style.css?v=${version}`, `data.json?v=${version}`, '"./"', '"icon.svg"', '"manifest.webmanifest"']) assert.ok(sw.includes(f), `${f} is not precached`);
  for (const f of ["app.js", "style.css", "data.json", "icon.svg", "manifest.webmanifest"]) assert.ok(existsSync(built(f)), `${f} is not in dist/`);
  // Availability must never come from a cache: the proxy and the registrar links go to the network.
  assert.match(sw, /startsWith\("\/api\/"\)/);
  assert.match(sw, /startsWith\("\/go\/"\)/);
});
test("the shipped tables carry three registrars, each dated, no zero prices", () => {
  const tables = JSON.parse(readFileSync(built("data.json"), "utf8"));
  for (const who of ["porkbun", "godaddy", "dynadot"]) assert.match(tables.asOf[who], /^\d{4}-\d{2}-\d{2}$/, `${who} is not dated`);
  const rows = Object.entries(tables.tlds);
  for (const who of ["pb", "gd", "dd"]) assert.ok(rows.filter(([, e]) => e[who]).length >= 500, `fewer than 500 ${who} prices`);
  assert.ok(rows.some(([, e]) => e.pb && e.gd && e.dd), "no extension priced by all three");
  for (const [tld, e] of rows) for (const who of ["pb", "gd", "dd"]) if (e[who]) assert.ok(e[who][0] > 0 && e[who][1] > 0, `${tld} ${who} has a zero price`);
});
test("the page registers the worker and says when it is offline", () => {
  const app = readFileSync(built("app.js"), "utf8");
  assert.match(app, /serviceWorker\.register\("sw\.js"\)/);
  assert.match(app, /Offline: prices only/);
  const manifest = JSON.parse(readFileSync(built("manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"), "no maskable icon");
  assert.ok(manifest.icons.some((i) => i.sizes === "192x192"), "no 192px icon");
});
