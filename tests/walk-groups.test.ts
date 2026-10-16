import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { dogsOnWalk } from "@/lib/walk-groups";
import { serviceProblem, type ServiceDraft } from "@/lib/services";
import {
  buildDay,
  collapseWalkGroups,
  GROUP_PICKUP_MIN,
  pinWalkGroupVisits,
  planDay,
  type RouteDayInputs,
} from "@/lib/route-inputs";
import { routeClock } from "@/lib/route-solver";
import { readWalkGroupAssignments } from "@/lib/walk-group-routing.server";
import { walkDay } from "./support/walk-day";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const sql = read("supabase/migrations/20261015200000_a-walk-can-be-a-group-walk.sql");
const draft: ServiceDraft = {
  name: "Group walk",
  service_line: "dog_walking",
  price_unit: "visit",
  base_price_cents: 2000,
  extra_pet_cents: 0,
  default_duration_min: 30,
};

describe("group walk rules", () => {
  it("counts plan dogs first, then active property dogs, with a floor of one", () => {
    expect(dogsOnWalk(2, 3)).toBe(2);
    expect(dogsOnWalk(null, 3)).toBe(3);
    expect(dogsOnWalk(undefined, 0)).toBe(1);
    expect(dogsOnWalk(0, 2)).toBe(1);
  });

  it("allows group sizes 1 to 50 only on walking services", () => {
    for (const max_dogs of [null, 1, 2, 50])
      expect(serviceProblem({ ...draft, max_dogs })).toBeNull();
    for (const max_dogs of [0, 51, 1.5, Number.NaN])
      expect(serviceProblem({ ...draft, max_dogs })).toMatch(/1 to 50 dogs/);
    expect(serviceProblem({ ...draft, service_line: "pet_waste", max_dogs: 2 })).toMatch(
      /dog walking/,
    );
    expect(serviceProblem({ ...draft, service_line: "pet_waste", max_dogs: null })).toBeNull();
  });

  it("serializes joins, counts the incoming row and excludes its old copy", () => {
    expect(sql).toMatch(/SELECT \* INTO _group[\s\S]*?FOR UPDATE;/);
    expect(sql).toMatch(/LANGUAGE sql STABLE SET search_path/);
    expect(sql).toContain("sum(public.walk_dogs_on_visit(v.id))");
    expect(sql).toContain("v.id <> NEW.id");
    expect(sql).toContain("+ _dogs INTO _total");
    expect(sql).toContain("IF _total > _capacity THEN");
    expect(sql).toContain("This group walk is full: % of % dogs.");
    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE OF walk_group_id, scheduled_on, service_id, subscription_id/,
    );
    expect(sql).toContain("NEW.status IN ('canceled', 'skipped', 'completed')");
    expect(sql).toContain("That walk is on another day or for another service.");
  });

  it("refuses active aggressive dogs across different clients in either direction", () => {
    expect(sql).toContain("v.client_id <> NEW.client_id");
    expect(sql).toMatch(
      /d.property_id = NEW.property_id\s+AND d.active AND d.temperament = 'aggressive'/,
    );
    expect(sql).toMatch(
      /d.property_id = v.property_id\s+AND d.active AND d.temperament = 'aggressive'/,
    );
    expect(sql).toContain("A dog marked aggressive walks alone. Book a solo walk instead.");
  });

  it("uses a separate tech guard and copies walkers only to scheduled members", () => {
    expect(sql).toContain("auth.uid() IS NOT NULL");
    expect(sql).toContain("NOT public.can_write_org(auth.uid(), OLD.organization_id)");
    expect(sql).toContain("NEW.walk_group_id IS DISTINCT FROM OLD.walk_group_id");
    expect(sql).toContain("ERRCODE = 'insufficient_privilege'");
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.visits_guard_privileged_columns");
    expect(sql).toContain("AFTER UPDATE OF assigned_staff_id ON public.walk_groups");
    expect(sql).toContain("WHERE walk_group_id = NEW.id AND status = 'scheduled'");
    expect(sql).toContain("NEW.assigned_staff_id := _group.assigned_staff_id");
  });

  it("checks group service, tenancy, window and schema security on a fresh replay", () => {
    expect(sql).toContain("max_dogs BETWEEN 1 AND 50 AND service_line = 'dog_walking'");
    expect(sql).toContain("s.organization_id = NEW.organization_id");
    expect(sql).toContain(
      "Choose a group walk service. Set its group size in Settings > Services.",
    );
    expect(sql).toContain("earliest_time < latest_time");
    expect(sql).toContain("char_length(notes) <= 500");
    expect(sql).toContain("ALTER TABLE public.walk_groups ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("SELECT public.require_mfa_policy('public.walk_groups')");
    expect(sql).toContain("is_org_member((SELECT auth.uid()), organization_id)");
    for (const operation of ["INSERT", "UPDATE", "DELETE"])
      expect(sql).toMatch(new RegExp(`FOR ${operation} TO authenticated`));
    expect(sql).toContain("REVOKE ALL ON TABLE public.walk_groups FROM PUBLIC, anon");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.walk_dogs_on_visit(uuid) FROM PUBLIC, anon",
    );
    expect(sql).toContain("DO $check$");
    expect(sql).toContain("permissive = 'RESTRICTIVE'");
    expect(sql).toContain("has_table_privilege('anon', 'public.walk_groups'");
    expect(sql).not.toContain("pg_get_functiondef");
  });
});

