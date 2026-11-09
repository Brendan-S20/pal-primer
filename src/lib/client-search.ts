// How a typed search finds a client (#617).
//
// One rule for every place a person looks a client up: the /clients list, the
// New invoice and One-off visit pickers, and Cmd-K. Before this, Cmd-K matched
// the display name only and was accent-sensitive, so "jose" did not find
// "José", a phone number found nobody, and neither did the id a business
// carried over from Jobber. The list matched name, email and phone, but only
// the exact characters, so "555-1234" missed "(555) 123-4567".
//
// What matches, for every word typed (all words have to match somewhere):
//   * the name, company, first and last name, email, tags, street and the
//     external id from an import, ignoring case and accents;
//   * a phone number by its digits, whatever punctuation either side used;
//   * the ZIP or town of any of the client's addresses (R2-27: "80210" found
//     nobody, because only the street was searched);
//   * the external id without its punctuation, so "#5004", "SP004" and
//     "sp-004" all find "SP-004" (R2-27).
//
// Pure, so the browser, the server and a test all run the same function.

/** Lower case, accents removed: "José Núñez" -> "jose nunez". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The digits of a value: "(555) 123-4567" -> "5551234567". */
export function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

export type SearchableClient = {
  display_name?: string | null;
  company?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  primary_email?: string | null;
  primary_phone?: string | null;
  import_external_id?: string | null;
  street?: string | null;
  /** Every live address of the client: streets, and their ZIPs and towns
   *  (placesOf). */
  streets?: readonly (string | null)[] | null;
  tags?: readonly string[] | null;
};

