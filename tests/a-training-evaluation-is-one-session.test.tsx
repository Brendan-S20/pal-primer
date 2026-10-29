// A training evaluation is one session (#574).
//
// Brendan, 2026-10-28: the booking link's Start service follows how the
// business configured THAT service, not a hard-coded weekly prepaid plan.
// Riverbend's "Evaluation (45 min)" became an open weekly plan the moment it
// was paid for. services.public_booking_mode is the owner's answer:
// one_time | recurring | package | request_only, set in Settings -> Services.
//
// Pinned here, without a database:
//   A. the field, its default by line, and that nothing reads a NAME
//   B. the form by mode: no cadence and "charged once" for one visit, the
//      package total for a package, no card at all for a request
//   C. the charge by mode, from the server's terms, never the body
//   D. the webhook: one visit and a package never run the org-wide horizon
//      or credit the balance, and write a paid invoice with a payment row
// The SQL half (the backfill, the trigger) is read from the migration file.

import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
import {
  BOOKING_MODE_LABEL,
  PUBLIC_BOOKING_MODES,
  defaultPublicBookingMode,
  effectiveBookingMode,
  noCadenceNote,
  oneTimeChargeSentence,
  packageChargeSentence,
  packageSessionEnd,
  signupBookingMode,
} from "@/lib/public-booking-mode";
import {
  publicServiceChoices,
  requestedBecause,
  withBookingModes,
  type PublicService,
} from "@/lib/public-services";
import { decideFormBranch, normalizeFormConfig } from "@/lib/new-customer-form";
import { signupChargeForTerms, SERVICE_NOT_PRICED } from "@/lib/signup-charge";
import {
  chargedTodayCoversOnce,
  oneVisitLineLabel,
  perVisitBillingSentence,
} from "@/lib/booking-copy";
import { serviceProblem } from "@/lib/services";
import { LAUNCH_DEFAULT } from "./support/service-line-availability";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** A file with its comments taken out: what runs, not what is said about it. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const MIGRATION = "supabase/migrations/20261029150000_a-service-says-how-it-starts-online.sql";
const SLUG = "riverbend";

const EVAL_ID = "00000000-0000-4000-8000-000000000045";
const WALK_ID = "00000000-0000-4000-8000-000000000030";
const PACK_SVC_ID = "00000000-0000-4000-8000-000000000060";
const PACK_ID = "00000000-0000-4000-8000-0000000000a4";

function row(id: string, name: string, line: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    service_line: line,
    price_unit: "visit",
    base_price_cents: 7500,
    extra_pet_cents: 0,
    default_duration_min: 45,
    ...extra,
  };
}

const EVALUATION = row(EVAL_ID, "Evaluation (45 min)", "training", { booking_mode: "one_time" });
const WALK = row(WALK_ID, "30-minute walk", "dog_walking", {
  base_price_cents: 2500,
  default_duration_min: 30,
  booking_mode: "recurring",
});
const FOUR_PACK = row(PACK_SVC_ID, "Private lesson (60 min)", "training", {
  booking_mode: "package",
  package: { id: PACK_ID, name: "4-pack", sessions_count: 4, price_cents: 32000 },
});

