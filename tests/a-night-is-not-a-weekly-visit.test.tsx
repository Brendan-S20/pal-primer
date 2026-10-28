// A night is not a weekly visit (#546).
//
// The booking link's Start service is a subscription on a cadence: weekly,
// twice weekly, every other week, monthly. Before #546 it offered those for
// every sitting service, including an Overnight stay and a House sit, which
// are priced per night (20261024081200 seeds both that way). The day sitting
// is switched on, a stranger could have subscribed to a nightly stay as if it
// were a drop-in that repeats.
//
// Now a service priced per night is a STAY (isRequestedAsAStay): no Frequency
// select, no Get instant price, no Start service, only the quote request,
// which carries the pets, the access notes and the first night. A drop-in,
// priced per visit, keeps the cadence and the signup.
//
// Rendered as tests/a-walk-is-not-a-yard-cleanup.test.tsx renders it: the
// claim is about what a visitor can press. Sitting is switched on here
// (SITTING_LIVE), because the rule has to hold the day it is. The last block
// switches it back off (SITTING_COMING_SOON, the switch before #547) and
// finds the stay is not listed at all.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/signup.functions", () => ({
  getPublicSignupForm: vi.fn(),
  getSignupQuote: vi.fn(),
  getPublicGroomTimes: vi.fn(),
  createSignupPaymentIntent: vi.fn(),
}));

import { SignupFlow } from "@/components/signup/SignupFlow";
import { BOOKING_COPY, STAY_COPY } from "@/lib/booking-copy";
import { decideFormBranch, normalizeFormConfig } from "@/lib/new-customer-form";
import {
  isRequestedAsAStay,
  publicServiceChoices,
  quotedPublicService,
} from "@/lib/public-services";
import type { ServiceLineAvailability } from "@/lib/service-lines";
import {
  LAUNCH_DEFAULT,
  SITTING_COMING_SOON,
  withBookable,
} from "./support/service-line-availability";

const SLUG = "riverbend";

const SITTING_LIVE: ServiceLineAvailability = {
  ...withBookable("pet_sitting"),
  customerRequestable: [...LAUNCH_DEFAULT.customerRequestable],
};

function row(id: string, name: string, line: string, unit: string) {
  return {
    id,
    name,
    service_line: line,
    price_unit: unit,
    base_price_cents: 6000,
    extra_pet_cents: 1000,
    default_duration_min: 30,
  };
}
const OVERNIGHT = row(
  "00000000-0000-4000-8000-000000005461",
  "Overnight stay",
  "pet_sitting",
  "night",
);
const HOUSE_SIT = row("00000000-0000-4000-8000-000000005462", "House sit", "pet_sitting", "night");
const DROP_IN = row(
  "00000000-0000-4000-8000-000000005463",
  "Drop-in visit",
  "pet_sitting",
  "visit",
);
const WALK = row("00000000-0000-4000-8000-000000005464", "30 minute walk", "dog_walking", "visit");

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
    firstCleanup: { mode: "flat", tiers: [] },
    services: publicServiceChoices(services, serviceLines),
    serviceLines,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SignupFlow slug={SLUG} />
    </QueryClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("which services are stays", () => {
  it("is the per-night ones: Overnight stay and House sit", () => {
    expect(isRequestedAsAStay(OVERNIGHT)).toBe(true);
    expect(isRequestedAsAStay(HOUSE_SIT)).toBe(true);
  });

  it("is not a drop-in, an hourly sit, a walk, or nothing chosen", () => {
    expect(isRequestedAsAStay(DROP_IN)).toBe(false);
    expect(isRequestedAsAStay({ ...DROP_IN, price_unit: "hour" })).toBe(false);
    expect(isRequestedAsAStay(WALK)).toBe(false);
    expect(isRequestedAsAStay(null)).toBe(false);
  });
});

