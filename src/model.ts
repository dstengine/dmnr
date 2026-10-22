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
  /** Dynadot's prices, or null. */
  dd: Price | null;
  /** The RDAP server that answers for this extension, or null. */
  rdap: string | null;
}

export interface Tables {
  asOf: { porkbun: string; godaddy: string; dynadot: string; rdap: string };
  tlds: Record<string, Extension>;
}

export type Availability = "idle" | "checking" | "available" | "taken" | "reserved" | "maybe" | "unknown";

/** What the registry's RDAP server said: a record, no record, a name it withholds, or no usable answer. */
export type RdapAnswer = "found" | "not-found" | "reserved" | "unavailable";

/** One source's word on a name. "premium" is free at a price the tables do
    not show; "silent" is a source that was asked and did not answer in
    time, or refused; "na" is a source that does not deal in the extension
    and so was never really asked. */
export type Vote = "free" | "taken" | "reserved" | "premium" | "silent" | "na";

/** Every source that can be asked about a name, browser side and server
    side. The server names which of its sources are configured. */
export type Source = "dns" | "dns2" | "rdap" | string;

export interface Row {
  domain: string;
  ext: Extension;
  state: Availability;
  /** What each source said, once it has. */
  votes: Partial<Record<Source, Vote>>;
  /** How sure the verdict is, 0–100: the sources that said free, out of
      those that could have answered. Set with the state. */
  sure?: number;
  /** Why the name is withheld, as the row shows it: the registry's own words, or the rule. */
  note?: string;
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
/** The registrars with a column, by the key their prices sit under. */
export type Registrar = "pb" | "gd" | "dd";

export function best(ext: Extension, by: "registration" | "renewal" = "registration"): { price: number; who: Registrar } | null {
  const i = by === "renewal" ? 1 : 0;
  const offers: { price: number; who: Registrar }[] = [];
  for (const who of ["pb", "gd", "dd"] as const) {
    const p = ext[who];
    if (p) offers.push({ price: p[i], who });
  }
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

/** Labels every gTLD must withhold under its ICANN registry agreement
    (Specification 5: registry operations and RFC 2606), which the
    registries' RDAP servers mostly answer with a plain "not found". A
    two-letter top label is a country code with rules of its own. */
const ICANN_RESERVED = new Set(["example", "nic", "www", "whois", "rdds"]);
export function icannReserved(label: string, tld: string): string | null {
  const top = tld.split(".").pop()!;
  if (top.length <= 2 || !ICANN_RESERVED.has(label)) return null;
  return "Reserved in every generic extension by ICANN's registry agreement (Specification 5), not by this registry alone.";
}

/** Two-character names: ICANN reserved every one, most registries have
    since had them released and sell them as premium names. Either way the
    standard price is not the price, which the row should say. */
export function shortLabelHint(label: string, tld: string): string | null {
  const top = tld.split(".").pop()!;
  if (top.length <= 2 || label.length > 2) return null;
  return "Two-character names are withheld or sold as premium names in most generic extensions, so the standard price shown is unlikely to apply.";
}

/** The names of the sources as the row shows them. */
export const SOURCE_NAMES: Record<string, string> = {
  dns: "Cloudflare DNS", dns2: "Google DNS", rdap: "the registry",
  godaddy: "GoDaddy", porkbun: "Porkbun", dynadot: "Dynadot", namesilo: "NameSilo", namecom: "Name.com", spaceship: "Spaceship", gandi: "Gandi",
};

/** A row's state from what the sources said. One "taken" settles it: a
    name with nameservers, a registry record or a registrar's "no" is not
    free whatever the others say. "reserved" is the registry's word, or
    ICANN's rule. Otherwise the verdict is a share: the sources that said
    free (a premium price is free, at a price), out of the sources that
    deal in the extension. All of them is "available"; some of them is
    "likely free" with the share beside it; none of them is "ask the
    registrar". Sources that were never asked ("na") do not count. */
export function verdict(votes: Partial<Record<Source, Vote>>): { state: Availability; sure: number } {
  const said = Object.values(votes).filter((v): v is Vote => v !== undefined && v !== "na");
  if (said.includes("taken")) return { state: "taken", sure: 100 };
  if (said.includes("reserved")) return { state: "reserved", sure: 100 };
  if (!said.length) return { state: "unknown", sure: 0 };
  const free = said.filter((v) => v === "free" || v === "premium").length;
  const sure = Math.round((100 * free) / said.length);
  if (!free) return { state: "unknown", sure: 0 };
  return { state: sure === 100 ? "available" : "maybe", sure };
}

/** The sources' answers in words, for the row's tooltip: who said free,
    who said nothing, who was never asked. */
export function explain(votes: Partial<Record<Source, Vote>>): string {
  const name = (s: string) => SOURCE_NAMES[s] ?? s;
  const by = (want: Vote[]) => Object.entries(votes).filter(([, v]) => v && want.includes(v)).map(([s]) => name(s));
  const parts: string[] = [];
  const taken = by(["taken"]), reserved = by(["reserved"]), free = by(["free"]), premium = by(["premium"]), silent = by(["silent"]);
  if (taken.length) parts.push(`${taken.join(", ")}: taken`);
  if (reserved.length) parts.push(`${reserved.join(", ")}: reserved`);
  if (free.length) parts.push(`${free.join(", ")}: free`);
  if (premium.length) parts.push(`${premium.join(", ")}: free at a premium price`);
  if (silent.length) parts.push(`${silent.join(", ")}: no answer`);
  return parts.join(" · ");
}

/** The RDAP answer as a vote. */
export function rdapVote(a: RdapAnswer | "none"): Vote {
  return a === "found" ? "taken" : a === "not-found" ? "free" : a === "reserved" ? "reserved" : a === "none" ? "na" : "silent";
}

/** The length bucket of an extension, for the filter: the letters in it,
    dots aside, so co.uk is 4 and com is 3. */
export function lengthBucket(tld: string): "2" | "3" | "4" {
  const n = tld.replace(/\./g, "").length;
  return n <= 2 ? "2" : n === 3 ? "3" : "4";
}
