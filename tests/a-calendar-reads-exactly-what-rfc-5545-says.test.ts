// A calendar reads exactly what RFC 5545 says, and nothing kinder.
//
// Google is forgiving about iCalendar. Outlook and some Apple versions are
// not, and the way they fail is the worst one available: they subscribe
// happily and show an empty calendar. So the writer in src/lib/ics.ts is
// pinned here to the letter of the RFC -- CRLF, 75-OCTET folds that never split
// a character, TEXT escaping, DTSTAMP on every event, UTC or DATE and nothing
// floating -- and the visit mapping in src/lib/calendar-feed.ts to the product
// rules: a UID per visit that never changes, timed from the ETA or all-day on
// the org's day, CANCELLED for a skip, and access codes only ever on a
// technician's own feed.

import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  escapeText,
  foldLine,
  formatDate,
  formatUtc,
  nextDay,
} from "@/lib/ics";
import {
  buildFeedCalendar,
  feedPath,
  tokenFromPathSegment,
  visitToEvent,
  visitUid,
  type FeedPayload,
  type FeedVisit,
} from "@/lib/calendar-feed";
import { hashFeedToken, newFeedToken } from "@/lib/calendar-feed.server";

const enc = new TextEncoder();
const octets = (s: string) => enc.encode(s).length;
/** Undo §3.1 folding: a CRLF followed by one space or tab is removed. */
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, "");
const NOW = new Date("2026-09-29T15:04:05.678Z");

const visit = (over: Partial<FeedVisit> = {}): FeedVisit => ({
  id: "3f1c2b8e-1111-4222-8333-444455556666",
  scheduled_on: "2026-10-06",
  status: "scheduled",
  eta_start: null,
  eta_end: null,
  updated_at: "2026-09-28T12:00:00Z",
  client_name: "Anastasia Vandermolen-Whitaker",
  street: "4417 North Ravenswood Avenue",
  city: "Ridgefield Heights",
  region: "IL",
  postal_code: "60614",
  tech_name: "Alejandro Villanueva-Castro",
  gate_code: null,
  lock_box_code: null,
  key_location: null,
  ...over,
});