/** Letters and digits only: "SP-004" -> "sp004". */
export function compact(s: string): string {
  return fold(s).replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The words of a query, folded. Empty when there is nothing to search for.
 * Punctuation at either end of a word is not part of it: "#5004" is "5004",
 * "smith," is "smith". Inside a word it stays ("o'brien", "sp-004").
 */
export function queryWords(q: string): string[] {
  return fold(q)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

/** Does this client match every word of the query? An empty query matches. */
export function clientMatchesQuery(c: SearchableClient, q: string): boolean {
  const words = queryWords(q);
  if (!words.length) return true;
  const hay = fold(
    [
      c.display_name,
      c.company,
      c.first_name,
      c.last_name,
      c.primary_email,
      c.primary_phone,
      c.import_external_id,
      c.street,
      ...(c.streets ?? []),
      ...(c.tags ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const phone = digitsOf(c.primary_phone ?? "");
  const externalId = compact(c.import_external_id ?? "");
  return words.every((w) => {
    if (hay.includes(w)) return true;
    // An old system's id typed with other punctuation, or none.
    const cw = compact(w);
    if (cw.length >= 3 && externalId.includes(cw)) return true;
    // A phone typed with different punctuation: three digits or more, so
    // "12" does not match every number on the books.
    const d = digitsOf(w);
    return d.length >= 3 && d.length === w.replace(/[\s().+-]/g, "").length && phone.includes(d);
  });
}

// ── The database half ────────────────────────────────────────────────────
//
// The pickers and Cmd-K cannot load every client to filter them, so the
// server narrows in SQL first and then applies clientMatchesQuery to what
// comes back. The SQL filter only has to be a SUPERSET of the real answer;
// it is built from the longest word typed, because that is the most
// selective one.

const VARIANTS: Record<string, string> = {
  a: "aàáâãäåā",
  c: "cç",
  e: "eèéêëē",
  i: "iìíîïī",
  n: "nñ",
  o: "oòóôõöøō",
  u: "uùúûüū",
  y: "yýÿ",
};

/**
 * The longest word of a query, the one the database filters on. Between two
 * words of the same length, the one with a digit in it: "Name 0999" filters
 * on "0999", which one client has, rather than "name", which a thousand
 * imported clients called "Name 0001"... "Name 0999" all have.
 */
export function searchAnchor(q: string): string {
  const hasDigit = (w: string) => /\p{N}/u.test(w);
  return queryWords(q)
    .reduce(
      (a, b) =>
        b.length > a.length || (b.length === a.length && hasDigit(b) && !hasDigit(a)) ? b : a,
      "",
    )
    .slice(0, 16);
}

/**
 * A case- and accent-insensitive regular expression for one folded word, for
 * PostgREST's `imatch`: "jose" -> "j[oòóôõöøō]s[eèéêëē]". Anything that is not
 * a letter or a digit becomes "." (any one character), which keeps the
 * pattern free of regex syntax and quoting trouble and only widens the match.
 *
 * An accented letter is six characters once it is in a URL, so a vowel class
 * costs about forty. The pattern stops growing at `maxUrlChars`: a leading
 * part of the word still finds everything the whole word would, and
 * clientMatchesQuery then checks the whole word. That is what keeps a long
 * query's request under 2 KB.
 */
export function accentPattern(word: string, maxUrlChars = 320): string {
  let out = "";
  for (const ch of word) {
    let piece: string;
    if (VARIANTS[ch]) piece = `[${VARIANTS[ch]}]`;
    else if (/[\p{L}\p{N}]/u.test(ch)) piece = ch;
    else piece = ".";
    if (out && encodeURIComponent(out + piece).length > maxUrlChars) break;
    out += piece;
  }
  return out;
}

/** A plain substring pattern for `ilike`, with no characters PostgREST's
 *  filter syntax treats specially. */
function likeWord(word: string): string {
  return word.replace(/[^\p{L}\p{N}@._-]/gu, "_");
}

/** True when the query reads as a phone number rather than words. */
export function looksLikePhone(q: string): boolean {
  const t = q.trim();
  return /^[\d\s().+-]+$/.test(t) && digitsOf(t).length >= 3;
}

/**
 * The PostgREST `or=(...)` filter for one query, or null when the query is
 * empty. Short by construction: one anchor word, at most 16 characters, so the
 * request stays well under 2 KB.
 */
export function clientSearchOrFilter(q: string): string | null {
  if (looksLikePhone(q)) {
    const d = digitsOf(q).slice(0, 15);
    // Digits in order with anything between them: "5551234" matches
    // "(555) 123-4". clientMatchesQuery then insists they are consecutive.
    const spread = `*${d.split("").join("*")}*`;
    return [
      `primary_phone.like.${spread}`,
      `import_external_id.ilike.*${d}*`,
      `display_name.ilike.*${d}*`,
    ].join(",");
  }
  const anchor = searchAnchor(q);
  if (!anchor) return null;
  const rx = accentPattern(anchor);
  const like = likeWord(anchor);
  // first_name and last_name are not searched separately: display_name is
  // built from them, and every column here costs the pattern's length again.
  const terms = [
    `display_name.imatch.${rx}`,
    `company.imatch.${rx}`,
    `primary_email.ilike.*${like}*`,
    `import_external_id.ilike.*${like}*`,
  ];
  // The external id with anything (or nothing) between its letters, so
  // "sp004" reaches "SP-004"; clientMatchesQuery then compares them compact.
  const bare = compact(anchor);
  if (bare.length >= 3) terms.push(`import_external_id.imatch.${bare.split("").join(".?")}`);
  return terms.join(",");
}

/** The `ilike` pattern for a street search, or null when there is no word. */
export function streetSearchPattern(q: string): string | null {
  const anchor = looksLikePhone(q) ? digitsOf(q).slice(0, 10) : searchAnchor(q);
  return anchor ? `%${likeWord(anchor)}%` : null;
}

/**
 * The `or=(...)` filter on a client's addresses (the `hit` embed), or null
 * when there is no word: the street, the ZIP and the town, so "80210" and
 * "pearl st" both find somebody (R2-27).
 */
export function placeSearchOrFilter(q: string): string | null {
  const anchor = looksLikePhone(q) ? digitsOf(q).slice(0, 10) : searchAnchor(q);
  if (!anchor) return null;
  const like = likeWord(anchor);
  return [`street.ilike.*${like}*`, `postal_code.ilike.*${like}*`, `city.ilike.*${like}*`].join(
    ",",
  );
}

type Place = {
  street?: string | null;
  postal_code?: string | null;
  city?: string | null;
  archived_at?: string | null;
};

/** What a search can match of a client's live addresses: each street, ZIP
 *  and town. The `streets` that clientMatchesQuery reads. */
export function placesOf(props: readonly Place[] | Place | null | undefined): string[] {
  const list: readonly Place[] = Array.isArray(props) ? props : props ? [props as Place] : [];
  const out: string[] = [];
  for (const p of list) {
    if (p.archived_at) continue;
    for (const v of [p.street, p.postal_code, p.city]) if (v) out.push(v);
  }
  return out;
}
