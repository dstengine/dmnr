// The search in the browser: the typed name becomes one row per extension,
// the rows are ordered cheapest first and every one is checked — at two
// DNS resolvers and the registry's RDAP server from here (through
// api/check where a registry refuses browsers), then, in batches, at the
// registrars' own APIs through api/avail. Each source casts a vote; the
// verdict and how sure it is come from model.ts, which holds the parts
// with no DOM in them.
import { best, explain, icannReserved, lengthBucket, money, order, parse, rdapVote, shortLabelHint, verdict, type Availability, type RdapAnswer, type Row, type Sort, type Tables, type Vote } from "./model";
import { answer404 } from "./refusal.js";

declare const __VERSION__: string;
/** Rows in the document at a time; every row is checked whether shown or not. */
const PAGE = 60;
/** Rows checked at once from the browser. */
const WORKERS = 8;
/** Names per api/avail call, and calls in flight. */
const BATCH = 20;
const INFLIGHT = 3;
const FLUSH = 250;
const TIMEOUT = 8000;
const RESOLVERS: [key: "dns" | "dns2", url: string][] = [
  ["dns", "https://cloudflare-dns.com/dns-query"],
  ["dns2", "https://dns.google/resolve"],
];

const $ = <T extends Element>(sel: string): T => document.querySelector(sel) as T;
const form = $<HTMLFormElement>("[data-form]");
const input = $<HTMLInputElement>("[data-q]");
const hint = $<HTMLElement>("[data-hint]");
const tools = $<HTMLElement>("[data-tools]");
const status = $<HTMLElement>("[data-status]");
const list = $<HTMLOListElement>("[data-rows]");
const more = $<HTMLButtonElement>("[data-more]");
const moreLabel = more.querySelector("span")!;
const onlyFree = $<HTMLButtonElement>("[data-only-free]");
const unverified = $<HTMLButtonElement>("[data-unverified]");

let tables: Tables | null = null;
let known: string[] = [];
let rows: Row[] = [];
let ordered: Row[] = [];
const els = new WeakMap<Row, HTMLLIElement>();
let sort: Sort = "cheapest";
let pinned: string | null = null;
let name = "";
let shown = 0;
let controller: AbortController | null = null;
/** One search: its abort signal, the browser workers busy, and the rows
    waiting for the registrars with the batch timer and the calls in flight. */
interface Run { signal: AbortSignal; active: number; queue: Row[]; timer: number; inflight: number }
let run: Run | null = null;
/** RDAP servers that refused the browser once: the rest go through api/check. */
const noCors = new Set<string>();
/** The registrars api/avail has keys for, as its last answer named them. */
let serverSources: string[] = [];

const LABELS: Record<Availability, [icon: string, text: string]> = {
  idle: ["", "queued"],
  checking: ["", "checking…"],
  available: ["i-check", "available"],
  taken: ["i-x", "taken"],
  reserved: ["i-x", "reserved"],
  maybe: ["i-check", "likely free"],
  unknown: ["i-help", "ask the registrar"],
};
const REGISTRARS = [["pb", "Porkbun", "porkbun"], ["gd", "GoDaddy", "godaddy"], ["dd", "Dynadot", "dynadot"]] as const;

async function load() {
  try {
    const r = await fetch(`data.json?v=${__VERSION__}`);
    if (!r.ok) throw new Error(String(r.status));
    tables = (await r.json()) as Tables;
  } catch {
    hint.textContent = "The price table did not load. Reload the page to try again.";
    hint.hidden = false;
    return;
  }
  for (const [tld, ext] of Object.entries(tables.tlds)) ext.tld = tld;
  known = Object.keys(tables.tlds);
  $("[data-tld-count]").textContent = String(known.length);
  const q = new URLSearchParams(location.search).get("q");
  if (q) {
    input.value = q;
    search();
  }
}