function render(services: Record<string, unknown>[]) {
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
    form: normalizeFormConfig({}),
    firstCleanup: { mode: "off", tiers: [] },
    services: publicServiceChoices(services, LAUNCH_DEFAULT),
    serviceLines: LAUNCH_DEFAULT,
    lines: ["dog_walking", "training"],
    extras: { addOns: [], sizePrices: [] },
    contact: { phone: null, email: null },
    serviceArea: null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SignupFlow slug={SLUG} />
    </QueryClientProvider>,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ── A. The field ───────────────────────────────────────────────────────────

describe("A. every bookable service carries an owner-set mode", () => {
  it("has exactly the four modes the acceptance names", () => {
    expect([...PUBLIC_BOOKING_MODES]).toEqual(["one_time", "recurring", "package", "request_only"]);
    for (const m of PUBLIC_BOOKING_MODES) expect(BOOKING_MODE_LABEL[m]).toBeTruthy();
  });

  it("defaults a training service to one visit, a stay to a request, anything else to a plan", () => {
    expect(defaultPublicBookingMode("training", "visit")).toBe("one_time");
    expect(defaultPublicBookingMode("training", "hour")).toBe("one_time");
    expect(defaultPublicBookingMode("pet_sitting", "night")).toBe("request_only");
    expect(defaultPublicBookingMode("dog_walking", "visit")).toBe("recurring");
    expect(defaultPublicBookingMode("pet_waste", "visit")).toBe("recurring");
    expect(defaultPublicBookingMode("mobile_grooming", "visit")).toBe("recurring");
  });

  it("reads an unset mode as a request, never as a plan", () => {
    expect(effectiveBookingMode({ booking_mode: null })).toBe("request_only");
    expect(effectiveBookingMode({ booking_mode: undefined })).toBe("request_only");
    expect(effectiveBookingMode({ booking_mode: "weekly" })).toBe("request_only");
    // A package with nothing to sell takes no card either.
    expect(effectiveBookingMode({ booking_mode: "package", package: null })).toBe("request_only");
    // No service named is the pet-waste signup it always was.
    expect(effectiveBookingMode(null)).toBe("recurring");
  });

  it("the migration adds the column, defaults new rows by line, and backfills by line", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS public_booking_mode text/);
    expect(sql).toMatch(/'one_time', 'recurring', 'package', 'request_only'/);
    expect(sql).toMatch(/WHEN NEW\.service_line = 'training' THEN 'one_time'/);
    expect(sql).toMatch(
      /UPDATE public\.services SET public_booking_mode = 'one_time'\s+WHERE public_booking_mode IS NULL AND service_line = 'training'/,
    );
    // Never overwrites an owner's choice on a replay.
    for (const u of sql.match(/UPDATE public\.services SET public_booking_mode[^;]+;/g) ?? [])
      expect(u).toMatch(/public_booking_mode IS NULL/);
    expect(sql).toMatch(/NOT APPLIED/);
  });

  it("never branches on a service's name", () => {
    const sql = read(MIGRATION).replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/evaluation/i);
    // The only place src/ spells "Evaluation" is the default seed's name.
    const offenders = walk("src").filter(
      (p) => p !== join("src", "lib", "services.ts") && /Evaluation/.test(code(p)),
    );
    expect(offenders).toEqual([]);
    for (const p of [
      "src/lib/public-booking-mode.ts",
      "src/lib/signup.functions.ts",
      "src/routes/api/public/hooks/stripe.ts",
      "src/components/signup/SignupFlow.tsx",
    ])
      expect(read(p)).not.toMatch(/\.name\)?\s*\.?(includes|match|test|startsWith)\(/);
  });

  it("Settings refuses a package with no package, and clears a stale one", () => {
    const base = {
      name: "Private lesson",
      service_line: "training" as const,
      price_unit: "visit" as const,
      base_price_cents: 9000,
      extra_pet_cents: 0,
      default_duration_min: 60,
    };
    expect(serviceProblem({ ...base, public_booking_mode: "package" })).toMatch(/package/i);
    expect(
      serviceProblem({ ...base, public_booking_mode: "package", public_package_id: PACK_ID }),
    ).toBeNull();
    expect(
      serviceProblem({
        ...base,
        service_line: "pet_sitting",
        price_unit: "night",
        default_duration_min: null,
        public_booking_mode: "one_time",
      }),
    ).toMatch(/by request/);
    expect(read("src/lib/services.functions.ts")).toMatch(
      /parsed\.public_booking_mode !== "package"\s+\? \{ public_package_id: null \}/,
    );
  });

  it("Settings shows the mode control for every line and keeps the groom day and time", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/On your booking link/);
    expect(page).toMatch(/Clients still pick a groom day and start time\./);
    expect(page).toMatch(/public_booking_mode: f\.bookingMode/);
  });
});

// ── B. The form by mode ────────────────────────────────────────────────────

