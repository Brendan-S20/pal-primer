// The booking link sells every live line (#560).
//
// Brendan, 2026-10-28, on the Oct 28 smoke of /signup/demo-pet-waste-co and
// Riverbend's link: walking, training and grooming missing from the picker is
// a gap, not a design. Each gets a self-serve path there, with a base price
// and add-ons ("dog breed, size"), and the three wording fails the smoke found
// on the sitting options go:
//
//   1. "Tell us about your yard and we'll get you a quote." over a sit
//   2. "Gate code or access notes" as the access label on a sit
//   3. "Drop-in (30 min) (30 min)" in the picker
//
// The form is RENDERED for what a visitor reads, as
// tests/a-walk-is-not-a-yard-cleanup.test.tsx renders it; the priced state
// needs a mutation's answer, which a static render cannot hold, so it is
// pinned through the pure functions the panel calls. The database half is
// supabase/proofs/20261028120000-the-booking-link-sells-every-live-line.sql.

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
  GROOM_COPY,
  STAY_COPY,
  ADD_ON_COPY,
  UNPRICED_COPY,
  bookingIntro,
  perVisitLineLabel,
  requestPanelHint,
} from "@/lib/booking-copy";
import {
  addOnsFor,
  bookingExtrasFromRows,
  cleanPetSizes,
  extrasNote,
  messageWithExtras,
  priceVisitWithExtras,
  sizePricesFor,
  type BookingExtras,
} from "@/lib/booking-extras";
import { decideFormBranch, normalizeFormConfig } from "@/lib/new-customer-form";
import {
  publicServiceChoices,
  publicServiceOptionLabel,
  publicServiceOptions,
  requestedBecause,
  type PublicService,
} from "@/lib/public-services";
import {
  SERVICE_LINES,
  bookingLinkOffersLine,
  customerCanBookService,
  type ServiceLineAvailability,
} from "@/lib/service-lines";
import { LAUNCH_DEFAULT, withoutBookable } from "./support/service-line-availability";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SLUG = "riverbend";

function svc(
  id: string,
  name: string,
  line: string,
  extra: Partial<PublicService> = {},
): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    name,
    service_line: line,
    price_unit: "visit",
    base_price_cents: 3000,
    extra_pet_cents: 500,
    default_duration_min: 30,
    ...extra,
  };
}

// Riverbend as the smoke saw it, with all five lines on.
const SCOOP = svc("1", "Pet waste removal", "pet_waste", {
  base_price_cents: null,
  default_duration_min: null,
});
const WALK = svc("2", "Dog walk", "dog_walking", { base_price_cents: null });
const DROP_IN = svc("3", "Drop-in", "pet_sitting", { base_price_cents: 2500 });
const DROP_IN_NAMED = svc("4", "Drop-in (30 min)", "pet_sitting", { base_price_cents: 2500 });
const HOUSE_SIT = svc("5", "House sit", "pet_sitting", {
  price_unit: "night",
  default_duration_min: null,
});
const GROOM = svc("6", "Full groom", "mobile_grooming", {
  base_price_cents: 8000,
  extra_pet_cents: 0,
  default_duration_min: 90,
});
const LESSON = svc("7", "Private lesson", "training", {
  base_price_cents: 9000,
  extra_pet_cents: 0,
  default_duration_min: 60,
});

const TEETH = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Teeth brushing",
  service_line: "mobile_grooming",
  unit_price_cents: 1200,
  active: true,
};
const EXTRA_15 = {
  id: "10000000-0000-4000-8000-000000000002",
  name: "Extra 15 minutes",
  service_line: "dog_walking",
  unit_price_cents: 800,
  active: true,
};
const PW_ADDON = {
  id: "10000000-0000-4000-8000-000000000003",
  name: "Deodorizer",
  service_line: null,
  unit_price_cents: 1500,
  active: true,
};
const HOMEWORK = {
  id: "10000000-0000-4000-8000-000000000004",
  name: "Written homework plan",
  service_line: "training",
  unit_price_cents: 2000,
  active: true,
};
const SIZES = [
  { service_id: GROOM.id, size: "small", coat_type: null, price_cents: 6500 },
  { service_id: GROOM.id, size: "large", coat_type: null, price_cents: 9500 },
  // A coat-specific price is the groomer's call at the van, not a stranger's.
  { service_id: GROOM.id, size: "large", coat_type: "double", price_cents: 12000 },
];

