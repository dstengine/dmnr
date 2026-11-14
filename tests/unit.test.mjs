// The parts with no browser in them: what typed text means, how rows are
// ordered, how the votes make a verdict, how prices print, where an
// extension's RDAP server is, what the registrars' answers mean, how
// Dynadot's price page is read, what the api/check and api/avail handlers
// refuse, and what the service worker precaches. Run: npm run build && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { best, countryOptions, explain, icannReserved, inCountry, lengthBucket, money, order, parse, rdapFor, rdapVote, shortLabelHint, verdict } from "../src/model.ts";
import { answer404, refusal } from "../src/refusal.js";
import { askAll, enabled, parseDynadot, parseGandi, parseGodaddy, parseNamecom, parseNamesilo, parsePorkbun, parseSpaceship } from "../src/providers.js";
import { dynadotTable } from "../tools/prices.mjs";
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

const ext = (tld, pb, gd, dd = null, mc = null) => ({ tld, pb, gd, dd, mc, rdap: null });
test("best: the cheaper registrar, by first year or by renewal", () => {
  const e = ext("xyz", [1.11, 11.44], [0.99, 14.99]);
  assert.deepEqual(best(e), { price: 0.99, who: "gd" });
  assert.deepEqual(best(e, "renewal"), { price: 11.44, who: "pb" });
  assert.equal(best(ext("none", null, null)), null);
  assert.deepEqual(best(ext("tie", [5, 5], [5, 5])), { price: 5, who: "pb" });
  assert.deepEqual(best(ext("three", [5, 5], [4, 9], [3, 3])), { price: 3, who: "dd" });
  assert.deepEqual(best(ext("three", [5, 5], [4, 9], [3, 30]), "renewal"), { price: 5, who: "pb" });
  assert.deepEqual(best(ext("only", null, null, [2, 2])), { price: 2, who: "dd" });
  assert.deepEqual(best(ext("country", null, null, null, [29, 29])), { price: 29, who: "mc" });
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
  // Sources that do not deal in the extension were never asked, and two
  // resolvers alone never make a name available.
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "na", godaddy: "na" }), { state: "maybe", sure: 50 });
  assert.deepEqual(verdict({ dns: "free", dns2: "free", rdap: "na", godaddy: "na", namecom: "free" }), { state: "available", sure: 100 });
  assert.deepEqual(verdict({ dns: "free", dns2: "silent" }), { state: "maybe", sure: 50 });
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
test("inCountry keeps one country's rows, every row without one", () => {
  const rows = [{ ext: { tld: "uk", cc: "GB" } }, { ext: { tld: "co.uk", cc: "GB" } }, { ext: { tld: "de", cc: "DE" } }, { ext: { tld: "com" } }];
  assert.deepEqual(inCountry(rows, "GB").map((r) => r.ext.tld), ["uk", "co.uk"]);
  assert.deepEqual(inCountry(rows, "").length, 4);
  assert.deepEqual(inCountry(rows, "ZZ"), []);
});
test("countryOptions are in name order", () => {
  assert.deepEqual(countryOptions({ GB: "United Kingdom", DE: "Germany", AI: "Anguilla" }), [["AI", "Anguilla"], ["DE", "Germany"], ["GB", "United Kingdom"]]);
});
test("data/countries.json: every two-letter root zone has a country, .uk is GB, the IDN zones are by hand", async () => {
  const { readFileSync } = await import("node:fs");
  const c = JSON.parse(readFileSync(new URL("../data/countries.json", import.meta.url), "utf8"));
  const iana = JSON.parse(readFileSync(new URL("../data/iana.json", import.meta.url), "utf8"));
  for (const tld of iana.tlds) if (tld.length === 2) assert.ok(c.names[c.zones[tld]], `no country for .${tld}`);
  assert.equal(c.zones.uk, "GB");
  assert.equal(c.names.GB, "United Kingdom");
  assert.equal(c.zones["xn--fiqs8s"], "CN");
  assert.equal(c.zones["xn--j6w193g"], "HK");
  assert.equal(c.zones.com, undefined);
});
test("parseSpaceship reads the answer loosely", () => {
  assert.deepEqual(parseSpaceship({ items: [{ domain: "a.com", available: true }, { domain: "b.com", available: false }, { name: "c.com", status: "available", isPremium: true }] }, ["a.com", "b.com", "c.com", "d.com"]),
    { "a.com": "free", "b.com": "taken", "c.com": "premium", "d.com": "silent" });
  assert.deepEqual(parseSpaceship([{ domain: "a.com", availability: "unavailable" }], ["a.com"]), { "a.com": "taken" });
  assert.deepEqual(parseSpaceship({ domains: [
    { domain: "google.com", result: "taken", premiumPricing: [] }, { domain: "z.com", result: "available", premiumPricing: [] },
    { domain: "p.com", result: "available", premiumPricing: [{ price: 1 }] }, { domain: "r.com", result: "reserved" },
  ] }, ["google.com", "z.com", "p.com", "r.com"]), { "google.com": "taken", "z.com": "free", "p.com": "premium", "r.com": "reserved" });
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
// A page shaped like Dynadot's: a Nuxt payload, one flat array in which
// objects and arrays hold indexes into it, and Reactive wraps a value.
const nuxtPage = (root) => {
  const flat = [];
  const put = (v) => {
    const i = flat.length; flat.push(null);
    if (v && v.$reactive) flat[i] = ["Reactive", put(v.$reactive)];
    else if (Array.isArray(v)) flat[i] = v.map(put);
    else if (v && typeof v === "object") flat[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]));
    else flat[i] = v;
    return i;
  };
  put(root);
  return `<html><title>Domain Prices</title><script type="application/json" data-ssr="true" id="__NUXT_DATA__">${JSON.stringify(flat)}</script></html>`;
};
const row = (name, reg, ren, sale = {}, currency = "USD") => ({ name, name_utf: name, reg_price: reg, original_reg_price: sale.reg ?? "-1", renew_price: ren, original_renew_price: sale.ren ?? "-1", google_data: { price: reg.replace("$", ""), currency } });
test("dynadotTable: every row wherever the page nests it, at the standard price, the table beating a promo card", () => {
  let deep = { rows: [{ heading: "Popular" }, row("com", "$11.62", "$11.62"), row("SHOP", "$1.99", "$29.99", { reg: "$29.99" }), row("rich", "$1,250.00", "$1,250.00"), row("gone", "$5.00", "-"), row("mx", "$230.00", "$230.00", {}, "MXN")] };
  for (let i = 0; i < 15; i++) deep = { $reactive: { level: i, inner: deep } };
  const promo = [row("com", "$0.99", "$0.99"), row("rich", "$9.00", "$9.00")];
  for (const [html, clashed] of [
    [nuxtPage({ $reactive: { banner: { title: "Sale" }, promo, page: deep } }), ["com", "rich"]],
    [nuxtPage({ $reactive: { banner: { title: "Sale" }, page: deep, promo } }), ["com", "rich"]],
    [nuxtPage({ $reactive: { featured: row("com", "$0.99", "$0.99"), page: deep } }), ["com"]],
  ]) {
    const { tlds, clashes, unsettled, foreign } = dynadotTable(html);
    assert.deepEqual(tlds, { com: [11.62, 11.62], shop: [29.99, 29.99], rich: [1250, 1250] });
    assert.deepEqual(clashes.sort(), clashed, "a promo priced unlike the table is reported, not taken");
    assert.deepEqual(unsettled.sort(), clashed, "a five-row table is no whole table: the read is not trusted to settle it");
    assert.deepEqual(foreign, { MXN: 1 });
  }
});
test("dynadotTable: a table keyed by extension weighs like a list, a currency in any case is read as one, one price twice is no clash", () => {
  const table = Object.fromEntries(["com", "net", "org"].map((n) => [n, row(n, "$10.00", "$12.00")]));
  const { tlds, clashes, foreign } = dynadotTable(nuxtPage({ $reactive: { promo: [row("com", "$1.00", "$1.00")], table, again: [row("net", "$10.00", "$12.00")] } }));
  assert.deepEqual(tlds, { com: [10, 12], net: [10, 12], org: [10, 12] });
  assert.deepEqual(clashes, ["com"]);
  assert.deepEqual(foreign, {});
  const lower = dynadotTable(nuxtPage({ rows: [row("com", "$9.00", "$9.00", {}, " usd "), row("de", "$5.00", "$5.00", {}, "eur")] }));
  assert.deepEqual(lower.tlds, { com: [9, 9] });
  assert.deepEqual(lower.foreign, { EUR: 1 });
});
test("dynadotTable: only a whole table settles a clash, whatever the number of promo rows", () => {
  const names = Array.from({ length: 520 }, (_, i) => (i ? `t${i}` : "com"));
  const table = names.map((n) => row(n, "$10.00", "$12.00"));
  const deals = ["com", "t1", "t2", "t3", "t4", "t5", "t6"].map((n) => row(n, "$0.99", "$0.99"));
  const whole = dynadotTable(nuxtPage({ $reactive: { deals, table } }));
  assert.equal(Object.keys(whole.tlds).length, 520);
  assert.deepEqual(whole.tlds.com, [10, 12]);
  assert.equal(whole.clashes.length, 7);
  assert.deepEqual(whole.unsettled, []);
  // The same rows split into lists of 300, 215 and 5, and a 21-row promo
  // list longer than the last of them: the promo would win, so it is unsettled.
  const popular = [...table.slice(0, 20), row("t516", "$0.99", "$0.99")];
  const split = dynadotTable(nuxtPage({ $reactive: { popular, a: table.slice(0, 300), b: table.slice(300, 515), c: table.slice(515) } }));
  assert.deepEqual(split.clashes, ["t516"]);
  assert.deepEqual(split.unsettled, ["t516"]);
  // Two whole tables at odds settle nothing either.
  const twice = dynadotTable(nuxtPage({ $reactive: { a: table, b: names.map((n) => row(n, n === "t9" ? "$1.00" : "$10.00", "$12.00")) } }));
  assert.deepEqual(twice.unsettled, ["t9"]);
});
test("dynadotTable: a page with no table reads as empty, not as an error", () => {
  const none = { tlds: {}, clashes: [], unsettled: [], foreign: {} };
  assert.deepEqual(dynadotTable("<html><title>Just a moment...</title></html>"), none);
  assert.deepEqual(dynadotTable('<script id="__NUXT_DATA__" type="application/json">[{"name":</script>'), none);
  assert.deepEqual(dynadotTable('<script id="__NUXT_DATA__" type="application/json">{"name":"com"}</script>'), none);
  assert.deepEqual(dynadotTable(nuxtPage({ $reactive: { page: { rows: [] }, error: { statusCode: 500 } } })), none);
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
test("api/check knows the servers the bootstrap lacks", async (t) => {
  // nic.io is registered; a 200 from Identity Digital says so (network).
  // A registry that does not answer (it rate-limits with 429) skips the
  // network half rather than failing: the weekly prices run gates its
  // commit on these tests, and one server's limit must not cost the week.
  const out = await call({ domain: "nic.io" });
  assert.equal(out.body.server, "https://rdap.identitydigital.services/rdap/");
  if (out.body.registered === null) return t.skip(`the registry did not answer (${out.body.status ?? out.body.error})`);
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
test("the shipped tables carry four registrars, each dated, no zero prices, and Marcaria's countries", () => {
  const tables = JSON.parse(readFileSync(built("data.json"), "utf8"));
  for (const who of ["porkbun", "godaddy", "dynadot", "marcaria"]) assert.match(tables.asOf[who], /^\d{4}-\d{2}-\d{2}$/, `${who} is not dated`);
  const rows = Object.entries(tables.tlds);
  for (const who of ["pb", "gd", "dd", "mc"]) assert.ok(rows.filter(([, e]) => e[who]).length >= 500, `fewer than 500 ${who} prices`);
  assert.ok(rows.some(([, e]) => e.pb && e.gd && e.dd), "no extension priced by all three");
  for (const [tld, e] of rows) for (const who of ["pb", "gd", "dd", "mc"]) if (e[who]) assert.ok(e[who][0] > 0 && e[who][1] > 0, `${tld} ${who} has a zero price`);
  // Marcaria's coverage: most countries' own zones, priced by it alone.
  assert.ok(Object.keys(tables.countries).length >= 200, `only ${Object.keys(tables.countries).length} countries have an extension`);
  for (const tld of ["com.br", "co.jp", "com.ar", "co.za", "com.mx"]) assert.ok(tables.tlds[tld]?.mc, `${tld} has no Marcaria price`);
  assert.equal(tables.tlds["com.br"].cc, "BR");
  assert.equal(tables.tlds.edu, undefined, ".edu is not for sale");
});
test("data/marcaria.json: the two lists copied off Marcaria's site, a first year and a renewal each", async () => {
  const { readFileSync } = await import("node:fs");
  const m = JSON.parse(readFileSync(new URL("../data/marcaria.json", import.meta.url), "utf8"));
  assert.match(m.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.keys(m.tlds).length >= 1000, `only ${Object.keys(m.tlds).length} extensions`);
  // A discount is on the first year only; the struck-through figure is the renewal.
  for (const [tld, p] of Object.entries(m.tlds)) assert.ok(Array.isArray(p) && p[0] > 0 && p[1] >= p[0], `${tld}: ${JSON.stringify(p)}`);
  assert.ok(Object.values(m.tlds).some(([first, renew]) => first < renew), "no discounted first year: the renewal column is being read as the first year again");
  assert.deepEqual(m.tlds["com.br"], [29, 29]);
  assert.deepEqual(m.tlds.coffee, [23, 50]);
  assert.deepEqual(m.tlds.eu, [9, 11]);
  assert.equal(m.years.ai, 2);
  assert.equal(m.tlds.edu, undefined);
  assert.equal(m.tlds.int, undefined);
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
