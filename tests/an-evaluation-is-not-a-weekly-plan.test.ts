// #574: the booking link's Start service follows how the owner set the
// service up, not a hard-coded weekly prepaid plan. Riverbend's "Evaluation
// (45 min)" is one session, and starting it online used to sign a stranger up
// for an evaluation every week.
//
// The rules are in src/lib/public-booking-mode.ts; the reads in
// public-booking-mode.server.ts; the charge in signup.functions.ts; what is
// provisioned in the Stripe webhook; the setting in Settings -> Services; and
// the column, its default and the backfill in migration 20261029150000.
// Nothing here reaches a database.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ONE_TIME_COPY,
  PACKAGE_COPY,
  PUBLIC_BOOKING_MODES,
  PUBLIC_BOOKING_MODE_COPY,
  defaultPublicBookingMode,
  effectivePublicBookingMode,
  startedChargeDescription,
  storedPublicBookingMode,
} from "@/lib/public-booking-mode";
import { publicServiceChoices, requestedBecause, type PublicService } from "@/lib/public-services";
import { decideFormBranch } from "@/lib/new-customer-form";
import { parseServiceDraft } from "@/lib/services.functions";
import { SERVICE_LINES } from "@/lib/service-lines";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const LIVE = {
  bookable: [...SERVICE_LINES],
  customerRequestable: [...SERVICE_LINES],
} as any;

function svc(over: Partial<PublicService> = {}): PublicService {
  return {
    id: "e867d1a8-0000-4000-8000-000000000001",
    name: "Evaluation (45 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 6500,
    extra_pet_cents: 0,
    default_duration_min: 45,
    ...over,
  };
}

const PACK = {
  id: "cccccccc-0000-4000-8000-00000000f001",
  name: "4-pack",
  sessions_count: 4,
  price_cents: 30000,
};

describe("the mode is the owner's setting, and the only switch", () => {
  it("has exactly the four modes the issue names", () => {
    expect([...PUBLIC_BOOKING_MODES]).toEqual(["one_time", "recurring", "package", "request_only"]);
    for (const m of PUBLIC_BOOKING_MODES) expect(PUBLIC_BOOKING_MODE_COPY[m].label).toBeTruthy();
  });

  it("defaults a new training service to one visit, a stay to request only, the rest to a plan", () => {
    expect(defaultPublicBookingMode("training", "visit")).toBe("one_time");
    expect(defaultPublicBookingMode("training", "hour")).toBe("one_time");
    expect(defaultPublicBookingMode("pet_sitting", "night")).toBe("request_only");
    expect(defaultPublicBookingMode("dog_walking", "visit")).toBe("recurring");
    expect(defaultPublicBookingMode("pet_waste", "visit")).toBe("recurring");
    expect(defaultPublicBookingMode("mobile_grooming", "visit")).toBe("recurring");
  });

  it("reads unset as request only, and a package with nothing to sell as request only", () => {
    expect(storedPublicBookingMode(null, null)).toBe("request_only");
    expect(storedPublicBookingMode("nonsense", null)).toBe("request_only");
    expect(storedPublicBookingMode("package", null)).toBe("request_only");
    expect(storedPublicBookingMode("package", { ...PACK, price_cents: 0 })).toBe("request_only");
    expect(storedPublicBookingMode("package", PACK)).toBe("package");
    expect(storedPublicBookingMode("one_time", null)).toBe("one_time");
  });

  it("treats a database the column has not reached as the link it was", () => {
    expect(effectivePublicBookingMode(svc())).toBe("recurring");
    expect(effectivePublicBookingMode(svc({ booking_mode: null }))).toBe("request_only");
    expect(effectivePublicBookingMode(svc({ booking_mode: "one_time" }))).toBe("one_time");
  });

  it("never decides by a service's name", () => {
    const sameName = svc({ booking_mode: "recurring" });
    expect(effectivePublicBookingMode(sameName)).toBe("recurring");
    for (const f of [
      "src/lib/public-booking-mode.ts",
      "src/lib/public-booking-mode.server.ts",
      "src/lib/signup.functions.ts",
      "src/components/signup/SignupFlow.tsx",
      "src/routes/api/public/hooks/stripe.ts",
      "src/lib/signup-start-billing.server.ts",
    ]) {
      expect(read(f), f).not.toMatch(/Evaluation/i);
    }
  });
});

