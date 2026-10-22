// The registrars' own availability APIs, asked from api/avail.js with the
// keys the deployment holds. Each provider is a job over a batch of
// domains that returns one vote per domain: "free", "taken", "premium"
// (free, at a price the tables do not show), "silent" (asked, no usable
// answer: a timeout, a rate limit, an error) or "na" (the registrar does
// not deal in that extension). The parsers are pure, so the tests can
// feed them the registrars' answers without the network; the fetches are
// in `ask`. Plain JavaScript so api/avail.js can import it as is.
//
// A provider is on when every key it names is set in the environment;
// nothing here reads a key file, and no key is ever logged or returned.

const TIMEOUT = 8000;

const bool = (v) => v === true || v === "true" || v === "yes" || v === 1;
const low = (s) => String(s ?? "").toLowerCase();

/** GoDaddy, bulk: POST /v1/domains/available with an array of names,
    checkType=FAST (the registry is asked for FULL). `definitive: false`
    is a cached guess, still an answer. Errors name the domains a TLD it
    does not sell. */
export function parseGodaddy(json, domains) {
  const out = {};
  for (const d of json?.domains ?? []) {
    if (!d?.domain) continue;
    out[low(d.domain)] = d.available ? "free" : "taken";
  }
  for (const e of json?.errors ?? []) {
    if (e?.domain) out[low(e.domain)] = /unsupported|not supported|invalid.*tld|tld/i.test(`${e.code} ${e.message}`) ? "na" : "silent";
  }
  for (const d of domains) out[d] ??= "silent";
  return out;
}

/** Porkbun, bulk: POST /domain/checkDomain with up to 25 names. The
    answer keys each name to the single-check shape (avail yes/no, premium
    yes/no); `unresolved` is "the registry did not answer", `invalid` is
    "we cannot sell this". */
export function parsePorkbun(json, domains) {
  const out = {};
  const answered = json?.domains ?? {};
  for (const [name, v] of Object.entries(answered)) {
    const r = v?.response ?? v ?? {};
    const avail = low(r.avail);
    out[low(name)] = avail === "yes" ? (low(r.premium) === "yes" ? "premium" : "free") : avail === "no" ? "taken" : "silent";
  }
  for (const name of json?.unresolved ?? []) out[low(typeof name === "string" ? name : name?.domain)] = "silent";
  for (const e of json?.invalid ?? []) {
    const name = low(typeof e === "string" ? e : e?.domain);
    if (name) out[name] = "na";
  }
  for (const d of domains) out[d] ??= "silent";
  return out;
}

/** NameSilo: GET checkRegisterAvailability?domains=a,b (up to 200). The
    reply lists available (with prices), unavailable and invalid names;
    each list is an array, or one object when there is one name. */
export function parseNamesilo(json, domains) {
  const out = {};
  const reply = json?.reply ?? {};
  const each = (v) => (v == null ? [] : Array.isArray(v) ? v : typeof v === "object" && !v.domain ? Object.values(v) : [v]);
  for (const a of each(reply.available)) {
    const name = low(typeof a === "string" ? a : a?.domain);
    if (name) out[name] = bool(a?.premium) ? "premium" : "free";
  }
  for (const u of each(reply.unavailable)) {
    const name = low(typeof u === "string" ? u : u?.domain);
    if (name) out[name] = "taken";
  }
  for (const i of each(reply.invalid)) {
    const name = low(typeof i === "string" ? i : i?.domain);
    if (name) out[name] = "na";
  }
  for (const d of domains) out[d] ??= "silent";
  return out;
}

/** Name.com: POST /core/v1/domains:checkAvailability with up to 50
    names. `purchasable` with `premium`; a name that is not purchasable
    carries a reason, which says whether the extension is sold at all. */
export function parseNamecom(json, domains) {
  const out = {};
  for (const r of json?.results ?? []) {
    const name = low(r?.domainName);
    if (!name) continue;
    if (r.purchasable) out[name] = r.premium ? "premium" : "free";
    else out[name] = /not (?:supported|offered|available for (?:registration|sale))|unsupported|tld/i.test(String(r.reason ?? "")) ? "na" : "taken";
  }
  for (const d of domains) out[d] ??= "silent";
  return out;
}

