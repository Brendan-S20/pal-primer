import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bookVisit, getOpenSlots } from "../src/lib/receptionist-booking";
import { twoBusinesses } from "./support/fake-receptionist-store";

// The receptionist books the visit (owner decision, 2026-10-09). These drive
// its two tools' rules -- get_open_slots and book_visit, in
// src/lib/receptionist-booking.ts -- against an in-memory store that answers
// each question the way the real query or RPC does. The model is not here:
// what is pinned is what the tools let through whatever the model asks.
// tests/the-receptionist-books-through-its-tools.test.ts drives the same
// tools through the real tool loop with a scripted model.
//
// The calendar: Monday 12 Oct 2026, 10am in Chicago; Monday to Friday.

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

/** Every key, at any depth, that would carry a price. */
function priceKeys(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => priceKeys(x, `${path}[${i}]`));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => [
      ...(/usd|cents|price|cost|amount|\$/i.test(k) ? [`${path}.${k}`] : []),
      ...priceKeys(x, `${path}.${k}`),
    ]);
  return typeof v === "string" && /\$\s?\d/.test(v) ? [path] : [];
}

describe("the days come only from the real schedule", () => {
  it("offers working days less closures, booked days and days nobody can work", async () => {
    const { db, store, clientA } = twoBusinesses();
    db.blackoutRows.push({ orgId: "org-a", day: "2026-10-14" }); // Wed: closed
    db.visits.push({
      id: "v1",
      orgId: "org-a",
      clientId: "client-a",
      propertyId: "prop-a",
      day: "2026-10-15",
      status: "scheduled",
      priceCents: 3000,
      bookedVia: null,
    }); // Thu: already coming
    db.timeOff.push({ staffId: "tech-a", starts: "2026-10-16", ends: "2026-10-16" }); // Fri: the only tech is off
    db.visits.push({
      id: "v2",
      orgId: "org-a",
      clientId: "client-a",
      propertyId: "prop-a",
      day: "2026-10-19",
      status: "skipped",
      priceCents: 3000,
      bookedVia: null,
    }); // Mon: skipped, so open again

    const r: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r.available).toBe(true);
    expect(r.slots.map((s: any) => s.date)).toEqual([
      "2026-10-13",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
    ]);
    expect(r.slots[0].label).toBe("Tue, Oct 13");
    expect(r.address).toBe("1 Ada St");
    expect(r.on_booking).toBe("books_into_calendar");
    // Only what was shown can be booked: exactly those five offers exist.
    expect(db.offers.map((o) => o.day).sort()).toEqual(r.slots.map((s: any) => s.date));
  });

  it("never offers today, a weekend, or past thirty days", async () => {
    const { db, store, clientA } = twoBusinesses();
    const r: any = await getOpenSlots(store, clientA, { now: db.now, days: 30 });
    const days: string[] = r.slots.map((s: any) => s.date);
    expect(days).not.toContain("2026-10-12");
    for (const d of days) expect([1, 2, 3, 4, 5]).toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
  });

  it("offers nothing on a day with no technician at all", async () => {
    const { db, store, clientA } = twoBusinesses();
    db.staff[0].is_field_tech = false;
    const r: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r).toMatchObject({ available: false, handoff: true, reason: "no_open_days" });
    expect(db.offers).toHaveLength(0);
  });

  it("offers nothing outside the service area, and hands it to a person", async () => {
    const { db, store, clientA } = twoBusinesses();
    db.props[0].postal_code = "99999";
    const r: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r).toMatchObject({ available: false, handoff: true, reason: "outside_service_area" });
    expect(db.offers).toHaveLength(0);
  });

  it("gives the client's arrival window where the business uses them, and not where it set them aside", async () => {
    const { db, store, clientA } = twoBusinesses();
    db.windows.set("client-a:prop-a", { earliest: "08:00:00", latest: "10:00:00" });
    const r: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r.slots[0].arrival_window).toBe("8:00 AM to 10:00 AM");
    db.orgs.get("org-a")!.route_windows = "ignore";
    const r2: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r2.slots[0].arrival_window).toBeNull();
  });
});