describe("the branch: a stay is never started, whatever the switch and the answer", () => {
  const priced = { available: true as const, quote: { recurring_price_cents: 6000 } };

  it("offers only the quote request for a stay, even priced with instant start on", () => {
    expect(decideFormBranch({ instantStart: true, answer: priced, stay: true })).toEqual({
      canStartService: false,
      canRequestQuote: true,
      quote: null,
      reason: "stay-request",
    });
  });

  it("leaves a drop-in's branch exactly as it was", () => {
    expect(decideFormBranch({ instantStart: true, answer: priced, stay: false })).toMatchObject({
      canStartService: true,
      reason: "priced",
    });
    expect(decideFormBranch({ instantStart: true, answer: priced })).toMatchObject({
      canStartService: true,
      reason: "priced",
    });
  });
});

describe.each([
  ["Overnight stay", OVERNIGHT],
  ["House sit", HOUSE_SIT],
])("a business whose only online service is %s", (_name, svc) => {
  const html = render([svc]);

  it("is quoted as itself", () => {
    const only = publicServiceChoices([svc], SITTING_LIVE);
    expect(quotedPublicService(only, "")?.id).toBe(svc.id);
  });

  it("offers no cadence: no Frequency select, and none of weekly / biweekly / monthly", () => {
    expect(html).not.toMatch(/id="frequency"/);
    expect(html).not.toMatch(/>Frequency</);
    expect(text(html)).not.toMatch(/weekly|every other week|monthly/i);
    expect(text(html)).toContain(STAY_COPY.howItWorks);
  });

  it("offers no instant price and no Start service", () => {
    expect(text(html)).not.toContain("Get instant price");
    expect(text(html)).not.toContain("Start service");
  });

  it("ends as a stay request with the pets, the access and the first night", () => {
    expect(text(html)).toContain(STAY_COPY.requestButton);
    expect(text(html)).toContain(STAY_COPY.panelHint);
    expect(html).toMatch(/id="pet-name-0"/);
    expect(html).toMatch(/id="access_notes"/);
    expect(html).toMatch(/id="preferred_start_date"/);
    expect(text(html)).toContain(STAY_COPY.startDateLabel);
    expect(html).toContain(STAY_COPY.notePlaceholder);
  });
});

describe("a drop-in still sells as a recurring visit", () => {
  const html = render([DROP_IN]);

  it("offers the sitting cadences and the instant price", () => {
    expect(html).toMatch(/id="frequency"/);
    expect(text(html)).toContain("Get instant price");
    expect(text(html)).not.toContain(STAY_COPY.howItWorks);
    expect(text(html)).not.toContain(STAY_COPY.requestButton);
    expect(BOOKING_COPY.pet_sitting.cadences).toEqual([
      "weekly",
      "twice_weekly",
      "biweekly",
      "monthly",
    ]);
  });
});

describe("with a drop-in and a stay on the picker", () => {
  it("opens on the first listed (the drop-in) with its cadence, and the stay has none", () => {
    const dropInFirst = render([DROP_IN, OVERNIGHT]);
    expect(dropInFirst).toMatch(/id="service"/);
    expect(dropInFirst).toMatch(/id="frequency"/);

    const stayFirst = render([OVERNIGHT, DROP_IN]);
    expect(stayFirst).toMatch(/id="service"/);
    expect(stayFirst).not.toMatch(/id="frequency"/);
    expect(text(stayFirst)).not.toContain("Start service");
  });
});

describe("with sitting Coming soon (as before #547)", () => {
  it("lists no sitting service at all", () => {
    expect(
      publicServiceChoices([OVERNIGHT, HOUSE_SIT, DROP_IN, WALK], SITTING_COMING_SOON).map(
        (s) => s.id,
      ),
    ).toEqual([WALK.id]);
  });

  it("and a walk-only business still has its cadence and instant price", () => {
    const html = render([WALK], SITTING_COMING_SOON);
    expect(html).toMatch(/id="frequency"/);
    expect(text(html)).toContain("Get instant price");
  });
});