function search() {
  if (!tables) return;
  const raw = input.value;
  const q = parse(raw, known);
  hint.hidden = true;
  if (q.error) {
    hint.textContent = q.error;
    hint.hidden = false;
  } else if (q.unknownTld) {
    hint.textContent = `.${q.unknownTld} is not an extension in the tables, so ${q.name} is searched across the ones that are.`;
    hint.hidden = false;
  }
  if (q.error || !q.name) {
    clear();
    return;
  }
  if (q.name === name && q.pinned === pinned) return;
  name = q.name;
  pinned = q.pinned;
  history.replaceState(null, "", `?q=${encodeURIComponent(raw.trim())}`);
  controller?.abort();
  if (run) clearTimeout(run.timer);
  controller = new AbortController();
  run = { signal: controller.signal, active: 0, queue: [], timer: 0, inflight: 0 };
  rows = known.map((tld) => ({ domain: `${name}.${tld}`, ext: tables!.tlds[tld], state: "idle" as Availability, votes: {} }));
  ordered = order(rows, sort, pinned);
  shown = Math.min(PAGE, ordered.length);
  tools.hidden = false;
  status.hidden = false;
  render();
  pump();
  updateStatus();
}

function clear() {
  controller?.abort();
  if (run) clearTimeout(run.timer);
  controller = null;
  run = null;
  name = "";
  pinned = null;
  rows = [];
  ordered = [];
  shown = 0;
  list.replaceChildren();
  more.hidden = true;
  tools.hidden = true;
  status.hidden = true;
  history.replaceState(null, "", location.pathname);
}

function render() {
  list.replaceChildren(...ordered.slice(0, shown).map(rowEl));
  const left = ordered.length - shown;
  more.hidden = left <= 0;
  moreLabel.textContent = `Show ${Math.min(PAGE, left)} more`;
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function rowEl(row: Row): HTMLLIElement {
  let li = els.get(row);
  if (li) return li;
  li = document.createElement("li");
  li.className = "row";
  li.dataset.len = lengthBucket(row.ext.tld);
  const head = el("div", "row-head");
  const dom = el("span", "dom");
  const tld = document.createElement("b");
  tld.textContent = `.${row.ext.tld}`;
  dom.append(name, tld);
  head.append(dom, el("span", "state"));
  const offers = el("div", "offers");
  const cheapest = best(row.ext);
  const from: string[] = [];
  for (const [who, label, slug] of REGISTRARS) {
    const p = row.ext[who];
    if (!p) continue;
    const a = document.createElement("a");
    a.className = "offer" + (cheapest?.who === who ? " best" : "");
    a.href = `go/${slug}/${row.domain}`;
    a.rel = "nofollow noopener";
    a.target = "_blank";
    a.title = `Open ${row.domain} at ${label}`;
    a.innerHTML = `<span class="who">${label}</span><span class="cost"><span class="price">${money(p[0])}</span><span class="renew">then ${money(p[1])}/yr</span></span><svg class="ico" aria-hidden="true"><use href="#i-out"/></svg>`;
    offers.append(a);
    from.push(`<span class="nowrap">${label} ${money(p[0])}</span>`);
  }
  const was = el("p", "from");
  was.innerHTML = from.join(" · ");
  li.append(head, offers, was, el("p", "note"));
  els.set(row, li);
  updateRow(row);
  return li;
}

function updateRow(row: Row) {
  const li = els.get(row);
  if (!li) return;
  li.dataset.state = row.state;
  const [icon, text] = LABELS[row.state];
  const st = li.querySelector(".state")!;
  const share = row.state === "maybe" && row.sure ? `<span class="sure">${row.sure}%</span>` : "";
  st.innerHTML = (icon ? `<svg class="ico" aria-hidden="true"><use href="#${icon}"/></svg>` : "") + text + share;
  const why = explain(row.votes);
  if (why) st.setAttribute("title", why);
  else st.removeAttribute("title");
  li.querySelector(".note")!.textContent = row.note ?? "";
}

/** Rows idle in reading order, shown ones first, a few at a time; each
    one's browser checks run here, and the registrars' turn is queued. */
function pump() {
  const r = run;
  if (!r) return;
  while (r.active < WORKERS) {
    const next = ordered.find((x) => x.state === "idle");
    if (!next) break;
    next.state = "checking";
    updateRow(next);
    r.active++;
    check(next, r)
      .catch(() => {
        settle(next);
      })
      .finally(() => {
        if (r.signal.aborted) return;
        r.active--;
        updateRow(next);
        updateStatus();
        pump();
      });
  }
}

/** The parent signal plus a timeout, so one slow server holds one worker. */
function timed(parent: AbortSignal): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any.call(AbortSignal, [parent, AbortSignal.timeout(TIMEOUT)]);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  parent.addEventListener("abort", () => { clearTimeout(t); c.abort(); }, { once: true });
  return c.signal;
}

