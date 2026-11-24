import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakeAdmin, type Row } from "./helpers/fake-supabase";
import { countSegments, overageBlocks, overageCents, ceilingSegments } from "@/lib/sms-segments";

// #988: 1,000 segments included in the $29 add-on, then $10 per started 500.

describe("segment counting", () => {
  it("counts 160 GSM-7 characters as one segment and 161 as two", () => {
    expect(countSegments("a".repeat(160))).toEqual({ segments: 1, encoding: "GSM-7" });
    expect(countSegments("a".repeat(161)).segments).toBe(2);
    expect(countSegments("a".repeat(306)).segments).toBe(2);
    expect(countSegments("a".repeat(307)).segments).toBe(3);
  });
  it("counts 70 UCS-2 characters as one segment; an emoji forces UCS-2", () => {
    expect(countSegments("😀")).toEqual({ segments: 1, encoding: "UCS-2" });
    expect(countSegments("é".repeat(70)).encoding).toBe("GSM-7");
    expect(countSegments("a".repeat(69) + "’").segments).toBe(1); // curly quote, 70 chars
    expect(countSegments("a".repeat(70) + "’").segments).toBe(2);
    expect(countSegments("a".repeat(134) + "’").segments).toBe(3); // 135 > 134 = 2*67
  });
  it("counts GSM extension characters as two", () => {
    expect(countSegments("€".repeat(80)).segments).toBe(1);
    expect(countSegments("€".repeat(81)).segments).toBe(2);
  });
  it("never splits an extension character or a surrogate pair across segments (S4)", () => {
    // 152 + 2 (the euro sign, escape + character) + 152 = 306 septets, which
    // a division calls 2. The euro does not fit in segment 1's last septet,
    // so it starts segment 2, and the rest spills into a third.
    expect(countSegments("a".repeat(152) + "€" + "a".repeat(152)).segments).toBe(3);
    // A 153rd-character euro that does fit (151 + 2) stays in segment 1.
    expect(countSegments("a".repeat(151) + "€" + "a".repeat(153)).segments).toBe(2);
    // UCS-2: 66 units, then an emoji (2 units) does not fit in 67.
    expect(countSegments("a".repeat(66) + "😀" + "a".repeat(65) + "’").segments).toBe(3);
    expect(countSegments("a".repeat(65) + "😀" + "a".repeat(66) + "’").segments).toBe(2);
  });
  it("an empty body is zero", () => {
    expect(countSegments("").segments).toBe(0);
  });
});

describe("the price", () => {
  it("1,000 is free; 1,001 is one $10 block; 1,500 is one; 1,501 is two", () => {
    expect(overageCents(1000)).toBe(0);
    expect(overageCents(1001)).toBe(1000);
    expect(overageCents(1500)).toBe(1000);
    expect(overageCents(1501)).toBe(2000);
    expect(overageBlocks(2500)).toBe(3);
  });
  it("the default ceiling is 5 blocks past the allowance", () => {
    expect(ceilingSegments()).toBe(3500);
  });
});

const ORG = "11111111-1111-1111-1111-111111111111";
const fake = createFakeAdmin();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
const created: Array<{ params: Record<string, unknown>; key: string | undefined }> = [];
const byKey = new Map<string, { id: string }>();
vi.mock("stripe", () => ({
  default: class {
    invoiceItems = {
      create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
        const key = opts?.idempotencyKey;
        if (key && byKey.has(key)) return byKey.get(key)!;
        const item = { id: `ii_${created.length + 1}` };
        if (key) byKey.set(key, item);
        created.push({ params, key });
        return item;
      },
    };
  },
}));

const period = (o: Partial<Row> = {}): Row => ({
  organization_id: ORG,
  period_month: "2026-07-01",
  // A stale rollup on purpose: the claim recounts from the ledger and bills
  // that number, never this one (M3).
  segments: 0,
  billed_at: null,
  billed_blocks: null,
  billed_cents: null,
  billed_segments: null,
  stripe_invoice_item_id: null,
  ...o,
});

const SMS_ADDON_ID = "addon-managed-sms";
const holding = (o: Partial<Row> = {}): Row => ({
  organization_id: ORG,
  addon_id: SMS_ADDON_ID,
  status: "active",
  canceled_at: null,
  waived_reason: null,
  stripe_subscription_item_id: "si_qa_test",
  created_at: "2026-05-01T00:00:00Z",
  ...o,
});

