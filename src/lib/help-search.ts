// Help search by words, not by letters.
//
// The Knowledge Center matched the query as one substring, so "get paid"
// found nothing above an article called "Getting paid", and "business hours"
// missed the article about the workday. Found 2026-09-27 by the first-time
// owner persona review. A person types the words they would say; this matches
// each of them, in any order, against the words an article uses, and knows a
// few of the synonyms this trade's owners reach for.

export interface SearchableArticle {
  title: string;
  body: string[];
  steps?: string[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "do",
  "i",
  "my",
  "how",
  "can",
  "is",
  "are",
  "of",
  "for",
  "in",
  "on",
  "and",
  "or",
  "what",
  "where",
  "when",
  "with",
  "me",
  "set",
  "up",
]);

/** Words a person types, mapped to the other words the articles use. */
const SYNONYMS: Record<string, string[]> = {
  pay: ["payment", "invoice", "charge", "collect", "stripe"],
  paid: ["pay", "payment", "invoice", "collect"],
  hour: ["workday", "work", "day"],
  customer: ["client"],
  client: ["customer"],
  job: ["visit"],
  visit: ["job", "stop"],
  stop: ["visit"],
  tech: ["technician", "staff", "crew"],
  technician: ["tech", "staff"],
  employee: ["staff", "team", "tech"],
  price: ["pricing", "rate", "zone"],
  cost: ["price", "pricing", "rate"],
  route: ["schedule", "dispatch"],
  schedule: ["route", "calendar"],
  text: ["sms", "message"],
  sms: ["text", "message"],
  email: ["mail"],
  cancel: ["skip"],
  skip: ["cancel"],
  card: ["payment", "stripe"],
};

/** Lowercase words, with plural and -ing/-ed endings folded, so "getting",
 *  "gets" and "get" are one word. Deliberately crude: it only has to make a
 *  person's phrasing meet an article's, not be linguistics. */
export function helpWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) {
    const base = w.slice(0, -3);
    // "getting" -> "get", "running" -> "run": undo the doubled consonant.
    return /([bdgmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function queryTerms(q: string): string[][] {
  return helpWords(q)
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => [w, ...(SYNONYMS[w] ?? []).map(stem)]);
}

/**
 * 0 = no match. Otherwise a score where a title hit outranks a body hit, so
 * "Getting paid" sorts above an article that merely mentions payment. Every
 * query word (or one of its synonyms) has to appear, as the start of some
 * word, so "invo" finds invoices while a user is still typing.
 */
export function helpMatchScore(article: SearchableArticle, q: string): number {
  const terms = queryTerms(q);
  if (!terms.length) return 1;
  const title = helpWords(article.title);
  const rest = helpWords([...article.body, ...(article.steps ?? [])].join(" "));
  let score = 0;
  for (const alts of terms) {
    const inTitle = alts.some((t) => title.some((w) => w.startsWith(t)));
    const inBody = inTitle || alts.some((t) => rest.some((w) => w.startsWith(t)));
    if (!inBody) return 0;
    score += inTitle ? 3 : 1;
  }
  return score;
}