/** Spaceship: POST /v1/domains/available with up to 20 names. The shape
    of the answer is read loosely — an array of items, each naming its
    domain and whether it is available — until a key confirms it. */
export function parseSpaceship(json, domains) {
  const out = {};
  const items = Array.isArray(json) ? json : json?.items ?? json?.results ?? json?.domains ?? [];
  for (const it of items) {
    const name = low(it?.domain ?? it?.name ?? it?.domainName);
    if (!name) continue;
    const a = it.available ?? it.isAvailable ?? it.availability ?? it.status;
    const free = bool(a) || low(a) === "available";
    const gone = a === false || low(a) === "false" || low(a) === "unavailable" || low(a) === "taken" || low(a) === "registered";
    out[name] = free ? (bool(it.premium) || bool(it.isPremium) ? "premium" : "free") : gone ? "taken" : "silent";
  }
  for (const d of domains) out[d] ??= "silent";
  return out;
}

/** Gandi: GET /v5/domain/check?name=x, one name per call. The `create`
    product's status: available* is free, unavailable* is taken,
    pending and the errors are no answer, reserved_corporate is not sold. */
export function parseGandi(json) {
  const p = (json?.products ?? []).find((x) => x?.process === "create") ?? json?.products?.[0];
  const s = low(p?.status);
  if (s.startsWith("available")) return s === "available_preorder" ? "silent" : "free";
  if (s === "unavailable_premium") return "premium";
  if (s.startsWith("unavailable")) return "taken";
  if (s === "reserved_corporate" || s === "error_invalid") return "na";
  return "silent";
}

/** Dynadot, api3 search: domain0…domainN in one call. A regular account
    answers one name per command; bulk accounts answer up to a hundred.
    Available yes/no, or offline/system_busy/over_quota/error. */
export function parseDynadot(json, domains) {
  const out = {};
  const r = json?.SearchResponse ?? json;
  for (const it of r?.SearchResults ?? []) {
    const name = low(it?.DomainName);
    if (!name) continue;
    const a = low(it.Available);
    out[name] = a === "yes" ? (/premium/i.test(String(it.Price ?? "")) ? "premium" : "free") : a === "no" ? "taken" : "silent";
  }
  for (const d of domains) out[d] ??= "silent";
  return out;
}

const json = async (r) => {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return null; }
};

/** The providers, in the order they are asked. `batch` is the most names
    one call takes; `keys` the environment variables that switch it on. */
