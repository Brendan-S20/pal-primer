// An owner sets each role's permissions; today's rules are the defaults
// (#863, umbrella #460).
//
// What this pins, in order:
//
//   * the DEFAULTS are main's rules on 2026-11-11, for every role, as a
//     snapshot of the whole matrix, so a change to a default is a change to
//     this file and not an accident;
//   * an override changes the answer on every side: hasPermission with the
//     stored map, requirePermission through a client that holds the rows,
//     and usePermissions through the list getMyOrg sends;
//   * the floors hold with overrides set: the owner-only permissions, the
//     owner's own row, a technician's gate code, and the rank rule on who
//     may grant which role;
//   * only the owner reads or writes the screen's functions, and nothing is
//     written before the refusal;
//   * one business's rows are read and written under its own id only;
//   * the migration establishes all of it in SQL (text pins), and
//     tests/sql/an-owner-sets-each-roles-permissions.proof.sql proves it
//     against a real database when one answers (skipped, loudly, when none
//     does).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_PERMISSIONS,
  CONFIGURABLE_ROLES,
  OWNER_ONLY_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  overridesFromRows,
} from "@/lib/permissions";
import { ALL_PERMISSION_NAMES } from "./viewports/fixtures/dataset";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION_NAME = "20261112010000_an-owner-sets-each-roles-permissions.sql";
const MIGRATION = join(ROOT, "supabase/migrations", MIGRATION_NAME);
const PROOF = join(ROOT, "tests/sql/an-owner-sets-each-roles-permissions.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── 1. The defaults are today's rules ───────────────────────────────────────
describe("the defaults are the rules main shipped on 2026-11-11", () => {
  it("for every role, as the whole matrix", () => {
    expect(ROLE_PERMISSIONS).toEqual({
      owner: [
        "manage_pricing",
        "booking",
        "manage_schedule",
        "close_visits",
        "manage_plans",
        "message_clients",
        "manage_client_billing",
        "view_financials",
        "view_client_directory",
        "manage_dna_billing",
        "reveal_signin_code",
        "record_field_addons",
        "manage_org_billing",
        "manage_leads",
        "send_campaigns",
        "manage_imports",
        "use_ai_tools",
        "manage_inventory",
        "manage_franchise",
        "manage_users",
        "manage_settings",
      ],
      office_manager: [
        "manage_pricing",
        "booking",
        "manage_schedule",
        "close_visits",
        "manage_plans",
        "message_clients",
        "manage_client_billing",
        "view_financials",
        "view_client_directory",
        "manage_dna_billing",
        "reveal_signin_code",
        "record_field_addons",
        "manage_leads",
        "send_campaigns",
        "manage_imports",
        "use_ai_tools",
        "manage_inventory",
        "manage_users",
        "manage_settings",
      ],
      dispatcher: [
        "view_client_directory",
        "record_field_addons",
        "booking",
        "manage_schedule",
        "close_visits",
        "manage_plans",
        "message_clients",
      ],
      tech: ["record_field_addons"],
    });
  });

  it("manage_plans (#907): a dispatcher by default, never a technician, and in permission_default from the start", () => {
    expect(hasPermission("dispatcher", "manage_plans")).toBe(true);
    expect(hasPermission("office_manager", "manage_plans")).toBe(true);
    expect(hasPermission("tech", "manage_plans")).toBe(false);
  });

  it("Brendan's dispatcher defaults (2026-11-12): cancel yes, complete yes, prepaid no", () => {
    // close_visits is its own permission so the first two do not bring
    // invoices, refunds, prepaid or credit with them.
    expect(hasPermission("dispatcher", "close_visits")).toBe(true);
    expect(hasPermission("office_manager", "close_visits")).toBe(true);
    expect(hasPermission("tech", "close_visits")).toBe(false);
    expect(hasPermission("dispatcher", "manage_client_billing")).toBe(false);
    // Both office actions ask for it, on the server.
    const visits = read("src/lib/visits.functions.ts");
    expect(
      visits.match(/loadVisitForOfficeAction\(supabase, userId, data\.visitId, "close_visits"\)/g),
    ).toHaveLength(2);
    // Prepaid stays a billing decision: a plan that is not billed after each
    // visit is refused to anyone without manage_client_billing before
    // anything is written, and the subscriptions write policies stay
    // manage_pricing (the migration's own check, and the proof).
    const clients = read("src/lib/clients.functions.ts");
    expect(clients).toMatch(
      /\(s\.billingCadence \?\? "postpaid"\) !== "postpaid" &&\s*!hasPermission\(caller\.role, "manage_client_billing", caller\.overrides\)/,
    );
    expect(clients).toMatch(/throw new Error\(PLAN_CADENCE_IS_BILLING\)/);
  });

  it("are what hasPermission answers with no overrides, for every pair", () => {
    for (const role of ["owner", "office_manager", "dispatcher", "tech"] as const) {
      for (const p of ALL_PERMISSIONS) {
        expect(hasPermission(role, p), `${role}/${p}`).toBe(ROLE_PERMISSIONS[role].includes(p));
        expect(hasPermission(role, p, {}), `${role}/${p} with an empty map`).toBe(
          ROLE_PERMISSIONS[role].includes(p),
        );
      }
    }
  });

  it("the catalogue the owner reads names every permission once, and nothing else", () => {
    expect(PERMISSION_CATALOG.map((c) => c.permission).sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const c of PERMISSION_CATALOG) {
      expect(c.label.length, c.permission).toBeGreaterThan(3);
      expect(c.explanation.length, c.permission).toBeGreaterThan(10);
    }
    // The viewport fixture spells the same list without importing it.
    expect(ALL_PERMISSION_NAMES).toEqual(ALL_PERMISSIONS);
  });
});

// ── 2. An override changes the answer ───────────────────────────────────────
describe("an override changes the answer", () => {
  it("on for a permission the role lacks, off for one it holds", () => {
    expect(hasPermission("dispatcher", "view_financials", { view_financials: true })).toBe(true);
    expect(hasPermission("office_manager", "manage_pricing", { manage_pricing: false })).toBe(
      false,
    );
    expect(hasPermission("tech", "view_client_directory", { view_client_directory: true })).toBe(
      true,
    );
    // An untouched permission is still the default.
    expect(hasPermission("dispatcher", "manage_pricing", { view_financials: true })).toBe(false);
    expect(hasPermission("dispatcher", "booking", { view_financials: true })).toBe(true);
  });

  it("folds stored rows into the map, and ignores anything that is not a known permission with a boolean", () => {
    expect(
      overridesFromRows([
        { permission: "view_financials", allowed: true },
        { permission: "booking", allowed: false },
        { permission: "not_a_permission", allowed: true },
        { permission: "manage_pricing", allowed: "true" },
        { permission: 42, allowed: true },
        null as any,
      ]),
    ).toEqual({ view_financials: true, booking: false });
    expect(overridesFromRows(null)).toEqual({});
  });

  it("effectivePermissions is the list the shell reads", () => {
    expect(effectivePermissions("tech", { view_client_directory: true })).toEqual([
      "view_client_directory",
      "record_field_addons",
    ]);
    expect(effectivePermissions("owner", { manage_pricing: false })).toEqual(ALL_PERMISSIONS);
    expect(effectivePermissions(null)).toEqual([]);
  });
});

// ── 3. The floors hold with overrides set ───────────────────────────────────
describe("the floors hold whatever is stored", () => {
  it("an owner holds everything, even with a row saying no", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(hasPermission("owner", p, { [p]: false }), p).toBe(true);
    }
  });

  it("the owner-only permissions stay off every other role, even with a row saying yes", () => {
    expect(OWNER_ONLY_PERMISSIONS).toEqual(["manage_org_billing", "manage_franchise"]);
    for (const role of CONFIGURABLE_ROLES) {
      for (const p of OWNER_ONLY_PERMISSIONS) {
        expect(hasPermission(role, p, { [p]: true }), `${role}/${p}`).toBe(false);
      }
    }
  });

  it("the screen lists them without a switch", () => {
    const page = read("src/routes/_authenticated/settings.roles.tsx");
    expect(page).toMatch(/Always the owner's/);
    expect(page).toMatch(/\.filter\(\(c\) => c\.state && !c\.state\.ownerOnly\)/);
  });

  it("who may grant which role: never above your own, never owner unless you are one", async () => {
    const { ROLES_A_CALLER_MAY_GRANT } = await import("@/lib/users.functions");
    expect(ROLES_A_CALLER_MAY_GRANT).toEqual({
      owner: ["owner", "office_manager", "dispatcher", "tech"],
      office_manager: ["office_manager", "dispatcher", "tech"],
      dispatcher: ["dispatcher", "tech"],
      tech: ["tech"],
    });
  });
});

