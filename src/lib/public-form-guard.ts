// What keeps a script out of the one public form, with nothing to render.
//
// /signup/{slug} is a stranger's page by design: no session, no account, and
// both of its buttons write a `leads` row the office reads and, since
// 20261009220000, is told about. A form that writes into somebody's pipeline
// and buzzes their phone is a form worth spamming, so three filters stand in
// front of the write, cheapest first:
//
//   1. A honeypot. One input no person can see or reach (visibility: hidden,
//      out of the tab order, hidden from screen readers) and a form-filling
//      script fills anyway, because it fills every input it finds.
//   2. A minimum time to submit. A person needs more than three seconds to
//      type a name and an email; a script posting the moment the page loads
//      does not. Measured in the browser from when the form appeared, so it
//      is a filter for naive scripts and not a lock: a script that knows the
//      field can claim any number. The rate limit is the part that holds.
//   3. A rate limit per address and per business, in the database
//      (take_public_form_turn), so the ceiling holds across server instances.
//
// No CAPTCHA, deliberately: the product has none and says so.
//
// Every refusal says the same calm thing and writes nothing. A person who was
// merely quick reads "try again", tries again, and gets through, because by
// then the clock has run; a script learns nothing about which filter it hit.
//
// Kept pure (no server import) so the form and the tests can both read it.

/** The honeypot's field name, in the form and in both request bodies. Named
 *  like something a script wants to fill and nothing a browser autofills. */
export const HONEYPOT_FIELD = "website_url" as const;

/** The elapsed-time field, in both request bodies. Milliseconds since the
 *  form appeared. */
export const ELAPSED_FIELD = "elapsed_ms" as const;

/** Faster than this is not a person typing a name and an email. */
export const MIN_FILL_MS = 3_000;

/**
 * The rate limit, per hour.
 *
 * Per address: a household pressing "Start service", fixing a typo and
 * pressing it again is two or three attempts; a tech canvassing on one phone
 * all afternoon is a door every few minutes; an office or a phone carrier's
 * shared address can put several people behind one IP. Twenty fits all of
 * them and turns "unbounded" into a number somebody would notice.
 *
 * Per business: a one-or-two-truck business that gets sixty new leads in an
 * hour is being flooded, not marketed to. This is the ceiling on how much of
 * a tenant's pipeline (and how many notifications) a distributed flood can
 * fill, whatever addresses it comes from.
 */
export const RATE_LIMIT = {
  windowSeconds: 3_600,
  perAddress: 20,
  perBusiness: 60,
} as const;

/** What every refused submission is told. Names no filter. */
export const CALM_REFUSAL =
  "Sorry, we couldn't send that just now. Please wait a moment and try again.";

export type BotVerdict =
  | { ok: true }
  | { ok: false; reason: "honeypot" | "too_fast" | "untimed" };

/**
 * The two checks that need nothing but the request body.
 *
 * `elapsedMs` missing is a refusal, not a pass: the form always sends it, so a
 * body without it did not come from the form, and an optional check is one a
 * script opts out of by leaving the field off.
 */
export function screenSubmission(input: {
  honeypot?: unknown;
  elapsedMs?: unknown;
}): BotVerdict {
  const hp = input.honeypot;
  if (hp != null && String(hp).trim() !== "") return { ok: false, reason: "honeypot" };
  const ms = typeof input.elapsedMs === "number" ? input.elapsedMs : Number(input.elapsedMs);
  if (input.elapsedMs == null || input.elapsedMs === "" || !Number.isFinite(ms)) {
    return { ok: false, reason: "untimed" };
  }
  if (ms < MIN_FILL_MS) return { ok: false, reason: "too_fast" };
  return { ok: true };
}

/**
 * The caller's address, from the request headers.
 *
 * Read the way cast_roadmap_vote reads it (20260913100000), for the same
 * reason. Cloudflare sits in front of this app and sets `cf-connecting-ip`
 * from the TCP peer, overwriting whatever the client sent under that name, so
 * it is the trustworthy key. `x-forwarded-for` is the fallback, and its LAST
 * segment, because a client may prepend its own list and the proxy appends the
 * real address to the end: taking the first segment would make the limit
 * opt-out by sending one extra header.
 */
export function callerAddress(header: (name: string) => string | null | undefined): string | null {
  const cf = (header("cf-connecting-ip") ?? "").trim();
  if (cf) return cf;
  const xff = header("x-forwarded-for") ?? "";
  const last = xff.split(",").pop()?.trim() ?? "";
  return last || null;
}
