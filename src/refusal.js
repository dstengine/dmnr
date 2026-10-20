// A registry's 404 can carry a reason. Most mean "no such domain", but some
// registries use the same status for a name they withhold — reserved by
// ICANN or by the registry, restricted, blocked — and say so in the error's
// title or description. Those words turn a would-be "available" into
// "reserved". Plain JavaScript so api/check.js and the page share it.
//
//   { errorCode: 404, title: "Not Found", description: ["Domain Name: example.bar",
//     "This name is not available for registration:", "IANA Reserved"] }   → "IANA Reserved"
//   { errorCode: 404, title: "Object not found", description: ["Object not found"] } → null
const WITHHELD = /not available for registration|reserved|reservation|restrict|prohibit|blocked|withheld/i;
const PREFACE = /^(?:not found|object not found|error (?:in )?processing request|\d+)$/i;
const MAX = 160;

/** What a 404 means, from its body: no such domain (an RDAP error, a bare
    "404 Not found" as .ws sends, or nothing at all, as Verisign sends), a
    name the registry withholds (an RDAP error with a reason), or no answer
    at all (a web server's HTML page: rdap.nic.ms sends one for every
    name, its own nic.ms included). */
export function answer404(text) {
  const t = String(text ?? "").trim();
  if (/<html|<!doctype/i.test(t)) return { state: "unavailable" };
  let body = null;
  try { body = JSON.parse(t); } catch {}
  const note = refusal(body);
  return note ? { state: "reserved", note } : { state: "not-found" };
}

/** The registry's own words when its 404 says the name is withheld, else null. */
export function refusal(body) {
  if (!body || typeof body !== "object") return null;
  const lines = [body.title, ...(Array.isArray(body.description) ? body.description : [])]
    .filter((s) => typeof s === "string")
    // One registry sends its Chinese text as runs of "?"; an apostrophe comes the same way.
    .map((s) => s.replace(/\?{2,}/g, " ").replace(/(\w)\?s\b/g, "$1’s").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = lines.join(" ");
  if (!WITHHELD.test(text) || /rights reserved/i.test(text)) return null;
  // The reason, not the wrapping: the error's title, the echoed domain name
  // and the generic preface go when a sentence of substance follows them.
  const reason = lines.filter((l) => !PREFACE.test(l) && !/^domain name:/i.test(l));
  let note = (reason.length ? reason : lines).join(" ").replace(/^this name is not available for registration:\s*(?=\S)/i, "");
  if (note.length > MAX) note = note.slice(0, MAX - 1).replace(/\s+\S*$/, "") + "…";
  return note;
}
