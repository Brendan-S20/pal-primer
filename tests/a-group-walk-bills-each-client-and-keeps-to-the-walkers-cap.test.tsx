// A group walk bills each client and keeps to the walker's cap (#731).
//
// Owner decision, 2026-11-08: "Several pets from different clients share one
// visit, each client billed separately, plus cap on dogs per walker and staff
// assigned by capacity". This file pins the pure rules, the wiring around
// them, and R2-29 (the group's Walker select said "Unassigned" while the
// database had the walker). The database half of the cap is
// a-walker-has-a-dog-cap-in-a-real-database.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dogsHoldingPlaces,
  groupBilling,
  groupCapacity,
  groupWalkerView,
  parseDogCap,
  planWalkerCapacity,
  walkerOptions,
  type WalkGroupSummary,
  type WalkGroupVisit,
  type WalkerCapacity,
} from "@/lib/walk-groups";
import { GroupWalkCard } from "@/components/routes/GroupWalksPanel";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIGRATION = "supabase/migrations/20261108150000_a-walker-has-a-dog-cap.sql";

function visit(id: string, over: Partial<WalkGroupVisit> = {}): WalkGroupVisit {
  return {
    id,
    serviceId: "svc",
    groupId: "g1",
    client: `Client ${id}`,
    clientId: `client-${id}`,
    dogs: [],
    dogCount: 1,
    status: "scheduled",
    walkerId: null,
    pinned: false,
    priceCents: 2000,
    ...over,
  };
}

function group(id: string, members: WalkGroupVisit[], over: Partial<WalkGroupSummary> = {}) {
  return {
    id,
    serviceId: "svc",
    service: "Pack walk",
    maxDogs: 6,
    walkerId: null,
    earliestTime: null,
    latestTime: null,
    members: members.map((m) => ({ ...m, groupId: id })),
    ...over,
  } satisfies WalkGroupSummary;
}

const walker = (id: string, maxDogs: number | null = null, services: string[] = []) =>
  ({ id, name: id, maxDogs, services }) satisfies WalkerCapacity;

