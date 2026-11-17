// #971: every business's toll-free verification said it was "a local service
// business", filed one visit-reminder sample, and named the booking link as
// the only opt-in. Carriers check that the summary, the samples and the
// opt-in match the business and that every opt-in method is described.
//
// This pins the words, for each line a business can run and for a business
// that runs all of them, and checks that the filing sends exactly the words
// Settings shows the owner before Submit.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative } from "./support/repo-paths";
import { filingCopy, filingLines, listOf, STOP_LINE } from "@/lib/texting-filing-copy";
import { tollFreeVerificationForm } from "@/lib/twilio-provisioning.server";
import { registrationDetailsSchema } from "@/lib/texting-registration";
import {
  cardDeclinedText,
  pastDueInvoiceText,
  reviewAskText,
  visitCompleteText,
  visitReminderText,
} from "@/lib/client-sms-templates";
import { onMyWayText } from "@/lib/on-my-way";
import { brandedBody } from "@/lib/sms-brand";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const BASE = {
  businessName: "QA Test 971",
  portalUrl: "https://app.houndstack.com/portal/qa-test-971",
  bookingUrl: "https://app.houndstack.com/signup/qa-test-971",
  supportEmail: "devin@example.com",
  websiteUrl: "https://example.com",
  googleReviewUrl: "https://g.page/r/qa-test-971/review",
};
const copyFor = (lines: string[]) => filingCopy({ ...BASE, lines });

const ALL = ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"];

const SUMMARY_TAIL =
  "It texts its own clients, who have opted in: visit reminders; on-the-way notices, with a live map link when live tracking is on; visit-complete confirmations; a request for a review after a completed visit, with a link to the business's Google review page; past-due invoice reminders and declined-card notices, with a link to the business's client portal; sign-in codes for that portal; and replies to their questions. No marketing.";
const YARD_TAIL =
  "It texts its own clients, who have opted in: visit reminders; on-the-way notices, with a live map link when live tracking is on and, for yard visits, a reply to say whether dogs are inside; visit-complete confirmations; a request for a review after a completed visit, with a link to the business's Google review page; past-due invoice reminders and declined-card notices, with a link to the business's client portal; sign-in codes for that portal; and replies to their questions. No marketing.";
const PAST_DUE =
  "QA Test 971: Hi [client name], this is a friendly reminder that invoice for $[amount] is past due. Pay: https://app.houndstack.com/portal/qa-test-971/[link] Reply STOP to opt out.";
const REVIEW =
  "QA Test 971: Hi [first name], thanks for choosing QA Test 971! If we did a great job, a quick review would mean the world: https://g.page/r/qa-test-971/review Reply STOP to opt out.";
const YARD_ON_MY_WAY =
  "QA Test 971: Hi [client name], [staff name] from QA Test 971 is on the way for today's visit, arriving between [time] and [time]. Live map: https://app.houndstack.com/track/[link] Dogs inside? Reply ENT. Rather we didn't come in? Reply DNE. Reply STOP to opt out.";
const VISIT_ON_MY_WAY =
  "QA Test 971: Hi [client name], [staff name] from QA Test 971 is on the way for today's visit, arriving between [time] and [time]. Live map: https://app.houndstack.com/track/[link] Anything we should know? Reply here. Reply STOP to opt out.";

