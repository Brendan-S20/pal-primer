// A walk, a sit, a groom or a lesson is not a pet-waste visit with a
// different label (#560).
//
// The launch polish pass: the words a customer reads (the booking page, the
// portal's skip reasons, the on-my-way text, the welcome email) and the ones
// a tech reads on a stop that is not pet waste. Each case here was a yard,
// a cleanup or a gate handshake shown to a business, or a visit, that has
// none.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bookingLine, bookingPageLines, bookingServicesLine } from "@/lib/booking-copy";
import { customerSkipReason } from "@/lib/skip-rules.functions";
import { onMyWayText } from "@/lib/on-my-way";
import type { PublicService } from "@/lib/public-services";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const svc = (service_line: PublicService["service_line"]) =>
  ({ id: service_line, name: service_line, service_line }) as unknown as PublicService;

describe("the booking page", () => {
  it("speaks for the business's own line when nothing is listed online", () => {
    expect(bookingLine([], null, ["dog_walking"])).toBe("dog_walking");
    expect(bookingLine([], null, ["pet_sitting", "dog_walking"])).toBe("pet_sitting");
    // A pet-waste business, or one whose lines could not be read, is the
    // scooping form it always was.
    expect(bookingLine([], null, ["pet_waste", "dog_walking"])).toBe("pet_waste");
    expect(bookingLine([], null)).toBe("pet_waste");
  });

  it("does not ask about a yard before a walker's visitor has picked", () => {
    expect(bookingLine([svc("dog_walking"), svc("pet_sitting")], null, ["dog_walking"])).toBe(
      "dog_walking",
    );
    expect(bookingLine([svc("pet_waste"), svc("dog_walking")], null)).toBe("pet_waste");
  });

  it("describes a walker with nothing listed as a walker, not a scooping form", () => {
    expect(bookingPageLines([], ["dog_walking"])).toEqual(["dog_walking"]);
    expect(bookingPageLines([], ["pet_waste", "dog_walking"])).toEqual([]);
    expect(bookingPageLines(["pet_sitting"], ["dog_walking"])).toEqual(["pet_sitting"]);
  });

  it("names what the business does on its first screen", () => {
    expect(bookingServicesLine(["dog_walking"])).toBe("Dog walking");
    expect(bookingServicesLine(["dog_walking", "pet_sitting", "dog_walking"])).toBe(
      "Dog walking and pet sitting",
    );
    expect(bookingServicesLine([])).toBeNull();
    expect(read("src/routes/signup.$slug.tsx")).toMatch(/data-booking-services/);
  });
});

describe("the portal's skip reasons", () => {
  it("say the access reasons without a yard for a visit that is not to one", () => {
    for (const code of ["gate_locked", "dog_outside", "access_blocked"]) {
      expect(customerSkipReason(code, false), code).not.toMatch(/yard/i);
    }
    // A yard visit reads exactly as before.
    expect(customerSkipReason("access_blocked")).toBe("We could not get to the yard");
  });
});

describe("on my way", () => {
  const base = { customerName: "Jane", orgName: "Acme", techName: "Sam", eta: null };

  it("asks a sit, a groom or a lesson for a reply, not ENT or DNE", () => {
    const text = onMyWayText({ ...base, yard: false });
    expect(text).not.toMatch(/Reply ENT|Reply DNE|Dogs inside/);
    expect(text).toMatch(/Reply STOP to opt out\.$/);
    // Word for word: Product checks this against the carrier registration's
    // sample messages, so a change here is a change there too.
    expect(text).toBe(
      "Hi Jane, Sam from Acme is on the way for today's visit. Anything we should know? Reply here. Reply STOP to opt out.",
    );
  });

  it("leaves the yard's text word for word", () => {
    expect(onMyWayText(base)).toBe(
      "Hi Jane, Sam from Acme is on the way for today's visit. Dogs inside? Reply ENT. Rather we didn't come in? Reply DNE. Reply STOP to opt out.",
    );
  });
});

describe("customer email", () => {
  it("welcomes every client without promising a clean yard", () => {
    expect(read("src/lib/email-templates/welcome.tsx")).not.toMatch(/yard/i);
  });
});

describe("a tech's stop", () => {
  const myDay = read("src/routes/_authenticated/my-day.tsx");

  it("decides pet waste by the visit's own line, not the business's", () => {
    expect(myDay).toMatch(
      /const petWaste = isYardVisit\(visit\.services\?\.service_line, businessRunsPetWaste\)/,
    );
  });

  it("shows waste stations and DNA only on a pet-waste stop", () => {
    expect(myDay).toMatch(/const hasStations = petWaste && \(/);
    expect(myDay).toMatch(/const dnaEnrolled = petWaste && /);
  });
});

describe("the examples read as English", () => {
  it("picks a or an for the services empty state and the quote hint", async () => {
    const { withArticle } = await import("@/lib/services");
    expect(withArticle("Overnight stay")).toBe("an overnight stay");
    expect(withArticle("30-minute walk")).toBe("a 30-minute walk");
    expect(withArticle("One-hour training session")).toBe("a one-hour training session");
    expect(withArticle("Extra pet")).toBe("an extra pet");
    expect(withArticle("Full groom")).toBe("a full groom");
    // The quote hint's grooming add-on is an activity, so it takes no article.
    const editor = read("src/components/quotes/QuoteEditor.tsx");
    expect(editor).toMatch(/\/ing\$\/i\.test\(addOnExampleFor\(orgLines\)\.name\)/);
  });
});

describe("the client page a tech opens", () => {
  it("reads as yard work only when one of the tech's own visits there is", async () => {
    const { fieldClientIsYardWork } = await import("@/lib/walk-concerns");
    // A walker in a business that also scoops: their visits are walks.
    expect(fieldClientIsYardWork(["dog_walking"], true)).toBe(false);
    expect(fieldClientIsYardWork(["dog_walking", "pet_waste"], true)).toBe(true);
    // A visit with no service is what the business runs.
    expect(fieldClientIsYardWork([null], true)).toBe(true);
    expect(fieldClientIsYardWork([null], false)).toBe(false);
    // The office goes by the business.
    expect(fieldClientIsYardWork(null, true)).toBe(true);
  });
});

describe("the office visit drawer", () => {
  it("decides yard words the way My Day does", () => {
    const drawer = read("src/components/VisitDetailDrawer.tsx");
    expect(drawer).toMatch(
      /const yardVisit = isYardVisit\(v\?\.services\?\.service_line, businessRunsPetWaste\)/,
    );
  });
});
