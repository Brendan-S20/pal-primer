// A walk is not a yard cleanup (#525), and the booking link's copy fixes (#528).
//
// /signup/{slug} was written for one service. With walking live (#530) a
// stranger who picked a walk still read "We'll price your yard ourselves",
// "First cleanup (one-time)" and "Gate code, dog names". The words that
// depend on what is being sold now come from one map, lib/booking-copy.ts,
// and the yard questions are asked only when asksAboutTheYard says so.
//
// The form is RENDERED here, as tests/a-quote-started-from-nothing.test.tsx
// renders the quote editor: the claim is about what a visitor reads, so the
// test is the markup. The server functions are stubbed and the form lookup is
// seeded into the cache the way a real fetch fills it; everything else is the
// real code. The quote panel's priced state needs a mutation's answer, which
// a static render cannot hold, so its sentences are pinned through the pure
// functions the panel calls.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/signup.functions", () => ({
  getPublicSignupForm: vi.fn(),
  getSignupQuote: vi.fn(),
  createSignupPaymentIntent: vi.fn(),
}));

import { SignupFlow } from "@/components/signup/SignupFlow";
import {
  BOOKING_COPY,
  bookingCadence,
  bookingLine,
  bookingMetaDescription,
  chargedTodayCovers,
  perVisitBillingSentence,
} from "@/lib/booking-copy";
import { PORTAL_FREQUENCY_VALUES } from "@/lib/frequency-request";
import { LAST_CLEANED_QUESTION } from "@/lib/first-cleanup";
import { normalizeFormConfig, readsAsQuoteOnly } from "@/lib/new-customer-form";
import { asksAboutTheYard, publicServiceChoices, quotedPublicService } from "@/lib/public-services";
import { SERVICE_LINES, type ServiceLineAvailability } from "@/lib/service-lines";
import { LAUNCH_DEFAULT, withBookable } from "./support/service-line-availability";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SLUG = "riverbend";
const YARD_WORDS = /yard|cleanup|cleaned/i;

// Sitting launched and open to customers, as it would be on its launch day.
const SITTING_LIVE: ServiceLineAvailability = {
  ...withBookable("pet_sitting"),
  customerRequestable: [...LAUNCH_DEFAULT.customerRequestable],
};

function row(id: string, name: string, line: string, unit = "visit") {
  return {
    id,
    name,
    service_line: line,
    price_unit: unit,
    base_price_cents: 3000,
    extra_pet_cents: 500,
    default_duration_min: 30,
  };
}
const SCOOP = row("00000000-0000-4000-8000-000000000001", "Pet waste removal", "pet_waste");
const WALK = row("00000000-0000-4000-8000-000000000002", "30 minute walk", "dog_walking");
const SIT = row("00000000-0000-4000-8000-000000000003", "Drop-in visit", "pet_sitting");

/** The form a business with these services shows, before anything is typed.
 *  Every business here has first-cleanup tiers configured, so the yard
 *  question is there to be wrongly asked. */
function render(services: unknown[], serviceLines: ServiceLineAvailability = SITTING_LIVE) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["signup-form", SLUG], {
    id: "org",
    name: "Riverbend Pet Services",
    currency: "usd",
    logoUrl: null,
    brandColor: null,
    resolvedSlug: SLUG,
    instantStart: true,
    form: normalizeFormConfig(null),
    firstCleanup: { mode: "by_last_cleaned", tiers: [{ id: "month", label: "Over a month ago" }] },
    services: publicServiceChoices(services, serviceLines),
    serviceLines,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SignupFlow slug={SLUG} />
    </QueryClientProvider>,
  );
}

/** What a person reads: text between tags, and the attributes they see. */
function visibleWords(html: string): string {
  const text = html.replace(/<[^>]*>/g, " ");
  const attrs = [...html.matchAll(/(?:placeholder|aria-label|title|alt)="([^"]*)"/g)].map(
    (m) => m[1],
  );
  return [text, ...attrs].join(" ");
}

describe("with a walk chosen, the form says nothing about a yard", () => {
  // Walking and sitting, no pet waste: the picker opens on the first listed,
  // the walk.
  const html = render([WALK, SIT]);

  it("is the walking form", () => {
    expect(html).toMatch(/id="service"/);
    expect(html).toContain(BOOKING_COPY.dog_walking.notePlaceholder);
  });

  it('contains none of "yard", "cleanup", "cleaned"', () => {
    expect(visibleWords(html)).not.toMatch(YARD_WORDS);
  });

  it("does not ask when the yard was last cleaned, though tiers are configured", () => {
    expect(html).not.toContain(LAST_CLEANED_QUESTION);
    expect(html).not.toMatch(/id="last_cleaned"/);
  });

  it("asks for dogs, because a walk is a dog's", () => {
    expect(html).toMatch(/<label[^>]*for="dog_count"[^>]*>Dogs<\/label>/);
  });
});

