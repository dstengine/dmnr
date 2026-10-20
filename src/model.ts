// The part of the search that has no browser in it: what the typed text
// means, what each row knows, how rows are ordered. Kept free of DOM and
// fetch so tests/unit.test.mjs can hold it still.

/** One registrar's price for an extension: first year, then renewal, USD. */
export type Price = [registration: number, renewal: number];

export interface Extension {
  tld: string;
  /** Porkbun's prices, or null where it does not sell the extension. */
  pb: Price | null;
  /** GoDaddy's standard prices, or null. */
  gd: Price | null;
  /** The RDAP server that answers for this extension, or null. */
  rdap: string | null;
}

export interface Tables {
  asOf: { porkbun: string; godaddy: string; rdap: string };
  tlds: Record<string, Extension>;
}

export type Availability = "idle" | "checking" | "available" | "taken" | "maybe" | "unknown";

export interface Row {
  domain: string;
  ext: Extension;
  state: Availability;
  /** What answered: dns, rdap, or nothing yet. */
  via?: "dns" | "rdap";
}

export interface Query {
  /** The label to search, lower-case ASCII; "" when nothing usable was typed. */
  name: string;
  /** An extension the reader typed along with the name, to list first. */
  pinned: string | null;
  /** An extension the reader typed that the tables do not price. */
  unknownTld?: string;
  /** Why the name is unusable, when it is. */
  error?: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** "Dmnr.CO.UK", "https://www.dmnr.uk/x", "my shop" → a label and, where
    one was typed, the extension it came with. */
export function parse(raw: string, known: Iterable<string>): Query {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  s = s.replace(/\s+/g, "-").replace(/^\.+|\.+$/g, "");
  if (!s) return { name: "", pinned: null };
  const tlds = new Set(known);
  const parts = s.split(".");
  let name = s;
  let pinned: string | null = null;
  let unknownTld: string | undefined;
  // The longest known suffix wins: "shop.co.uk" is shop + co.uk, not shop.co + uk.
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join(".");
    if (tlds.has(suffix)) {
      name = parts.slice(0, i).join(".");
      pinned = suffix;
      break;
    }
  }
  if (!pinned && parts.length > 1) {
    // "shop.somethingelse": the name is the first label and the rest is an
    // extension the tables do not have, which the page says out loud.
    name = parts[0];
    unknownTld = parts.slice(1).join(".");
  }
  // Dots left inside the name are taken as a slip of the thumb for hyphens.
  name = name.replace(/\./g, "-");
  if (!LABEL.test(name)) {
    const error = /[^a-z0-9-]/.test(name)
      ? "Letters a–z, digits and hyphens only: accented and non-Latin names are not searched here yet."
      : name.length > 63 ? "A domain name is at most 63 characters." : "A name cannot begin or end with a hyphen.";
    return { name, pinned, unknownTld, error };
  }
  return { name, pinned, unknownTld };
}

/** The cheaper of what is offered, and who offers it. */
export function best(ext: Extension, by: "registration" | "renewal" = "registration"): { price: number; who: "pb" | "gd" } | null {
  const i = by === "renewal" ? 1 : 0;
  const offers: { price: number; who: "pb" | "gd" }[] = [];
  if (ext.pb) offers.push({ price: ext.pb[i], who: "pb" });
  if (ext.gd) offers.push({ price: ext.gd[i], who: "gd" });
  if (!offers.length) return null;
  return offers.sort((a, b) => a.price - b.price)[0];
}

export type Sort = "cheapest" | "renewal" | "alpha";

/** Rows in reading order: the typed extension first, then by the chosen
    key, ties alphabetically so the order is stable between runs. */
export function order(rows: Row[], sort: Sort, pinned: string | null): Row[] {
  const key = (r: Row): number => {
    if (sort === "alpha") return 0;
    const b = best(r.ext, sort === "renewal" ? "renewal" : "registration");
    return b ? b.price : Number.POSITIVE_INFINITY;
  };
  return [...rows].sort((a, b) => {
    if (pinned) {
      if (a.ext.tld === pinned) return -1;
      if (b.ext.tld === pinned) return 1;
    }
    return key(a) - key(b) || a.ext.tld.localeCompare(b.ext.tld);
  });
}

/** "$5.66", "$1,234.50", "$0.99". */
export function money(n: number): string {
  return "$" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The RDAP server for an extension: its own, or the registry above it —
    co.uk answers at Nominet's uk server. */
export function rdapFor(tld: string, servers: Record<string, string | null | undefined>): string | null {
  const parts = tld.split(".");
  for (let i = 0; i < parts.length; i++) {
    const s = servers[parts.slice(i).join(".")];
    if (s) return s;
  }
  return null;
}

/** A row's state from the two answers a check can collect. */
export function judge(dns: "has-ns" | "no-ns" | "failed", rdap: "found" | "not-found" | "unavailable" | "none"): { state: Availability; via?: "dns" | "rdap" } {
  if (dns === "has-ns") return { state: "taken", via: "dns" };
  if (rdap === "found") return { state: "taken", via: "rdap" };
  if (rdap === "not-found") return { state: "available", via: "rdap" };
  if (dns === "no-ns" && rdap === "none") return { state: "maybe", via: "dns" };
  return { state: "unknown" };
}