function seed(segments: number, addons: Row[] = [holding()]) {
  fake.reset({
    organizations: [
      {
        id: ORG,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        timezone: "America/Chicago",
      },
    ],
    platform_addons: [
      {
        id: SMS_ADDON_ID,
        slug: "managed-sms",
        texting_segments_included: 1000,
        texting_block_size: 500,
        texting_block_cents: 1000,
        texting_ceiling_blocks: 5,
      },
    ],
    org_platform_addons: addons,
    sms_usage_periods: [period()],
    sms_usage_events: [
      { organization_id: ORG, period_month: "2026-07-01", num_segments: segments },
    ],
  });
}

// claim_sms_overage, as the migration defines it, over the fake's tables:
// recount the month from the ledger, store it, and claim on that count. The
// SQL itself is driven against real Postgres in
// tests/integration/two-texts-at-once-are-both-counted.db.test.ts.
fake.onRpc("claim_sms_overage", (a) => {
  const t = fake.tables;
  const terms = (t.platform_addons ?? []).find((r) => r.slug === "managed-sms");
  const inc = terms?.texting_segments_included as number | null;
  const size = terms?.texting_block_size as number | null;
  const price = terms?.texting_block_cents as number | null;
  if (inc == null || !size || price == null)
    return [
      {
        outcome: "not_metered",
        segments: null,
        blocks: null,
        cents: null,
        segments_included: inc,
        block_size: size,
      },
    ];
  const used = (t.sms_usage_events ?? [])
    .filter((e) => e.organization_id === a._org_id && e.period_month === a._period_month)
    .reduce((n, e) => n + Number(e.num_segments), 0);
  const p = (t.sms_usage_periods ?? []).find(
    (r) => r.organization_id === a._org_id && r.period_month === a._period_month,
  )!;
  p.segments = used;
  if (p.billed_at)
    return [
      { outcome: "already_billed", segments: used, segments_included: inc, block_size: size },
    ];
  const blocks = used <= inc ? 0 : Math.ceil((used - inc) / size);
  const cents = blocks * price;
  const row = { segments: used, blocks, cents, segments_included: inc, block_size: size };
  if (cents <= 0) {
    Object.assign(p, {
      billed_at: "now",
      billed_blocks: 0,
      billed_cents: 0,
      billed_segments: used,
    });
    return [{ outcome: "no_overage", ...row }];
  }
  if (!a._can_charge) return [{ outcome: "no_stripe_customer", ...row }];
  Object.assign(p, {
    billed_at: "now",
    billed_blocks: blocks,
    billed_cents: cents,
    billed_segments: used,
  });
  return [{ outcome: "claimed", ...row }];
});

async function run(opts: { live?: boolean } = { live: true }) {
  const { runSmsOverageBilling } = await import("@/lib/sms-overage-billing.server");
  return runSmsOverageBilling(opts);
}

