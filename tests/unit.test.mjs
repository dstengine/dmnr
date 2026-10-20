// The parts with no browser in them: what typed text means, how rows are
// ordered, how prices print, where an extension's RDAP server is, and what
// the api/check handler refuses. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { best, judge, money, order, parse, rdapFor } from "../src/model.ts";
import check from "../api/check.js";

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

const ext = (tld, pb, gd) => ({ tld, pb, gd, rdap: null });
test("best: the cheaper registrar, by first year or by renewal", () => {
  const e = ext("xyz", [1.11, 11.44], [0.99, 14.99]);
  assert.deepEqual(best(e), { price: 0.99, who: "gd" });
  assert.deepEqual(best(e, "renewal"), { price: 11.44, who: "pb" });
  assert.equal(best(ext("none", null, null)), null);
  assert.deepEqual(best(ext("tie", [5, 5], [5, 5])), { price: 5, who: "pb" });
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
test("judge", () => {
  assert.deepEqual(judge("has-ns", "none"), { state: "taken", via: "dns" });
  assert.deepEqual(judge("no-ns", "found"), { state: "taken", via: "rdap" });
  assert.deepEqual(judge("no-ns", "not-found"), { state: "available", via: "rdap" });
  assert.deepEqual(judge("failed", "not-found"), { state: "available", via: "rdap" });
  assert.deepEqual(judge("no-ns", "none"), { state: "maybe", via: "dns" });
  assert.deepEqual(judge("no-ns", "unavailable"), { state: "unknown" });
  assert.deepEqual(judge("failed", "none"), { state: "unknown" });
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
test("api/check answers null where no registry publishes RDAP", async () => {
  const out = await call({ domain: "example.no-such-tld-zz" });
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, { domain: "example.no-such-tld-zz", registered: null, server: null });
  assert.match(out.headers["Cache-Control"], /s-maxage=600/);
});