describe("the public form", () => {
  it("keeps the mode and the package through publicServiceChoices", () => {
    const [one, pack] = publicServiceChoices(
      [
        { ...svc(), booking_mode: "one_time", package: null },
        {
          ...svc({ id: "e867d1a8-0000-4000-8000-000000000002", name: "Lessons" }),
          booking_mode: "package",
          package: PACK,
        },
      ],
      LIVE,
    );
    expect(one.booking_mode).toBe("one_time");
    expect(pack.booking_mode).toBe("package");
    expect(pack.package).toEqual(PACK);
    // A row from a database without the column carries no mode at all.
    expect(publicServiceChoices([svc()], LIVE)[0]).not.toHaveProperty("booking_mode");
  });

  it("offers no card for request only, and none for a service left unset", () => {
    expect(requestedBecause(svc({ booking_mode: "request_only" }))).toBe("request_only");
    expect(requestedBecause(svc({ booking_mode: null }))).toBe("request_only");
    expect(requestedBecause(svc({ booking_mode: "one_time" }))).toBeNull();
    expect(requestedBecause(svc({ booking_mode: "recurring" }))).toBeNull();
    // A package is priced by the package, so an unpriced service can sell one.
    expect(
      requestedBecause(svc({ base_price_cents: null, booking_mode: "package", package: PACK })),
    ).toBeNull();
    expect(
      decideFormBranch({
        instantStart: true,
        answer: { available: true, quote: {} },
        request: "unpriced",
      }).canStartService,
    ).toBe(false);
  });

  it("says one visit is charged once, with no per-session sentence after today", () => {
    const words = Object.values(ONE_TIME_COPY).join(" ");
    expect(words).not.toMatch(/After today/);
    expect(words).toMatch(/once/);
    expect(PACKAGE_COPY.sessionsTracked(4)).toMatch(/4 sessions/);
    expect(PACKAGE_COPY.chargedTodayLead).toMatch(/Package total/);
  });

  it("writes UI copy without em dashes", () => {
    const words = [
      ...Object.values(ONE_TIME_COPY),
      PACKAGE_COPY.howItWorks(4),
      PACKAGE_COPY.lineLabel("4-pack", 4),
      PACKAGE_COPY.sessionsTracked(1),
      ...Object.values(PUBLIC_BOOKING_MODE_COPY).flatMap((c) => [c.label, c.hint]),
    ].join(" ");
    expect(words).not.toMatch(/—/);
  });

  it("hides the cadence picker unless the service repeats", () => {
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/const repeats = mode === "recurring";/);
    expect(flow).toMatch(/ONE_TIME_COPY\.howItWorks/);
    expect(flow).toMatch(/PACKAGE_COPY\.howItWorks/);
  });

  it("names the charge for what was sold", () => {
    expect(startedChargeDescription("one_time", "Evaluation (45 min)", null)).toBe(
      "Evaluation (45 min), one visit",
    );
    expect(startedChargeDescription("package", "Private lesson", PACK)).toBe(
      "4-pack: Private lesson (4 sessions)",
    );
  });
});

describe("the server charges what the mode says", () => {
  const fn = read("src/lib/signup.functions.ts");

  it("refuses a card for request only before any price is asked", () => {
    for (const handler of ["getSignupQuote", "createSignupPaymentIntent"]) {
      const body = fn.slice(fn.indexOf(`export const ${handler}`));
      const refuse = body.indexOf("refuseRequestOnly(booking)");
      const rpc = body.indexOf('sb.rpc("public_quote"');
      expect(refuse, handler).toBeGreaterThan(0);
      expect(refuse, handler).toBeLessThan(rpc);
    }
  });

  it("prices one visit and a package with no cadence, and a package at its own price", () => {
    expect(fn).toMatch(
      /mode === "recurring" \? data : \(\{ \.\.\.data, frequency: "weekly" \} as T\)/,
    );
    expect(fn).toMatch(/recurring_price_cents: pack\.price_cents/);
    expect(fn).toMatch(/booking_mode: mode,/);
  });
});