describe("group walker routing", () => {
  it("pins both member visits to their group walker despite reassignment or skills", () => {
    const inputs = walkDay();
    inputs.techs.push({ ...inputs.techs[0], id: "walker-b", services: ["another-service"] });
    const pinned = pinWalkGroupVisits(
      inputs,
      inputs.visits.map((visit) => ({ id: visit.id, walkerId: "walker-b" })),
    );
    expect(inputs.visits.every((visit) => !visit.fixed)).toBe(true);
    expect(
      pinned.visits.every((visit) => visit.fixed && visit.assigned_staff_id === "walker-b"),
    ).toBe(true);
    const built = buildDay(pinned, { day: "2026-10-19", honourWindows: true });
    expect(built.problem.stops.map((stop) => stop.fixedTech)).toEqual([1, 1]);
    const plan = planDay(pinned, {
      day: "2026-10-19",
      honourWindows: true,
      solver: { rounds: 20, now: () => 0 },
    });
    expect(plan.unassigned).toEqual([]);
    expect(plan.routes.find((route) => route.staff_id === "walker-b")?.visit_ids).toEqual([
      "walk-0",
      "walk-1",
    ]);
    expect(plan.routes.find((route) => route.staff_id === "walker-a")?.visit_ids ?? []).toEqual([]);
  });

  it("leaves solo visits and groups without a walker unchanged", () => {
    const inputs = walkDay();
    expect(pinWalkGroupVisits(inputs, [])).toEqual(inputs);
    expect(pinWalkGroupVisits(inputs, [{ id: "walk-0", walkerId: null }])).toEqual(inputs);
  });

  it("does not give members to a different walker when their group walker is absent", () => {
    const inputs = walkDay();
    const pinned = pinWalkGroupVisits(
      inputs,
      inputs.visits.map((visit) => ({ id: visit.id, walkerId: "absent" })),
    );
    const plan = planDay(pinned, {
      day: "2026-10-19",
      honourWindows: true,
      solver: { rounds: 5, now: () => 0 },
    });
    expect(plan.routes.flatMap((route) => route.visit_ids)).toEqual([]);
    expect(plan.unassigned.map((visit) => visit.reason)).toEqual([
      "no_eligible_tech",
      "no_eligible_tech",
    ]);
  });

  it("reads group assignment once for the day's visit IDs and fails on read errors", async () => {
    const calls: unknown[][] = [];
    let error: { message: string } | null = null;
    const query = {
      select: (columns: string) => {
        calls.push(["select", columns]);
        return query;
      },
      eq: (column: string, value: string) => {
        calls.push(["eq", column, value]);
        return query;
      },
      in: (column: string, values: string[]) => {
        calls.push(["in", column, values]);
        return query;
      },
      not: async () => ({
        data: [
          {
            id: "walk-0",
            walk_group_id: "group-a",
            walk_groups: {
              id: "group-a",
              assigned_staff_id: "walker-a",
              earliest_time: "09:00:00",
              latest_time: "10:00:00",
            },
          },
        ],
        error,
      }),
    };
    const client = {
      from: (table: string) => {
        calls.push(["from", table]);
        return query;
      },
    } as unknown as SupabaseClient<Database>;
    const pinned = await readWalkGroupAssignments(client, "org-a", walkDay());
    expect(calls.filter((call) => call[0] === "from")).toHaveLength(1);
    expect(calls).toContainEqual(["eq", "organization_id", "org-a"]);
    expect(calls).toContainEqual(["in", "id", ["walk-0", "walk-1"]]);
    expect(pinned.visits[0].fixed).toBe(true);
    expect(pinned.visits[0].walk_group).toEqual({
      id: "group-a",
      earliest: "09:00",
      latest: "10:00",
    });
    expect(pinned.visits[1].fixed).toBe(false);
    expect(pinned.visits[1].walk_group).toBeUndefined();
    error = { message: "read failed" };
    await expect(readWalkGroupAssignments(client, "org-a", walkDay())).rejects.toThrow(
      "read failed",
    );
    expect(read("src/lib/route-plan.server.ts")).toMatch(
      /await readWalkGroupAssignments\(\s*supabase,\s*args\.orgId/,
    );
    expect(read("src/lib/auto-routing.server.ts")).toContain("planDayRoutes(");
  });
});

/** Four dogs on one 60-minute group walk, doors about 110 m apart, with
 *  their own plan windows in the afternoon and the group's in the morning. */
function fourDogGroup(walkerId: string | null): RouteDayInputs {
  const day = walkDay();
  day.techs.push({ ...day.techs[0], id: "walker-b" });
  day.visits = [0, 1, 2, 3].map((i) => ({
    ...day.visits[0],
    id: `dog-${i}`,
    lat: 30.001 + i * 0.001,
    lon: -97.001,
    service_min: 60,
    earliest: "15:00",
    latest: "17:00",
    client: `Client ${i}`,
  }));
  return pinWalkGroupVisits(
    day,
    day.visits.map((visit) => ({
      id: visit.id,
      walkerId,
      groupId: "group-a",
      earliest: "09:00:00",
      latest: "10:00:00",
    })),
  );
}

const DAY = "2026-10-19";
const SOLVER = { rounds: 20, seed: 7, now: () => 0 };

describe("a group walk is planned as one walk", () => {
  it("plans four dogs on a 60 minute walk at about 60 minutes plus pickups and travel", () => {
    const inputs = fourDogGroup("walker-b");
    const { inputs: collapsed, members } = collapseWalkGroups(inputs);
    expect(collapsed.visits.map((visit) => visit.id)).toEqual(["dog-0"]);
    expect(members.get("dog-0")).toEqual(["dog-0", "dog-1", "dog-2", "dog-3"]);
    const stop = collapsed.visits[0];
    // The walk once, a pickup at each door, and the drive between the doors
    // out and back: each leg here is park-and-walk plus a few seconds.
    expect(stop.service_min).toBeGreaterThan(60 + 4 * GROUP_PICKUP_MIN);
    expect(stop.service_min).toBeLessThan(100);

    const plan = planDay(inputs, { day: DAY, honourWindows: true, solver: SOLVER });
    expect(plan.unassigned).toEqual([]);
    const walker = plan.routes.find((route) => route.staff_id === "walker-b")!;
    expect(walker.visit_ids).toEqual(["dog-0", "dog-1", "dog-2", "dog-3"]);
    expect(plan.routes.find((route) => route.staff_id === "walker-a")?.visit_ids ?? []).toEqual(
      [],
    );
    const day = plan.solution.costs[1];
    expect(day.service).toBeCloseTo(stop.service_min, 5);
    expect(day.load).toBeGreaterThan(60 + 4 * GROUP_PICKUP_MIN);
    expect(day.load).toBeLessThan(110);
    expect(day.load).toBeLessThan(240 / 2);
  });

  it("applies the group's window to every member, in place of their own", () => {
    const inputs = fourDogGroup("walker-b");
    const { inputs: collapsed } = collapseWalkGroups(inputs);
    expect([collapsed.visits[0].earliest, collapsed.visits[0].latest]).toEqual(["09:00", "10:00"]);
    const built = buildDay(collapsed, { day: DAY, honourWindows: true });
    // Minutes after the 08:00 workday start.
    expect([built.problem.stops[0].earliest, built.problem.stops[0].latest]).toEqual([60, 120]);
    expect(routeClock(built.problem, 1, [0]).late).toEqual([]);

    // A window nobody can keep names all four dogs, each under the group window.
    const tight = fourDogGroup("walker-b");
    for (const visit of tight.visits)
      visit.walk_group = { id: "group-a", earliest: "08:00", latest: "08:01" };
    const missed = planDay(tight, { day: DAY, honourWindows: true, solver: SOLVER });
    expect(missed.routes.flatMap((route) => route.visit_ids)).toEqual([]);
    expect(
      missed.unassigned.map((visit) => [visit.visit_id, visit.client, visit.earliest, visit.latest]),
    ).toEqual([
      ["dog-0", "Client 0", "08:00", "08:01"],
      ["dog-1", "Client 1", "08:00", "08:01"],
      ["dog-2", "Client 2", "08:00", "08:01"],
      ["dog-3", "Client 3", "08:00", "08:01"],
    ]);
  });

  it("still plans one walk when the group has no walker, on whoever takes it", () => {
    const plan = planDay(fourDogGroup(null), { day: DAY, honourWindows: true, solver: SOLVER });
    expect(plan.unassigned).toEqual([]);
    const taken = plan.routes.filter((route) => route.visit_ids.length > 0);
    expect(taken).toHaveLength(1);
    expect(taken[0].visit_ids).toEqual(["dog-0", "dog-1", "dog-2", "dog-3"]);
  });

  it("plans a group with one visit in play as a solo walk", () => {
    const inputs = fourDogGroup("walker-b");
    inputs.visits = inputs.visits.slice(0, 1);
    const { inputs: collapsed, members } = collapseWalkGroups(inputs);
    expect(members.size).toBe(0);
    expect(collapsed.visits[0].service_min).toBe(60);
    expect(collapsed.visits[0].earliest).toBe("15:00");
  });

  it("times the group the same way when the plan is saved", () => {
    expect(sql).toContain(`_pickup_min CONSTANT integer := ${GROUP_PICKUP_MIN};`);
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.apply_route_plan(");
    expect(sql).toContain("LEFT JOIN _arp_grp gm ON gm.vid = a.vid");
    expect(sql).toContain(
      "COALESCE(gm.svc, public.stop_service_min(sv.default_duration_min, p.service_duration_min))",
    );
    expect(sql).toContain("_cur_lat := _r.resume_lat; _cur_lon := _r.resume_lon;");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.apply_route_plan(uuid, uuid[], date, boolean, jsonb, boolean, uuid[]) TO authenticated, service_role;",
    );
  });
});

describe("a member that changes leaves its group", () => {
  it("detaches on a move or a skip, and counts only walks still to happen", () => {
    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE OF walk_group_id, scheduled_on, service_id, subscription_id, status, organization_id/,
    );
    expect(sql).toContain("_kept := NEW.walk_group_id IS NOT DISTINCT FROM OLD.walk_group_id;");
    expect(sql).toMatch(/IF NEW.status IN \('skipped', 'canceled'\) THEN\s+NEW.walk_group_id := NULL;/);
    expect(sql.match(/AND v.status IN \('scheduled', 'in_progress'\)/g)).toHaveLength(2);
    expect(sql).toContain("IF NOT _kept AND _group.assigned_staff_id IS NOT NULL THEN");
  });
});