describe("monthly overage billing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    process.env.PLATFORM_STRIPE_SECRET_KEY = "sk_test_988";
    created.length = 0;
    byKey.clear();
  });

  it("1,001 segments adds exactly one $10 item with the documented idempotency key", async () => {
    seed(1001);
    const r = await run();
    expect(r.centsTotal).toBe(1000);
    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({ amount: 1000, currency: "usd", customer: "cus_1" });
    expect(created[0].key).toBe(`sms-overage-${ORG}-2026-07`);
  });

  it("1,501 segments is $20", async () => {
    seed(1501);
    expect((await run()).centsTotal).toBe(2000);
  });

  it("1,000 segments bills nothing and is marked closed", async () => {
    seed(1000);
    await run();
    expect(created).toHaveLength(0);
    expect(fake.tables.sms_usage_periods[0].billed_at).toBeTruthy();
  });

  it("a re-run never adds a duplicate", async () => {
    seed(1001);
    await run();
    await run();
    expect(created).toHaveLength(1);
  });

  it("never bills the month still open", async () => {
    seed(5000);
    fake.tables.sms_usage_periods[0].period_month = "2026-08-01";
    await run();
    expect(created).toHaveLength(0);
  });

  it("bills the ledger's count, not a stale rollup (M3)", async () => {
    seed(1501);
    fake.tables.sms_usage_periods[0].segments = 1500; // lost a concurrent send
    const r = await run();
    expect(r.centsTotal).toBe(2000);
    expect(created[0].params.metadata).toMatchObject({ segments_used: "1501", blocks: "2" });
    expect(fake.tables.sms_usage_periods[0]).toMatchObject({
      segments: 1501,
      billed_segments: 1501,
    });
  });

  it("an overage with no Stripe customer is not claimed, so it bills once there is one", async () => {
    seed(1600);
    fake.tables.organizations[0].stripe_customer_id = null;
    await run();
    expect(created).toHaveLength(0);
    expect(fake.tables.sms_usage_periods[0].billed_at).toBeNull();
  });

  // S3: only a business that held managed-sms, paid, for the billed month.
  const notHolders: Array<[string, Row[]]> = [
    ["no add-on at all", []],
    ["comped (no Stripe subscription item)", [holding({ stripe_subscription_item_id: null })]],
    ["waived", [holding({ waived_reason: "founding" })]],
    ["cancelled", [holding({ status: "canceled", canceled_at: "2026-07-15T00:00:00Z" })]],
    ["cancel scheduled", [holding({ canceled_at: "2026-07-15T00:00:00Z" })]],
    ["added after the month", [holding({ created_at: "2026-08-02T00:00:00Z" })]],
    ["a different add-on", [holding({ addon_id: "addon-something-else" })]],
  ];
  for (const [label, addons] of notHolders) {
    it(`no overage item for a business that did not hold managed-sms: ${label} (S3)`, async () => {
      seed(3000, addons);
      const r = await run();
      expect(created).toHaveLength(0);
      expect(r.billed).toBe(0);
      expect(r.outcomes[0]).toMatchObject({ skipped: "not_a_paying_managed_sms_holder" });
      expect(fake.tables.sms_usage_periods[0]).toMatchObject({ billed_blocks: 0, billed_cents: 0 });
      expect(fake.rpcs.filter((c) => c.fn === "claim_sms_overage")).toHaveLength(0);
    });
  }
});

describe("one switch, off by default (M2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    process.env.PLATFORM_STRIPE_SECRET_KEY = "sk_test_988";
    created.length = 0;
    byKey.clear();
  });

  it("is a code constant set to false, not an env var", async () => {
    const launch = await import("@/lib/texting-launch");
    expect(launch.TEXTING_USAGE_BILLING_LIVE).toBe(false);
    const src = readFileSync("src/lib/texting-launch.ts", "utf8");
    expect(src).toMatch(/^export const TEXTING_USAGE_BILLING_LIVE = false;$/m);
    expect(src).not.toMatch(/process\.env|import\.meta\.env/);
  });

  it("left at its default, the nightly bills nothing, claims nothing and marks nothing", async () => {
    seed(5000);
    const { runSmsOverageBilling } = await import("@/lib/sms-overage-billing.server");
    const r = await runSmsOverageBilling();
    expect(r).toMatchObject({ live: false, billed: 0, centsTotal: 0 });
    expect(created).toHaveLength(0);
    expect(fake.rpcs).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    expect(fake.tables.sms_usage_periods[0]).toMatchObject({
      billed_at: null,
      billed_blocks: null,
    });
  });

  it("left at its default, billing one month directly is refused too", async () => {
    seed(5000);
    const { billOrgSmsOverage } = await import("@/lib/sms-overage-billing.server");
    expect(
      await billOrgSmsOverage({ organization_id: ORG, period_month: "2026-07-01" }),
    ).toMatchObject({
      skipped: "billing_off",
    });
    expect(created).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
  });

  it("left at its default, a business far over the ceiling is not stopped", async () => {
    fake.reset({});
    fake.onRpc("sms_usage_state", () => [overCeiling]);
    const { assertUnderTextingCeiling } = await import("@/lib/sms-usage.server");
    await expect(assertUnderTextingCeiling(ORG, "reminder")).resolves.toBeUndefined();
    // Not even read: the ceiling costs nothing while it is off.
    expect(fake.rpcs).toHaveLength(0);
  });

  it("the nightly and the send path use the default, not an override", () => {
    const nightly = readFileSync("src/routes/api/public/hooks/nightly.ts", "utf8");
    expect(nightly).toMatch(/await runSmsOverageBilling\(\);/);
    const twilio = readFileSync("src/lib/twilio.server.ts", "utf8");
    expect(twilio).toMatch(
      /await assertUnderTextingCeiling\(params\.usage\.orgId, params\.usage\.kind\);/,
    );
  });

  it("counting does not depend on it: a send is still recorded with the switch off", async () => {
    fake.reset({ organizations: [{ id: ORG, timezone: "UTC" }], sms_usage_events: [] });
    const { recordSmsSegments } = await import("@/lib/sms-usage.server");
    await recordSmsSegments({
      orgId: ORG,
      direction: "outbound",
      kind: "reminder",
      body: "QA TEST",
      twilioSid: "SMqa1",
    });
    expect(fake.tables.sms_usage_events).toHaveLength(1);
  });
});

