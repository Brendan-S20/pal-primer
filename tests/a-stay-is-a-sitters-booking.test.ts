// A stay is a sitter's booking (#411, part 2): the day rules, the visit
// count, the windows, and how the migration and the server keep a stay, its
// plans and its sitter together.
//
// The database half runs in tests/integration/stays.db.test.ts (generation
// counts, the overnight conflict, cancel, RLS).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  addDays,
  arrivalWindowProblem,
  firstTakenNight,
  lastVisitDay,
  overnightConflictSentence,
  stayDatesLabel,
  stayDatesProblem,
  stayDays,
  stayKindFor,
  stayPlanWindows,
  stayVisitCount,
  stayVisitPriceCents,
  stayWindowsProblem,
  visitCountSentence,
  visitStayDates,
  DEFAULT_OVERNIGHT_ARRIVAL,
} from "@/lib/stays";
import { walkWindowsProblem } from "@/lib/subscription-form";
import { readWalkGroupAssignments } from "@/lib/walk-group-routing.server";
import { walkDay } from "./support/walk-day";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261016120000_a-stay-is-a-sitters-booking.sql");
const code = sql.replace(/--[^\n]*/g, "");

// 2026-10-19 is a Monday.
const MON = "2026-10-19";
const FRI = "2026-10-23";
const SAT = "2026-10-24";
const morning = { earliestTime: "08:00", latestTime: "10:00" };
const evening = { earliestTime: "17:00", latestTime: "19:00" };

