// Builds data/marcaria.json from the two price lists copied off Marcaria's
// site: data/marcaria-countries.txt and data/marcaria-gtlds.txt. Marcaria
// sells country-code extensions nobody else in the tables does, from
// .com.br to .co.jp, at a price per year; it has no public API and its site
// refuses scripted requests (403), so the lists are copied in a browser:
//
//   1. Open https://www.marcaria.com/register/countrypricesdom.asp?cont=all
//      and run in the console
//        const row = (tr) => [...tr.children].map((td) => td.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
//        const num = (s) => (s.replace(/,/g, "").match(/\d+/g) || []).map(Number);
//        let region = "";
//        copy([...document.querySelectorAll("tr")].map(row).flatMap((c) => {
//          if (c.length === 1 && /^(America|Europe|Africa|Asia|Oceania|Generic|Alternative)$/.test(c[0]))
//            return c[0] === region ? [] : ["#" + (region = c[0])];
//          if (c.length !== 5 || !/^\.[a-z0-9.-]+$/i.test(c[0])) return [];
//          const [first, renew = first] = num(c[4]);
//          return [[c[0].slice(1).toLowerCase(), c[1].replace(/^Generic-.*/, "Generic"), first, renew, num(c[3])[0]].join("|")];
//        }).join("\n"));
//      and paste under the header of data/marcaria-countries.txt. A row there
//      reads extension, country, price for the minimum term, years, and the
//      price per year, which is the one kept.
//   2. At https://www.marcaria.com/register/newgtldspricesdom.asp?cont=all a
//      row has no country column; with row and num as above, run
//        copy([...document.querySelectorAll("tr")].map(row).filter((c) => c.length === 4 && /^\.[a-z0-9.-]+$/i.test(c[0]))
//          .map((c) => { const [first, renew = first] = num(c[3]); return [c[0].slice(1).toLowerCase(), first, renew, num(c[2])[0]].join("|"); })
//          .filter((l, i, a) => a.findIndex((m) => m.split("|")[0] === l.split("|")[0]) === i).join("\n"));
//      and paste into data/marcaria-gtlds.txt. That page lists an extension
//      once per category; the first line is kept.
//   3. Set the #asOf line in both files, then: node tools/marcaria.mjs
//
// One page load per list and per refresh: the snippets read the page that is
// open, and nothing here fetches Marcaria's pages from a script or on a
// schedule.
//
// Where Marcaria offers a discount, the price-per-year cell holds two
// figures, "$23 $53" with the second struck through, and a tooltip says
// the discount is valid only for the first year: the first figure is the
// first year and the second the renewal. A cell with one figure is both.
// Extensions not sold to the public (.edu, .int) are left out whatever
// Marcaria lists.
import { readFileSync, writeFileSync } from "node:fs";

const data = (f) => new URL(`../data/${f}`, import.meta.url);
const NOT_FOR_SALE = new Set(["edu", "int"]);

function read(file, cols) {
  const rows = {};
  let asOf = "";
  for (const line of readFileSync(data(file), "utf8").split("\n")) {
    if (line.startsWith("#asOf")) { asOf = line.slice(5).trim(); continue; }
    if (!line.trim() || line.startsWith("#")) continue;
    const c = line.split("|").map((s) => s.trim());
    const tld = c[cols.tld].toLowerCase(), first = Number(c[cols.first]), renew = Number(c[cols.renew]);
    const years = Number(c[cols.years]);
    if (!/^[a-z0-9.-]+$/.test(tld) || !(first > 0) || !(renew > 0) || !(years >= 1)) throw new Error(`${file}: bad line "${line}"`);
    if (NOT_FOR_SALE.has(tld) || rows[tld]) continue;
    rows[tld] = { first, renew, years };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`${file}: no #asOf YYYY-MM-DD line`);
  return { rows, asOf };
}

const countries = read("marcaria-countries.txt", { tld: 0, first: 2, renew: 3, years: 4 });
const gtlds = read("marcaria-gtlds.txt", { tld: 0, first: 1, renew: 2, years: 3 });
const tlds = {}, years = {};
for (const src of [countries, gtlds]) {
  for (const [tld, r] of Object.entries(src.rows)) {
    if (tlds[tld]) continue;
    tlds[tld] = [r.first, r.renew];
    if (r.years > 1) years[tld] = r.years;
  }
}
const asOf = countries.asOf < gtlds.asOf ? countries.asOf : gtlds.asOf;
writeFileSync(data("marcaria.json"), JSON.stringify({
  asOf, currency: "USD",
  source: "https://www.marcaria.com/register/countrypricesdom.asp?cont=all and newgtldspricesdom.asp?cont=all, copied in a browser",
  note: "First year and renewal, per year of the minimum term: a discounted first year with the struck-through price as the renewal, otherwise the same price twice; `years` lists the extensions whose minimum term is longer than a year.",
  tlds, years,
}, null, 1) + "\n");
console.log(`marcaria: ${Object.keys(tlds).length} extensions, ${Object.keys(years).length} with a term over a year, as of ${asOf}`);