function extrasFor(services: Record<string, unknown>[]): BookingExtras {
  const listed = publicServiceChoices(services, LAUNCH_DEFAULT);
  return bookingExtrasFromRows(
    [TEETH, EXTRA_15, PW_ADDON, HOMEWORK],
    SIZES,
    [...new Set(listed.map((s) => s.service_line))].filter((l) => l !== "pet_waste"),
    listed.map((s) => s.id),
  );
}

function render(services: Record<string, unknown>[], intro = "") {
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
    form: normalizeFormConfig({ intro }),
    firstCleanup: { mode: "off", tiers: [] },
    services: publicServiceChoices(services, LAUNCH_DEFAULT),
    serviceLines: LAUNCH_DEFAULT,
    lines: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"],
    extras: extrasFor(services),
  });
  // What a person reads: the markup with its escaped quotes put back.
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SignupFlow slug={SLUG} />
    </QueryClientProvider>,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// ── B1. The picker lists every live line ────────────────────────────────────

describe("the picker lists all five lines on a business that runs them", () => {
  const ALL = [SCOOP, WALK, DROP_IN, HOUSE_SIT, GROOM, LESSON];

  it("keeps walking, training and grooming, priced or not", () => {
    const lines = publicServiceChoices(ALL, LAUNCH_DEFAULT).map((s) => s.service_line);
    expect(new Set(lines)).toEqual(
      new Set(["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"]),
    );
  });

  it("reads the bookable switch alone, so training is offered though no customer may request it elsewhere", () => {
    expect(LAUNCH_DEFAULT.customerRequestable).not.toContain("training");
    for (const line of SERVICE_LINES)
      expect(bookingLinkOffersLine(line, LAUNCH_DEFAULT), line).toBe(
        LAUNCH_DEFAULT.bookable.includes(line),
      );
    // The doors that cannot ask a size or price an add-on keep their gate.
    expect(customerCanBookService("training", LAUNCH_DEFAULT)).toBe(false);
    expect(customerCanBookService("mobile_grooming", LAUNCH_DEFAULT)).toBe(false);
  });

  it("still leaves a Coming soon line out", () => {
    const off: ServiceLineAvailability = withoutBookable("mobile_grooming");
    expect(publicServiceChoices(ALL, off).map((s) => s.service_line)).not.toContain(
      "mobile_grooming",
    );
  });

  it("labels every one of them for the picker", () => {
    const labels = publicServiceChoices(ALL, LAUNCH_DEFAULT).map(publicServiceOptionLabel);
    expect(labels).toEqual([
      "Pet waste removal",
      "Dog walk (30 min)",
      "Drop-in (30 min)",
      "House sit",
      "Full groom (1 hr 30 min)",
      "Private lesson (1 hr)",
    ]);
  });
});

// ── B2/B3. Each line has a path, with its base price and add-ons ────────────