export const PROVIDERS = [
  {
    id: "godaddy", name: "GoDaddy", batch: 500, keys: ["GODADDY_API_KEY"],
    async ask(domains, env, fetch) {
      const headers = { authorization: `Bearer ${env.GODADDY_API_KEY}`, "content-type": "application/json", accept: "application/json" };
      const r = await fetch("https://api.godaddy.com/v1/domains/available?checkType=FAST", {
        method: "POST", headers, body: JSON.stringify(domains), signal: AbortSignal.timeout(TIMEOUT),
      });
      if (r.ok) return parseGodaddy(await json(r), domains);
      // The bulk call has a monthly quota of its own, small on an ordinary
      // key; the one-name call has only the per-minute one. Ask name by
      // name, a few at a time, and let a 429 there be silence.
      if (r.status !== 429 || !/QUOTA/i.test(await r.text())) return null;
      const out = {};
      let next = 0;
      const worker = async () => {
        while (next < domains.length) {
          const d = domains[next++];
          try {
            const one = await fetch(`https://api.godaddy.com/v1/domains/available?domain=${encodeURIComponent(d)}&checkType=FAST`, { headers, signal: AbortSignal.timeout(TIMEOUT) });
            // 422 UNSUPPORTED_TLD: an extension GoDaddy's API does not sell (.uk among them).
            if (one.status === 422) { out[d] = "na"; continue; }
            if (!one.ok) { out[d] = "silent"; continue; }
            const j = await json(one);
            out[d] = j?.available === true ? "free" : j?.available === false ? "taken" : "silent";
          } catch { out[d] = "silent"; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, domains.length) }, worker));
      return out;
    },
  },
  {
    id: "namesilo", name: "NameSilo", batch: 200, keys: ["NAMESILO_API_KEY"],
    async ask(domains, env, fetch) {
      const u = new URL("https://www.namesilo.com/api/checkRegisterAvailability");
      u.search = new URLSearchParams({ version: "1", type: "json", key: env.NAMESILO_API_KEY, domains: domains.join(",") }).toString();
      const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return null;
      return parseNamesilo(await json(r), domains);
    },
  },
  {
    id: "namecom", name: "Name.com", batch: 50, keys: ["NAMECOM_USERNAME", "NAMECOM_TOKEN"],
    async ask(domains, env, fetch) {
      const auth = Buffer.from(`${env.NAMECOM_USERNAME}:${env.NAMECOM_TOKEN}`).toString("base64");
      const r = await fetch("https://api.name.com/core/v1/domains:checkAvailability", {
        method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ domainNames: domains, purchaseType: "registration" }), signal: AbortSignal.timeout(TIMEOUT),
      });
      // 422: none of the names is in an extension it sells.
      if (r.status === 422) return Object.fromEntries(domains.map((d) => [d, "na"]));
      if (!r.ok) return null;
      return parseNamecom(await json(r), domains);
    },
  },
  {
    id: "porkbun", name: "Porkbun", batch: 25, keys: ["PORKBUN_API_KEY", "PORKBUN_SECRET_KEY"],
    async ask(domains, env, fetch) {
      const r = await fetch("https://api.porkbun.com/api/json/v3/domain/checkDomain", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ apikey: env.PORKBUN_API_KEY, secretapikey: env.PORKBUN_SECRET_KEY, domains }), signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) return null;
      const j = await json(r);
      if (j?.status && j.status !== "SUCCESS") return null;
      return parsePorkbun(j, domains);
    },
  },
  {
    id: "spaceship", name: "Spaceship", batch: 20, keys: ["SPACESHIP_API_KEY", "SPACESHIP_API_SECRET"],
    async ask(domains, env, fetch) {
      const r = await fetch("https://spaceship.dev/api/v1/domains/available", {
        method: "POST", headers: { "x-api-key": env.SPACESHIP_API_KEY, "x-api-secret": env.SPACESHIP_API_SECRET, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ domains }), signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) return null;
      return parseSpaceship(await json(r), domains);
    },
  },
  {
    id: "dynadot", name: "Dynadot", batch: 100, keys: ["DYNADOT_API_KEY"],
    async ask(domains, env, fetch) {
      const u = new URL("https://api.dynadot.com/api3.json");
      const q = new URLSearchParams({ key: env.DYNADOT_API_KEY, command: "search" });
      domains.forEach((d, i) => q.set(`domain${i}`, d));
      u.search = q.toString();
      const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return null;
      return parseDynadot(await json(r), domains);
    },
  },
  {
    id: "gandi", name: "Gandi", batch: 1, keys: ["GANDI_PAT"],
    async ask(domains, env, fetch) {
      const r = await fetch(`https://api.gandi.net/v5/domain/check?name=${encodeURIComponent(domains[0])}`, {
        headers: { authorization: `Bearer ${env.GANDI_PAT}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) return null;
      return { [domains[0]]: parseGandi(await json(r)) };
    },
  },
];

/** The providers whose keys the environment holds. */
export function enabled(env) {
  return PROVIDERS.filter((p) => p.keys.every((k) => env[k]));
}

/** Every enabled provider asked about every domain, in batches of what
    each takes, at most `width` calls in flight per provider. A provider
    that fails is silent for the names it failed on, never an error:
    the page counts silence. */
export async function askAll(domains, env, fetch, width = 4) {
  const providers = enabled(env);
  const votes = Object.fromEntries(domains.map((d) => [d, {}]));
  await Promise.all(providers.map(async (p) => {
    const batches = [];
    for (let i = 0; i < domains.length; i += p.batch) batches.push(domains.slice(i, i + p.batch));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        let got = null;
        try { got = await p.ask(batch, env, fetch); } catch { got = null; }
        for (const d of batch) votes[d][p.id] = got?.[d] ?? "silent";
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, batches.length) }, worker));
  }));
  return { sources: providers.map((p) => p.id), votes };
}
