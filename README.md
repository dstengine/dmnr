# dmnr.uk

Domain name search: type a name, see which extensions are free and what
Porkbun, GoDaddy and Dynadot charge for them, cheapest first, with the
renewal price beside the first-year one. Every extension is checked at
several sources, and a row is as sure as its sources agree.

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
- `api/avail.js` — the registrars' own availability APIs, asked for a
  batch of names with the keys the deployment holds; `src/providers.js`
  has one adapter per registrar and the parsers the tests feed.
- `tools/env-set.sh KEY` — takes the value from the clipboard and stores it
  as `KEY` in `../.env` and in the Vercel production environment, so a
  registrar key never passes through a terminal or a chat.
  `tools/env-push.sh` copies every known key from `../.env` to Vercel.
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

## How a name is checked

Each name is put to several sources and each casts a vote: `free`,
`taken`, `reserved`, `premium` (free at a price the tables do not show),
`silent` (asked, no usable answer) or `na` (the source does not deal in
the extension). `verdict()` in `src/model.ts` turns the votes into the
row: one `taken` settles it, `reserved` next, otherwise the share of
sources that said free is the row's confidence — all of them is
"available", some of them is "likely free · 60%", none is "ask the
registrar". The badge's tooltip names who said what.

The browser asks three sources itself, for every row, eight rows at a
time: Cloudflare's and Google's resolvers for nameservers, and the
registry's RDAP server (through `api/check` where it refuses browsers).
Names those have not settled go to `api/avail` twenty at a time, three
batches in flight, and the registrars answer there with the keys the
deployment holds:

| Source | Key(s) | Per call | Notes |
|---|---|---|---|
| GoDaddy | `GODADDY_API_KEY` | 500 | The bulk call has a small monthly quota of its own; past it the names are asked one by one, 60 a minute |
| NameSilo | `NAMESILO_API_KEY` | 200 | |
| Name.com | `NAMECOM_USERNAME`, `NAMECOM_TOKEN` | 50 | 20 calls a second |
| Porkbun | `PORKBUN_API_KEY`, `PORKBUN_SECRET_KEY` | 25 | 200 names a minute; sustained checking with few registrations is throttled to 50 names per 5 minutes |
| Spaceship | `SPACESHIP_API_KEY`, `SPACESHIP_API_SECRET` | 20 | 30 calls per 30 s; the answer's shape is read loosely until a key confirms it |
| Dynadot | `DYNADOT_API_KEY` | 100 | A regular account answers one name per call and wants the caller's IP whitelisted, which a Vercel function has not got |
| Gandi | `GANDI_PAT` | 1 | |

A source whose keys are missing is simply not there: `api/avail` names
the sources it has, and the page counts only those. With no keys the
verdict rests on DNS and RDAP, as before. Every call is cached at the
edge for ten minutes; a rate limit or an error is silence for the names
it covered, never an error on the page, and silence lowers the share.
Keys never leave the function: nothing logs them and the answer carries
only votes.

Not here, and why: Namecheap wants the caller's IP whitelisted; Fastly's
Domain Research API (the former Domainr) is billed per request; Hostinger
and IONOS need a hosting account; Cloudflare Registrar, Marcaria and
Hover publish no API.

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