describe("a business that sells only a walk is priced and worded as a walk", () => {
  // Walking is bookable at launch, so this is a live case: no picker (one
  // service), and before the fix no service id, so public_quote priced the
  // zone rate card with its first cleanup and the form asked about the yard.
  const html = render([WALK], LAUNCH_DEFAULT);

  it("has no picker, and still says nothing about a yard", () => {
    expect(html).not.toMatch(/id="service"/);
    expect(html).toContain(BOOKING_COPY.dog_walking.notePlaceholder);
    expect(visibleWords(html)).not.toMatch(YARD_WORDS);
    expect(html).not.toContain(LAST_CLEANED_QUESTION);
  });

  it("quotes the walk by its id, so the server adds no first cleanup", () => {
    const only = publicServiceChoices([WALK], LAUNCH_DEFAULT);
    expect(quotedPublicService(only, "")?.id).toBe(WALK.id);
    expect(asksAboutTheYard(quotedPublicService(only, ""))).toBe(false);
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/const chosen = quotedPublicService\(services, form\.service_id\);/);
    expect(flow).toMatch(/const serviceField = chosen \? \{ service_id: chosen\.id \} : \{\};/);
  });

  it("a pet-waste-only business still sends no id", () => {
    expect(quotedPublicService(publicServiceChoices([SCOOP], LAUNCH_DEFAULT), "")).toBeNull();
    expect(quotedPublicService([], "")).toBeNull();
  });
});

describe("with a sit chosen, the pet field is Pets", () => {
  it("reads Pets, with the count rule unchanged", () => {
    const html = render([SIT, WALK]);
    expect(html).toMatch(/<label[^>]*for="dog_count"[^>]*>Pets<\/label>/);
    expect(html).toMatch(/id="dog_count"[^>]*min="1"[^>]*max="20"|max="20"[^>]*min="1"/);
    expect(visibleWords(html)).not.toMatch(YARD_WORDS);
  });
});

describe("pet waste reads exactly as it did", () => {
  // A business that lists nothing online: the zone-priced scooping form.
  const html = render([]);

  it("keeps every word it had", () => {
    expect(html).toMatch(/<label[^>]*for="dog_count"[^>]*>Dogs<\/label>/);
    expect(html).toContain("Gate code, dog names, preferred days…");
    expect(visibleWords(html)).toMatch(
      /Enter your ZIP and dogs, then hit\s+Get instant price\s*\./,
    );
    expect(html).toContain(LAST_CLEANED_QUESTION);
  });

  it("and the map's pet-waste entry is the old copy, word for word", () => {
    const c = BOOKING_COPY.pet_waste;
    expect(c.outOfArea).toBe("We'll price your yard ourselves and get back to you.");
    expect(c.priceHint).toBe("Enter your ZIP and dogs, then hit");
    expect(c.notePlaceholder).toBe("Gate code, dog names, preferred days…");
    expect(c.visit).toBe("visit");
    expect(c.cadences).toEqual(PORTAL_FREQUENCY_VALUES);
    expect(c.metaDescription).toBe(
      "Enter your ZIP, number of dogs, and cleanup frequency to get a price, then start service online or ask for a quote.",
    );
    expect(chargedTodayCovers("pet_waste", true)).toBe(
      ", which covers your first cleanup plus your first scheduled visit.",
    );
    expect(chargedTodayCovers("pet_waste", false)).toBe(
      ", which covers your first scheduled visit.",
    );
  });
});

describe("the copy map", () => {
  it("has an entry for every line, and no yard words outside pet waste", () => {
    for (const line of SERVICE_LINES) {
      const c = BOOKING_COPY[line];
      expect(c, line).toBeDefined();
      if (line === "pet_waste") continue;
      const words = [
        c.priceHint,
        c.outOfArea,
        c.notePlaceholder,
        c.metaDescription,
        c.visit,
        c.visits,
        chargedTodayCovers(line, false),
        perVisitBillingSentence(line, "$30.00"),
      ].join(" ");
      expect(words, line).not.toMatch(YARD_WORDS);
    }
  });

  it("says Dogs only for a dog-only line", () => {
    expect(BOOKING_COPY.pet_waste.petLabel).toBe("Dogs");
    expect(BOOKING_COPY.dog_walking.petLabel).toBe("Dogs");
    expect(BOOKING_COPY.training.petLabel).toBe("Dogs");
    expect(BOOKING_COPY.pet_sitting.petLabel).toBe("Pets");
    expect(BOOKING_COPY.mobile_grooming.petLabel).toBe("Pets");
  });

  it("offers only cadences the server accepts, and falls back to the line's first", () => {
    for (const line of SERVICE_LINES) {
      const offered = BOOKING_COPY[line].cadences;
      expect(offered.length, line).toBeGreaterThan(0);
      for (const c of offered) expect(PORTAL_FREQUENCY_VALUES, line).toContain(c);
    }
    expect(bookingCadence("dog_walking", "twice_weekly")).toBe("twice_weekly");
    expect(bookingCadence("mobile_grooming", "weekly")).toBe("monthly");
  });

  it("speaks for the service picked, else the only one, else pet waste", () => {
    const [walk, sit] = publicServiceChoices([WALK, SIT], SITTING_LIVE);
    expect(bookingLine([walk, sit], sit)).toBe("pet_sitting");
    expect(bookingLine([walk], null)).toBe("dog_walking");
    expect(bookingLine([], null)).toBe("pet_waste");
  });

  it("uses no em or en dash anywhere", () => {
    const all = JSON.stringify(BOOKING_COPY) + bookingMetaDescription(["pet_waste", "dog_walking"]);
    expect(all).not.toMatch(/[—–]/);
  });
});

