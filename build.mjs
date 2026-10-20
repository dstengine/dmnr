// Builds dist/: the page, one bundled script, the stylesheet, the price
// tables as data.json, icons, a share card, a manifest, robots.txt and the
// sitemap. Asset URLs are relative; canonical URLs name dmnr.uk.
import { build } from "esbuild";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const src = (f) => new URL(`./src/${f}`, import.meta.url);
const data = (f) => new URL(`./data/${f}`, import.meta.url);
const dist = (f = "") => new URL(`./dist/${f}`, import.meta.url);
const SITE = "https://dmnr.uk/";
const ACCENT = "#0F766E", DARK = "#0B1514", LIGHT = "#F2F7F6";

rmSync(dist(), { recursive: true, force: true });
mkdirSync(dist());
const pub = new URL("./public/", import.meta.url);
if (existsSync(pub)) cpSync(pub, dist(), { recursive: true });

// ---- the tables the page ships. Only extensions under a root-zone TLD:
// Porkbun also sells Handshake names, which ordinary DNS does not resolve,
// and a price for one of those is not a price for a domain. A price of
// zero is Porkbun's placeholder for an extension it cannot sell yet.
const json = (f) => JSON.parse(readFileSync(data(f), "utf8"));
const porkbun = json("porkbun.json"), godaddy = json("godaddy.json"), rdap = json("rdap.json");
const iana = new Set(json("iana.json").tlds);
const real = (tld) => iana.has(tld.split(".").pop());
const sold = (p) => p && p[0] > 0 && p[1] > 0 ? p : null;
const rdapFor = (tld) => {
  const parts = tld.split(".");
  for (let i = 0; i < parts.length; i++) {
    const s = rdap.tlds[parts.slice(i).join(".")];
    if (s) return s;
  }
  return null;
};
const tlds = {};
for (const [tld, price] of Object.entries(porkbun.tlds)) if (real(tld) && sold(price)) tlds[tld] = { pb: price, gd: null, rdap: rdapFor(tld) };
let gdAsOf = "";
for (const [tld, v] of Object.entries(godaddy.tlds)) {
  if (!sold(v.price) || !real(tld)) continue;
  (tlds[tld] ??= { pb: null, gd: null, rdap: rdapFor(tld) }).gd = v.price;
  if (v.asOf > gdAsOf) gdAsOf = v.asOf;
}
const tables = { asOf: { porkbun: porkbun.asOf, godaddy: gdAsOf, rdap: rdap.publication }, tlds };
writeFileSync(dist("data.json"), JSON.stringify(tables));
const count = Object.keys(tlds).length;
const hundreds = `${Math.floor(count / 100) * 100}+`;
const day = (iso) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
const asOf = porkbun.asOf === gdAsOf ? day(porkbun.asOf) : `${day(porkbun.asOf)} (Porkbun) and ${day(gdAsOf)} (GoDaddy)`;

// The version is the hash of what ships, so an unchanged build keeps its
// cache and a changed one replaces it.
const hash = createHash("sha256");
for (const f of ["app.ts", "model.ts", "style.css", "index.html", "icon.svg"]) hash.update(readFileSync(src(f)));
hash.update(readFileSync(dist("data.json")));
const version = hash.digest("hex").slice(0, 10);

await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  outfile: "dist/app.js",
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "warning",
});
cpSync(src("style.css"), dist("style.css"));
cpSync(src("icon.svg"), dist("icon.svg"));

const svg = readFileSync(src("icon.svg"));
for (const size of [180, 192, 512]) {
  await sharp(svg, { density: 300 }).resize(size, size).png().toFile(dist(`icon-${size}.png`).pathname);
}
await sharp({ create: { width: 512, height: 512, channels: 4, background: ACCENT } })
  .composite([{ input: await sharp(svg, { density: 300 }).resize(380, 380).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(dist("icon-maskable.png").pathname);
const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${DARK}"/>
  <text x="80" y="250" font-family="Helvetica, Arial, sans-serif" font-size="84" font-weight="800" fill="#E6F0EE">Domain name search</text>
  <text x="80" y="340" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#2DD4BF">${hundreds} extensions · cheapest first</text>
  <text x="80" y="420" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#94A8A4">Porkbun and GoDaddy prices, first year and renewal, checked live</text>
</svg>`;
await sharp(Buffer.from(card)).png().toFile(dist("share.png").pathname);

writeFileSync(dist("manifest.webmanifest"), JSON.stringify({
  name: "dmnr — domain name search",
  short_name: "dmnr",
  description: `Domain name search across ${hundreds} extensions, cheapest first, with Porkbun's and GoDaddy's prices.`,
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: DARK,
  theme_color: ACCENT,
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
}, null, 2));

writeFileSync(dist("index.html"), readFileSync(src("index.html"), "utf8")
  .replaceAll("__VERSION__", version)
  .replaceAll("__COUNT__", hundreds)
  .replaceAll("__ASOF__", asOf));

// The page is dated by the last commit that changed what it shows (src/ and
// the price tables), not by the build: a date that is always "now" is worse
// than none. Vercel gets the upload without .git, so the date is kept in
// src/updated.txt, which every local build refreshes from git.
const stampFile = src("updated.txt");
let updated;
try {
  updated = execFileSync("git", ["log", "-1", "--format=%cI", "--", "src/", "data/", ":!src/updated.txt"], { encoding: "utf8" }).trim();
} catch {}
if (updated) writeFileSync(stampFile, updated + "\n");
else if (existsSync(stampFile)) updated = readFileSync(stampFile, "utf8").trim();
writeFileSync(dist("robots.txt"), `User-agent: *\nAllow: /\nDisallow: /go/\nDisallow: /api/\n\nSitemap: ${SITE}sitemap.xml\n`);
writeFileSync(dist("sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE}</loc>${updated ? `\n    <lastmod>${updated}</lastmod>` : ""}
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`);

const kb = (f) => (readFileSync(dist(f)).length / 1024).toFixed(1);
console.log(`dist/ built, version ${version}; ${count} extensions (${hundreds}); app.js ${kb("app.js")} KB, style.css ${kb("style.css")} KB, data.json ${kb("data.json")} KB; light ${LIGHT}`);