describe("only an offered day is booked", () => {
  it("books a day it offered, into the calendar, once", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    const r: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: true, status: "booked", date: "2026-10-13" });
    expect(db.visits).toHaveLength(1);
    expect(db.visits[0]).toMatchObject({
      clientId: "client-a",
      propertyId: "prop-a",
      day: "2026-10-13",
    });
    // Through the request the portal makes, marked as made by text.
    expect(db.tickets).toHaveLength(1);
    expect(db.tickets[0]).toMatchObject({
      requestedVia: "ai_receptionist",
      bookedVisitId: db.visits[0].id,
    });
    // Written down, and the office told.
    expect(db.activity.some((a) => a.kind === "visit.created")).toBe(true);
    expect(db.notices).toHaveLength(1);
    expect(db.notices[0].title).toMatch(/Booked by text: Ada Client/);
  });

  it("refuses a day it did not offer", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    // The 23rd is a perfectly good Friday. It was not one of the five.
    const r: any = await bookVisit(store, clientA, { date: "2026-10-23", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "not_offered" });
    expect(db.visits).toHaveLength(0);
    expect(db.tickets).toHaveLength(0);
  });

  it("refuses any day when nothing was offered at all", async () => {
    const { db, store, clientA } = twoBusinesses();
    const r: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "not_offered" });
    expect(db.visits).toHaveLength(0);
  });

  it("refuses an offer that has gone stale", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    expect(db.offers.map((o) => o.day)).toContain("2026-10-16");
    const later = new Date(db.now.getTime() + 49 * 3_600_000);
    const r: any = await bookVisit(store, clientA, { date: "2026-10-16", now: later });
    expect(r).toMatchObject({ booked: false, reason: "not_offered" });
    expect(db.visits).toHaveLength(0);
  });
});

describe("a day taken in the meantime is refused", () => {
  it("when the office booked a visit there since it was offered", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    db.visits.push({
      id: "office",
      orgId: "org-a",
      clientId: "client-a",
      propertyId: "prop-a",
      day: "2026-10-13",
      status: "scheduled",
      priceCents: 3000,
      bookedVia: null,
    });
    const r: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "no_longer_available" });
    expect(db.visits).toHaveLength(1);
    expect(db.tickets).toHaveLength(0);
  });

  it("when the technician took the day off since", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    db.timeOff.push({ staffId: "tech-a", starts: "2026-10-13", ends: "2026-10-13" });
    const r: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "no_longer_available" });
    expect(db.visits).toHaveLength(0);
  });

  it("when the business closed that day since", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    db.blackoutRows.push({ orgId: "org-a", day: "2026-10-13" });
    const r: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "no_longer_available" });
  });

  it("and the request the database refuses releases the offer rather than holding it", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    const real = store.requestOneOff;
    store.requestOneOff = async () => {
      throw new Error("already_scheduled");
    };
    const r: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "no_longer_available" });
    expect(db.offers.find((o) => o.day === "2026-10-13")).toMatchObject({
      claimed_at: null,
      outcome: null,
    });
    store.requestOneOff = real;
  });
});

