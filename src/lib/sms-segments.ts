// #988 — how many segments a text is, and what a month of them costs.
//
// A segment is one 160-character GSM-7 text, or 70 characters when any
// character is outside GSM-7 (emoji, curly quotes, most non-Latin text). A
// message too long for one segment is split into pieces that carry a header,
// so the per-segment limit drops to 153 (GSM-7) or 67 (UCS-2). These are the
// carrier rules Twilio bills by; Twilio's own `num_segments` wins when it
// reports one, and this is the local count used before it does and for
// inbound messages that carry no count.

export type SmsEncoding = "GSM-7" | "UCS-2";

// GSM 03.38 basic set. Each is one septet.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// Extension table: each costs two septets (escape + character).
const GSM_EXT = "^{}\\[~]|€\f";

const BASIC = new Set(GSM_BASIC);
const EXT = new Set(GSM_EXT);

export function smsEncoding(body: string): SmsEncoding {
  for (const ch of body) if (!BASIC.has(ch) && !EXT.has(ch)) return "UCS-2";
  return "GSM-7";
}

/** Length in the unit the segment limits are written in: septets for GSM-7,
 *  UTF-16 code units for UCS-2 (so one emoji is 2). */
export function smsLength(body: string, enc: SmsEncoding = smsEncoding(body)): number {
  if (enc === "UCS-2") return body.length;
  let n = 0;
  for (const ch of body) n += EXT.has(ch) ? 2 : 1;
  return n;
}

export function countSegments(body: string): { segments: number; encoding: SmsEncoding } {
  const encoding = smsEncoding(body);
  const len = smsLength(body, encoding);
  if (len === 0) return { segments: 0, encoding };
  const single = encoding === "GSM-7" ? 160 : 70;
  const multi = encoding === "GSM-7" ? 153 : 67;
  if (len <= single) return { segments: 1, encoding };
  // A GSM-7 extension character (escape + character) and a UCS-2 surrogate
  // pair (one emoji) are never split across two segments: when one does not
  // fit in what is left of a segment, the whole of it starts the next one.
  // So this packs character by character rather than dividing the length,
  // which undercounts by one when such a character lands on the boundary.
  let segments = 1;
  let used = 0;
  for (const ch of body) {
    const cost = encoding === "GSM-7" ? (EXT.has(ch) ? 2 : 1) : ch.length;
    if (used + cost > multi) {
      segments++;
      used = 0;
    }
    used += cost;
  }
  return { segments, encoding };
}

export type TextingTerms = {
  included: number;
  blockSize: number;
  blockCents: number;
  /** Overage blocks the org may use in a month before automatic texts stop. */
  ceilingBlocks: number;
};

/** The terms Brendan set on 2026-11-17: 1,000 included, $10 per extra 500. The
 *  database row is the source of truth; this is only the fallback for a
 *  database that has not been migrated. */
export const DEFAULT_TEXTING_TERMS: TextingTerms = {
  included: 1000,
  blockSize: 500,
  blockCents: 1000,
  ceilingBlocks: 5,
};

/** Blocks of overage owed for a month's segments, rounded up. */
export function overageBlocks(segments: number, t: TextingTerms = DEFAULT_TEXTING_TERMS): number {
  if (!(segments > t.included) || t.blockSize <= 0) return 0;
  return Math.ceil((segments - t.included) / t.blockSize);
}

export function overageCents(segments: number, t: TextingTerms = DEFAULT_TEXTING_TERMS): number {
  return overageBlocks(segments, t) * t.blockCents;
}

/** Segments at which automatic texts stop for the month. */
export function ceilingSegments(
  t: TextingTerms = DEFAULT_TEXTING_TERMS,
  ceilingBlocks: number = t.ceilingBlocks,
): number {
  return t.included + ceilingBlocks * t.blockSize;
}

/** Fractions of the included volume at which the owner is warned. */
export const SMS_WARN_AT_FRACTION = 0.8;