describe("each line reaches a quote or a request", () => {
  const walk = publicServiceChoices([WALK], LAUNCH_DEFAULT)[0];
  const pricedWalk = publicServiceChoices([{ ...WALK, base_price_cents: 3000 }], LAUNCH_DEFAULT)[0];
  const groom = publicServiceChoices([GROOM], LAUNCH_DEFAULT)[0];
  const lesson = publicServiceChoices([LESSON], LAUNCH_DEFAULT)[0];
  const stay = publicServiceChoices([HOUSE_SIT], LAUNCH_DEFAULT)[0];

  it("says why a service is requested, or that it can be started", () => {
    expect(requestedBecause(null)).toBeNull();
    expect(requestedBecause(pricedWalk)).toBeNull();
    expect(requestedBecause(lesson)).toBeNull();
    expect(requestedBecause(groom)).toBe("groom");
    expect(requestedBecause(walk)).toBe("unpriced");
    expect(requestedBecause(stay)).toBe("stay");
    // A groom with no base price is still priced when it has size prices.
    expect(requestedBecause({ ...groom, base_price_cents: null }, true)).toBe("groom");
    expect(requestedBecause({ ...groom, base_price_cents: null }, false)).toBe("unpriced");
  });

  it("prices a groom and offers both doors, book or request; asks for an unpriced walk", () => {
    // Brendan, Oct 28: "There should be both options; it would be
    // half-finished if not." A priced groom can be booked and paid for, or
    // requested for the office to place.
    const answer = { available: true as const, quote: { recurring_price_cents: 9500 } };
    const g = decideFormBranch({ instantStart: true, answer, request: "groom" });
    expect(g).toMatchObject({ canStartService: true, canRequestQuote: true, reason: "priced" });
    expect(g.quote).toEqual(answer.quote);
    const u = decideFormBranch({ instantStart: true, answer: null, request: "unpriced" });
    expect(u).toMatchObject({
      canStartService: false,
      canRequestQuote: true,
      reason: "unpriced-request",
    });
    // A lesson and a priced walk start like anything else.
    expect(decideFormBranch({ instantStart: true, answer, request: null }).canStartService).toBe(
      true,
    );
  });

  it("offers each line its own add-ons, and pet waste none", () => {
    const extras = extrasFor([SCOOP, WALK, GROOM, LESSON]);
    expect(addOnsFor(extras, groom).map((a) => a.name)).toEqual(["Teeth brushing"]);
    expect(addOnsFor(extras, walk).map((a) => a.name)).toEqual(["Extra 15 minutes"]);
    expect(addOnsFor(extras, lesson).map((a) => a.name)).toEqual(["Written homework plan"]);
    expect(addOnsFor(extras, { service_line: "pet_waste" })).toEqual([]);
    expect(addOnsFor(extras, null)).toEqual([]);
    // The untagged add-on is a pet-waste extra and is not on any of them.
    expect(JSON.stringify(extras)).not.toContain("Deodorizer");
  });

  it("asks a size only where the service prices by size, and not a coat", () => {
    const extras = extrasFor([SCOOP, WALK, GROOM, LESSON]);
    expect(sizePricesFor(extras, groom)).toEqual([
      { service_id: GROOM.id, size: "small", price_cents: 6500 },
      { service_id: GROOM.id, size: "large", price_cents: 9500 },
    ]);
    expect(sizePricesFor(extras, lesson)).toEqual([]);
  });

  it("prices a lesson or a walk as its base plus each add-on", () => {
    const extras = extrasFor([LESSON]);
    const priced = priceVisitWithExtras({
      service: lesson,
      baseCents: 9000,
      petCount: 1,
      sizes: [],
      sizePrices: [],
      addOns: addOnsFor(extras, lesson),
    });
    expect(priced.perVisitCents).toBe(11000);
    expect(priced.lines).toEqual([
      { label: "Base price", cents: 9000, addOn: false },
      { label: "Written homework plan", cents: 2000, addOn: true },
    ]);
    // No add-on picked: the base, with nothing to break down.
    expect(
      priceVisitWithExtras({
        service: lesson,
        baseCents: 9000,
        petCount: 1,
        sizes: [],
        sizePrices: [],
        addOns: [],
      }),
    ).toEqual({ perVisitCents: 9000, lines: [], addOnNames: [] });
  });

  it("prices a groom per pet by size with groomQuote, and a pet with no size at the base", () => {
    const extras = extrasFor([GROOM]);
    const priced = priceVisitWithExtras({
      service: groom,
      baseCents: 16000,
      petCount: 3,
      sizes: cleanPetSizes(["small", "large", ""], 3),
      sizePrices: sizePricesFor(extras, groom),
      addOns: addOnsFor(extras, groom),
    });
    expect(priced.perVisitCents).toBe(6500 + 9500 + 8000 + 1200);
    expect(priced.lines.map((l) => l.label)).toEqual([
      "Pet 1: Small",
      "Pet 2: Large",
      "Pet 3: Size not given",
      "Teeth brushing",
    ]);
  });

  it("names the extras on the lead for the office", () => {
    const note = extrasNote(["Teeth brushing"], ["small", "", "large"]);
    expect(note).toBe("Add-ons: Teeth brushing. Sizes: small, large.");
    expect(messageWithExtras("Biscuit bites at the nails", note)).toBe(
      "Biscuit bites at the nails\n\nAdd-ons: Teeth brushing. Sizes: small, large.",
    );
    expect(messageWithExtras("", null)).toBe("");
  });

  it("draws the groom's size question, its add-on and its request button", () => {
    const html = render([GROOM, LESSON]);
    expect(html).toContain('id="pet-size-0"');
    expect(html).toContain(GROOM_COPY.sizeHint);
    expect(html).toContain("Teeth brushing");
    expect(html).toContain("+$12.00");
    expect(html).toContain(GROOM_COPY.requestButton);
    expect(html).toContain("Get instant price");
    // The add-on row is the target, 44px tall.
    expect(html).toMatch(/<label[^>]*for="add-on-[^"]+"[^>]*class="[^"]*min-h-11/);
  });

  it("draws an unpriced walk as a request, with no instant price", () => {
    const html = render([WALK, LESSON]);
    // A walk asks about the dogs, not "pets" or a property.
    expect(html).toContain(requestPanelHint("dog_walking"));
    expect(requestPanelHint("dog_walking")).toBe(
      "Tell us about your dogs and we'll get back to you with a price.",
    );
    expect(requestPanelHint("pet_waste")).toMatch(/property and pets/);
    // A ticked add-on with no price yet says the price comes with the quote.
    expect(html).toContain(ADD_ON_COPY.unpricedHint);
    expect(html).toContain(UNPRICED_COPY.requestButton);
    expect(html).not.toContain("Get instant price");
    expect(html).toContain("Extra 15 minutes");
  });

  it("labels a groom's price per groom, not as an ongoing charge", () => {
    expect(perVisitLineLabel("mobile_grooming", true)).toBe("Each groom");
    expect(perVisitLineLabel("dog_walking", false)).toBe("Ongoing");
  });

  it("names the sizes on a signup's lead as well as a request's", () => {
    const fns = read("src/lib/signup.functions.ts");
    expect(fns).toContain("extrasNote(q.add_on_names, q.pet_sizes)");
  });

  it("draws a lesson with its add-on and an instant price", () => {
    const html = render([LESSON, WALK]);
    expect(html).toContain("Written homework plan");
    expect(html).toContain("Get instant price");
    expect(html).not.toContain('id="pet-size-0"');
  });

  it("books a groom at the price the server makes, and still offers the request beside it", () => {
    const fns = read("src/lib/signup.functions.ts");
    const checkout = fns.slice(fns.indexOf("export const createSignupPaymentIntent"));
    // No refusal: a groom checks out like a walk, priced by quoteWithExtras
    // from the sizes and add-ons the server reads, and the lead names them.
    expect(fns).not.toContain("refuseAGroomStart");
    expect(checkout).toContain("const q = await quoteWithExtras(q0, data);");
    expect(checkout).toContain("extrasNote(q.add_on_names, q.pet_sizes");
    // The panel words both doors for a groom.
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toContain("GROOM_COPY.bookButton");
    expect(flow).toContain("GROOM_COPY.requestButton");
    expect(flow).toContain("GROOM_COPY.requestNote");
    // The extras are priced from rows the server read, never from the body.
    const quote = fns.slice(fns.indexOf("async function quoteWithExtras"));
    expect(quote).toContain('.from("addon_services")');
    expect(quote).toContain('.from("service_size_rules")');
    expect(quote).toContain(
      "if (extras.addOns.length !== wanted.length) throw new Error(ADD_ON_NOT_OFFERED);",
    );
  });
});

// ── A. The three wording fails on sitting ───────────────────────────────────

describe("a sit does not read as a yard", () => {
  const OWNER_INTRO = "Tell us about your yard and we'll get you a quote.";

  it("puts the line's own sentence under the headline when the owner's is about a yard", () => {
    expect(bookingIntro(OWNER_INTRO, "pet_sitting")).toBe(BOOKING_COPY.pet_sitting.intro);
    expect(bookingIntro(OWNER_INTRO, "pet_sitting")).not.toMatch(/yard/i);
    for (const line of ["dog_walking", "mobile_grooming", "training"] as const)
      expect(bookingIntro(OWNER_INTRO, line)).not.toMatch(/yard/i);
    // Pet waste keeps the owner's words, and so does an owner who wrote none
    // about a yard.
    expect(bookingIntro(OWNER_INTRO, "pet_waste")).toBe(OWNER_INTRO);
    expect(bookingIntro("Tell us about your pets.", "pet_sitting")).toBe(
      "Tell us about your pets.",
    );
  });

  it("the route words the line under the headline for the service the form is on", () => {
    const route = read("src/routes/signup.$slug.tsx");
    expect(route).toContain("bookingIntro(copy.intro, line)");
    expect(route).toContain("onLineChange={setPickedLine}");
    expect(route).not.toContain("{copy.intro}");
  });

  it("labels the access box for a door on a sit, a gate only on pet waste", () => {
    expect(BOOKING_COPY.pet_waste.accessLabel).toBe("Gate code or access notes");
    expect(BOOKING_COPY.pet_sitting.accessLabel).toBe("Door code or access notes");
    for (const line of SERVICE_LINES.filter((l) => l !== "pet_waste"))
      expect(BOOKING_COPY[line].accessLabel, line).not.toMatch(/^Gate code/);
  });

  it("renders a drop-in and a stay with no yard and no gate-code label", () => {
    for (const services of [
      [DROP_IN, HOUSE_SIT],
      [HOUSE_SIT, DROP_IN],
    ]) {
      const html = render(services, OWNER_INTRO);
      expect(html).toContain("Door code or access notes");
      expect(html).not.toContain("Gate code or access notes");
      expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\byard\b/i);
    }
    expect(render([HOUSE_SIT, DROP_IN])).toContain(STAY_COPY.requestButton);
  });

  it("does not say a drop-in's length twice", () => {
    const [named, plain] = publicServiceChoices([DROP_IN_NAMED, DROP_IN], LAUNCH_DEFAULT);
    expect(publicServiceOptionLabel(named)).toBe("Drop-in (30 min)");
    expect(publicServiceOptionLabel(plain)).toBe("Drop-in (30 min)");
    const hour = publicServiceChoices(
      [svc("8", "Long walk 1 hr", "dog_walking", { default_duration_min: 60 })],
      LAUNCH_DEFAULT,
    )[0];
    expect(publicServiceOptionLabel(hour)).toBe("Long walk 1 hr");
    // The grooming starter services name their length in minutes; the
    // duration label would say "1 hr 30 min" beside it.
    const seeded = publicServiceChoices(
      [svc("9", "Full groom (90 min)", "mobile_grooming", { default_duration_min: 90 })],
      LAUNCH_DEFAULT,
    )[0];
    expect(publicServiceOptionLabel(seeded)).toBe("Full groom (90 min)");
    expect(render([DROP_IN_NAMED, HOUSE_SIT])).not.toContain("(30 min) (30 min)");
    // The two drop-ins read the same and cost the same: one choice.
    const listed = publicServiceChoices([DROP_IN_NAMED, DROP_IN, HOUSE_SIT], LAUNCH_DEFAULT);
    expect(publicServiceOptions(listed).map(publicServiceOptionLabel)).toEqual([
      "Drop-in (30 min)",
      "House sit",
    ]);
    // At different prices they are two choices, both kept.
    const dearer = publicServiceChoices(
      [DROP_IN_NAMED, { ...DROP_IN, base_price_cents: 3500 }],
      LAUNCH_DEFAULT,
    );
    expect(publicServiceOptions(dearer)).toHaveLength(2);
  });
});
