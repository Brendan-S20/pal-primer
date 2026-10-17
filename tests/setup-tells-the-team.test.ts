// Adding Done-for-you setup tells the HoundStack team (owner, 2026-10-10:
// "yes build the setup notification").
//
// Until this, nobody at HoundStack was told when a tenant added setup: a paid
// one left a Stripe invoice line, a free one nothing but the
// org_platform_addons row. Now every successful purchase, paid or free, emails
// the team address once and puts one notification in front of each platform
// admin. See src/lib/setup-notify.server.ts.
//
// These run `subscribePlatformAddon` for real with the framework, Supabase and
// Stripe faked, like setup-is-free-where-the-site-says.test.ts, but the fake
// database here keeps what is written to it: a retry has to find the row the
// first purchase wrote, and a second notification has to meet the unique
// event_key the first one claimed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SETUP_ADDON_SLUG } from "@/lib/done-for-you-setup";

const ORG = "0f000000-0000-4000-8000-0000000000c1";
const OWNER = "0a000000-0000-4000-8000-0000000000c2";
const ADMIN_A = "0b000000-0000-4000-8000-0000000000a1";
const ADMIN_B = "0b000000-0000-4000-8000-0000000000a2";
const CLIENT = "0c000000-0000-4000-8000-0000000000c3";
const GROWTH = "10000000-0000-4000-8000-000000000002";
const SCALE = "10000000-0000-4000-8000-000000000003";
const SETUP_ID = "20000000-0000-4000-8000-000000000098";

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: any }> = [];
/** Set to make enqueue_email fail, or the platform_admins read fail. */
let failEnqueue = false;
let failAdmins = false;

/** Unique keys the real schema enforces, as ON CONFLICT targets. */
const CONFLICT: Record<string, string[]> = {
  org_platform_addons: ["organization_id", "addon_id"],
  app_notifications: ["recipient_user_id", "event_key"],
};

function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" | "upsert" | "insert" = "select";
  let payload: any;
  let opts: any;
  let returning = false;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const run = async () => {
    if (table === "platform_admins" && failAdmins) return { data: null, error: { message: "boom" } };
    if (op === "select") return { data: rows(), error: null };
    const list = (tables[table] ??= []);
    if (op === "update") {
      for (const r of rows()) Object.assign(r, payload);
      return { data: null, error: null };
    }
    const incoming = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...r }));
    const keys = op === "upsert" ? CONFLICT[table] : undefined;
    const inserted: Row[] = [];
    for (const r of incoming) {
      const clash = keys && list.find((x) => keys.every((k) => x[k] === r[k]));
      if (clash) {
        if (!opts?.ignoreDuplicates) Object.assign(clash, r);
        continue;
      }
      list.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r });
      inserted.push(r);
    }
    return { data: returning ? inserted : null, error: null };
  };
  const api: any = {
    select: () => ((returning = op !== "select"), api),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), api),
    not: () => api,
    order: () => api,
    limit: () => api,
    gte: () => api,
    is: () => api,
    update: (p: unknown) => ((op = "update"), (payload = p), api),
    upsert: (p: unknown, o?: unknown) => ((op = "upsert"), (payload = p), (opts = o), api),
    insert: (p: unknown) => ((op = "insert"), (payload = p), api),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: "no rows" } }),
    then: (res: any, rej: any) => run().then(res, rej),
  };
  return api;
}
const db = {
  from: (t: string) => chain(t),
  rpc: async (fn: string, args: any) => {
    rpcCalls.push({ fn, args });
    return failEnqueue ? { data: null, error: { message: "queue down" } } : { data: 1, error: null };
  },
  auth: {
    getUser: async () => ({ data: { user: null } }),
    admin: {
      getUserById: async (id: string) => ({
        data: { user: id === OWNER ? { id, email: "dana@riverbend.test", phone: "", user_metadata: {} } : null },
      }),
    },
  },
};

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
          h({ data: validate(opts.data), context: { supabase: db, userId: OWNER } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: ORG, role: "owner" }),
  resolveCaller: async () => ({ orgId: ORG, role: "owner" }),
}));
const pushes: Array<{ uid: string; payload: any }> = [];
vi.mock("@/lib/push.server", () => ({
  sendPushToUser: async (uid: string, payload: any) => {
    pushes.push({ uid, payload });
  },
}));