/** The verdict from the votes in hand. */
function settle(row: Row) {
  const v = verdict(row.votes);
  row.state = v.state;
  row.sure = v.sure;
  if ((v.state === "available" || v.state === "maybe") && !row.note) {
    const label = row.domain.slice(0, -(row.ext.tld.length + 1));
    row.note = shortLabelHint(label, row.ext.tld) ?? undefined;
  }
}

async function check(row: Row, r: Run) {
  const { signal } = r;
  const dns = await Promise.all(RESOLVERS.map(([, url]) => askDns(url, row.domain, signal)));
  RESOLVERS.forEach(([key], i) => { row.votes[key] = dns[i]; });
  const label = row.domain.slice(0, -(row.ext.tld.length + 1));
  if (!dns.includes("taken")) {
    // Withheld under every gTLD's registry agreement: the rule answers, not a server.
    const icann = icannReserved(label, row.ext.tld);
    if (icann) {
      row.votes.rdap = "reserved";
      row.note = icann;
      settle(row);
      return;
    }
    row.votes.rdap = row.ext.rdap ? rdapVote(await askRdap(row, signal)) : "na";
  } else {
    row.votes.rdap = "na";
  }
  if (row.votes.rdap === "taken" || row.votes.rdap === "reserved" || dns.includes("taken") || navigator.onLine === false) {
    settle(row);
    return;
  }
  // Not settled by DNS or the registry: the registrars get a say, in a batch.
  enqueue(row, r);
}

async function askDns(url: string, domain: string, signal: AbortSignal): Promise<Vote> {
  try {
    const r = await fetch(`${url}?name=${domain}&type=NS`, { headers: { accept: "application/dns-json" }, signal: timed(signal) });
    const j = (await r.json()) as { Status: number; Answer?: { type: number }[] };
    if (j.Status === 0 && (j.Answer ?? []).some((a) => a.type === 2)) return "taken";
    if (j.Status === 3 || j.Status === 0) return "free";
    return "silent";
  } catch (e) {
    if (signal.aborted) throw e;
    return "silent";
  }
}

async function askRdap(row: Row, signal: AbortSignal): Promise<RdapAnswer> {
  const server = row.ext.rdap!;
  if (server.startsWith("https://") && !noCors.has(server)) {
    try {
      const r = await fetch(`${server}domain/${row.domain}`, { headers: { accept: "application/rdap+json" }, signal: timed(signal) });
      if (r.status === 200) return "found";
      // A 404 is "no such domain" unless the registry's words say the name
      // is withheld, or the body is a web server's page and not an answer.
      if (r.status === 404) return withheld(row, await r.text());
      return "unavailable";
    } catch (e) {
      if (signal.aborted) throw e;
      noCors.add(server);
    }
  }
  try {
    const r = await fetch(`api/check?domain=${row.domain}`, { signal: timed(signal) });
    const j = (await r.json()) as { registered: boolean | null; reserved?: string };
    if (j.reserved) {
      row.note = said(j.reserved);
      return "reserved";
    }
    return j.registered === true ? "found" : j.registered === false ? "not-found" : "unavailable";
  } catch (e) {
    if (signal.aborted) throw e;
    return "unavailable";
  }
}

function withheld(row: Row, text: string): RdapAnswer {
  const a = answer404(text);
  if (a.note) row.note = said(a.note);
  return a.state as RdapAnswer;
}

const said = (words: string) => `The registry says: “${words}”`;

