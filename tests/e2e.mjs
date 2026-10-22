// Drives the built page in Chromium at 320px, light and dark: a fresh name
// finds available extensions cheapest first, a typed extension is pinned,
// our own dmnr.uk is taken, the filters and the sort work, a bad name is
// explained, nothing overflows, and the page talks only to the resolvers,
// the registries and itself (the registrars are asked through api/avail). Then, offline: the service worker opens the
// page with its prices and says the checks need a connection. Needs the
// network: the checks are real.
// Run: npm run build && npm run e2e
import { chromium, devices } from "playwright";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { serve } from "./server.mjs";

const PORT = 4174;
const BASE = process.env.URL || `http://localhost:${PORT}/`;
const shots = process.env.SHOTS || ".test";
mkdirSync(shots, { recursive: true });
const server = process.env.URL ? null : await serve(PORT);
const rdapHosts = new Set(["rdap.json", "rdap-extra.json"].flatMap((f) => Object.values(JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8")).tlds)).map((u) => new URL(u).host));
const browser = await chromium.launch();

for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ ...devices["iPhone SE"], viewport: { width: 320, height: 640 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [], foreign = new Set();
  page.on("pageerror", (e) => errors.push(e.message));
  // A 404 from a registry is "no such domain", the answer wanted; a 403 or
  // 429 is a registry's rate limit, which the page answers with "ask the
  // registrar"; a CORS refusal is what api/check is there for. Chromium
  // logs all of them as errors.
  const expected = /status of (?:404|403|429)|CORS policy|net::ERR_FAILED/;
  page.on("console", (m) => m.type() === "error" && !expected.test(m.text()) && errors.push(m.text()));
  page.on("request", (r) => !r.url().startsWith(BASE) && foreign.add(new URL(r.url()).host));

  await page.goto(BASE);
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector("[data-tld-count]").textContent));
  const count = Number(await page.textContent("[data-tld-count]"));
  assert.ok(count >= 600, `only ${count} extensions`);
  await page.screenshot({ path: `${shots}/empty-320-${scheme}.png`, fullPage: true });

  // A name nobody has: available rows, cheapest first.
  const fresh = `zq${randomBytes(4).toString("hex")}`;
  await page.fill("[data-q]", fresh);
  await page.waitForFunction(() => document.querySelectorAll(".row").length === 60);
  // The sixty shown settle first; the rest go on behind them.
  await page.waitForFunction(() => [...document.querySelectorAll(".row")].every((r) => !/idle|checking/.test(r.dataset.state)), null, { timeout: 180000 });
  const states = await page.$$eval(".row", (rows) => rows.map((r) => r.dataset.state));
  const tally = Object.fromEntries(["available", "taken", "reserved", "maybe", "unknown"].map((s) => [s, states.filter((x) => x === s).length]));
  assert.ok(tally.available >= 1, `no available row for ${fresh}: ${JSON.stringify(tally)}`);
  assert.ok(tally.taken <= 3, `a fresh name is taken in ${tally.taken} extensions`);
  // Half, not all: the rdap.nic.* registries limit queries per IP and a few
  // runs in a row from one machine use that up — the page then says
  // "ask the registrar", which is the honest answer, not a fault.
  assert.ok(tally.available + tally.maybe >= 30, `only ${tally.available + tally.maybe} of 60 answered for ${fresh}: ${JSON.stringify(tally)}`);
  const prices = await page.$$eval(".row .offer.best .price", (els) => els.map((e) => Number(e.textContent.replace(/[$,]/g, ""))));
  for (let i = 1; i < prices.length; i++) assert.ok(prices[i] >= prices[i - 1], `row ${i} is cheaper than row ${i - 1}`);
  await page.screenshot({ path: `${shots}/results-320-${scheme}.png`, fullPage: true });

  // Nothing wider than the phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0, "the page scrolls sideways at 320px");

  // Sixty more on request; every row carries its length bucket and the
  // badge says who said what.
  await page.click("[data-more]");
  await page.waitForFunction(() => document.querySelectorAll(".row").length === 120);
  assert.ok(await page.$$eval(".row", (rows) => rows.every((r) => /^[234]$/.test(r.dataset.len))), "a row without a length bucket");
  assert.match(await page.$eval(".row .state", (e) => e.title), /DNS|registry/, "the badge does not say who answered");
  await page.click('[data-len="2"]');
  assert.ok(await page.$$eval(".row", (rows) => rows.filter((r) => getComputedStyle(r).display !== "none").every((r) => r.dataset.len === "2")), "the length filter shows other lengths");
  await page.click('[data-len="any"]');
  await page.click("[data-unverified]");
  assert.ok(await page.$$eval(".row", (rows) => rows.filter((r) => getComputedStyle(r).display !== "none").every((r) => /maybe|unknown/.test(r.dataset.state))), "unverified shows a settled row");
  await page.click("[data-unverified]");

  // Our own name, with its extension: pinned first, and taken.
  await page.fill("[data-q]", "dmnr.uk");
  await page.waitForFunction(() => document.querySelector(".row .dom")?.textContent === "dmnr.uk");
  await page.waitForFunction(() => document.querySelector(".row").dataset.state === "taken", null, { timeout: 30000 });
  assert.equal(await page.$eval(".row .from", (e) => e.textContent.includes("$")), true, "a taken row still names its price");
  assert.match(await page.textContent(".row .from"), /Porkbun \$[\d.]+ · Dynadot \$[\d.]+/, "a taken row does not list every registrar that sells the extension");

  // A name the registry withholds: not available, and the registry's words shown.
  await page.fill("[data-q]", "coffee.bar");
  await page.waitForFunction(() => document.querySelector(".row .dom")?.textContent === "coffee.bar");
  await page.waitForFunction(() => document.querySelector(".row").dataset.state === "reserved", null, { timeout: 30000 });
  assert.match(await page.textContent(".row .note"), /reserved/i, "the registry's reason is not shown");
  assert.equal(await page.$eval(".row .offers", (e) => getComputedStyle(e).display), "none", "a reserved row still offers to buy");
  await page.screenshot({ path: `${shots}/reserved-320-${scheme}.png` });
  await page.fill("[data-q]", "dmnr.uk");
  await page.waitForFunction(() => document.querySelector(".row")?.dataset.state === "taken", null, { timeout: 30000 });

  // Available only hides the taken rows; A–Z keeps the pinned row first.
  await page.click("[data-only-free]");
  assert.equal(await page.$eval(".row", (e) => getComputedStyle(e).display), "none");
  await page.click('[data-sort="alpha"]');
  assert.equal(await page.textContent(".row .dom"), "dmnr.uk");
  assert.equal(await page.$eval(".row:nth-child(2) .dom b", (e) => e.textContent < ".m"), true, "A–Z does not start near A");
  await page.click("[data-only-free]");
  await page.screenshot({ path: `${shots}/pinned-320-${scheme}.png` });

  // A bad name is explained, and an unknown extension named.
  await page.fill("[data-q]", "héllo");
  await page.waitForFunction(() => !document.querySelector("[data-hint]").hidden);
  assert.match(await page.textContent("[data-hint]"), /Letters/);
  assert.equal((await page.$$(".row")).length, 0);
  await page.fill("[data-q]", "shop.nosuchtld");
  await page.waitForFunction(() => /nosuchtld/.test(document.querySelector("[data-hint]").textContent));
  await page.waitForFunction(() => document.querySelectorAll(".row").length === 60);

  const others = [...foreign].filter((h) => h !== "cloudflare-dns.com" && h !== "dns.google" && !rdapHosts.has(h));
  assert.deepEqual(others, [], "requests outside the resolvers, the registries and the page");
  assert.deepEqual(errors, [], "console errors");
  console.log(`ok  ${scheme}: ${count} extensions; ${fresh}: ${JSON.stringify(tally)}; pinned, filter, sort, hints, no overflow, no outside requests`);
  await ctx.close();
}
// Offline: once the worker has installed, the page opens from its cache with
// the extension list and prices, and says the checks cannot run.
{
  const ctx = await browser.newContext({ ...devices["iPhone SE"], viewport: { width: 320, height: 640 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector("[data-tld-count]").textContent));
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    return !!reg.active && keys.some((k) => k.startsWith("dmnr-")) && !!navigator.serviceWorker.controller;
  }, null, { timeout: 30000 });
  const cached = await page.evaluate(async () => (await caches.keys()).find((k) => k.startsWith("dmnr-")));
  await ctx.setOffline(true);
  await page.goto(`${BASE}?q=coffee`);
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector("[data-tld-count]").textContent));
  assert.ok(Number(await page.textContent("[data-tld-count]")) >= 600, "the offline page lost its extensions");
  await page.waitForFunction(() => document.querySelectorAll(".row").length === 60);
  await page.waitForFunction(() => /^Offline: .*extensions shown$/.test(document.querySelector("[data-status]").textContent), null, { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".row")].every((r) => !/idle|checking/.test(r.dataset.state)), null, { timeout: 60000 });
  assert.doesNotMatch(await page.textContent("[data-status]"), /checked|available/, "the offline status claims a check ran");
  const offline = await page.$$eval(".row", (rows) => rows.map((r) => r.dataset.state));
  assert.ok(offline.every((s) => s === "unknown"), `offline rows claim a verdict: ${JSON.stringify([...new Set(offline)])}`);
  assert.equal(await page.$eval(".row .offer.best .price", (e) => /^\$\d/.test(e.textContent)), true, "no price offline");
  await page.screenshot({ path: `${shots}/offline-320-light.png` });
  await ctx.setOffline(false);
  console.log(`ok  offline: cache ${cached}, the extensions and prices shown, every row "ask the registrar"`);
  await ctx.close();
}
await browser.close();
server?.close();