let subscriptionIntervalInStripe: "month" | "year" = "month";
const invoiceItemCreates: any[] = [];
const makeStripe = vi.fn(async () => ({
  prices: {
    list: async () => ({
      data: [{ id: "price_setup_test", lookup_key: "addon_developer_setup", unit_amount: 19900 }],
      has_more: false,
    }),
  },
  subscriptions: {
    retrieve: async () => ({
      id: "sub_1",
      items: { data: [{ price: { id: "price_plan", recurring: { interval: subscriptionIntervalInStripe } } }] },
    }),
  },
  invoiceItems: {
    create: async (params: any) => (invoiceItemCreates.push(params), { id: "ii_setup_1", invoice: null }),
    del: async () => ({}),
  },
  products: { create: async () => ({ id: "prod_x" }) },
}));
vi.mock("@/lib/stripe-client.server", () => ({ makeStripe }));

function seed(opts: { planId: string; interval?: "month" | "year" }) {
  subscriptionIntervalInStripe = opts.interval ?? "month";
  tables = {
    platform_addons: [
      {
        id: SETUP_ID,
        slug: SETUP_ADDON_SLUG,
        name: "Done-for-you setup",
        description: null,
        price_cents: 19900,
        billing_interval: "one_time",
        status: "active",
        is_active: true,
        stripe_product_id: "prod_setup",
        stripe_price_id: "price_1UP1QtQjJFmqXgZDJA7vgmdX",
        feature_flag: null,
      },
    ],
    platform_plans: [
      { id: GROWTH, slug: "growth", name: "Growth" },
      { id: SCALE, slug: "scale", name: "Scale" },
    ],
    organizations: [
      {
        id: ORG,
        name: "Riverbend Pet Services",
        contact_email: "office@riverbend.test",
        contact_phone: "+15555550100",
        stripe_subscription_id: "sub_1",
        stripe_customer_id: "cus_1",
        plan_status: "active",
        plan_id: opts.planId,
      },
    ],
    founding_accounts: [],
    org_platform_addons: [],
    user_roles: [{ organization_id: ORG, user_id: OWNER, role: "owner" }],
    staff: [
      {
        organization_id: ORG,
        user_id: OWNER,
        display_name: "Dana Rivers",
        email: "dana@riverbend.test",
        phone: "+15555550111",
        active: true,
      },
    ],
    // A client of the business, with an email address, so the test can prove
    // nobody but the team is written to.
    clients: [{ id: CLIENT, organization_id: ORG, display_name: "A Client", primary_email: "client@example.test" }],
    platform_admins: [{ user_id: ADMIN_A }, { user_id: ADMIN_B }],
    app_notifications: [],
    app_notification_prefs: [],
    email_send_log: [],
    suppressed_emails: [],
  };
}

async function buySetup() {
  const { subscribePlatformAddon } = await import("@/lib/platform-addons.functions");
  return subscribePlatformAddon({ data: { addonId: SETUP_ID } } as any);
}

const emails = () => rpcCalls.filter((c) => c.fn === "enqueue_email").map((c) => c.args.payload);
const teamRows = () => tables.app_notifications.filter((n) => n.type === "setup_added");

beforeEach(async () => {
  rpcCalls.length = 0;
  pushes.length = 0;
  invoiceItemCreates.length = 0;
  failEnqueue = false;
  failAdmins = false;
  delete process.env.PLATFORM_TEAM_EMAIL;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  makeStripe.mockClear();
  const { resetNotifyMemoForTests } = await import("@/lib/notify-center.server");
  resetNotifyMemoForTests();
});