describe("the per-visit billing line (#528)", () => {
  it("says the per-visit amount in plain words", () => {
    expect(perVisitBillingSentence("pet_waste", "$30.00")).toBe(
      "After today, you pay $30.00 per visit as visits happen. Cancel anytime.",
    );
    expect(perVisitBillingSentence("dog_walking", "$25.00")).toBe(
      "After today, you pay $25.00 per walk as walks happen. Cancel anytime.",
    );
  });

  it("is what the quote panel says, with the quote's own per-visit price", () => {
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(
      /perVisitBillingSentence\(line, money\(quote\.recurring_price_cents, quote\.currency\)\)/,
    );
    expect(flow).not.toMatch(/billed for visits as they happen/);
  });
});

describe("the meta description follows what the business sells", () => {
  it("is built from its lines, not a fixed scooping sentence", () => {
    expect(bookingMetaDescription([])).toBe(BOOKING_COPY.pet_waste.metaDescription);
    expect(bookingMetaDescription(["dog_walking"])).not.toMatch(YARD_WORDS);
    expect(bookingMetaDescription(["pet_waste", "dog_walking", "dog_walking"])).toBe(
      "Get a price for pet waste removal or dog walking: pick a service and enter your ZIP and pets, then start service online or ask for a quote.",
    );
    const route = read("src/routes/signup.$slug.tsx");
    expect(route).toMatch(/bookingMetaDescription\(loaderData\?\.lines \?\? \[\]\)/);
    expect(route).not.toMatch(/cleanup frequency to get a price/);
  });
});

describe("one hint, one name per button (#528)", () => {
  const flow = read("src/components/signup/SignupFlow.tsx");

  it('names the quote request "Get a quote by email" beside Start service, "Request a quote" alone', () => {
    expect(flow).toContain('"Get a quote by email"');
    expect(flow).toContain('"Request a quote"');
    expect(flow).not.toContain('"Just send me a quote"');
  });

  it("shows one hint once Start service is on offer", () => {
    expect(flow).toContain("Add your name, email and street address to continue.");
    expect(flow).toMatch(
      /!hasContact && !\(branch\.canStartService && firstCleanupCents != null\) &&/,
    );
  });

  it('shows "First cleanup" only when the yard questions apply', () => {
    expect(flow).toMatch(/const showsFirstCleanup =\s*asksAboutTheYard\(chosen\) &&/);
    expect(flow).toMatch(/\{showsFirstCleanup && \(/);
  });
});

describe("a quote-only headline on an instant page (#528)", () => {
  it("is recognised, and the instant defaults are not", () => {
    expect(readsAsQuoteOnly("Request a quote")).toBe(true);
    expect(readsAsQuoteOnly("Tell us about your yard and we'll get you a quote.")).toBe(true);
    expect(readsAsQuoteOnly("Get an instant quote")).toBe(false);
    expect(
      readsAsQuoteOnly(
        "Tell us about your property and pets and we'll price it in seconds. Start service online, or ask us for a quote.",
      ),
    ).toBe(false);
    expect(readsAsQuoteOnly("")).toBe(false);
  });

  it("is warned about in Settings, with a way back to the default", () => {
    const page = read("src/routes/_authenticated/settings.online-signup.tsx");
    expect(page).toMatch(
      /instantOn && \(readsAsQuoteOnly\(headline\) \|\| readsAsQuoteOnly\(intro\)\)/,
    );
    expect(page).toContain("Use the default wording");
  });
});

describe("a Coming soon line is still not offered", () => {
  it("is not listed, so the form has nothing to pick and nothing to price", () => {
    // Sitting is Coming soon at launch: only the walk is left, so no picker.
    expect(publicServiceChoices([WALK, SIT], LAUNCH_DEFAULT).map((s) => s.service_line)).toEqual([
      "dog_walking",
    ]);
    const html = render([SCOOP, SIT], LAUNCH_DEFAULT);
    expect(html).not.toMatch(/id="service"/);
    expect(html).not.toContain("Drop-in visit");
  });
});
