// An RFC 5545 (iCalendar) writer. Pure: no I/O, no clock unless one is passed.
//
// Small on purpose. A calendar feed needs VCALENDAR, VEVENT and a handful of
// properties, and every part of the format that bites is in here and pinned by
// tests/a-calendar-reads-exactly-what-rfc-5545-says.test.ts:
//
//   * Lines end in CRLF, not LF (§3.1). Google tolerates LF; Outlook and some
//     Apple versions do not, and fail by showing an empty calendar.
//   * A content line is at most 75 OCTETS, not characters (§3.1). A client
//     name with an accent or an emoji is several octets per character, so a
//     fold counted in characters overruns; and a fold that splits a multi-byte
//     character in half produces invalid UTF-8. Continuation lines start with
//     one space, and that space counts toward their 75.
//   * TEXT values escape backslash, semicolon, comma and newline (§3.3.11).
//     An unescaped comma in LOCATION ("12 Oak St, Springfield") is legal
//     but means a LIST, and a semicolon ends the value for strict parsers.
//   * DTSTAMP is required on every VEVENT (§3.6.1).
//   * Times are UTC ("Z") or DATE. No floating times, which each device would
//     read in its own zone, and no TZID, which would oblige a VTIMEZONE block
//     this writer does not need: an instant in UTC is the same instant on
//     every phone, and an all-day DATE is the same day on every phone.

export type IcsDateTime = Date | string;

export type IcsEvent = {
  /** Stable across fetches, or a calendar duplicates the event every poll. */
  uid: string;
  summary: string;
  location?: string | null;
  description?: string | null;
  /** All-day: a calendar DATE (YYYY-MM-DD); `end` defaults to the next day. */
  allDay?: { start: string; end?: string };
  /** Timed: two instants. Emitted in UTC. */
  timed?: { start: IcsDateTime; end: IcsDateTime };
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  lastModified?: IcsDateTime | null;
};

export type IcsCalendar = {
  /** PRODID, e.g. "-//HoundStack//Calendar feed//EN". */
  prodId: string;
  /** X-WR-CALNAME: what Google and Apple title the subscribed calendar. */
  name?: string;
  /** X-WR-TIMEZONE: a hint for how to DISPLAY, not how to read, the times. */
  timezone?: string;
  /** REFRESH-INTERVAL / X-PUBLISHED-TTL, in minutes. */
  refreshMinutes?: number;
  events: IcsEvent[];
};

const CRLF = "\r\n";
const MAX_OCTETS = 75;
const encoder = new TextEncoder();

/** RFC 5545 §3.3.11 TEXT escaping, plus removal of the control characters
 *  TEXT may not contain (everything below 0x20 except TAB, and DEL). CR, LF
 *  and CRLF all become the two characters `\n`. */
export function escapeText(value: string | null | undefined): string {
  if (value == null) return "";
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
  let out = "";
  for (const ch of escaped) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Fold one content line into chunks of at most 75 octets each, CRLF-joined,
 *  never splitting a UTF-8 character. The input must not contain CR or LF. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = "";
  let octets = 0;
  // A continuation line's leading space is one of its 75 octets.
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (octets + n > limit) {
      out.push(current);
      current = "";
      octets = 0;
      limit = MAX_OCTETS - 1;
    }
    current += ch;
    octets += n;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function toDate(v: IcsDateTime): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 2026-10-06T14:05:09.123Z -> 20261006T140509Z. Seconds are kept, millis
 *  dropped: DATE-TIME has no fractional seconds. */
export function formatUtc(v: IcsDateTime): string {
  const d = toDate(v);
  if (!d) throw new Error(`Not a date-time: ${String(v)}`);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** 2026-10-06 -> 20261006. Refuses anything that is not a calendar day. */
export function formatDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Not a calendar day: ${day}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** The calendar day after `day`, in pure date arithmetic (UTC, so no device
 *  zone can move it). DTEND of an all-day event is EXCLUSIVE (§3.6.1). */
export function nextDay(day: string): string {
  formatDate(day);
  const t = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function eventLines(e: IcsEvent, dtstamp: string): string[] {
  const lines = [
    "BEGIN:VEVENT",
    prop("UID", escapeText(e.uid)),
    prop("DTSTAMP", dtstamp),
  ];
  if (e.timed) {
    lines.push(prop("DTSTART", formatUtc(e.timed.start)));
    lines.push(prop("DTEND", formatUtc(e.timed.end)));
  } else if (e.allDay) {
    lines.push(prop("DTSTART;VALUE=DATE", formatDate(e.allDay.start)));
    lines.push(prop("DTEND;VALUE=DATE", formatDate(e.allDay.end ?? nextDay(e.allDay.start))));
  } else {
    throw new Error(`Event ${e.uid} has neither a time nor a day`);
  }
  lines.push(prop("SUMMARY", escapeText(e.summary)));
  if (e.location) lines.push(prop("LOCATION", escapeText(e.location)));
  if (e.description) lines.push(prop("DESCRIPTION", escapeText(e.description)));
  if (e.status) lines.push(prop("STATUS", e.status));
  // Shown as busy unless cancelled, so a skipped visit does not block time.
  lines.push(prop("TRANSP", e.status === "CANCELLED" || e.allDay ? "TRANSPARENT" : "OPAQUE"));
  if (e.lastModified) {
    const lm = toDate(e.lastModified);
    if (lm) lines.push(prop("LAST-MODIFIED", formatUtc(lm)));
  }
  lines.push("END:VEVENT");
  return lines;
}

/** The whole VCALENDAR as a string, CRLF line endings, ending in CRLF. */
export function buildCalendar(cal: IcsCalendar, now: Date = new Date()): string {
  const dtstamp = formatUtc(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    prop("PRODID", cal.prodId),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (cal.name) lines.push(prop("X-WR-CALNAME", escapeText(cal.name)));
  if (cal.timezone) lines.push(prop("X-WR-TIMEZONE", escapeText(cal.timezone)));
  if (cal.refreshMinutes && cal.refreshMinutes > 0) {
    const m = Math.round(cal.refreshMinutes);
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${m}M`);
    lines.push(`X-PUBLISHED-TTL:PT${m}M`);
  }
  for (const e of cal.events) lines.push(...eventLines(e, dtstamp));
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}
