import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { dogsOnWalk } from "@/lib/walk-groups";
import { serviceProblem, type ServiceDraft } from "@/lib/services";
import { buildDay, pinWalkGroupVisits, planDay } from "@/lib/route-inputs";
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
        data: [{ id: "walk-0", walk_groups: { assigned_staff_id: "walker-a" } }],
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
    expect(pinned.visits[1].fixed).toBe(false);
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
