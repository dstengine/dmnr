# dmnr.uk

Domain name search: type a name, see which extensions are free and what
Porkbun, GoDaddy and Dynadot charge for them, cheapest first, with the
renewal price beside the first-year one.

- `src/` — the page, its styles, and the search (`app.ts`), with the parts
  that need no browser in `model.ts`.
- `data/` — the tables the page ships: Porkbun's, GoDaddy's and Dynadot's prices,
  the IANA RDAP bootstrap, the root-zone list, and `rdap-extra.json`, the RDAP
  servers the bootstrap lacks (io, me, de, ch, us…), each checked by hand. `node tools/prices.mjs`
  refreshes them (one source as an argument: `porkbun`, `dynadot`,
  `godaddy`, `rdap`, `iana`); the GoDaddy pass takes ten minutes at its rate limit and needs
  `GODADDY_API_KEY` in `../.env`.
- `api/check.js` — a proxy to the registries' RDAP servers for the ones
  that refuse browsers. `src/refusal.js` reads a registry's reason out of
  its 404, where it gives one: a name the registry withholds is "reserved",
  not "available".
- `build.mjs` — writes `dist/`: the data as `data.json`, the bundled
  script, the service worker (`src/sw.js`, which keeps the page openable
  offline and caches no availability answer), icons, share card, manifest,
  robots.txt and sitemap.

```
npm install
npm run build     # dist/
npm test          # node:test over model.ts and api/check.js
npm run e2e       # Chromium at 320px, light and dark; needs the network
npm run serve     # http://localhost:4174/ with api/check mounted
```

Deploys go through git push: the Vercel project `dmnr` is linked to
[github.com/dstengine/dmnr](https://github.com/dstengine/dmnr), and every
push to `main` builds and deploys. `vercel deploy --prod` from this
directory still works for a one-off. The `/go/` links are redirects to the
registrars' own search pages and are kept out of robots.txt.

## Adding a registrar

A registrar earns a column when all of this holds; one "no" is a no.

- A price list a script can read with no account and no key, so
  `tools/prices.mjs` can refresh it: JSON, or a page that carries the
  whole table in its markup. A page behind a bot wall cannot be refreshed.
- Both prices per extension, the first year and the renewal, as standard
  rates before sales (or with the sale marked so the standard can be read).
- US dollars: one currency on the page, or "cheapest first" is a lie.
- At least half of the extensions the page lists, or the column is mostly
  empty.
- A search URL that takes the typed name and lands on its result with no
  login, for `/go/<registrar>/<domain>`.
- robots.txt and the terms allow reading the price page; the refresh is
  one fetch by hand, not a crawl.
- An ICANN-accredited registrar, or the retail brand of one.

Then a job in `tools/prices.mjs` writing `data/<name>.json`
(`{ asOf, currency, tlds: { tld: [firstYear, renewal] } }`), the merge in
`build.mjs`, `Extension` and `Registrar` in `src/model.ts`,
`REGISTRARS` in `src/app.ts`, the redirect in `vercel.json`, the texts
in `src/index.html`, and the tests.

MIT licence.