describe("B. the public form follows the service's mode", () => {
  it("attaches modes from the service rows, and a package only when it is the service's own and active", () => {
    const listed = publicServiceChoices([EVALUATION, WALK, FOUR_PACK], LAUNCH_DEFAULT).map((s) => ({
      ...s,
      booking_mode: null,
      package: null,
    }));
    const withModes = withBookingModes(
      listed,
      [
        { id: EVAL_ID, public_booking_mode: "one_time", public_package_id: null },
        { id: WALK_ID, public_booking_mode: "recurring", public_package_id: null },
        { id: PACK_SVC_ID, public_booking_mode: "package", public_package_id: PACK_ID },
      ],
      [
        {
          id: PACK_ID,
          service_id: PACK_SVC_ID,
          name: "4-pack",
          sessions_count: 4,
          price_cents: 32000,
          active: true,
        },
      ],
    );
    const by = (id: string) => withModes.find((s) => s.id === id)!;
    expect(effectiveBookingMode(by(EVAL_ID))).toBe("one_time");
    expect(effectiveBookingMode(by(WALK_ID))).toBe("recurring");
    expect(effectiveBookingMode(by(PACK_SVC_ID))).toBe("package");
    expect(by(PACK_SVC_ID).package?.sessions_count).toBe(4);

    const inactive = withBookingModes(
      listed,
      [{ id: PACK_SVC_ID, public_booking_mode: "package", public_package_id: PACK_ID }],
      [
        {
          id: PACK_ID,
          service_id: PACK_SVC_ID,
          name: "4-pack",
          sessions_count: 4,
          price_cents: 32000,
          active: false,
        },
      ],
    );
    expect(effectiveBookingMode(inactive.find((s) => s.id === PACK_SVC_ID)!)).toBe("request_only");
    // A row the lookup did not return is a request.
    expect(effectiveBookingMode(inactive.find((s) => s.id === EVAL_ID)!)).toBe("request_only");
  });

  it("an Evaluation set to one visit has no cadence picker and says it is booked once", () => {
    const html = render([EVALUATION]);
    expect(html).not.toMatch(/>Frequency</);
    expect(html).toContain("One session, booked once.");
    expect(html).toContain("Get instant price");
  });

  it("the same service set to a repeating plan has the line's cadences, as a walk does", () => {
    const html = render([{ ...EVALUATION, booking_mode: "recurring" }]);
    expect(html).toMatch(/>Frequency</);
    expect(html).not.toContain("booked once");
    expect(render([WALK])).toMatch(/>Frequency</);
  });

  it("a package names its sessions where the cadence would be", () => {
    const html = render([FOUR_PACK]);
    expect(html).not.toMatch(/>Frequency</);
    expect(html).toContain("4-pack: 4 sessions.");
  });

  it("a request-only service, or one with no mode, offers a quote request and no price", () => {
    for (const s of [
      { ...EVALUATION, booking_mode: "request_only" },
      { ...EVALUATION, booking_mode: undefined },
    ]) {
      const html = render([s]);
      expect(html).not.toContain("Get instant price");
      expect(html).not.toContain("Start service");
      expect(html).toContain("Request a quote");
      const chosen = publicServiceChoices([s], LAUNCH_DEFAULT)[0] as PublicService;
      expect(requestedBecause(chosen)).toBe("request_only");
      const branch = decideFormBranch({
        instantStart: true,
        answer: { available: true, quote: {} },
        request: "request_only",
      });
      expect(branch.canStartService).toBe(false);
      expect(branch.canRequestQuote).toBe(true);
    }
  });

  it("one visit never promises charges after today; a plan still does", () => {
    const once = `${chargedTodayCoversOnce("training", false)} ${oneTimeChargeSentence("session")}`;
    expect(once).not.toMatch(/After today/);
    expect(once).toMatch(/charged once for this session/);
    expect(oneVisitLineLabel("training")).toBe("One session");
    expect(perVisitBillingSentence("dog_walking", "$25.00")).toMatch(
      /After today, you pay \$25\.00/,
    );
    expect(packageChargeSentence(4, "sessions", "session")).toMatch(/includes 4 sessions/);
    expect(noCadenceNote("one_time", "session", "sessions", null)).toBe(
      "One session, booked once.",
    );
  });

  it("writes no em dash and no filler into the new copy", () => {
    for (const p of ["src/lib/public-booking-mode.ts", "src/lib/booking-copy.ts"]) {
      const src = read(p);
      expect(src).not.toMatch(/—/);
      expect(src).not.toMatch(/seamless|robust|elevate|unlock|delve/i);
    }
  });
});