describe("an unknown number becomes a lead and is never booked", () => {
  it("gets days for a ZIP in the area, and a 'yes' makes a lead, not a client or a visit", async () => {
    const { db, store, stranger } = twoBusinesses();
    const none: any = await getOpenSlots(store, stranger, { now: db.now });
    expect(none).toMatchObject({ available: false, needs_postal_code: true });

    const r: any = await getOpenSlots(store, stranger, { now: db.now, postal_code: "60601" });
    expect(r.available).toBe(true);
    expect(r.on_booking).toBe("office_confirms");

    const b: any = await bookVisit(store, stranger, {
      date: r.slots[0].date,
      postal_code: "60601",
      name: "Sam Stranger",
      now: db.now,
    });
    expect(b).toMatchObject({ booked: false, status: "office_will_confirm" });
    expect(db.visits).toHaveLength(0);
    expect(db.tickets).toHaveLength(0);
    expect(db.clients).toHaveLength(2);
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0]).toMatchObject({
      orgId: "org-a",
      name: "Sam Stranger",
      source: "sms_receptionist",
    });
    expect(db.leads[0].note).toMatch(/Not booked: the office confirms/);
    expect(db.notices).toHaveLength(1);

    // Asking again is the same lead, not a second one.
    const again: any = await bookVisit(store, stranger, {
      date: r.slots[0].date,
      postal_code: "60601",
      now: db.now,
    });
    expect(again).toMatchObject({ booked: false, already: true });
    expect(db.leads).toHaveLength(1);
  });

  it("outside the area, a stranger gets no days", async () => {
    const { db, store, stranger } = twoBusinesses();
    const r: any = await getOpenSlots(store, stranger, { now: db.now, postal_code: "10001" });
    expect(r).toMatchObject({ available: false, handoff: true, reason: "outside_service_area" });
  });

  it("a phone on two of the business's clients is a person's job", async () => {
    const { db, store, clientA } = twoBusinesses();
    db.clients.push({ ...db.clients[0], id: "client-a2", portal_token: "token-a2" });
    const r: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r).toMatchObject({ available: false, handoff: true });
    expect(db.offers).toHaveLength(0);
  });
});

describe("a repeated booking message books once", () => {
  it("one after the other", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    const first: any = await bookVisit(store, clientA, { date: "2026-10-16", now: db.now });
    const second: any = await bookVisit(store, clientA, { date: "2026-10-16", now: db.now });
    expect(first.booked).toBe(true);
    expect(second).toMatchObject({ booked: true, already: true, date: "2026-10-16" });
    expect(db.visits).toHaveLength(1);
    expect(db.tickets).toHaveLength(1);
    expect(db.notices).toHaveLength(1);
  });

  it("at the same moment", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    const results: any[] = await Promise.all([
      bookVisit(store, clientA, { date: "2026-10-16", now: db.now }),
      bookVisit(store, clientA, { date: "2026-10-16", now: db.now }),
      bookVisit(store, clientA, { date: "2026-10-16", now: db.now }),
    ]);
    expect(results.filter((r) => r.booked === true && !r.already)).toHaveLength(1);
    expect(db.visits).toHaveLength(1);
    expect(db.tickets).toHaveLength(1);
  });

  it("offering the same days again does not open a second booking", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    await bookVisit(store, clientA, { date: "2026-10-16", now: db.now });
    const again: any = await getOpenSlots(store, clientA, { now: db.now });
    // The 20th now has a visit, so it is not offered, and the booking stands.
    expect(again.slots.map((s: any) => s.date)).not.toContain("2026-10-16");
    await bookVisit(store, clientA, { date: "2026-10-16", now: db.now });
    expect(db.visits).toHaveLength(1);
  });
});

