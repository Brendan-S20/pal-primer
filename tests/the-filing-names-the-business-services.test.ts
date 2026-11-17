// #971: every business's toll-free verification said it was "a local service
// business", filed one visit-reminder sample, and named the booking link as
// the only opt-in. Carriers check that the summary, the samples and the
// opt-in match the business and that every opt-in method is described.
//
// This pins the words, for each line a business can run and for a business
// that runs all of them, and checks that the filing sends exactly the words
// Settings shows the owner before Submit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filingCopy, filingLines, listOf, STOP_LINE } from "@/lib/texting-filing-copy";
import { tollFreeVerificationForm } from "@/lib/twilio-provisioning.server";
import { registrationDetailsSchema } from "@/lib/texting-registration";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const BASE = {
  businessName: "QA Test 971",
  portalUrl: "https://app.houndstack.com/portal/qa-test-971",
  bookingUrl: "https://app.houndstack.com/signup/qa-test-971",
  supportEmail: "devin@example.com",
  websiteUrl: "https://example.com",
};
const copyFor = (lines: string[]) => filingCopy({ ...BASE, lines });

const ALL = ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"];

describe("each line's filing, word for word", () => {
  it("a scooping business", () => {
    const c = copyFor(["pet_waste"]);
    expect(c.useCaseSummary).toBe(
      "QA Test 971 is a local pet care business that provides yard cleanups. It texts its own clients, who have opted in, about their yard cleanups: reminders, on-the-way notices, visit updates and reports, their invoices and payments with a link to the business's client portal, sign-in codes for that portal, and replies to their questions. No marketing.",
    );
    expect(c.samples).toEqual([
      "QA Test 971: Reminder, your yard cleanup is scheduled for [day, date] at [time]. Reply STOP to opt out.",
      "QA Test 971: [Tech name] is on the way for your yard cleanup, arriving about [time]. Reply STOP to opt out.",
      "QA Test 971: Your invoice for [amount] is ready. View and pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
    ]);
  });

  it("a walking business", () => {
    const c = copyFor(["dog_walking"]);
    expect(c.useCaseSummary).toMatch(
      /^QA Test 971 is a local pet care business that provides walks\./,
    );
    expect(c.samples).toEqual([
      "QA Test 971: Reminder, your walk is scheduled for [day, date] at [time]. Reply STOP to opt out.",
      "QA Test 971: [Walker name] finished [pet name]'s walk at [time]. See the walk report: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
      "QA Test 971: Your invoice for [amount] is ready. View and pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
    ]);
  });

  it("a sitting business", () => {
    const c = copyFor(["pet_sitting"]);
    expect(c.useCaseSummary).toMatch(/provides pet sits\. .* about their pet sits:/);
    expect(c.samples).toEqual([
      "QA Test 971: Reminder, your pet sit is scheduled for [day, date] at [time]. Reply STOP to opt out.",
      "QA Test 971: [Sitter name] checked in on [pet name] at [time]. See the visit report: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
      "QA Test 971: Your invoice for [amount] is ready. View and pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
    ]);
  });

  it("a grooming business", () => {
    const c = copyFor(["mobile_grooming"]);
    expect(c.useCaseSummary).toMatch(/provides grooming appointments\./);
    expect(c.samples).toEqual([
      "QA Test 971: Reminder, your grooming appointment is scheduled for [day, date] at [time]. Reply STOP to opt out.",
      "QA Test 971: [Groomer name] is on the way for [pet name]'s grooming appointment, arriving about [time]. Reply STOP to opt out.",
      "QA Test 971: Your invoice for [amount] is ready. View and pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
    ]);
  });

  it("a training business", () => {
    const c = copyFor(["training"]);
    expect(c.useCaseSummary).toMatch(/provides training sessions\./);
    expect(c.samples).toEqual([
      "QA Test 971: Reminder, your training session is scheduled for [day, date] at [time]. Reply STOP to opt out.",
      "QA Test 971: [Trainer name] finished [pet name]'s training session. See the session notes: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
      "QA Test 971: Your invoice for [amount] is ready. View and pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
    ]);
  });

  it("a business that runs all five", () => {
    const c = copyFor(ALL);
    expect(c.useCaseSummary).toBe(
      "QA Test 971 is a local pet care business that provides yard cleanups, walks, pet sits, grooming appointments and training sessions. It texts its own clients, who have opted in, about their yard cleanups, walks, pet sits, grooming appointments and training sessions: reminders, on-the-way notices, visit updates and reports, their invoices and payments with a link to the business's client portal, sign-in codes for that portal, and replies to their questions. No marketing.",
    );
    expect(c.samples).toEqual([
      "QA Test 971: Reminder, your [yard cleanup / walk / pet sit / grooming appointment / training session] is scheduled for [day, date] at [time]. Reply STOP to opt out.",
      "QA Test 971: [Staff name] is on the way for your [service], arriving about [time]. Reply STOP to opt out.",
      "QA Test 971: Your invoice for [amount] is ready. View and pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.",
    ]);
  });

  it("a walker who also sits is named for both, in a fixed order", () => {
    const c = copyFor(["pet_sitting", "dog_walking"]);
    expect(c.useCaseSummary).toMatch(/provides walks and pet sits\./);
    expect(c.samples[0]).toMatch(/your \[walk \/ pet sit\] is scheduled/);
  });
});

