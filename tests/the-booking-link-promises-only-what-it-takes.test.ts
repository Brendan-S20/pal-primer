// R2-24 (round-2 audit: train-r2-02, walk-r2-09, sit-r2-05, groom-r2-06).
// With no Stripe account the link takes quote requests only, and it said:
//
//   "One visit. You pay once for this session." on a $0 consult and on a
//     walker's drop-in, above a Request a quote button;
//   "A package of 6 sessions. You pay once..." with no package name or price;
//   a Frequency select on a request-only service (Weekly for an evaluation,
//     blank for a groom), whose value the lead never sent;
//   a groom's day and start time "(to book)", disabled for good;
//   and the lead lost the package asked about and a stay's last night.
//
// Not done here: grooming's 6- and 8-week cadences on the link. The link's
// frequencies are the subscription enum (weekly, every 2 weeks, monthly),
// priced and charged through public_quote and the Stripe webhook; a new
// cadence is a schema change, not copy.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ONE_TIME_COPY,
  PACKAGE_COPY,
  QUOTE_MESSAGE_MAX,
  quoteRequestMessage,
} from "@/lib/public-booking-mode";
import { BOOKING_COPY, STAY_COPY } from "@/lib/booking-copy";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const flow = read("src/components/signup/SignupFlow.tsx");

describe("one visit, in the line's words, and payment only when it can be taken", () => {
  it("a walker's drop-in is a walk, not a session", () => {
    expect(ONE_TIME_COPY.howItWorks(BOOKING_COPY.dog_walking.visit, true)).toBe(
      "One walk. You pay once for this walk.",
    );
  });

  it("with no card to take, it promises a confirmation, not a payment", () => {
    const quoteOnly = ONE_TIME_COPY.howItWorks(BOOKING_COPY.training.visit, false);
    expect(quoteOnly).not.toMatch(/You pay/);
    expect(quoteOnly).toMatch(/confirm the price and payment/);
  });

  it("the form passes the line's word and the link's state", () => {
    expect(flow).toMatch(/ONE_TIME_COPY\.howItWorks\(lineCopy\.visit, instantStart\)/);
  });
});

describe("a package says what it is", () => {
  it("names the package and its price", () => {
    const s = PACKAGE_COPY.howItWorks(6, { name: "Puppy basics", price: "$780.00" }, true);
    expect(s).toMatch(/^Puppy basics: 6 sessions for \$780\.00\./);
    expect(s).toMatch(/You pay once/);
  });

  it("with no card to take, does not say you pay", () => {
    const s = PACKAGE_COPY.howItWorks(6, { name: "Puppy basics", price: "$780.00" }, false);
    expect(s).not.toMatch(/You pay/);
    expect(s).toMatch(/confirm payment/);
  });

  it("the form hands it the package and the link's state", () => {
    expect(flow).toMatch(
      /PACKAGE_COPY\.howItWorks\(pack\.sessions_count, packDetail, instantStart\)/,
    );
  });
});

describe("no select that is never sent", () => {
  it("a request-only service shows no Frequency", () => {
    expect(flow).toMatch(/\) : mode === "request_only" \? null : \(/);
    // ...because a request-only service sends no cadence on its lead.
    expect(flow).toMatch(/frequency: stay \|\| !repeats \? "" : frequency/);
  });

  it("a groom's day and time are booked only when the link can take a card", () => {
    expect(flow).toMatch(/const groomBooks = groom && instantStart;/);
    expect(flow).toMatch(
      /\{groomBooks && \(\s*<div className="min-w-0 space-y-1\.5">\s*<Label htmlFor="groom_start_time">/,
    );
    expect(flow).toMatch(/enabled: groomBooks && !!quote/);
  });
});

describe("the lead keeps what the visitor asked about", () => {
  it("the package and a stay's last night go in the message", () => {
    const m = quoteRequestMessage("Mornings are best.", {
      pack: { name: "Puppy basics", sessions_count: 6, price: "$780.00" },
      lastNight: "2026-11-20",
    });
    expect(m).toBe(
      "Mornings are best.\n\nAsked about the package Puppy basics (6 sessions, $780.00).\n\nLast night of the stay: 2026-11-20.",
    );
    expect(quoteRequestMessage("", { pack: null, lastNight: null })).toBe("");
    expect(quoteRequestMessage("", { lastNight: "2026-11-20" })).toBe(
      "Last night of the stay: 2026-11-20.",
    );
  });

  it("stays inside the endpoint's limit, shortening the visitor's note rather than failing", () => {
    const m = quoteRequestMessage("x".repeat(QUOTE_MESSAGE_MAX), { lastNight: "2026-11-20" });
    expect(m.length).toBeLessThanOrEqual(QUOTE_MESSAGE_MAX);
    expect(m.endsWith("Last night of the stay: 2026-11-20.")).toBe(true);
    expect(read("src/routes/api/public/leads.ts")).toMatch(
      new RegExp(`message: z\\.string\\(\\)\\.trim\\(\\)\\.max\\(${QUOTE_MESSAGE_MAX}\\)`),
    );
  });

  it("a stay asks for its last night, and the form sends both", () => {
    expect(STAY_COPY.endDateLabel).toBe("Last night");
    expect(STAY_COPY.notePlaceholder).not.toMatch(/last night/i);
    expect(flow).toMatch(/<Label htmlFor="last_night">/);
    expect(flow).toMatch(/message: quoteRequestMessage\(lead\.message, \{/);
    expect(flow).toMatch(/lastNight: stay && form\.last_night \? form\.last_night : null/);
  });
});