describe("the price comes only from get_pricing_quote", () => {
  it("neither tool answers with a price, booked or not", async () => {
    const { db, store, clientA, stranger } = twoBusinesses();
    db.windows.set("client-a:prop-a", { earliest: "08:00:00", latest: "10:00:00" });
    const outputs: unknown[] = [];
    outputs.push(await getOpenSlots(store, clientA, { now: db.now }));
    outputs.push(await bookVisit(store, clientA, { date: "2026-10-13", now: db.now }));
    outputs.push(await bookVisit(store, clientA, { date: "2026-10-13", now: db.now }));
    outputs.push(await bookVisit(store, clientA, { date: "2026-10-30", now: db.now }));
    outputs.push(await getOpenSlots(store, stranger, { now: db.now, postal_code: "60601" }));
    outputs.push(
      await bookVisit(store, stranger, { date: "2026-10-13", postal_code: "60601", now: db.now }),
    );
    expect(outputs.flatMap((o) => priceKeys(o))).toEqual([]);
  });

  it("books at the price get_pricing_quote quotes for an extra cleanup", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(db.visits[0].priceCents).toBe(4500);
    // ...which is organizations.one_off_price_cents, and that is what the
    // pricing tool hands the model as extra_cleanup_for_existing_clients_usd.
    const src = read("src/lib/ai-receptionist.server.ts");
    expect(src).toMatch(/\.select\("one_off_price_cents"\)/);
    expect(src).toMatch(/extra_cleanup_for_existing_clients_usd: cents \/ 100/);
    expect(read("src/lib/receptionist-booking.ts")).toMatch(
      /priceCents: Number\(org\.one_off_price_cents\)/,
    );
  });

  it("without a price, or with booking requests switched off, the office books it", async () => {
    const { db, store, clientA } = twoBusinesses();
    db.orgs.get("org-a")!.portal_auto_accept_bookings = false;
    const r: any = await getOpenSlots(store, clientA, { now: db.now });
    expect(r.on_booking).toBe("office_confirms");
    const b: any = await bookVisit(store, clientA, { date: "2026-10-13", now: db.now });
    expect(b).toMatchObject({ booked: false, status: "office_will_confirm" });
    expect(db.visits).toHaveLength(0);
    expect(db.tickets).toHaveLength(1);
    expect(db.tickets[0].requestedVia).toBe("ai_receptionist");
    expect(db.activity.some((a) => a.kind === "receptionist.visit_requested")).toBe(true);
  });
});

describe("a client of business A cannot book into business B", () => {
  it("texting B's number, A's client is a stranger to B", async () => {
    const { db, store, clientA } = twoBusinesses();
    // The webhook matched nobody in B; even if a caller claimed A's client id,
    // B looks the phone up in B.
    const intoB = { orgId: "org-b", fromNumber: clientA.fromNumber, clientId: "client-a" };
    const r: any = await getOpenSlots(store, intoB, { now: db.now });
    expect(r).toMatchObject({ available: false, needs_postal_code: true });
    const r2: any = await getOpenSlots(store, intoB, { now: db.now, postal_code: "60602" });
    expect(r2.on_booking).toBe("office_confirms");
    const b: any = await bookVisit(store, intoB, {
      date: r2.slots[0].date,
      postal_code: "60602",
      now: db.now,
    });
    expect(b.booked).toBe(false);
    expect(db.visits).toHaveLength(0);
    expect(db.tickets).toHaveLength(0);
    expect(db.leads.every((l) => l.orgId === "org-b")).toBe(true);
  });

  it("an offer made in A cannot be booked through B", async () => {
    const { db, store, clientA } = twoBusinesses();
    await getOpenSlots(store, clientA, { now: db.now });
    const viaB = { ...clientA, orgId: "org-b" };
    const r: any = await bookVisit(store, viaB, { date: "2026-10-13", now: db.now });
    expect(r).toMatchObject({ booked: false, reason: "not_offered" });
    expect(db.visits).toHaveLength(0);
  });

  it("B's own client books into B, at B's price", async () => {
    const { db, store, clientB } = twoBusinesses();
    await getOpenSlots(store, clientB, { now: db.now });
    const r: any = await bookVisit(store, clientB, { date: "2026-10-13", now: db.now });
    expect(r.booked).toBe(true);
    expect(db.visits[0]).toMatchObject({ orgId: "org-b", clientId: "client-b", priceCents: 9900 });
  });
});

describe("nothing here uses the platform's toll-free number", () => {
  it("sends no text at all: the reply is the webhook's answer from the business's own number", () => {
    for (const f of [
      "src/lib/receptionist-booking.ts",
      "src/lib/receptionist-booking-store.server.ts",
      "src/lib/ai-receptionist.server.ts",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(
        /platformAccountHolderFrom|twilio-credentials|twilio\.server|sendSms|endCustomerSmsSender|messages\.create/,
      );
      expect(src, f).not.toMatch(/mode:\s*"gateway"/);
    }
  });
});