// ── 3b. The pure UI helpers read the configured set too ───────────────────
describe("the helpers that take a role read the configured set", () => {
  const card = {
    status: "succeeded",
    stripe_payment_intent_id: "pi_1",
    amount_cents: 10000,
    surcharge_cents: 300,
  };

  it("usePermissions hands the server's list to them", () => {
    const hook = read("src/hooks/useMyRole.ts");
    expect(hook).toMatch(
      /permissions: Permission\[\] \| null;\n\} \{\n {2}const \{ role, loading, permissions \} = useMyRole\(\);/,
    );
    for (const file of [
      "src/components/InvoiceDrawer.tsx",
      "src/components/RefundPaymentAction.tsx",
      "src/components/ManualRefundAction.tsx",
      "src/components/TapToPayButton.tsx",
    ]) {
      expect(read(file), file).toMatch(/const \{ role, permissions \} = usePermissions\(\);/);
    }
  });

  it("a refund: a dispatcher the owner gave billing to is offered one; an office manager who lost it is not", async () => {
    const { canOfferRefund, canRecordManualRefund } = await import("@/lib/refunds");
    expect(canOfferRefund("dispatcher", card)).toBe(false);
    expect(canOfferRefund("dispatcher", card, ["manage_client_billing"])).toBe(true);
    expect(canOfferRefund("office_manager", card)).toBe(true);
    expect(canOfferRefund("office_manager", card, ["booking"])).toBe(false);
    const cash = { status: "succeeded", stripe_payment_intent_id: null, amount_cents: 5000 };
    expect(canRecordManualRefund("dispatcher", cash, ["manage_client_billing"])).toBe(true);
    expect(canRecordManualRefund("office_manager", cash, ["booking"])).toBe(false);
  });

  it("tap to pay: the configured set decides who taps; the terms stay the owner's", async () => {
    const { tapToPayGate, canAcceptTapToPayTerms } = await import("@/lib/tap-to-pay");
    const input = {
      isNativeBundle: true,
      platform: "ios" as const,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      cardPaymentsReady: true,
      invoiceStatus: "open",
      dueCents: 1200,
    };
    expect(tapToPayGate({ ...input, role: "dispatcher" })).toMatchObject({ mode: "ask_admin" });
    expect(
      tapToPayGate({ ...input, role: "dispatcher", permissions: ["manage_client_billing"] }),
    ).toMatchObject({ mode: "ready" });
    expect(
      tapToPayGate({ ...input, role: "office_manager", permissions: ["booking"] }),
    ).toMatchObject({ mode: "ask_admin" });
    expect(canAcceptTapToPayTerms("owner")).toBe(true);
    expect(canAcceptTapToPayTerms("office_manager", ["manage_client_billing"])).toBe(false);
  });

  it("the CPA pack's franchise settlements read the overrides, and stay the owner's", async () => {
    const { mayViewFranchiseSettlements } = await import("@/lib/cpa-reports");
    expect(mayViewFranchiseSettlements("owner", "enterprise")).toBe(true);
    expect(
      mayViewFranchiseSettlements("office_manager", "enterprise", { manage_franchise: true }),
    ).toBe(false);
    expect(read("src/lib/cpa-reports.functions.ts")).toMatch(
      /mayViewFranchiseSettlements\(ctx\.role, await planTierForOrg\(ctx\.orgId\), ctx\.overrides\)/,
    );
  });
});