describe("rules every filing keeps", () => {
  const cases = [
    ["pet_waste"],
    ["dog_walking"],
    ["pet_sitting"],
    ["mobile_grooming"],
    ["training"],
    ALL,
  ];

  it.each(cases.map((l) => [l.join("+"), l] as const))(
    "%s: two or three samples, each named and ending STOP",
    (_k, lines) => {
      const c = copyFor([...lines]);
      expect(c.samples.length).toBeGreaterThanOrEqual(2);
      expect(c.samples.length).toBeLessThanOrEqual(3);
      for (const s of c.samples) {
        expect(s.startsWith("QA Test 971: ")).toBe(true);
        expect(s.endsWith(STOP_LINE)).toBe(true);
        // Variables in [brackets]; no made-up client name standing in for one.
        expect(s).toMatch(/\[[a-z ,/]+\]/i);
        expect(s).not.toMatch(/\bSam\b|\bWed\b|\bAug\b/);
      }
      // The portal link real texts carry (invoices, reports) is in a sample.
      expect(c.samples.some((s) => s.includes(BASE.portalUrl))).toBe(true);
      expect(c.productionMessageSample).toBe(c.samples.join("\n"));
      expect(c.useCaseSummary).not.toMatch(/local service business/);
    },
  );

  it("the opt-in covers the portal, the booking link and a verbal yes, and imported clients", () => {
    const d = copyFor(["pet_waste"]).optInDescription;
    expect(d).toContain("client portal (sign-in at https://app.houndstack.com/portal/qa-test-971)");
    expect(d).toContain("public booking page (https://app.houndstack.com/signup/qa-test-971)");
    expect(d).toMatch(
      /telling the business's staff yes in person or on the phone, which staff record/,
    );
    expect(d).toContain(
      "Clients imported from a spreadsheet or another system are not texted until they agree in one of these ways.",
    );
    expect(d).toMatch(/Msg & data rates may apply/);
  });

  it("with no booking link the booking page is still described, and the website is the opt-in page", () => {
    const c = filingCopy({ ...BASE, bookingUrl: null, lines: ["dog_walking"] });
    expect(c.optInDescription).toContain("(2) on the business's public booking page, by ticking");
    expect(c.optInImageUrls).toEqual([BASE.websiteUrl]);
    expect(copyFor(["dog_walking"]).optInImageUrls).toEqual([BASE.bookingUrl]);
  });

  it("an unknown or empty line list reads as pet waste, like every other screen", () => {
    expect(filingLines([])).toEqual(["pet_waste"]);
    expect(filingLines(["other", "nonsense"])).toEqual(["pet_waste"]);
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b", "c"])).toBe("a, b and c");
  });

  it("fits Twilio's field even for a long name and all five lines", () => {
    const c = filingCopy({ ...BASE, businessName: "D".repeat(64), lines: ALL });
    expect(c.productionMessageSample.length).toBeLessThanOrEqual(1000);
    expect(c.useCaseSummary.length).toBeLessThanOrEqual(1000);
  });
});

describe("the filing sends the words the owner reviewed", () => {
  const details = registrationDetailsSchema.parse({
    legal_name: "QA Test 971 LLC",
    business_type: "llc",
    dba: "QA Test 971",
    street: "100 Main St",
    street2: "",
    city: "Ann Arbor",
    region: "MI",
    postal_code: "48104",
    website_url: "https://example.com",
    privacy_url: "https://example.com/privacy",
    terms_url: "https://example.com/terms",
    business_email: "devin@example.com",
    business_phone: "(313) 555-0100",
    contacts: [
      {
        first_name: "Devin",
        last_name: "Doe",
        title: "Owner",
        email: "devin@example.com",
        phone: "313-555-0101",
      },
      {
        first_name: "Sam",
        last_name: "Roe",
        title: "Manager",
        email: "sam@example.com",
        phone: "313-555-0102",
      },
    ],
  });

  it.each([["pet_waste"], ["dog_walking"], ALL])("%s", (...lines) => {
    const flat = lines.flat();
    const form = tollFreeVerificationForm({
      details,
      ein: "12-3456789",
      phoneNumberSid: "PN1",
      customerProfileSid: "BU1",
      orgId: "org-1",
      businessName: BASE.businessName,
      bookingUrl: BASE.bookingUrl,
      notificationEmail: "devin@example.com",
      lines: flat,
      portalUrl: BASE.portalUrl,
    });
    const c = copyFor(flat);
    expect(form.UseCaseSummary).toBe(c.useCaseSummary);
    expect(form.ProductionMessageSample).toBe(c.productionMessageSample);
    expect(form.AdditionalInformation).toBe(c.optInDescription);
    expect(form.OptInType).toBe("WEB_FORM");
    expect(form.OptInImageUrls).toEqual([BASE.bookingUrl]);
    expect(form.OptInConfirmationMessage).toBe(c.optInConfirmationMessage);
    expect(form.HelpMessageSample).toBe(c.helpMessageSample);
  });

  it("Settings builds its review with the same builder and the same facts", () => {
    const review = read("src/components/settings/TextingFilingReview.tsx");
    expect(review).toMatch(/import \{ filingCopy \} from "@\/lib\/texting-filing-copy"/);
    expect(review).toMatch(/getTextingFilingContext/);
    const fns = read("src/lib/texting-filing.functions.ts");
    expect(fns).toMatch(/filingContextFor\(orgId\)/);
    const prov = read("src/lib/twilio-provisioning.server.ts");
    expect(prov).toMatch(/await filingContextFor\(orgId\)/);
    const page = read("src/routes/_authenticated/settings.sms.tsx");
    // Above the Submit button.
    expect(page.indexOf("<TextingFilingReview")).toBeGreaterThan(0);
    expect(page.indexOf("<TextingFilingReview")).toBeLessThan(
      page.indexOf('<Button type="submit"'),
    );
  });
});