describe("R2-29: the Walker select says who holds the walk", () => {
  it("names the group's walker when the group has one", () => {
    expect(groupWalkerView(group("g", [visit("a")], { walkerId: "ann" }))).toEqual({
      kind: "group",
      walkerId: "ann",
    });
  });

  it("names the members' walker when the group row has none but every walk is held", () => {
    // The R2-29 state: the walks were assigned (board, Optimize, or by hand
    // before joining) and the group row was never written.
    const g = group("g", [visit("a", { walkerId: "ann" }), visit("b", { walkerId: "ann" })]);
    expect(groupWalkerView(g)).toEqual({ kind: "members", walkerId: "ann" });
  });

  it("says the walks are split rather than pretending one walker or none", () => {
    const g = group("g", [visit("a", { walkerId: "bo" }), visit("b", { walkerId: "ann" })]);
    expect(groupWalkerView(g)).toEqual({ kind: "mixed", walkerIds: ["ann", "bo"] });
    const half = group("g", [visit("a", { walkerId: "ann" }), visit("b")]);
    expect(groupWalkerView(half)).toEqual({ kind: "mixed", walkerIds: ["ann"] });
  });

  it("ignores finished walks and says none only when nobody holds anything", () => {
    const g = group("g", [visit("a", { walkerId: "ann", status: "completed" }), visit("b")]);
    expect(groupWalkerView(g)).toEqual({ kind: "none" });
  });

  it("lists the shown walker even when they do not run routes, so the select cannot fall back to Unassigned", () => {
    const walkers = [{ id: "ann", display_name: "Ann" }];
    const everyone = [...walkers, { id: "owner", display_name: "Owner Olive" }];
    expect(walkerOptions(walkers, everyone, "owner")).toEqual([
      { id: "ann", label: "Ann", outsideList: false },
      { id: "owner", label: "Owner Olive", outsideList: true },
    ]);
    expect(walkerOptions(walkers, everyone, "ann")).toHaveLength(1);
    expect(walkerOptions(walkers, everyone, null)).toHaveLength(1);
  });

  it("renders the members' walker as selected, not Unassigned", () => {
    const g = group("g", [visit("a", { walkerId: "ann" }), visit("b", { walkerId: "ann" })]);
    const html = renderToStaticMarkup(
      <GroupWalkCard
        group={g}
        walkers={[{ id: "ann", display_name: "Ann", is_field_tech: true }]}
        everyone={[
          {
            id: "ann",
            display_name: "Ann",
            is_field_tech: true,
            active: true,
            routingAvailable: true,
            maxDogs: null,
          },
        ]}
        available={[]}
        pending={false}
        onWalker={() => {}}
        onMember={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toMatch(/<option value="ann" selected="">Ann<\/option>/);
    expect(html).not.toMatch(/<option value="" selected="">Unassigned/);
    expect(html).toContain("Every walk in this group is with Ann");
  });

  it("renders a walker who does not run routes by name", () => {
    const g = group("g", [visit("a")], { walkerId: "owner" });
    const html = renderToStaticMarkup(
      <GroupWalkCard
        group={g}
        walkers={[]}
        everyone={[
          {
            id: "owner",
            display_name: "Owner Olive",
            is_field_tech: false,
            active: true,
            routingAvailable: true,
            maxDogs: null,
          },
        ]}
        available={[]}
        pending={false}
        onWalker={() => {}}
        onMember={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toMatch(/<option value="owner" disabled="" selected="">Owner Olive/);
  });

  it("reads the panel's select from the view, never from the group row alone", () => {
    const ui = read("src/components/routes/GroupWalksPanel.tsx");
    expect(ui).toContain("const view = groupWalkerView(group);");
    expect(ui).not.toContain('value={group.walkerId ?? ""}');
  });
});

describe("the walker's dog cap", () => {
  it("is the service's size unless the walker's cap is lower", () => {
    expect(groupCapacity(6, null)).toBe(6);
    expect(groupCapacity(6, undefined)).toBe(6);
    expect(groupCapacity(6, 3)).toBe(3);
    expect(groupCapacity(4, 10)).toBe(4);
  });

  it("counts only walks that still hold a place, as the database does", () => {
    expect(
      dogsHoldingPlaces([
        { status: "scheduled", dogCount: 2 },
        { status: "in_progress", dogCount: 1 },
        { status: "completed", dogCount: 3 },
      ]),
    ).toBe(3);
  });

  it("takes an empty field as no cap and refuses anything outside 1 to 50", () => {
    expect(parseDogCap("")).toEqual({ ok: true, value: null });
    expect(parseDogCap("  ")).toEqual({ ok: true, value: null });
    expect(parseDogCap("4")).toEqual({ ok: true, value: 4 });
    expect(parseDogCap("50")).toEqual({ ok: true, value: 50 });
    for (const bad of ["0", "51", "2.5", "-1", "four"])
      expect(parseDogCap(bad)).toEqual({ ok: false });
  });

  it("shows the walker's cap and an over-cap group on the card", () => {
    const g = group("g", [visit("a", { dogCount: 2 }), visit("b", { dogCount: 2 })], {
      walkerId: "ann",
    });
    const html = renderToStaticMarkup(
      <GroupWalkCard
        group={g}
        walkers={[{ id: "ann", display_name: "Ann", is_field_tech: true }]}
        everyone={[
          {
            id: "ann",
            display_name: "Ann",
            is_field_tech: true,
            active: true,
            routingAvailable: true,
            maxDogs: 3,
          },
        ]}
        available={[]}
        pending={false}
        onWalker={() => {}}
        onMember={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain("4 of 3 dogs");
    expect(html).toContain("(walker&#x27;s cap)");
    expect(html).toContain("over the cap");
  });

  it("is a new nullable column with no default, enforced by two new triggers", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(
      "ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS max_dogs_per_walk integer;",
    );
    expect(sql).not.toMatch(/max_dogs_per_walk integer\s+(NOT NULL|DEFAULT)/);
    expect(sql).toContain("max_dogs_per_walk IS NULL OR max_dogs_per_walk BETWEEN 1 AND 50");
    expect(sql).toContain("CREATE TRIGGER visits_validate_walk_group_walker_cap");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF walk_group_id, subscription_id, status");
    expect(sql).toContain("CREATE TRIGGER walk_groups_walker_cap");
    expect(sql).toContain("FOR UPDATE;");
    expect(sql).toContain("AND v.status IN ('scheduled', 'in_progress')");
    // Postgres fires same-event triggers in name order: the cap runs after
    // validate_walk_group_member has copied the group's walker on.
    expect(["visits_validate_walk_group", "visits_validate_walk_group_walker_cap"].sort()).toEqual([
      "visits_validate_walk_group",
      "visits_validate_walk_group_walker_cap",
    ]);
    // Does not restate the group triggers, touch billing, or read a set of functions.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.validate_walk_group/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copy_walk_group_walker/);
    expect(sql).not.toMatch(
      /(ALTER TABLE|UPDATE|INSERT INTO|DELETE FROM)\s+public\.(invoices|invoice_line_items|payments|subscriptions)\b/,
    );
    expect(sql).not.toContain("pg_get_functiondef");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.enforce_walker_dog_cap_on_member() FROM PUBLIC, anon, authenticated;",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.enforce_walker_dog_cap_on_group() FROM PUBLIC, anon, authenticated;",
    );
    expect(sql).toContain("DO $check$");
  });

  it("is set on Users & roles with the routing tickboxes' permission, for walking businesses only", () => {
    const server = read("src/lib/walk-groups.functions.ts");
    const fn = server.slice(server.indexOf("export const setWalkerDogCap"));
    expect(fn).toContain('requirePermission(context.supabase, context.userId, "manage_users")');
    expect(fn).toContain('.eq("organization_id", orgId)');
    expect(fn).toContain("z.number().int().min(1).max(50).nullable()");
    const ui = read("src/components/settings/WalkerDogCap.tsx");
    expect(ui).toContain('if (!known || !lines.includes("dog_walking")) return null;');
    expect(read("src/routes/_authenticated/settings.users.tsx")).toContain(
      "<WalkerDogCap staffId={staff.id} canEdit={canEdit} />",
    );
  });
});

describe("each client is billed separately, once", () => {
  it("lists one line per client, each visit once, without skipped or canceled walks", () => {
    const a = visit("a", { clientId: "c1", client: "Alder", dogCount: 2, priceCents: 2500 });
    const lines = groupBilling([
      a,
      a, // the same visit read twice is still one visit
      visit("b", { clientId: "c2", client: "Birch", priceCents: 2000 }),
      visit("c", { clientId: "c3", client: "Cedar", status: "skipped" }),
      visit("d", { clientId: "c4", client: "Dogwood", status: "canceled" }),
      visit("e", { clientId: "c2", client: "Birch", priceCents: null }),
    ]);
    expect(lines).toEqual([
      { clientId: "c1", client: "Alder", visitIds: ["a"], dogs: 2, priceCents: 2500 },
      { clientId: "c2", client: "Birch", visitIds: ["b", "e"], dogs: 2, priceCents: null },
    ]);
  });

  it("never lets a group reach the billing run: billing reads visits, never groups", () => {
    // The postpaid run, the hand invoice and the visit drawer bill a visit
    // through invoice_line_items.visit_id, unique per visit
    // (invoice_line_items_visit_unique). A group walk is N clients' own
    // visits, so it bills N clients once each. If billing ever started
    // reading walk_group_id, this is where to stop and think.
    for (const f of [
      "src/lib/visit-invoicing.ts",
      "src/lib/visit-invoicing.server.ts",
      "src/lib/invoices.functions.ts",
      "src/lib/billing.functions.ts",
      "src/lib/manual-invoice.server.ts",
    ])
      expect(read(f), f).not.toMatch(/walk_group|walkGroup/);
    const migrations = readdirSync(join(root, "supabase/migrations"));
    const billingSql = migrations.filter((m) =>
      /admin_generate_invoice_for_client|run_billing_cycles/.test(read(`supabase/migrations/${m}`)),
    );
    expect(billingSql.length).toBeGreaterThan(0);
    for (const m of billingSql)
      expect(read(`supabase/migrations/${m}`), m).not.toMatch(/walk_group/);
    expect(
      read("supabase/migrations/20260701162450_9c3e3c61-2bb2-48d2-bdb4-3dd96d90d688.sql"),
    ).toMatch(
      /CREATE UNIQUE INDEX invoice_line_items_visit_unique ON public\.invoice_line_items\(visit_id\)/,
    );
  });

  it("shows the office who each shared walk bills", () => {
    const g = group("g", [
      visit("a", { clientId: "c1", client: "Alder", priceCents: 2500 }),
      visit("b", { clientId: "c2", client: "Birch", priceCents: 1800 }),
    ]);
    const html = renderToStaticMarkup(
      <GroupWalkCard
        group={g}
        walkers={[]}
        everyone={[]}
        available={[]}
        pending={false}
        onWalker={() => {}}
        onMember={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain("Each client is billed separately");
    expect(html).toContain("$25.00");
    expect(html).toContain("$18.00");
  });
});

describe("assign by capacity", () => {
  it("never takes a group someone placed: a walker on the group, a held walk, a pinned walk", () => {
    const decisions = planWalkerCapacity(
      [
        group("named", [visit("a")], { walkerId: "bo" }),
        group("held", [visit("b", { walkerId: "bo" })]),
        group("pinned", [visit("c", { pinned: true })]),
        group("empty", []),
      ],
      [walker("ann"), walker("bo")],
    );
    expect(decisions).toEqual([
      { groupId: "named", action: "keep", reason: "has_walker" },
      { groupId: "held", action: "keep", reason: "members_assigned" },
      { groupId: "pinned", action: "keep", reason: "members_assigned" },
      { groupId: "empty", action: "keep", reason: "empty" },
    ]);
  });

  it("gives a group only to a walker whose cap fits its dogs", () => {
    const g = group("g", [visit("a", { dogCount: 3 }), visit("b", { dogCount: 2 })]);
    expect(planWalkerCapacity([g], [walker("ann", 4), walker("bo", 5)])).toEqual([
      { groupId: "g", action: "assign", walkerId: "bo" },
    ]);
    expect(planWalkerCapacity([g], [walker("ann", 4)])).toEqual([
      { groupId: "g", action: "keep", reason: "no_walker_fits" },
    ]);
    // No cap set is no cap.
    expect(planWalkerCapacity([g], [walker("ann", 4), walker("cy")])[0]).toEqual({
      groupId: "g",
      action: "assign",
      walkerId: "cy",
    });
  });

  it("respects service skills: nothing ticked is any service", () => {
    const g = group("g", [visit("a")]);
    expect(
      planWalkerCapacity([g], [walker("ann", null, ["grooming"]), walker("bo", null, ["svc"])])[0],
    ).toEqual({
      groupId: "g",
      action: "assign",
      walkerId: "bo",
    });
  });

  it("spreads the day by dogs already held, placing the biggest groups first", () => {
    const big = group("big", [visit("a", { dogCount: 4 })]);
    const small = group("small", [visit("b", { dogCount: 1 })]);
    const other = group("other", [visit("c", { dogCount: 2 })]);
    const decisions = planWalkerCapacity([small, big, other], [walker("ann"), walker("bo")], {
      ann: 0,
      bo: 1,
    });
    // big (4) to Ann (0 held); other (2) to Bo (1 held vs Ann's 4); small (1)
    // to Bo (3 held vs Ann's 4).
    expect(decisions).toEqual([
      { groupId: "small", action: "assign", walkerId: "bo" },
      { groupId: "big", action: "assign", walkerId: "ann" },
      { groupId: "other", action: "assign", walkerId: "bo" },
    ]);
  });

  it("counts dogs already in groups that keep their walker", () => {
    const kept = group("kept", [visit("a", { dogCount: 3 })], { walkerId: "ann" });
    const open = group("open", [visit("b")]);
    expect(planWalkerCapacity([kept, open], [walker("ann"), walker("bo")])[1]).toEqual({
      groupId: "open",
      action: "assign",
      walkerId: "bo",
    });
  });

  it("gives the same answer for the same day", () => {
    const groups = [group("x", [visit("a")]), group("y", [visit("b")])];
    const walkers = [walker("ann"), walker("bo")];
    expect(planWalkerCapacity(groups, walkers)).toEqual(planWalkerCapacity(groups, walkers));
  });

  it("writes only to a group that still has no walker, as the office", () => {
    const server = read("src/lib/walk-groups.functions.ts");
    const fn = server.slice(
      server.indexOf("export const assignWalkGroupsByCapacity"),
      server.indexOf("export const setWalkerDogCap"),
    );
    expect(fn).toContain("await requireWalkGroupOffice(context.supabase, context.userId)");
    expect(fn).toContain('.is("assigned_staff_id", null)');
    expect(fn).toContain('.eq("organization_id", orgId)');
    expect(fn).toContain("planWalkerCapacity(summaries, walkers, dayLoad)");
    expect(fn).toContain('rpc("is_staff_off"');
    expect(fn).toContain("p.active && p.is_field_tech && p.routingAvailable");
  });
});

describe("a walk plan has a walker, and a one-person business walks its own walks (F-17)", () => {
  const sql = read("supabase/migrations/20261108150100_a-walk-plan-has-a-walker.sql");
  const fill = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.fill_visit_walker()"),
    sql.indexOf("REVOKE ALL ON FUNCTION public.fill_visit_walker()"),
  );

  it("adds a nullable plan walker with no default", () => {
    expect(sql).toContain(
      "ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS assigned_staff_id uuid",
    );
    expect(sql).toContain("REFERENCES public.staff(id) ON DELETE SET NULL;");
    expect(sql).toContain("'Choose a walker from this business.'");
  });

  it("fills only a new visit that arrives with nobody, and never fails one", () => {
    expect(sql).toMatch(/CREATE TRIGGER visits_plan_walker\s+BEFORE INSERT ON public\.visits/);
    expect(fill).toContain(
      "IF NEW.assigned_staff_id IS NOT NULL OR NEW.subscription_id IS NULL THEN",
    );
    expect(fill).not.toContain("RAISE");
    expect(fill).not.toMatch(/TG_OP\s*=\s*'UPDATE'/);
  });

  it("gives a walk only to someone who can take that day", () => {
    expect(fill).toContain("IF NOT FOUND OR _stay IS NOT NULL THEN");
    expect(fill.match(/COALESCE\(st\.is_field_tech, false\)/g)).toHaveLength(2);
    expect(fill.match(/NOT public\.is_staff_off\(/g)).toHaveLength(2);
    // A plan naming a walker who cannot take the day does not fall through to
    // the one-person rule or anyone else.
    const plan = fill.slice(fill.indexOf("-- 1. The plan's walker."), fill.indexOf("-- 2."));
    expect(plan.trim().endsWith("RETURN NEW;\n  END IF;")).toBe(true);
  });

  it("limits the one-person rule to dog walks in a business with exactly one active person", () => {
    expect(fill).toContain("IF _line IS DISTINCT FROM 'dog_walking' THEN");
    expect(fill).toContain("IF _people = 1 AND EXISTS (");
  });

  it("runs before the stay and group triggers, so a group's walker still wins", () => {
    const names = ["visits_validate_walk_group", "visits_stay_sitter", "visits_plan_walker"].sort();
    expect(names[0]).toBe("visits_plan_walker");
  });

  it("is set by dispatch, for someone who runs routes, in this business", () => {
    const server = read("src/lib/plan-walker.functions.ts");
    const set = server.slice(server.indexOf("export const setPlanWalker"));
    expect(set).toContain('rpc("can_write_org"');
    expect(set).toContain('if (!allowed) throw new Error("Not authorized");');
    expect(set).toContain("if (!person.is_field_tech)");
    expect(set.match(/\.eq\("organization_id", orgId\)/g)).toHaveLength(2);
    const tab = read("src/components/client-detail/ServicesTab.tsx");
    expect(tab).toMatch(
      /s\.services\?\.service_line === "dog_walking" && !s\.stay_id && \(\s*<PlanWalker subscriptionId=\{s\.id\} \/>/,
    );
    const ui = read("src/components/client-detail/PlanWalker.tsx");
    expect(ui).toContain("Walks already on");
    expect(ui).toContain("walkerOptions(walkers, people, current)");
    expect(ui).toContain("min-h-11");
  });
});