describe("office group controls", () => {
  it("shows the panel only for walking orgs with an active group service", () => {
    const ui = read("src/components/routes/GroupWalksPanel.tsx");
    expect(ui).toContain('known && lines.includes("dog_walking")');
    expect(ui).toContain(
      'service.active && service.service_line === "dog_walking" && service.max_dogs != null',
    );
    expect(ui).toContain("if (!walking || groupServices.length === 0) return null");
    expect(ui).toContain("toast.error(error.message)");
    expect(ui).toContain("sm:grid-cols-2 lg:grid-cols-4");
    expect(ui).toContain("min-h-11");
    const settings = read("src/routes/_authenticated/settings.services.tsx");
    expect(settings).toContain('{form.service_line === "dog_walking" && (');
    expect(settings).toContain("Group walk, up to {s.max_dogs} dogs");
  });

  it("uses dispatch's existing permission and limits membership writes to scheduled visits", () => {
    const server = read("src/lib/walk-groups.functions.ts");
    expect(server).toContain('rpc("can_write_org", { _user_id: userId, _org_id: orgId })');
    expect(server.match(/await requireWalkGroupOffice\(/g)).toHaveLength(4);
    expect(server).toContain('.eq("status", "scheduled")');
    expect(server).toContain("throw new Error(error.message)");
  });
});