/** Rows for the registrars wait for a batch: twenty names, or a quarter
    of a second, whichever comes first, three batches in flight. */
function enqueue(row: Row, r: Run) {
  r.queue.push(row);
  clearTimeout(r.timer);
  if (r.queue.length >= BATCH) flush(r);
  else r.timer = window.setTimeout(() => flush(r), FLUSH);
}

function flush(r: Run) {
  clearTimeout(r.timer);
  while (r.queue.length && r.inflight < INFLIGHT) {
    const batch = r.queue.splice(0, BATCH);
    r.inflight++;
    askRegistrars(batch, r.signal)
      // A new search aborts the batch; the rows are gone with it.
      .catch(() => {})
      .finally(() => {
        if (r.signal.aborted) return;
        r.inflight--;
        for (const row of batch) updateRow(row);
        updateStatus();
        if (r.queue.length) flush(r);
      });
  }
  if (r.queue.length) r.timer = window.setTimeout(() => flush(r), FLUSH);
}

async function askRegistrars(batch: Row[], signal: AbortSignal) {
  let sources = serverSources;
  let votes: Record<string, Record<string, Vote>> = {};
  try {
    const r = await fetch(`api/avail?domains=${batch.map((x) => x.domain).sort().join(",")}`, { signal: timed(signal) });
    const j = (await r.json()) as { sources?: string[]; votes?: typeof votes };
    if (j.sources) serverSources = sources = j.sources;
    votes = j.votes ?? {};
  } catch (e) {
    if (signal.aborted) throw e;
  }
  for (const row of batch) {
    for (const s of sources) row.votes[s] = votes[row.domain]?.[s] ?? "silent";
    settle(row);
  }
}

function updateStatus() {
  const done = ordered.filter((r) => r.state !== "idle" && r.state !== "checking").length;
  const free = ordered.filter((r) => r.state === "available" || r.state === "maybe").length;
  const nw = (s: string) => `<span class="nowrap">${s}</span>`;
  // Without a connection the prices still show; the checks cannot run, so
  // the line must not say they did.
  if (navigator.onLine === false) {
    status.innerHTML = `Offline: prices only, the checks need a connection · ${nw(`${Math.min(shown, ordered.length)} of ${ordered.length}`)} extensions shown`;
    return;
  }
  status.innerHTML = done < ordered.length
    ? `Checking ${nw(`${done} of ${ordered.length}`)} · ${nw(`${free} available`)} so far`
    : `${nw(`${ordered.length} extensions checked`)} · ${nw(`${free} available`)}`;
}
addEventListener("online", () => rows.length && updateStatus());
addEventListener("offline", () => rows.length && updateStatus());

form.addEventListener("submit", (e) => {
  e.preventDefault();
  search();
});
let typing = 0;
input.addEventListener("input", () => {
  clearTimeout(typing);
  typing = window.setTimeout(search, 450);
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-sort]")) {
  b.addEventListener("click", () => {
    sort = b.dataset.sort as Sort;
    for (const x of document.querySelectorAll("[data-sort]")) x.setAttribute("aria-pressed", String(x === b));
    if (!rows.length) return;
    ordered = order(rows, sort, pinned);
    render();
    pump();
    updateStatus();
  });
}
const toggle = (b: HTMLButtonElement, attr: string) => {
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    list.toggleAttribute(attr, on);
  });
};
toggle(onlyFree, "data-only-free");
toggle(unverified, "data-unverified");
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-len]")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll("[data-len]")) x.setAttribute("aria-pressed", String(x === b));
    const len = b.dataset.len!;
    if (len === "any") delete list.dataset.len;
    else list.dataset.len = len;
  });
}
more.addEventListener("click", () => {
  shown = Math.min(shown + PAGE, ordered.length);
  render();
  updateStatus();
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-example]")) {
  b.addEventListener("click", () => {
    input.value = b.dataset.example!;
    search();
    input.focus();
  });
}
load();

// The service worker keeps the page openable offline (see src/sw.js). It is
// registered after load so it never competes with the page's own requests.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
