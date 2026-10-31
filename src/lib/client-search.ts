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
//   * a phone number by its digits, whatever punctuation either side used.
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
  streets?: readonly (string | null)[] | null;
  tags?: readonly string[] | null;
};

/** The words of a query, folded. Empty when there is nothing to search for. */
export function queryWords(q: string): string[] {
  return fold(q).split(/\s+/).filter(Boolean);
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
  return words.every((w) => {
    if (hay.includes(w)) return true;
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

/** The longest word of a query, the one the database filters on. */
export function searchAnchor(q: string): string {
  return queryWords(q).reduce((a, b) => (b.length > a.length ? b : a), "").slice(0, 16);
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
  return [
    `display_name.imatch.${rx}`,
    `company.imatch.${rx}`,
    `primary_email.ilike.*${like}*`,
    `import_external_id.ilike.*${like}*`,
  ].join(",");
}

/** The `ilike` pattern for a street search, or null when there is no word. */
export function streetSearchPattern(q: string): string | null {
  const anchor = looksLikePhone(q) ? digitsOf(q).slice(0, 10) : searchAnchor(q);
  return anchor ? `%${likeWord(anchor)}%` : null;
}