describe("content lines", () => {
  it("end in CRLF, every one of them, including the last", () => {
    const ics = buildCalendar({ prodId: "-//T//T//EN", events: [] }, NOW);
    expect(ics.endsWith("\r\n")).toBe(true);
    // No bare LF anywhere: every LF is the second half of a CRLF.
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("fold at 75 octets, and a continuation's leading space is one of them", () => {
    const long = `SUMMARY:${"x".repeat(200)}`;
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(2);
    expect(octets(parts[0])).toBe(75);
    for (const p of parts.slice(1)) {
      expect(p.startsWith(" ")).toBe(true);
      expect(octets(p)).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toBe(long);
  });

  it("count octets, not characters, and never split a multi-byte character", () => {
    // "é" is two octets and "🐕" is four; 75 characters of them is 150+
    // octets, which a character-counting fold would emit as one line.
    const long = `SUMMARY:${"é".repeat(40)}🐕${"é".repeat(40)}`;
    const folded = foldLine(long);
    for (const p of folded.split("\r\n")) {
      expect(octets(p)).toBeLessThanOrEqual(75);
      // A split surrogate or byte sequence would not round-trip.
      expect(new TextDecoder("utf-8", { fatal: true }).decode(enc.encode(p))).toBe(p);
    }
    expect(unfold(folded)).toBe(long);
  });

  it("leaves a line of exactly 75 octets alone", () => {
    const line = `X:${"a".repeat(73)}`;
    expect(octets(line)).toBe(75);
    expect(foldLine(line)).toBe(line);
  });
});

describe("TEXT escaping (§3.3.11)", () => {
  it("escapes backslash, semicolon, comma and every newline form", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
  });

  it("escapes the backslash first, so an escape is not escaped twice", () => {
    expect(escapeText(";")).toBe("\\;");
    expect(escapeText("\\;")).toBe("\\\\\\;");
  });

  it("drops control characters TEXT cannot hold, and keeps a tab", () => {
    expect(escapeText("a\u0000b\u0007c\td\u007f")).toBe("abc\td");
  });

  it("writes a LOCATION with commas as one value, not a list", () => {
    const ics = buildFeedCalendar(
      { scope: "mine", org_name: "W&R", timezone: "America/Chicago", holder_name: null, events: [visit()] },
      NOW,
    );
    expect(unfold(ics)).toContain(
      "LOCATION:4417 North Ravenswood Avenue\\, Ridgefield Heights\\, IL 60614\r\n",
    );
  });
});

describe("times", () => {
  it("are UTC with a Z, seconds kept and milliseconds dropped", () => {
    expect(formatUtc("2026-10-06T14:05:09.123Z")).toBe("20261006T140509Z");
    // An offset is converted, not copied.
    expect(formatUtc("2026-10-06T09:05:09-05:00")).toBe("20261006T140509Z");
  });

  it("dates are basic format and the all-day end is the next day (exclusive)", () => {
    expect(formatDate("2026-10-06")).toBe("20261006");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(() => formatDate("10/06/2026")).toThrow();
  });

  it("every VEVENT carries DTSTAMP", () => {
    const ics = buildFeedCalendar(
      {
        scope: "org",
        org_name: "W&R",
        timezone: "America/Chicago",
        holder_name: null,
        events: [visit(), visit({ id: "3f1c2b8e-1111-4222-8333-444455556667" })],
      },
      NOW,
    );
    const events = ics.split("BEGIN:VEVENT").slice(1);
    expect(events).toHaveLength(2);
    for (const e of events) expect(e).toContain("\r\nDTSTAMP:20260929T150405Z\r\n");
  });

  it("never emits a floating time or a TZID the file does not define", () => {
    const ics = buildFeedCalendar(
      {
        scope: "mine",
        org_name: "W&R",
        timezone: "America/Chicago",
        holder_name: null,
        events: [
          visit({ eta_start: "2026-10-06T14:00:00Z", eta_end: "2026-10-06T15:30:00Z" }),
          visit({ id: "3f1c2b8e-1111-4222-8333-444455556667" }),
        ],
      },
      NOW,
    );
    expect(ics).not.toMatch(/TZID=/);
    for (const m of ics.matchAll(/^(DTSTART|DTEND)[^:]*:(.*)$/gm)) {
      const value = m[2].trim();
      expect(value.endsWith("Z") || /^\d{8}$/.test(value), `${m[0]}`).toBe(true);
    }
    // The zone is a display hint only.
    expect(ics).toContain("X-WR-TIMEZONE:America/Chicago\r\n");
  });
});

describe("a visit as an event", () => {
  it("has a UID that is the visit's, so a re-fetch updates rather than duplicates", () => {
    const a = visitToEvent(visit(), "mine");
    const b = visitToEvent(
      visit({ status: "completed", eta_start: "2026-10-06T14:00:00Z", tech_name: "Somebody" }),
      "org",
    );
    expect(a.uid).toBe(visitUid("3f1c2b8e-1111-4222-8333-444455556666"));
    expect(b.uid).toBe(a.uid);
    expect(a.uid).toMatch(/@houndstack\.com$/);
    expect(visitToEvent(visit({ id: "00000000-0000-4000-8000-000000000001" }), "mine").uid).not.toBe(
      a.uid,
    );
  });

  it("is all-day on the scheduled day when there is no ETA", () => {
    const e = visitToEvent(visit(), "mine");
    expect(e.allDay).toEqual({ start: "2026-10-06", end: "2026-10-07" });
    expect(e.timed).toBeUndefined();
    const ics = buildFeedCalendar(
      { scope: "mine", org_name: "W&R", timezone: "America/Chicago", holder_name: null, events: [visit()] },
      NOW,
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261006\r\nDTEND;VALUE=DATE:20261007\r\n");
  });

  it("is timed from the ETA window when there is one", () => {
    const e = visitToEvent(
      visit({ eta_start: "2026-10-06T14:00:00Z", eta_end: "2026-10-06T15:30:00Z" }),
      "mine",
    );
    expect(e.allDay).toBeUndefined();
    const ics = buildCalendar({ prodId: "-//T//T//EN", events: [e] }, NOW);
    expect(ics).toContain("DTSTART:20261006T140000Z\r\nDTEND:20261006T153000Z\r\n");
  });

  it("gives an ETA with no usable end a half-hour slot, not a zero-length or a week-long one", () => {
    const noEnd = visitToEvent(visit({ eta_start: "2026-10-06T14:00:00Z" }), "mine");
    expect(new Date(noEnd.timed!.end).toISOString()).toBe("2026-10-06T14:30:00.000Z");
    const backwards = visitToEvent(
      visit({ eta_start: "2026-10-06T14:00:00Z", eta_end: "2026-10-06T13:00:00Z" }),
      "mine",
    );
    expect(new Date(backwards.timed!.end).toISOString()).toBe("2026-10-06T14:30:00.000Z");
    const garbage = visitToEvent(visit({ eta_start: "not a time" }), "mine");
    expect(garbage.allDay?.start).toBe("2026-10-06");
  });

  it("is CANCELLED when the visit was skipped, and says so in the title", () => {
    const e = visitToEvent(visit({ status: "skipped" }), "mine");
    expect(e.status).toBe("CANCELLED");
    expect(e.summary).toBe("Skipped: Anastasia Vandermolen-Whitaker");
    const ics = buildCalendar({ prodId: "-//T//T//EN", events: [e] }, NOW);
    expect(ics).toContain("STATUS:CANCELLED\r\n");
    expect(ics).toContain("TRANSP:TRANSPARENT\r\n");
    expect(visitToEvent(visit({ status: "canceled" }), "mine").status).toBe("CANCELLED");
    expect(visitToEvent(visit({ status: "completed" }), "mine").status).toBe("CONFIRMED");
  });

  it("prints access codes on a technician's own feed only when the SQL sent them", () => {
    const withCodes = visit({ gate_code: "4471#", lock_box_code: "0915", key_location: "Blue pot" });
    const mine = visitToEvent(withCodes, "mine").description!;
    expect(mine).toContain("Gate code: 4471#");
    expect(mine).toContain("Lock box: 0915");
    expect(mine).toContain("Key: Blue pot");
    expect(visitToEvent(visit(), "mine").description).not.toMatch(/Gate code|Lock box|Key:/);
  });

  it("never prints access codes on the org-wide feed, even if they arrive", () => {
    // The SQL does not select them for scope 'org'. This is the second layer:
    // if that ever regressed, the feed still would not print them.
    const withCodes = visit({ gate_code: "4471#", lock_box_code: "0915", key_location: "Blue pot" });
    const ics = buildFeedCalendar(
      { scope: "org", org_name: "W&R", timezone: "America/Chicago", holder_name: null, events: [withCodes] },
      NOW,
    );
    expect(unfold(ics)).not.toMatch(/4471|0915|Blue pot|Gate code/);
    expect(unfold(ics)).toContain("Technician: Alejandro Villanueva-Castro");
  });
});

describe("the link", () => {
  it("is 43 base64url characters, and only its hash is what the database sees", () => {
    const t = newFeedToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newFeedToken()).not.toBe(t);
    expect(hashFeedToken(t)).toMatch(/^[0-9a-f]{64}$/);
    // The same digest Postgres computes with encode(sha256(...), 'hex').
    expect(hashFeedToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is refused before the database is asked when it cannot be a token", () => {
    const t = newFeedToken();
    expect(tokenFromPathSegment(`${t}.ics`)).toBe(t);
    expect(tokenFromPathSegment(t)).toBe(t);
    expect(tokenFromPathSegment(`${t}x.ics`)).toBeNull();
    expect(tokenFromPathSegment("' or 1=1 --")).toBeNull();
    expect(tokenFromPathSegment("")).toBeNull();
    expect(feedPath(t)).toBe(`/api/public/calendar/${t}.ics`);
  });
});

describe("the whole calendar", () => {
  it("is named for the business and whose visits these are", () => {
    const p: FeedPayload = {
      scope: "mine",
      org_name: "Whitfield & Ramirez Yard and Waste Services",
      timezone: "America/Chicago",
      holder_name: "Alejandro Villanueva-Castro",
      events: [],
    };
    const ics = unfold(buildFeedCalendar(p, NOW));
    expect(ics).toContain(
      "X-WR-CALNAME:Whitfield & Ramirez Yard and Waste Services: Alejandro Villanueva-Castro\r\n",
    );
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:/);
    expect(ics).toContain("METHOD:PUBLISH\r\n");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });
});
