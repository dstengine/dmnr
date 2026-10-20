// Drives the built page in Chromium at 320px, light and dark: a fresh name
// finds available extensions cheapest first, a typed extension is pinned,
// our own dmnr.uk is taken, the filter and the sort work, a bad name is
// explained, nothing overflows, and the page talks only to the resolver,
// the registries and itself. Needs the network: the checks are real.
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
const rdapHosts = new Set(Object.values(JSON.parse(readFileSync(new URL("../data/rdap.json", import.meta.url), "utf8")).tlds).map((u) => new URL(u).host));
const browser = await chromium.launch();

for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ ...devices["iPhone SE"], viewport: { width: 320, height: 640 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [], foreign = new Set();
  page.on("pageerror", (e) => errors.push(e.message));
  // A 404 from a registry is "no such domain", the answer wanted, and a CORS
  // refusal is what api/check is there for; Chromium logs both as errors.
  const expected = /status of 404|CORS policy|net::ERR_FAILED/;
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
  await page.waitForFunction(() => /extensions checked/.test(document.querySelector("[data-status]").textContent), null, { timeout: 120000 });
  const states = await page.$$eval(".row", (rows) => rows.map((r) => r.dataset.state));
  const tally = Object.fromEntries(["available", "taken", "maybe", "unknown"].map((s) => [s, states.filter((x) => x === s).length]));
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

  // Sixty more on request.
  await page.click("[data-more]");
  await page.waitForFunction(() => document.querySelectorAll(".row").length === 120);

  // Our own name, with its extension: pinned first, and taken.
  await page.fill("[data-q]", "dmnr.uk");
  await page.waitForFunction(() => document.querySelector(".row .dom")?.textContent === "dmnr.uk");
  await page.waitForFunction(() => document.querySelector(".row").dataset.state === "taken", null, { timeout: 30000 });
  assert.equal(await page.$eval(".row .from", (e) => e.textContent.includes("$")), true, "a taken row still names its price");

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

  const others = [...foreign].filter((h) => h !== "cloudflare-dns.com" && !rdapHosts.has(h));
  assert.deepEqual(others, [], "requests outside the resolver, the registries and the page");
  assert.deepEqual(errors, [], "console errors");
  console.log(`ok  ${scheme}: ${count} extensions; ${fresh}: ${JSON.stringify(tally)}; pinned, filter, sort, hints, no overflow, no outside requests`);
  await ctx.close();
}
await browser.close();
server?.close();