// ── 4. requirePermission reads the stored rows ──────────────────────────────
//
// A client double that records every read with its filters, and answers
// user_roles with the role under test and role_permission_overrides with
// whatever rows the test stored for (org, role).
const ORG_A = "0a000000-0000-4000-8000-00000000863a";
const ORG_B = "0b000000-0000-4000-8000-00000000863b";

type Row = { permission: string; allowed: boolean };
function clientFor(role: string, orgId: string, rows: Record<string, Row[]>) {
  const reads: Array<{ table: string; filters: Record<string, string> }> = [];
  const client = {
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const entry = { table, filters };
      reads.push(entry);
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: string) => ((filters[col] = v), chain),
        maybeSingle: async () =>
          table === "user_roles"
            ? { data: { organization_id: orgId, role }, error: null }
            : { data: null, error: null },
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === "role_permission_overrides"
              ? {
                  data: rows[`${filters.organization_id}:${filters.role}`] ?? [],
                  error: null,
                }
              : { data: [], error: null },
          ),
      };
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return { client, reads };
}

vi.mock("@/lib/impersonation-session.server", () => ({
  assertImpersonationSessionActive: async () => {},
}));

describe("requirePermission reads the business's overrides for the caller's role", () => {
  it("lets a dispatcher in once the owner turned the permission on", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { client } = clientFor("dispatcher", ORG_A, {
      [`${ORG_A}:dispatcher`]: [{ permission: "view_financials", allowed: true }],
    });
    const caller = await requirePermission(client, "u-1", "view_financials");
    expect(caller).toEqual({
      orgId: ORG_A,
      role: "dispatcher",
      overrides: { view_financials: true },
    });
  });

  it("refuses an office manager once the owner turned the permission off", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { client } = clientFor("office_manager", ORG_A, {
      [`${ORG_A}:office_manager`]: [{ permission: "manage_pricing", allowed: false }],
    });
    await expect(requirePermission(client, "u-1", "manage_pricing")).rejects.toThrow(
      "Not authorized",
    );
    // And still holds the rest.
    await expect(requirePermission(client, "u-1", "manage_users")).resolves.toMatchObject({
      role: "office_manager",
    });
  });

  it("refuses an owner-only permission even with a row saying yes", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { client } = clientFor("office_manager", ORG_A, {
      [`${ORG_A}:office_manager`]: [{ permission: "manage_org_billing", allowed: true }],
    });
    await expect(requirePermission(client, "u-1", "manage_org_billing")).rejects.toThrow(
      "Not authorized",
    );
  });

  it("asks for the caller's own business and role, and nothing of another business reaches the answer", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { client, reads } = clientFor("dispatcher", ORG_A, {
      // Business B turned it on for dispatchers; business A did not.
      [`${ORG_B}:dispatcher`]: [{ permission: "view_financials", allowed: true }],
    });
    await expect(requirePermission(client, "u-1", "view_financials")).rejects.toThrow(
      "Not authorized",
    );
    const overrideRead = reads.find((r) => r.table === "role_permission_overrides");
    expect(overrideRead?.filters).toEqual({ organization_id: ORG_A, role: "dispatcher" });
  });

  it("does not ask about an owner at all", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { client, reads } = clientFor("owner", ORG_A, {});
    const caller = await requirePermission(client, "u-1", "manage_org_billing");
    expect(caller).toEqual({ orgId: ORG_A, role: "owner" });
    expect(reads.map((r) => r.table)).toEqual(["user_roles"]);
  });

  it("fails closed when the overrides read errors", async () => {
    const { requirePermission } = await import("@/lib/authz.server");
    const client = {
      from: (table: string) => {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({
            data: { organization_id: ORG_A, role: "tech" },
            error: null,
          }),
          then: (resolve: (v: unknown) => void) =>
            resolve(
              table === "role_permission_overrides"
                ? { data: null, error: { message: "boom" } }
                : { data: [], error: null },
            ),
        };
        return chain;
      },
      rpc: async () => ({ data: [], error: null }),
    };
    await expect(requirePermission(client, "u-1", "record_field_addons")).rejects.toThrow("boom");
  });

  it("the server functions that branch on a permission pass the caller's overrides", () => {
    // Every hasPermission(caller.role, ...) and hasPermission(role, ...) in a
    // server function carries the overrides resolveCaller returned. A new
    // call that leaves them out reads the defaults and ignores the owner.
    const dir = join(ROOT, "src/lib");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".functions.ts") && !f.endsWith(".server.ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(
        /hasPermission\(\s*(caller\.role|role|appRole)\s*,\s*"[a-z_]+"\s*\)/g,
      )) {
        // shell-context's manage_franchise is owner-only: no override can
        // change it, so the defaults are the answer.
        if (f === "shell-context.functions.ts" && m[0].includes("manage_franchise")) continue;
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── 5. The screen's functions: owner only, scoped to the business ───────────
const fns = vi.hoisted(() => ({
  role: "owner" as string,
  writes: [] as Array<{
    table: string;
    op: string;
    args: unknown;
    filters: Record<string, string>;
  }>,
  reads: [] as Array<{ table: string; filters: Record<string, string> }>,
  overrideRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: screenDb, userId: "owner-1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const screenDb = {
  from: (table: string) => {
    const filters: Record<string, string> = {};
    const chain: any = {
      select: () => (fns.reads.push({ table, filters }), chain),
      eq: (col: string, v: string) => ((filters[col] = v), chain),
      delete: () => (fns.writes.push({ table, op: "delete", args: null, filters }), chain),
      upsert: (args: unknown, opts: unknown) => (
        fns.writes.push({ table, op: "upsert", args: { row: args, opts }, filters }),
        chain
      ),
      maybeSingle: async () => ({ data: { organization_id: ORG_A, role: fns.role }, error: null }),
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data:
            table === "role_permission_overrides"
              ? fns.overrideRows
              : table === "staff"
                ? [{ user_id: "owner-1", display_name: "Dana Whitfield-Ramirez" }]
                : [],
          error: null,
        }),
    };
    return chain;
  },
  rpc: async () => ({ data: [], error: null }),
};

beforeEach(() => {
  fns.writes.length = 0;
  fns.reads.length = 0;
  fns.overrideRows = [];
});

describe("Settings -> Roles & permissions, through the server functions", () => {
  for (const role of ["office_manager", "dispatcher", "tech"]) {
    it(`refuses ${role} on every function, before any write`, async () => {
      fns.role = role;
      const m = await import("@/lib/role-permissions.functions");
      await expect(m.getRolePermissions({} as any)).rejects.toThrow(
        m.ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS,
      );
      await expect(
        m.setRolePermission({
          data: { role: "dispatcher", permission: "view_financials", allowed: true },
        } as any),
      ).rejects.toThrow(m.ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS);
      await expect(m.resetRolePermissions({ data: { role: "dispatcher" } } as any)).rejects.toThrow(
        m.ONLY_THE_OWNER_SETS_ROLE_PERMISSIONS,
      );
      expect(fns.writes).toEqual([]);
    });
  }

  it("the owner reads every role with the default beside the stored answer, and who changed it last", async () => {
    fns.role = "owner";
    fns.overrideRows = [
      {
        role: "dispatcher",
        permission: "view_financials",
        allowed: true,
        updated_by: "owner-1",
        updated_at: "2026-11-11T15:04:00Z",
      },
      {
        role: "dispatcher",
        permission: "message_clients",
        allowed: false,
        updated_by: "gone-1",
        updated_at: "2026-11-10T09:00:00Z",
      },
    ];
    const { getRolePermissions } = await import("@/lib/role-permissions.functions");
    const answer = await getRolePermissions({} as any);
    expect(answer.roles.map((r) => r.role)).toEqual(["office_manager", "dispatcher", "tech"]);
    const dispatcher = answer.roles[1];
    expect(dispatcher.changed).toBe(2);
    expect(dispatcher.lastChange).toEqual({
      by: "Dana Whitfield-Ramirez",
      at: "2026-11-11T15:04:00Z",
    });
    expect(dispatcher.permissions.find((p) => p.permission === "view_financials")).toEqual({
      permission: "view_financials",
      allowed: true,
      byDefault: false,
      ownerOnly: false,
    });
    expect(dispatcher.permissions.find((p) => p.permission === "message_clients")).toEqual({
      permission: "message_clients",
      allowed: false,
      byDefault: true,
      ownerOnly: false,
    });
    expect(dispatcher.permissions.find((p) => p.permission === "manage_org_billing")).toEqual({
      permission: "manage_org_billing",
      allowed: false,
      byDefault: false,
      ownerOnly: true,
    });
    expect(answer.roles[0].changed).toBe(0);
    expect(answer.roles[0].lastChange).toBeNull();
    // Read under the owner's business only (user_roles is the caller lookup,
    // filtered by user).
    for (const r of fns.reads.filter((r) => r.table !== "user_roles")) {
      expect(r.filters.organization_id, r.table).toBe(ORG_A);
    }
    expect(fns.reads.map((r) => r.table)).toContain("role_permission_overrides");
  });

  it("a change away from the default is an upsert under the owner's business, with the actor", async () => {
    fns.role = "owner";
    const { setRolePermission } = await import("@/lib/role-permissions.functions");
    await setRolePermission({
      data: { role: "dispatcher", permission: "view_financials", allowed: true },
    } as any);
    expect(fns.writes).toHaveLength(1);
    expect(fns.writes[0].op).toBe("upsert");
    expect((fns.writes[0].args as any).row).toMatchObject({
      organization_id: ORG_A,
      role: "dispatcher",
      permission: "view_financials",
      allowed: true,
      updated_by: "owner-1",
    });
    expect((fns.writes[0].args as any).opts).toEqual({
      onConflict: "organization_id,role,permission",
    });
  });

  it("a change back to the default deletes the row, under the owner's business", async () => {
    fns.role = "owner";
    const { setRolePermission } = await import("@/lib/role-permissions.functions");
    await setRolePermission({
      data: { role: "dispatcher", permission: "booking", allowed: true },
    } as any);
    expect(fns.writes).toEqual([
      {
        table: "role_permission_overrides",
        op: "delete",
        args: null,
        filters: { organization_id: ORG_A, role: "dispatcher", permission: "booking" },
      },
    ]);
  });

  it("refuses to turn an owner-only permission on, before any write", async () => {
    fns.role = "owner";
    const m = await import("@/lib/role-permissions.functions");
    await expect(
      m.setRolePermission({
        data: { role: "office_manager", permission: "manage_org_billing", allowed: true },
      } as any),
    ).rejects.toThrow(m.THAT_PERMISSION_IS_THE_OWNERS);
    expect(fns.writes).toEqual([]);
  });

  it("refuses the owner role and an unknown permission at the door", async () => {
    fns.role = "owner";
    const { setRolePermission, resetRolePermissions } =
      await import("@/lib/role-permissions.functions");
    // The validator refuses these before the handler runs (synchronously in
    // this double, as a rejected request in production).
    const attempt = (fn: () => unknown) => Promise.resolve().then(fn);
    await expect(
      attempt(() =>
        setRolePermission({
          data: { role: "owner", permission: "booking", allowed: false },
        } as any),
      ),
    ).rejects.toThrow();
    await expect(
      attempt(() =>
        setRolePermission({
          data: { role: "tech", permission: "run_the_world", allowed: true },
        } as any),
      ),
    ).rejects.toThrow();
    await expect(
      attempt(() => resetRolePermissions({ data: { role: "owner" } } as any)),
    ).rejects.toThrow();
    expect(fns.writes).toEqual([]);
  });

  it("Reset to defaults deletes the role's rows under the owner's business", async () => {
    fns.role = "owner";
    const { resetRolePermissions } = await import("@/lib/role-permissions.functions");
    await resetRolePermissions({ data: { role: "tech" } } as any);
    expect(fns.writes).toEqual([
      {
        table: "role_permission_overrides",
        op: "delete",
        args: null,
        filters: { organization_id: ORG_A, role: "tech" },
      },
    ]);
  });
});

// ── 6. The browser reads the configured set ─────────────────────────────────
describe("the shell reads the configured set", () => {
  it("getMyOrg sends the caller's effective permissions", () => {
    const src = read("src/lib/org.functions.ts");
    expect(src).toMatch(/readRoleOverrides\(supabase, org\.id, appRole\)/);
    expect(src).toMatch(/permissions = effectivePermissions\(appRole, overrides\)/);
    expect(src).toMatch(/organization: \{ \.\.\.org, role: role\.role as string, permissions \}/);
  });

  it("usePermissions answers from that list, and from the defaults until it arrives", async () => {
    const { permissionsOf } = await import("@/hooks/useMyRole");
    expect(permissionsOf({ permissions: ["booking", "nonsense", 7] })).toEqual(["booking"]);
    expect(permissionsOf({ role: "tech" })).toBeNull();
    expect(permissionsOf(null)).toBeNull();
    const hook = read("src/hooks/useMyRole.ts");
    expect(hook).toMatch(
      /permissions \? permissions\.includes\(permission\) : hasPermission\(role, permission\)/,
    );
  });

  it("the users page gives the controls to whoever holds manage_users as configured", () => {
    const page = read("src/routes/_authenticated/settings.users.tsx");
    expect(page).toMatch(/const canManageStaff = myRole === "owner" \|\| can\("manage_users"\);/);
  });

  it("the page is owner-only on the rail, in the router and on Android", async () => {
    const { ROUTE_ROLES, canAccess } = await import("@/hooks/useMyRole");
    expect(ROUTE_ROLES["/settings/roles"]).toEqual(["owner"]);
    expect(canAccess("office_manager", "/settings/roles")).toBe(false);
    expect(canAccess("owner", "/settings/roles")).toBe(true);
    expect(read("src/routes/_authenticated/settings.tsx")).toMatch(
      /\{ label: "Roles & permissions", to: "\/settings\/roles" \}/,
    );
    const { appLinkClaims } = await import("@/lib/android-app-links");
    expect(appLinkClaims("/settings/roles")).toBe(true);
    expect(read("android/app/src/main/AndroidManifest.xml")).toMatch(
      /android:pathPrefix="\/settings\/roles"/,
    );
  });
});

// ── 7. The migration ────────────────────────────────────────────────────────
describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const fn = (name: string, sig: string) =>
    sql.match(
      new RegExp(
        // Up to the body's own terminator, which 20261023130000's copy of
        // office_skip_visit writes inline (`END; $function$;`).
        `CREATE OR REPLACE FUNCTION public\\.${name}\\(${sig}[\\s\\S]*?\\$function\\$;`,
      ),
    )?.[0] ?? "";

  it("is the version SIC reserved for #905, after 20261111151000, and the only file at it", () => {
    // Not "the newest": main took 20261112050000 (#883) while this was open,
    // and SIC kept this file at 20261112010000. #907's 20261112040000 sorts
    // after it, which is why permission_default carries manage_plans here.
    const files = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files).toContain(MIGRATION_NAME);
    expect(files.filter((f) => f.startsWith("20261112010000"))).toEqual([MIGRATION_NAME]);
    expect(MIGRATION_NAME > "20261111151000").toBe(true);
  });

  it("the defaults in SQL are the defaults in TypeScript (the parity test holds the matrix itself)", () => {
    const body = fn("permission_default", "_role public.app_role, _permission text");
    expect(body).toMatch(/IMMUTABLE/);
    expect(body).toMatch(/WHEN _role = 'owner' THEN true/);
    expect(body).toMatch(/WHEN _role = 'tech' THEN _permission = 'record_field_addons'/);
    expect(body).toMatch(/WHEN _role = 'dispatcher' THEN _permission IN \([^)]*'close_visits'/);
    expect(body).toMatch(/WHEN _role = 'dispatcher' THEN _permission IN \([^)]*'manage_plans'/);
  });

  it("completing and canceling from the office ask close_visits in SQL too, and prepaid stays billing", () => {
    const complete = fn("office_complete_visit", "\\s*_visit_id uuid,\\s*--");
    expect(complete).toMatch(
      /IF NOT public\.has_permission\(auth\.uid\(\), _org, 'close_visits'\) THEN/,
    );
    expect(complete).not.toMatch(/can_write_org/);
    const skip = fn("office_skip_visit", "\\s*_visit_id uuid, _reason text");
    expect(skip).toMatch(
      /IF NOT public\.has_permission\(auth\.uid\(\), _org, 'close_visits'\) THEN/,
    );
    expect(skip).not.toMatch(/can_write_org/);
    expect(sql).toMatch(/generate_prepaid_invoice no longer asks for manage_client_billing/);
    expect(sql).toMatch(/a subscriptions write policy no longer requires manage_pricing/);
  });

  it("the table: configurable roles only, the floor as a CHECK, two-step, owner-only writes, member reads", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.role_permission_overrides/);
    expect(sql).toMatch(/PRIMARY KEY \(organization_id, role, permission\)/);
    expect(sql).toMatch(
      /CHECK \(role IN \('office_manager'::public\.app_role, 'dispatcher'::public\.app_role, 'tech'::public\.app_role\)\)/,
    );
    expect(sql).toMatch(
      /CHECK \(NOT \(allowed AND permission IN \('manage_org_billing', 'manage_franchise'\)\)\)/,
    );
    expect(sql).toMatch(/ALTER TABLE public\.role_permission_overrides ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(
      /SELECT public\.require_mfa_policy\('public\.role_permission_overrides'\);/,
    );
    const policies = sql.match(/CREATE POLICY[\s\S]*?;\n/g) ?? [];
    const onTable = policies.filter((p) => /ON public\.role_permission_overrides/.test(p));
    expect(onTable).toHaveLength(4);
    expect(onTable.find((p) => /FOR SELECT/.test(p))).toMatch(
      /is_org_member\(\(SELECT auth\.uid\(\)\), organization_id\)/,
    );
    for (const p of onTable.filter((p) => /FOR (INSERT|UPDATE|DELETE)/.test(p))) {
      expect(p).toMatch(
        /has_role\(\(SELECT auth\.uid\(\)\), organization_id, 'owner'::public\.app_role\)/,
      );
      expect(p).not.toMatch(/has_permission/);
    }
    expect(sql).toMatch(/REVOKE ALL ON public\.role_permission_overrides FROM PUBLIC, anon;/);
  });

  it("has_permission reads the stored set behind the floor, and keeps its three guards", () => {
    const body = fn("has_permission", "_user_id uuid, _org_id uuid, _permission text");
    expect(body).toMatch(
      /\(SELECT auth\.uid\(\)\) IS NULL OR _user_id IS NOT DISTINCT FROM \(SELECT auth\.uid\(\)\)/,
    );
    expect(body).toMatch(/public\.mfa_satisfied\(\)/);
    expect(body).toMatch(/NOT s\.active/);
    expect(body).toMatch(/ur\.role = 'owner'/);
    expect(body).toMatch(/_permission NOT IN \('manage_org_billing', 'manage_franchise'\)/);
    expect(body).toMatch(
      /COALESCE\(\s*\(SELECT o\.allowed\s+FROM public\.role_permission_overrides o\s+WHERE o\.organization_id = _org_id\s+AND o\.role = ur\.role\s+AND o\.permission = _permission\),\s*public\.permission_default\(ur\.role, _permission\)\)/,
    );
    expect(body).not.toMatch(/RAISE/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.has_permission\(uuid, uuid, text\) FROM PUBLIC, anon;/,
    );
  });

  it("logs every change with the actor", () => {
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.role_permission_overrides/);
    expect(sql).toMatch(/'role_permissions\.changed'/);
    expect(sql).toMatch(/_actor uuid := auth\.uid\(\)/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_log_role_permission_change\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("staff authority asks manage_users as configured, inside the owner floor and the rank rule", () => {
    const active = fn("set_staff_active", "_staff_id uuid, _active boolean");
    expect(active).toMatch(/has_role\(auth\.uid\(\), _org, 'owner'::app_role\)/);
    expect(active).toMatch(/ELSIF public\.has_permission\(auth\.uid\(\), _org, 'manage_users'\)/);
    expect(active).toMatch(/IF public\.staff_row_is_an_owner\(_staff_id\) THEN/);
    expect(active).not.toMatch(/'office_manager'/);
    const change = fn("change_user_role", "_org_id uuid, _user_id uuid, _new_role app_role");
    expect(change).toMatch(
      /ELSIF public\.has_permission\(auth\.uid\(\), _org_id, 'manage_users'\)/,
    );
    expect(change).toMatch(/IF NOT public\.caller_may_grant_role\(_org_id, _new_role::text\) THEN/);
    expect(change).toMatch(/Only an owner can change the owner''s role\./);
    expect(change).toMatch(/That person is not on your team\./);
    expect(change).toMatch(/RAISE EXCEPTION 'Cannot demote the last owner';/);
    const grant = fn("caller_may_grant_role", "_org_id uuid, _role text");
    expect(grant).toMatch(/_role NOT IN \('owner', 'platform_admin'\)/);
    expect(grant).toMatch(/public\.role_rank\(_role\) <= \(/);
    const rank = fn("role_rank", "_role text");
    expect(rank).toMatch(
      /WHEN 'owner' THEN 3[\s\S]*WHEN 'office_manager' THEN 2[\s\S]*WHEN 'dispatcher' THEN 1[\s\S]*WHEN 'tech' THEN 0/,
    );
    const staffPolicy = (sql.match(/CREATE POLICY[\s\S]*?;\n/g) ?? []).find((p) =>
      /ON public\.staff\s+AS RESTRICTIVE FOR UPDATE/.test(p),
    );
    expect(staffPolicy).toMatch(/staff_authority_unchanged\(id, active, role\)/);
    expect(staffPolicy).toMatch(/public\.caller_may_grant_role\(organization_id, role::text\)/);
    expect(staffPolicy).toMatch(/NOT public\.staff_row_is_an_owner\(id\)/);
    // INSERT of an owner and DELETE stay owner-only: not touched here.
    expect(sql).not.toMatch(
      /DROP POLICY IF EXISTS "Only an owner (adds an owner|removes a person)"/,
    );
  });

  it("a technician's gate code is for the assigned day, whatever the directory setting", () => {
    const codes = fn("property_access_codes", "_property_ids uuid\\[\\]");
    expect(codes).toMatch(
      /has_permission\(\(SELECT auth\.uid\(\)\), p\.organization_id, 'view_client_directory'\)\s+-- [^\n]*\n\s+AND NOT public\.has_role\(\(SELECT auth\.uid\(\)\), p\.organization_id, 'tech'::public\.app_role\)/,
    );
    expect(codes).toMatch(/v\.scheduled_on = \(now\(\) AT TIME ZONE/);
    const stay = fn("stay_access_codes", "_stay_ids uuid\\[\\]");
    expect(
      stay.match(
        /AND NOT public\.has_role\(_uid, st\.organization_id, 'tech'::public\.app_role\)/g,
      ),
    ).toHaveLength(2);
    expect(stay).toMatch(/'stay\.access_viewed'/);
  });

  it("checks what it establishes, from any starting state, and nothing it cannot", () => {
    expect(sql).toMatch(/DO \$post\$/);
    expect(sql).toMatch(/permissive = 'PERMISSIVE'/);
    expect(sql).not.toMatch(/pg_get_functiondef/);
    expect(sql).not.toMatch(/cron\./);
  });
});

// ── 8. The proof, in a real database ────────────────────────────────────────
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the an-owner-sets-each-roles-permissions proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("an owner sets each role's permissions, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("an override changes has_permission and RLS; the floors and tenant isolation hold; only the owner writes; every change is logged", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out).toMatch(/ALL ROLE-PERMISSION PROOFS PASSED/);
    expect(out).toMatch(/ok: a dispatcher completes and cancels by default/);
  });
});