const overCeiling = {
  period_month: "2026-08-01",
  segments_used: 9000,
  segments_included: 1000,
  block_size: 500,
  block_cents: 1000,
  blocks_owed: 16,
  overage_cents: 16000,
  ceiling_segments: 3500,
};

describe("the ceiling, once switched on", () => {
  beforeEach(() => {
    fake.reset({});
    fake.onRpc("sms_usage_state", () => [overCeiling]);
  });

  it("stops an automatic text at the ceiling", async () => {
    const { assertUnderTextingCeiling, TextingCeilingReached } =
      await import("@/lib/sms-usage.server");
    await expect(assertUnderTextingCeiling(ORG, "reminder", true)).rejects.toBeInstanceOf(
      TextingCeilingReached,
    );
  });

  it("never stops a client's portal sign-in code, or a compliance text, or what came in", async () => {
    const { assertUnderTextingCeiling, NEVER_BLOCKED } = await import("@/lib/sms-usage.server");
    expect([...NEVER_BLOCKED].sort()).toEqual(["consent", "inbound", "portal_code", "stop_help"]);
    for (const kind of ["portal_code", "consent", "stop_help", "inbound"] as const) {
      await expect(assertUnderTextingCeiling(ORG, kind, true), kind).resolves.toBeUndefined();
    }
  });

  it("reads the ceiling from the catalog row, not the code default (S5)", async () => {
    // A row that allows 8 blocks: 1,000 + 8 * 500 = 5,000.
    fake.onRpc("sms_usage_state", () => [
      { ...overCeiling, segments_used: 4000, ceiling_segments: 5000 },
    ]);
    const { readSmsUsageState, assertUnderTextingCeiling } = await import("@/lib/sms-usage.server");
    const s = await readSmsUsageState(ORG);
    expect(s?.terms.ceilingBlocks).toBe(8);
    expect(s?.ceilingSegments).toBe(5000);
    await expect(assertUnderTextingCeiling(ORG, "reminder", true)).resolves.toBeUndefined();
  });
});

describe("a TwiML reply is keyed to the inbound text it answers (S2)", () => {
  it("derives one key per inbound SID, and none without one", async () => {
    const { twimlReplySid } = await import("@/lib/sms-usage.server");
    expect(twimlReplySid("SMabc")).toBe("SMabc:reply");
    expect(twimlReplySid(null)).toBeNull();
    expect(twimlReplySid("")).toBeNull();
  });

  it("a retried webhook records the reply once", async () => {
    fake.reset({ organizations: [{ id: ORG, timezone: "UTC" }], sms_usage_events: [] });
    const { recordSmsSegments, twimlReplySid } = await import("@/lib/sms-usage.server");
    const reply = {
      orgId: ORG,
      direction: "outbound" as const,
      kind: "stop_help" as const,
      body: "QA TEST reply",
    };
    await recordSmsSegments({ ...reply, twilioSid: twimlReplySid("SMinbound1") });
    await recordSmsSegments({ ...reply, twilioSid: twimlReplySid("SMinbound1") });
    expect(
      fake.tables.sms_usage_events.filter((r) => r.twilio_sid === "SMinbound1:reply"),
    ).toHaveLength(1);
  });

  it("the inbound webhook records its reply with that key", () => {
    const src = readFileSync("src/routes/api/public/hooks/twilio.ts", "utf8");
    const reply = src.slice(src.indexOf("const { recordSmsSegments, twimlReplySid }"));
    expect(reply.slice(0, 400)).toMatch(/twilioSid: twimlReplySid\(sid\)/);
  });
});

// Every business text must say who it is billed to, so it is counted.
describe("every sender is counted", () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  it("each sendTwilioSms call in src passes `usage`", () => {
    const bad: string[] = [];
    for (const f of walk("src")) {
      if (f.endsWith("twilio.server.ts")) continue;
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/sendTwilioSms\(\{/g)) {
        const end = s.indexOf("});", m.index!);
        if (!s.slice(m.index!, end).includes("usage:")) bad.push(f);
      }
    }
    expect(bad).toEqual([]);
  });
});
