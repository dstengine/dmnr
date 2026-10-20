# dmnr.uk

Domain name search: type a name, see which extensions are free and what
Porkbun and GoDaddy charge for them, cheapest first, with the renewal price
beside the first-year one.

- `src/` — the page, its styles, and the search (`app.ts`), with the parts
  that need no browser in `model.ts`.
- `data/` — the tables the page ships: Porkbun's and GoDaddy's prices, the
  IANA RDAP bootstrap, the root-zone list, and `rdap-extra.json`, the RDAP
  servers the bootstrap lacks (io, me, de, ch, us…), each checked by hand. `node tools/prices.mjs`
  refreshes them (one source as an argument: `porkbun`, `godaddy`, `rdap`,
  `iana`); the GoDaddy pass takes ten minutes at its rate limit and needs
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

MIT licence.
