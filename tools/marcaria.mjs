// Builds data/marcaria.json from the two price lists read off Marcaria's
// site: data/marcaria-countries.txt and data/marcaria-gtlds.txt. Marcaria
// sells country-code extensions nobody else in the tables does, from
// .com.br to .co.jp, at a price per year; it has no API and its site
// answers robots with 403, so the lists are read in a browser, by hand:
//
//   1. Open https://www.marcaria.com/register/countrypricesdom.asp?cont=all
//      and run in the console
//        copy([...document.querySelectorAll('tr')].map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean))
//          .filter(c => c.length >= 5 && /^\.[a-z0-9.-]+$/i.test(c[0]))
//          .map(c => [c[0].slice(1).toLowerCase(), c[1], c[4].match(/[\d,]+/)[0].replace(/,/g, ''), c[3].match(/\d+/)[0]].join('|')).join('\n'))
//      and paste under the header of data/marcaria-countries.txt.
//   2. The same at https://www.marcaria.com/register/newgtldspricesdom.asp?cont=all
//      with columns [0, 3, 2] (extension, price per year, years) into
//      data/marcaria-gtlds.txt; that page lists an extension once per
//      category, and the first line wins here.
//   3. Set the #asOf line in both files, then: node tools/marcaria.mjs
//
// The price Marcaria prints is per year of the minimum term, which is
// what Porkbun prints too, so the table keeps it as first year and
// renewal alike. Extensions not sold to the public (.edu, .int) are left
// out whatever Marcaria lists.
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
    const tld = c[cols.tld].toLowerCase(), price = Number(c[cols.price]), years = Number(c[cols.years] ?? 1);
    if (!/^[a-z0-9.-]+$/.test(tld) || !(price > 0)) throw new Error(`${file}: bad line "${line}"`);
    if (NOT_FOR_SALE.has(tld) || rows[tld]) continue;
    rows[tld] = { price, years: years > 1 ? years : 1 };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`${file}: no #asOf YYYY-MM-DD line`);
  return { rows, asOf };
}

const countries = read("marcaria-countries.txt", { tld: 0, price: 2, years: 3 });
const gtlds = read("marcaria-gtlds.txt", { tld: 0, price: 1, years: 2 });
const tlds = {}, years = {};
for (const src of [countries, gtlds]) {
  for (const [tld, r] of Object.entries(src.rows)) {
    if (tlds[tld]) continue;
    tlds[tld] = [r.price, r.price];
    if (r.years > 1) years[tld] = r.years;
  }
}
const asOf = countries.asOf < gtlds.asOf ? countries.asOf : gtlds.asOf;
writeFileSync(data("marcaria.json"), JSON.stringify({
  asOf, currency: "USD",
  source: "https://www.marcaria.com/register/countrypricesdom.asp?cont=all and newgtldspricesdom.asp?cont=all, read in a browser",
  note: "Price per year of the minimum term, kept as first year and renewal; `years` lists the extensions whose minimum term is longer than a year.",
  tlds, years,
}, null, 1) + "\n");
console.log(`marcaria: ${Object.keys(tlds).length} extensions, ${Object.keys(years).length} with a term over a year, as of ${asOf}`);