describe("each line's filing, word for word (#971 review: only texts that are sent)", () => {
  it("a scooping business: the yard's on-my-way, with ENT / DNE and the live map", () => {
    const c = copyFor(["pet_waste"]);
    expect(c.useCaseSummary).toBe(
      `QA Test 971 is a local pet care business that provides yard cleanups. ${YARD_TAIL}`,
    );
    expect(c.samples).toEqual([YARD_ON_MY_WAY, PAST_DUE, REVIEW]);
  });

  it("a walking business: the walk's on-my-way, which names the dogs", () => {
    const c = copyFor(["dog_walking"]);
    expect(c.useCaseSummary).toBe(
      `QA Test 971 is a local pet care business that provides walks. ${SUMMARY_TAIL}`,
    );
    expect(c.samples).toEqual([
      "QA Test 971: Hi [client name], [staff name] from QA Test 971 is on the way to pick up [dog names] for today's walk, arriving between [time] and [time]. Live map: https://app.houndstack.com/track/[link] Reply STOP to opt out.",
      PAST_DUE,
      REVIEW,
    ]);
  });

  it.each([
    ["pet_sitting", "pet sits"],
    ["mobile_grooming", "grooming appointments"],
    ["training", "training sessions"],
  ])("a %s business: the visit's on-my-way, which asks for a reply", (line, words) => {
    const c = copyFor([line]);
    expect(c.useCaseSummary).toBe(
      `QA Test 971 is a local pet care business that provides ${words}. ${SUMMARY_TAIL}`,
    );
    expect(c.samples).toEqual([VISIT_ON_MY_WAY, PAST_DUE, REVIEW]);
  });

  it("a business that runs all five: every line named, and the yard's two-way text", () => {
    const c = copyFor(ALL);
    expect(c.useCaseSummary).toBe(
      `QA Test 971 is a local pet care business that provides yard cleanups, walks, pet sits, grooming appointments and training sessions. ${YARD_TAIL}`,
    );
    expect(c.samples).toEqual([YARD_ON_MY_WAY, PAST_DUE, REVIEW]);
  });

  it("a walker who also sits is named for both, in a fixed order", () => {
    const c = copyFor(["pet_sitting", "dog_walking"]);
    expect(c.useCaseSummary).toMatch(/provides walks and pet sits\./);
    expect(c.samples[0]).toBe(VISIT_ON_MY_WAY);
  });

  it("claims no text the product does not send", () => {
    for (const lines of [["pet_waste"], ["dog_walking"], ["pet_sitting"], ["training"], ALL]) {
      const c = copyFor(lines);
      const all = `${c.useCaseSummary}\n${c.productionMessageSample}`;
      // Walk, sit and lesson reports go by email and push; no "invoice
      // ready" text exists.
      expect(all).not.toMatch(
        /walk report|visit report|session notes|invoice for \[amount\] is ready/i,
      );
      expect(all).not.toMatch(/visit updates and reports/);
    }
  });

  it("a business with no Google review link files the review request with a placeholder", () => {
    const c = filingCopy({ ...BASE, googleReviewUrl: null, lines: ["pet_waste"] });
    expect(c.samples[2]).toContain("mean the world: [Google review link] Reply STOP");
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
    "%s: three samples, each named, bracketed, ending STOP, with every link real texts carry",
    (_k, lines) => {
      const c = copyFor([...lines]);
      expect(c.samples).toHaveLength(3);
      for (const s of c.samples) {
        expect(s.startsWith("QA Test 971: ")).toBe(true);
        expect(s.endsWith(STOP_LINE)).toBe(true);
        // Variables in [brackets]; no made-up client name standing in for one.
        expect(s).toMatch(/\[[a-z ,/]+\]/i);
        expect(s).not.toMatch(/\bSam\b|\bWed\b|\bAug\b/);
      }
      // Every link a real text carries is in a sample (#971 review): the
      // portal (past due, declined card), the live map (on my way) and the
      // review link (review request).
      const all = c.samples.join("\n");
      expect(all).toContain(`${BASE.portalUrl}/[link]`);
      expect(all).toContain("https://app.houndstack.com/track/[link]");
      expect(all).toContain(BASE.googleReviewUrl);
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
      googleReviewUrl: BASE.googleReviewUrl,
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

// ── #971 review: the samples cannot drift from what is sent ────────────────
//
// The first filing described a walk report and an "invoice ready" text that
// nobody sends, and missed the review request and the live-map link. Now
// each automated text is built by one function that the filing's samples
// are built from too, and this holds every sender to it: a sender that
// writes its own words again, or a new file that texts clients, fails here
// by name and has to be squared with the filing first.
describe("every text a business's number sends is one the filing describes", () => {
  const code = (p: string) =>
    read(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  /** Every file that calls sendTwilioSms, and what it sends. */
  const SENDERS: Record<string, string> = {
    "src/lib/twilio.server.ts": "the transport itself",
    "src/lib/on-my-way.server.ts": "on-my-way, from onMyWayText / walkOnMyWayText (sample 1)",
    "src/routes/api/public/hooks/nightly.ts": "past due, from pastDueInvoiceText (sample 2)",
    "src/routes/api/public/hooks/stripe.ts": "declined card, from cardDeclinedText (summary)",
    "src/lib/reviews.functions.ts": "review request, from reviewAskText (sample 3)",
    "src/lib/my-day.functions.ts": "review request after a visit, from reviewAskText (sample 3)",
    "src/lib/messages.functions.ts":
      "reminder and visit complete, from client-sms-templates (summary), and replies typed by staff",
    "src/lib/portal-auth.server.ts": "portal sign-in codes (summary)",
    "src/lib/client-sms-consent.server.ts": "the opt-in confirmation (OptInConfirmationMessage)",
  };

  it("knows every file that texts a client", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && readFileSync(full, "utf8").includes("sendTwilioSms("))
          found.push(repoRelative(full, root));
      }
    };
    walk(join(root, "src"));
    found.sort();
    expect(found, "a new sender: add it here and to the filing's summary or samples").toEqual(
      Object.keys(SENDERS).sort(),
    );
  });

  it.each([
    ["src/lib/on-my-way.server.ts", /\bonMyWayText\(/],
    ["src/lib/on-my-way.server.ts", /\bwalkOnMyWayText\(/],
    ["src/routes/api/public/hooks/nightly.ts", /\bpastDueInvoiceText\(/],
    ["src/routes/api/public/hooks/stripe.ts", /\bcardDeclinedText\(/],
    ["src/lib/reviews.functions.ts", /\breviewAskText\(/],
    ["src/lib/my-day.functions.ts", /\breviewAskText\(/],
    ["src/lib/messages.functions.ts", /\bvisitReminderText\(/],
    ["src/lib/messages.functions.ts", /\bvisitCompleteText\(/],
  ])("%s builds its text with %s", (file, fn) => {
    expect(code(file)).toMatch(fn);
  });

  it("no sender writes those words inline again", () => {
    for (const file of Object.keys(SENDERS)) {
      const src = code(file);
      expect(src, file).not.toMatch(/is past due\. Pay:/);
      expect(src, file).not.toMatch(/card on file was declined\. Please update/);
      expect(src, file).not.toMatch(/a quick review would mean the world/);
      expect(src, file).not.toMatch(/this is a reminder your visit is scheduled/);
      expect(src, file).not.toMatch(/your visit is complete for/);
    }
  });

  it("the past-due and declined-card texts now end with STOP wording, like every other", () => {
    expect(pastDueInvoiceText({ name: "A", amount: "1.00", link: "https://x" })).toMatch(
      / Reply STOP to opt out\.$/,
    );
    expect(cardDeclinedText({ name: "A", link: "https://x" })).toMatch(/ Reply STOP to opt out\.$/);
  });

  it("the samples ARE those texts, with bracketed values", () => {
    const c = copyFor(["pet_waste"]);
    expect(c.samples[0]).toBe(
      brandedBody(
        "QA Test 971",
        onMyWayText({
          customerName: "[client name]",
          orgName: "QA Test 971",
          techName: "[staff name]",
          eta: "between [time] and [time]",
          trackUrl: "https://app.houndstack.com/track/[link]",
          yard: true,
        }),
      ),
    );
    expect(c.samples[1]).toBe(
      brandedBody(
        "QA Test 971",
        pastDueInvoiceText({
          name: "[client name]",
          amount: "[amount]",
          link: `${BASE.portalUrl}/[link]`,
        }),
      ),
    );
    expect(c.samples[2]).toBe(
      brandedBody(
        "QA Test 971",
        reviewAskText({
          template: null,
          orgName: "QA Test 971",
          firstName: "[first name]",
          link: BASE.googleReviewUrl,
        }),
      ),
    );
    // And the reminder and visit-complete texts the summary names are the
    // ones Messages sends.
    expect(visitReminderText({ name: "[client name]", day: "[day]" })).toBe(
      "Hi [client name], this is a reminder your visit is scheduled for [day]. Reply STOP to opt out.",
    );
    expect(visitCompleteText({ name: "[client name]", day: "[day]" })).toBe(
      "Hi [client name], your visit is complete for [day]. Thanks! Reply STOP to opt out.",
    );
  });
});