// ── C. The charge ──────────────────────────────────────────────────────────

describe("C. the charge comes from the server's terms", () => {
  const q = { initial_cleanup_cents: 0, recurring_price_cents: 7500 };

  it("one visit is one session's price; a plan is the first visit, as before", () => {
    expect(signupChargeForTerms(q, { mode: "one_time", pkg: null }).amountCents).toBe(7500);
    expect(signupChargeForTerms(q, { mode: "recurring", pkg: null }).amountCents).toBe(7500);
  });

  it("a package is its price, once, whatever the per-visit quote says", () => {
    const c = signupChargeForTerms(
      { ...q, recurring_price_cents: null },
      { mode: "package", pkg: { price_cents: 32000, sessions_count: 4 } },
    );
    expect(c.amountCents).toBe(32000);
    expect(c.firstCleanupCents).toBe(0);
    expect(c.recurringCents).toBe(8000);
    expect(() => signupChargeForTerms(q, { mode: "package", pkg: null })).toThrow(
      SERVICE_NOT_PRICED,
    );
  });

  it("the quote and the checkout refuse a request-only service and price the rest as one session", () => {
    const src = read("src/lib/signup.functions.ts");
    expect(src.match(/refuseARequestOnlyService\(terms\)/g)?.length).toBe(2);
    expect(src.match(/publicQuoteArgs\(asked\)/g)?.length).toBe(2);
    expect(src).toMatch(
      /booking_mode: terms\.mode,\s+service_package_id: terms\.pkg\?\.id \?\? null/,
    );
    // A mode is read from the service row, never from the body.
    expect(src).not.toMatch(/data\.booking_mode|data\.public_booking_mode/);
  });
});

// ── D. After the card ──────────────────────────────────────────────────────

describe("D. the webhook provisions by mode", () => {
  const hook = read("src/routes/api/public/hooks/stripe.ts");

  it("a signup from before the column is the recurring signup it was sold as", () => {
    expect(signupBookingMode(null)).toBe("recurring");
    expect(signupBookingMode("one_time")).toBe("one_time");
    expect(signupBookingMode("package")).toBe("package");
    expect(signupBookingMode("request_only")).toBe("recurring");
  });

  it("runs the org-wide horizon and the prepaid credit only for a repeating plan", () => {
    expect(hook).toMatch(/if \(mode === "recurring"\) await generateVisitHorizon\(/);
    expect(hook).toMatch(/if \(mode === "recurring" && prepay > 0\)/);
    expect(hook).toMatch(/if \(!groom && mode === "recurring"\) \{/);
  });

  it("books one visit as a bounded one-off and a package as N weekly sessions", () => {
    expect(hook).toMatch(/if \(!groom && mode === "one_time"\)[\s\S]+?bookOneOffVisit\(/);
    expect(hook).toMatch(/client_package_id: cp\.id/);
    expect(hook).toMatch(/ends_on: endsOn/);
    expect(packageSessionEnd("2026-11-02", 4)).toBe("2026-11-23");
    expect(packageSessionEnd("2026-11-02", 1)).toBe("2026-11-02");
  });

  it("leaves a paid invoice and a payment row for one visit and a package", () => {
    const bill = read("src/lib/signup-start-billing.server.ts");
    expect(bill).toMatch(/status: "paid"/);
    expect(bill).toMatch(/from\("payments"\)\.insert/);
    expect(bill).toMatch(/visit_id: l\.visitId \?\? null/);
    expect(hook.match(/billSignupStart\(supabaseAdmin/g)?.length).toBe(2);
  });

  it("books one groom with no repeat, and keeps Book and pay for a plan", () => {
    const fns = read("src/lib/signup.functions.ts");
    expect(fns).toMatch(/every_weeks: once \? null : groomEveryWeeks\(data\.frequency\)/);
    expect(fns).toMatch(/terms\.mode === "one_time",\s+\)/);
  });
});
