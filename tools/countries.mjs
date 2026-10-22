// Writes data/countries.json: which country each country-code extension
// belongs to, and the country's English name. Every two-letter extension
// in the root zone is a country code (ISO 3166-1 alpha-2, with .uk standing
// for GB), named through the Unicode CLDR data Node ships; the handful of
// internationalised country-code extensions the tables price are listed by
// hand, each checked against iana.org/domains/root/db. Run it after
// `node tools/prices.mjs iana`, look at the diff, commit it.
//
//   node tools/countries.mjs
import { readFileSync, writeFileSync } from "node:fs";

const data = (f) => new URL(`../data/${f}`, import.meta.url);
const iana = JSON.parse(readFileSync(data("iana.json"), "utf8"));

/** Country codes whose CLDR name is not the one a domain buyer looks for. */
const NAMES = { SU: "Soviet Union", PS: "Palestine", HK: "Hong Kong", MO: "Macao", IO: "British Indian Ocean Territory" };
/** Extensions whose code is not the extension itself. */
const CODES = { uk: "GB" };
/** Internationalised country-code extensions, by hand: the label in the
    root zone's own script, and whose it is. */
const IDN = {
  "xn--fiqs8s": "CN",        // .中国
  "xn--j6w193g": "HK",       // .香港
  "xn--h2brj9c": "IN",       // .भारत
  "xn--gecrj9c": "IN",       // .ભારત
  "xn--s9brj9c": "IN",       // .ਭਾਰਤ
  "xn--45brj9c": "IN",       // .ভারত
  "xn--mgbbh1a71e": "IN",    // .بھارت
  "xn--xkc2dl3a5ee0h": "IN", // .இந்தியா
  "xn--fpcrj9c3d": "IN",     // .భారత్
  "xn--e1a4c": "EU",         // .ею
  "xn--qxa6a": "EU",         // .ευ
  "xn--p1ai": "RU",          // .рф
  "xn--90ais": "BY",         // .бел
  "xn--j1amh": "UA",         // .укр
  "xn--3e0b707e": "KR",      // .한국
  "xn--kprw13d": "TW",       // .台湾
  "xn--kpry57d": "TW",       // .台灣
};

const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const zones = {};
const names = {};
for (const tld of iana.tlds) {
  const code = tld.length === 2 ? CODES[tld] ?? tld.toUpperCase() : IDN[tld];
  if (!code) continue;
  const name = NAMES[code] ?? display.of(code);
  if (!name) throw new Error(`no name for ${tld} (${code})`);
  zones[tld] = code;
  names[code] = name;
}
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const out = { asOf: iana.asOf, source: "ISO 3166-1 codes named by CLDR; the internationalised extensions by hand from iana.org/domains/root/db", zones: sorted(zones), names: sorted(names) };
writeFileSync(data("countries.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`data/countries.json: ${Object.keys(zones).length} extensions, ${Object.keys(names).length} countries`);