describe("the days a stay has visits on", () => {
  it("drop-ins Monday to Friday with two windows are ten visits", () => {
    expect(stayDays("drop_in", MON, FRI)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(stayVisitCount("drop_in", MON, FRI, 2)).toBe(10);
    expect(visitCountSentence(10)).toBe("This creates 10 visits.");
  });

  it("overnights Monday to Saturday are five nights: Saturday is checkout", () => {
    expect(stayDays("overnight", MON, SAT)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(stayVisitCount("overnight", MON, SAT, 0)).toBe(5);
    expect(lastVisitDay("overnight", MON, SAT)).toBe(FRI);
    expect(lastVisitDay("drop_in", MON, SAT)).toBe(SAT);
  });

  it("a one-day drop-in is one day; an overnight needs a checkout after check-in", () => {
    expect(stayVisitCount("drop_in", MON, MON, 1)).toBe(1);
    expect(visitCountSentence(1)).toBe("This creates 1 visit.");
    expect(stayDays("overnight", MON, MON)).toEqual([]);
    expect(stayDatesProblem("overnight", MON, MON)).toMatch(/at least one day after check-in/);
    expect(stayDatesProblem("drop_in", FRI, MON)).toMatch(/can't be before/);
    expect(stayDatesProblem("drop_in", MON, MON)).toBeNull();
    expect(stayDatesProblem("overnight", "", "")).toMatch(/check-in and check-out/);
    expect(stayDatesProblem("drop_in", MON, addDays(MON, 91))).toMatch(/up to 90 days/);
  });

  it("crosses a month and a daylight-saving change without losing a day", () => {
    expect(stayDays("drop_in", "2026-10-30", "2026-11-02")).toHaveLength(4);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("the windows", () => {
  it("allows one to four distinct drop-in windows", () => {
    expect(stayWindowsProblem([morning])).toBeNull();
    expect(stayWindowsProblem([morning, evening])).toBeNull();
    expect(stayWindowsProblem([])).toMatch(/1 and 4 drop-in times/);
    expect(
      stayWindowsProblem(
        Array.from({ length: 5 }, (_, i) => ({ earliestTime: `0${i}:00`, latestTime: `0${i}:30` })),
      ),
    ).toMatch(/1 and 4/);
    expect(stayWindowsProblem([morning, morning])).toMatch(/different arrival window/);
    expect(stayWindowsProblem([{ earliestTime: "10:00", latestTime: "08:00" }])).toMatch(/before/);
    expect(stayWindowsProblem([{ earliestTime: "", latestTime: "08:00" }])).toMatch(
      /earliest and latest/,
    );
  });

  it("walk times keep the words and the limit they had", () => {
    expect(walkWindowsProblem([])).toBe("Choose between 1 and 6 walk times.");
    expect(walkWindowsProblem([morning, morning])).toBe(
      "Each walk time must have a different arrival window.",
    );
  });

  it("an overnight has one arrival window, 7 PM to 9 PM unless set", () => {
    expect(DEFAULT_OVERNIGHT_ARRIVAL).toEqual({ earliestTime: "19:00", latestTime: "21:00" });
    expect(arrivalWindowProblem(DEFAULT_OVERNIGHT_ARRIVAL)).toBeNull();
    expect(arrivalWindowProblem({ earliestTime: "21:00", latestTime: "19:00" })).toMatch(/before/);
    expect(stayPlanWindows("overnight", [morning, evening])).toEqual([DEFAULT_OVERNIGHT_ARRIVAL]);
    expect(stayPlanWindows("drop_in", [evening, morning])).toEqual([morning, evening]);
  });
});

describe("kind, price and the sentences", () => {
  it("a service priced per night is an overnight", () => {
    expect(stayKindFor("night")).toBe("overnight");
    expect(stayKindFor("visit")).toBe("drop_in");
    expect(stayKindFor("hour")).toBe("drop_in");
    expect(stayKindFor(null)).toBe("drop_in");
  });

  it("prices one visit for the pets on the stay, one night at a time", () => {
    const night = { price_unit: "night", base_price_cents: 6000, extra_pet_cents: 1000, default_duration_min: null } as const;
    expect(stayVisitPriceCents(night, 1)).toBe(6000);
    expect(stayVisitPriceCents(night, 3)).toBe(8000);
    expect(stayVisitPriceCents(night, 0)).toBe(6000);
    const dropIn = { price_unit: "visit", base_price_cents: 2500, extra_pet_cents: 0, default_duration_min: 30 } as const;
    expect(stayVisitPriceCents(dropIn, 2)).toBe(2500);
    expect(stayVisitPriceCents({ ...dropIn, base_price_cents: null }, 2)).toBeNull();
  });

  it("names the night a sitter is already booked, the way the database does", () => {
    expect(overnightConflictSentence("Sam", "2026-10-19")).toBe(
      "Sam already has an overnight stay on the night of Monday, October 19, 2026.",
    );
    expect(overnightConflictSentence(null, "2026-10-19")).toMatch(/^This sitter already has/);
    expect(firstTakenNight([MON, "2026-10-20"], ["2026-10-20", "2026-10-25"])).toBe("2026-10-20");
    expect(firstTakenNight([MON], [])).toBeNull();
    // The database's sentence is built from the same parts.
    expect(code).toMatch(/'% already has an overnight stay on the night of %\.'/);
    expect(code).toMatch(/to_char\(NEW\.scheduled_on, 'FMDay, FMMonth FMDD, YYYY'\)/);
  });

  it("labels a stay's dates, and a visit that is not part of a stay has none", () => {
    expect(stayDatesLabel("drop_in", MON, FRI)).toBe("Oct 19 to Oct 23");
    expect(stayDatesLabel("drop_in", MON, MON)).toBe("Oct 19");
    expect(stayDatesLabel("overnight", MON, SAT)).toBe("Check-in Oct 19, check-out Oct 24");
    expect(visitStayDates({ kind: "overnight", starts_on: MON, ends_on: SAT })).toBe(
      "Check-in Oct 19, check-out Oct 24",
    );
    expect(visitStayDates(null)).toBeNull();
    expect(visitStayDates(undefined)).toBeNull();
  });
});

describe("the migration", () => {
  it("creates stays with the columns and rules the booking needs", () => {
    for (const col of [
      "organization_id uuid NOT NULL",
      "client_id uuid NOT NULL",
      "property_id uuid NOT NULL",
      "service_id uuid NOT NULL",
      "starts_on date NOT NULL",
      "ends_on date NOT NULL",
      "drop_in_windows jsonb",
      "overnight_arrival_earliest time",
      "overnight_arrival_latest time",
      "pet_ids uuid[] NOT NULL DEFAULT '{}'",
      "assigned_staff_id uuid",
      "status text NOT NULL DEFAULT 'confirmed'",
      "deposit_cents integer",
      "care_snapshot jsonb",
      "created_by uuid DEFAULT auth.uid()",
    ])
      expect(code, col).toContain(col);
    expect(code).toMatch(/CHECK \(kind IN \('drop_in', 'overnight'\)\)/);
    expect(code).toMatch(/CHECK \(status IN \('requested', 'confirmed', 'canceled', 'completed'\)\)/);
    expect(code).toMatch(/CHECK \(ends_on >= starts_on\)/);
    expect(code).toMatch(/CHECK \(kind <> 'overnight' OR ends_on > starts_on\)/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS stays_org_starts_idx ON public\.stays\(organization_id, starts_on\)/);
    // US spelling (#469).
    expect(sql).not.toMatch(/cancelled/i);
  });

  it("derives kind from the service and requires a pet sitting service of the same business", () => {
    const fn = code.slice(code.indexOf("FUNCTION public.tg_stays_validate"));
    expect(fn).toMatch(/_line IS DISTINCT FROM 'pet_sitting'/);
    expect(fn).toMatch(/_svc_org IS DISTINCT FROM NEW\.organization_id/);
    expect(fn).toMatch(/NEW\.kind := CASE WHEN _unit = 'night' THEN 'overnight' ELSE 'drop_in' END/);
    expect(fn).toMatch(/COALESCE\(NEW\.overnight_arrival_earliest, '19:00'::time\)/);
    expect(fn).toMatch(/COALESCE\(NEW\.overnight_arrival_latest, '21:00'::time\)/);
  });

  it("locks stays down: RLS, two-step, office writes, no anon", () => {
    expect(code).toMatch(/ALTER TABLE public\.stays ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/SELECT public\.require_mfa_policy\('public\.stays'\)/);
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.stays FROM PUBLIC, anon/);
    const policies = (code.match(/CREATE POLICY[\s\S]*?;/g) ?? []).filter((p) =>
      /ON public\.stays\b/.test(p),
    );
    expect(policies).toHaveLength(4);
    for (const p of policies.filter((p) => !/FOR SELECT/.test(p)))
      expect(p).toMatch(/can_write_org\(\(SELECT auth\.uid\(\)\), organization_id\)/);
    expect(policies.find((p) => /FOR SELECT/.test(p))).toMatch(/is_org_member/);
  });

  it("links plans to their stay and refuses a plan that does not match it", () => {
    expect(code).toMatch(
      /ADD COLUMN IF NOT EXISTS stay_id uuid REFERENCES public\.stays\(id\) ON DELETE CASCADE/,
    );
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS subscriptions_stay_idx ON public\.subscriptions\(stay_id\)/);
    expect(code).toMatch(/WHEN \(NEW\.stay_id IS NOT NULL\)\s+EXECUTE FUNCTION public\.tg_subscriptions_stay\(\)/);
  });

  it("splices one stay branch into the generator, before the weekday branch, with no hold or blackout skip", () => {
    expect(code).toMatch(/pg_get_functiondef\('public\.generate_visits_core\(uuid, date, uuid\)'::regprocedure\)/);
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.generate_visits_core/);
    const branch = sql.slice(sql.indexOf("$branch$"), sql.lastIndexOf("$branch$"));
    expect(branch).toMatch(/IF _sub\.stay_id IS NOT NULL THEN/);
    expect(branch).not.toMatch(/blackout_dates|client_holds/);
    expect(branch).toMatch(/rescheduled_from = _candidate/);
    // Not the target 20261010010000 counts, so re-applying that file in a
    // proof still finds exactly four.
    expect(branch).toMatch(/ON CONFLICT DO NOTHING;/);
    expect(branch).not.toMatch(/ON CONFLICT \(subscription_id, scheduled_on\)/);
    expect(code).toMatch(/_branch_at\s+CONSTANT text := '-- weekday set \(subscriptions\.weekdays, 0 = Sunday\)/);
    expect(code).toMatch(/the stay branch must come before the weekday branch/);
  });

  it("gives a stay visit the stay's sitter and refuses a second overnight on one night", () => {
    const fn = code.slice(
      code.indexOf("FUNCTION public.tg_visits_stay_sitter"),
      code.indexOf("DROP TRIGGER IF EXISTS visits_stay_sitter"),
    );
    expect(fn).toMatch(/TG_OP = 'INSERT' AND NEW\.assigned_staff_id IS NULL/);
    expect(fn).toMatch(/NEW\.assigned_staff_id := _stay\.assigned_staff_id/);
    expect(fn).toMatch(/pg_advisory_xact_lock/);
    expect(fn).toMatch(/st\.kind = 'overnight'/);
    expect(fn).toMatch(/v\.status NOT IN \('canceled', 'skipped', 'missed'\)/);
    expect(code).toMatch(
      /BEFORE INSERT OR UPDATE OF assigned_staff_id, scheduled_on, status, subscription_id\s+ON public\.visits/,
    );
  });

  it("cancels a stay's future visits and ends its plans; a new sitter takes its future visits", () => {
    const fn = code.slice(code.indexOf("FUNCTION public.tg_stays_follow"));
    expect(fn).toMatch(/SET status = 'canceled'[\s\S]*?v\.status = 'scheduled'[\s\S]*?v\.scheduled_on >= _today/);
    expect(fn).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.invoice_line_items li WHERE li\.visit_id = v\.id\)/);
    expect(fn).toMatch(/UPDATE public\.subscriptions s\s+SET status = 'canceled'/);
    expect(fn).toMatch(/SET assigned_staff_id = NEW\.assigned_staff_id, sequence = NULL/);
  });

  it("revokes every trigger function and pins its search_path", () => {
    for (const name of [
      "tg_stays_validate",
      "tg_subscriptions_stay",
      "tg_visits_stay_sitter",
      "tg_stays_follow",
    ]) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(\\) FROM PUBLIC, anon, authenticated`));
      const def = code.slice(code.indexOf(`FUNCTION public.${name}()`));
      expect(def.slice(0, 200), name).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    }
  });

  it("ends by checking what it established", () => {
    const tail = code.slice(code.lastIndexOf("DO $check$"));
    expect(tail).toMatch(/public\.stays is missing/);
    expect(tail).toMatch(/subscriptions\.stay_id is missing/);
    expect(tail).toMatch(/a stay trigger is missing or disabled/);
    expect(tail).toMatch(/stay_windows_are_valid does not hold the rule/);
    expect(tail).toMatch(/generate_visits_core does not read stays/);
  });
});

describe("the server", () => {
  const fns = read("src/lib/stays.functions.ts");

  it("books a stay through the plan path #468's walk times use", () => {
    expect(fns).toMatch(/requirePermission\(supabase, context\.userId, "manage_pricing"\)/);
    expect(fns).toMatch(/createSubscriptionPlans\(supabase, context\.userId, plans, "pet_sitting", stayId\)/);
    expect(fns).toMatch(/weekdays: \[\.\.\.EVERY_DAY\]/);
    expect(fns).toMatch(/generate_visits_for_subscription/);
    // A failed plan write takes the stay with it.
    expect(fns).toMatch(/from\("stays"\)\.delete\(\)\.eq\("id", stayId\)/);
    expect(fns).toMatch(/care_snapshot: await careSnapshot\(supabase, petIds\)/);
  });

  it("checks the sitter's nights before it writes, and asks the database's own office check", () => {
    expect(fns).toMatch(/await refuseOvernightConflict\(supabase, orgId, data\.sitterId, days, null\)/);
    expect(fns).toMatch(/rpc\("can_write_org"/);
  });

  it("a stay's plan carries the stay", () => {
    const shared = read("src/lib/subscriptions.functions.ts");
    expect(shared).toMatch(/\.\.\.\(stayId \? \{ stay_id: stayId \} : \{\}\)/);
    expect(shared).toContain('"Choose a pet sitting service."');
    expect(shared).toMatch(/services\(name, service_line\), stay_id/);
  });

  it("stay plans are not the property's routine service", () => {
    expect(read("src/lib/estimate.server.ts")).toMatch(/\.is\("stay_id", null\)/);
    expect(read("src/components/client-detail/ServicesTab.tsx")).toMatch(
      /allSubscriptions\.filter\(\(s: any\) => !s\.stay_id\)/,
    );
  });
});

describe("routing keeps a stay with its sitter", () => {
  it("pins stay visits to the stay's sitter in the same single read as group walks", async () => {
    const calls: unknown[][] = [];
    const query = {
      select: (columns: string) => {
        calls.push(["select", columns]);
        return query;
      },
      eq: () => query,
      in: async () => ({
        data: [
          { id: "walk-0", walk_group_id: null, subscriptions: { stay_id: "stay-1", stays: { assigned_staff_id: "sitter-a" } } },
          { id: "walk-1", walk_group_id: null, subscriptions: { stay_id: null, stays: null } },
        ],
        error: null,
      }),
    };
    const client = {
      from: (table: string) => {
        calls.push(["from", table]);
        return query;
      },
    } as unknown as SupabaseClient<Database>;
    const pinned = await readWalkGroupAssignments(client, "org-a", walkDay());
    expect(calls.filter((c) => c[0] === "from")).toHaveLength(1);
    expect(String(calls.find((c) => c[0] === "select")?.[1])).toMatch(/stays\(assigned_staff_id\)/);
    expect(pinned.visits[0].fixed).toBe(true);
    expect(pinned.visits[0].assigned_staff_id).toBe("sitter-a");
    expect(pinned.visits[1].fixed).toBe(false);
  });
});
