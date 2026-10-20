# dmnr.uk

Domain name search: type a name, see which extensions are free and what
Porkbun and GoDaddy charge for them, cheapest first, with the renewal price
beside the first-year one.

- `src/` — the page, its styles, and the search (`app.ts`), with the parts
  that need no browser in `model.ts`.
- `data/` — the tables the page ships: Porkbun's and GoDaddy's prices, the
  IANA RDAP bootstrap and the root-zone list. `node tools/prices.mjs`
  refreshes them (one source as an argument: `porkbun`, `godaddy`, `rdap`,
  `iana`); the GoDaddy pass takes ten minutes at its rate limit and needs
  `GODADDY_API_KEY` in `../.env`.
- `api/check.js` — a proxy to the registries' RDAP servers for the ones
  that refuse browsers.
- `build.mjs` — writes `dist/`: the data as `data.json`, the bundled
  script, icons, share card, manifest, robots.txt and sitemap.

```
npm install
npm run build     # dist/
npm test          # node:test over model.ts and api/check.js
npm run e2e       # Chromium at 320px, light and dark; needs the network
npm run serve     # http://localhost:4174/ with api/check mounted
```

Deploys to Vercel from this directory: `vercel deploy --prod`. The `/go/`
links are redirects to the registrars' own search pages and are kept out
of robots.txt.

MIT licence.