describe("a free setup tells the team once", () => {
  it("emails the team address and notifies each platform admin, with the reason", async () => {
    seed({ planId: GROWTH, interval: "year" });
    expect(await buySetup()).toEqual({ ok: true, waived: "yearly" });

    expect(emails()).toHaveLength(1);
    const mail = emails()[0];
    expect(mail.to).toBe("support@houndstack.com");
    expect(mail.from).toBe("HoundStack <noreply@notify.houndstack.com>");
    expect(mail.subject).toBe("Riverbend Pet Services added Done-for-you setup (free: yearly billing)");
    expect(mail.text).toContain(
      "Riverbend Pet Services added Done-for-you setup (free: yearly billing). Reach out to schedule it.",
    );
    expect(mail.text).toContain(`Business: Riverbend Pet Services (${ORG})`);
    expect(mail.text).toContain("Owner: Dana Rivers");
    expect(mail.text).toContain("Owner email: dana@riverbend.test");
    expect(mail.text).toContain("Owner phone: +15555550111");
    expect(mail.text).toContain("Plan: Growth, billed yearly");
    expect(mail.text).toContain("Charge: Free (yearly billing). Nothing was charged.");
    expect(mail.text).toMatch(/Added: \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(mail.text).toContain(`Platform console: https://app.houndstack.com/platform/tenants/${ORG}`);
    expect(mail.html).toContain(`/platform/tenants/${ORG}`);

    const rows = teamRows();
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual([ADMIN_A, ADMIN_B]);
    for (const r of rows) {
      expect(r.title).toBe("Riverbend Pet Services added Done-for-you setup (free: yearly billing).");
      expect(r.body).toContain("Reach out to schedule it.");
      expect(r.body).toContain("Dana Rivers");
      expect(r.link).toBe(`/platform/tenants/${ORG}`);
      expect(r.organization_id).toBe(ORG);
    }
    expect(pushes.map((p) => p.uid).sort()).toEqual([ADMIN_A, ADMIN_B]);
  });

  it("Scale: says so, and still never makes a Stripe client to find the interval", async () => {
    seed({ planId: SCALE });
    expect(await buySetup()).toEqual({ ok: true, waived: "scale" });
    expect(makeStripe).not.toHaveBeenCalled();
    expect(emails()).toHaveLength(1);
    expect(emails()[0].subject).toBe("Riverbend Pet Services added Done-for-you setup (free: Scale plan)");
    expect(emails()[0].text).toContain("Plan: Scale, billing interval not checked");
  });
});

describe("a paid setup tells the team once", () => {
  it("names the $199 and the Stripe invoice item", async () => {
    seed({ planId: GROWTH, interval: "month" });
    expect(await buySetup()).toEqual({ ok: true });
    expect(invoiceItemCreates).toHaveLength(1);

    expect(emails()).toHaveLength(1);
    const mail = emails()[0];
    expect(mail.subject).toBe("Riverbend Pet Services added Done-for-you setup (paid $199)");
    expect(mail.text).toContain("Charge: Paid, $199 one time. Stripe invoice item ii_setup_1");
    expect(mail.text).toContain("Plan: Growth, billed monthly");
    expect(teamRows()).toHaveLength(2);
  });

  it("is told only after the purchase is recorded, never for one that failed", async () => {
    seed({ planId: GROWTH, interval: "month" });
    tables.organizations[0].stripe_customer_id = null; // "No billing customer on file yet."
    await expect(buySetup()).rejects.toThrow(/billing customer/);
    expect(emails()).toEqual([]);
    expect(teamRows()).toEqual([]);
  });
});

describe("a retry or a double click does not tell the team again", () => {
  it("a second add after success: no second email, no second notification", async () => {
    seed({ planId: GROWTH, interval: "year" });
    await buySetup();
    expect(await buySetup()).toEqual({ ok: true, already: true });
    expect(emails()).toHaveLength(1);
    expect(teamRows()).toHaveLength(2);
    expect(pushes).toHaveLength(2);
  });

  it("the same purchase told twice (a race past the check) is held to one by its key", async () => {
    seed({ planId: GROWTH, interval: "year" });
    const { notifyTeamOfSetup } = await import("@/lib/setup-notify.server");
    const event = {
      orgId: ORG,
      addonId: SETUP_ID,
      generation: "first",
      charge: { kind: "free" as const, reason: "yearly" as const },
      planSlug: "growth",
      planInterval: "year" as const,
    };
    const first = await notifyTeamOfSetup(event);
    const { resetNotifyMemoForTests } = await import("@/lib/notify-center.server");
    resetNotifyMemoForTests(); // another server instance: only the database remembers
    const second = await notifyTeamOfSetup(event);

    expect(first.email).toBe("enqueued");
    expect(second.email).toBe("already_sent");
    expect(first.inApp.sort()).toEqual([ADMIN_A, ADMIN_B]);
    expect(second.inApp).toEqual([]);
    expect(emails()).toHaveLength(1);
    expect(teamRows()).toHaveLength(2);
    expect(pushes).toHaveLength(2);
  });

  it("a double click that raced past the check: the second purchase is not told again", async () => {
    seed({ planId: GROWTH, interval: "year" });
    expect(await buySetup()).toEqual({ ok: true, waived: "yearly" });
    // The second click read org_platform_addons before the first wrote it, so
    // it runs the whole purchase again, with the same generation ("first").
    const written = tables.org_platform_addons;
    tables.org_platform_addons = [];
    // And it landed on another server instance, so only the database remembers.
    const { resetNotifyMemoForTests } = await import("@/lib/notify-center.server");
    resetNotifyMemoForTests();
    expect(await buySetup()).toEqual({ ok: true, waived: "yearly" });
    tables.org_platform_addons = written;

    expect(emails()).toHaveLength(1);
    expect(teamRows()).toHaveLength(2);
    expect(pushes).toHaveLength(2);
  });
});

describe("a failed notification never fails or undoes the purchase", () => {
  it("the queue is down: the purchase succeeds, the row stands, the admins are still told", async () => {
    seed({ planId: GROWTH, interval: "month" });
    failEnqueue = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await buySetup()).toEqual({ ok: true });
    expect(tables.org_platform_addons).toHaveLength(1);
    expect(tables.org_platform_addons[0]).toMatchObject({ status: "active", addon_id: SETUP_ID });
    // The claim became a failure, so a later attempt may send it.
    expect(tables.email_send_log.map((r) => r.status)).toEqual(["failed"]);
    expect(teamRows()).toHaveLength(2);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("the platform_admins read fails: the purchase succeeds and the email still goes", async () => {
    seed({ planId: GROWTH, interval: "year" });
    failAdmins = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await buySetup()).toEqual({ ok: true, waived: "yearly" });
    expect(tables.org_platform_addons[0]).toMatchObject({ status: "active", waived_reason: "yearly" });
    expect(emails()).toHaveLength(1);
    errors.mockRestore();
  });

  it("the notifier itself throws: the purchase still succeeds", async () => {
    seed({ planId: GROWTH, interval: "year" });
    vi.resetModules();
    vi.doMock("@/lib/setup-notify.server", () => ({
      notifyTeamOfSetup: async () => {
        throw new Error("notifier exploded");
      },
    }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await buySetup()).toEqual({ ok: true, waived: "yearly" });
      expect(tables.org_platform_addons[0]).toMatchObject({ status: "active" });
      expect(errors.mock.calls.some((c) => String(c[0]).includes("the purchase stands"))).toBe(true);
    } finally {
      errors.mockRestore();
      vi.doUnmock("@/lib/setup-notify.server");
      vi.resetModules();
    }
  });
});

describe("nobody but the team is written to", () => {
  it("no email goes to the business's clients, its contact address or its owner", async () => {
    seed({ planId: GROWTH, interval: "month" });
    await buySetup();
    seed({ planId: SCALE });
    await buySetup();
    const to = new Set(emails().map((m) => m.to));
    expect([...to]).toEqual(["support@houndstack.com"]);
    expect(tables.email_send_log.every((r) => r.recipient_email === "support@houndstack.com")).toBe(true);
    // And no notification row reaches anyone who is not a platform admin.
    expect(teamRows().every((r) => [ADMIN_A, ADMIN_B].includes(r.recipient_user_id))).toBe(true);
  });

  it("PLATFORM_TEAM_EMAIL changes the address", async () => {
    process.env.PLATFORM_TEAM_EMAIL = "setup@houndstack.test";
    seed({ planId: SCALE });
    await buySetup();
    expect(emails().map((m) => m.to)).toEqual(["setup@houndstack.test"]);
  });

  it("the default is the support address the app already publishes", async () => {
    const { DEFAULT_TEAM_EMAIL } = await import("@/lib/setup-notify.server");
    const { PLATFORM_SUPPORT } = await import("@/lib/platform-inbound.server");
    expect(DEFAULT_TEAM_EMAIL).toBe(PLATFORM_SUPPORT);
  });

  it("the purchase path calls the notifier only after the record and the feature flag", () => {
    const src = readFileSync("src/lib/platform-addons.functions.ts", "utf8");
    const body = src.slice(
      src.indexOf("export const subscribePlatformAddon"),
      src.indexOf("export const cancelPlatformAddon"),
    );
    const calls = [...body.matchAll(/await tellTheTeamAboutSetup\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(2);
    // Free: after the waived upsert's error check. Paid: after the record's.
    expect(calls[0]).toBeGreaterThan(body.indexOf("if (waiveErr)"));
    expect(calls[1]).toBeGreaterThan(body.indexOf("if (recordErr)"));
  });
});