describe("the webhook provisions what was charged", () => {
  const hook = read("src/routes/api/public/hooks/stripe.ts");

  it("makes one visit a one_time plan that ends the day it starts", () => {
    expect(hook).toMatch(/frequency: "one_time",[\s\S]{0,400}ends_on: startsOn/);
  });

  it("generates only that plan's visit, never the weekly horizon, for one visit", () => {
    expect(hook).toMatch(/const weeks = groom \|\| mode === "recurring";/);
    expect(hook).toMatch(/if \(weeks\) await generateVisitHorizon/);
    const one = hook.slice(hook.indexOf("    if (oneTimeSubscriptionId) {"));
    expect(one.slice(0, 400)).toMatch(
      /rpc\("generate_visits_core"[\s\S]*_subscription_id: oneTimeSubscriptionId/,
    );
  });

  it("sells a package as a client package and no plan", () => {
    expect(hook).toMatch(/from\("client_packages"\)[\s\S]{0,200}\.insert\(/);
    expect(hook).toMatch(/if \(!groom && mode === "recurring"\) \{\s*\/\/ Create subscription/);
  });

  it("leaves an invoice and a payment for one visit and a package", () => {
    expect(hook).toMatch(/billSignupStart\(/);
    const bill = read("src/lib/signup-start-billing.server.ts");
    expect(bill).toMatch(/from\("invoices"\)/);
    expect(bill).toMatch(/from\("invoice_line_items"\)/);
    expect(bill).toMatch(/from\("payments"\)/);
    expect(bill).toMatch(/status: "paid"/);
    // The one-visit credit is tied to its invoice, and the plain prepay
    // credit is written only for a repeating plan or a groom.
    expect(bill).toMatch(/invoice_id: invoiceId,\s*note:/);
    expect(hook).toMatch(/if \(prepay > 0 && \(groom \|\| mode === "recurring"\)\)/);
  });
});

describe("Settings -> Services", () => {
  const base = {
    name: "Evaluation (45 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 6500,
    extra_pet_cents: 0,
    default_duration_min: 45,
  };

  it("takes the mode, and refuses a package with no package", () => {
    expect(
      parseServiceDraft({ ...base, public_booking_mode: "one_time" }).public_booking_mode,
    ).toBe("one_time");
    expect(() => parseServiceDraft({ ...base, public_booking_mode: "package" })).toThrow(
      /Pick the package/,
    );
    expect(() => parseServiceDraft({ ...base, public_booking_mode: "weekly" })).toThrow();
    // A package id rides only a package.
    expect(
      parseServiceDraft({
        ...base,
        public_booking_mode: "one_time",
        public_package_id: PACK.id,
      }).public_package_id,
    ).toBeNull();
  });

  it("shows the control for every line", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/<BookingModeField form=\{form\} setForm=\{setForm\} \/>/);
    const call = page.indexOf("<BookingModeField");
    // Not inside any line's own block.
    const before = page.slice(Math.max(0, call - 200), call);
    expect(before).not.toMatch(/service_line === "/);
  });
});

describe("the migration", () => {
  const sql = read(
    "supabase/migrations/20261029150000_a-service-says-how-it-is-started-online.sql",
  );

  it("adds the column with the four modes and a default for new rows", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS public_booking_mode text/);
    expect(sql).toMatch(
      /CHECK \(public_booking_mode IN \('one_time', 'recurring', 'package', 'request_only'\)\)/,
    );
    expect(sql).toMatch(/BEFORE INSERT ON public\.services/);
  });

  it("moves existing training services, Riverbend's Evaluation among them, to one visit", () => {
    const backfill = sql.slice(sql.indexOf("UPDATE public.services"));
    expect(backfill).toMatch(/WHEN service_line = 'training' THEN 'one_time'/);
    expect(backfill).toMatch(/WHERE public_booking_mode IS NULL/);
    expect(sql).not.toMatch(/\bname\s*(I?LIKE|=)/i);
  });

  it("is the same default rule the app uses", () => {
    expect(sql).toMatch(/WHEN NEW\.price_unit = 'night' THEN 'request_only'/);
    expect(sql).toMatch(/WHEN NEW\.service_line = 'training' THEN 'one_time'/);
  });
});
