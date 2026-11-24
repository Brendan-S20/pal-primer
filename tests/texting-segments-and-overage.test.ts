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

const period = (segments: number, o: Partial<Row> = {}): Row => ({
  organization_id: ORG,
  period_month: "2026-07-01",
  segments,
  billed_at: null,
  billed_blocks: null,
  billed_cents: null,
  stripe_invoice_item_id: null,
  ...o,
});

function seed(segments: number) {
  fake.reset({
    organizations: [
      { id: ORG, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", timezone: "America/Chicago" },
    ],
    platform_addons: [
      {
        slug: "managed-sms",
        texting_segments_included: 1000,
        texting_block_size: 500,
        texting_block_cents: 1000,
        texting_ceiling_blocks: 5,
      },
    ],
    sms_usage_periods: [period(segments)],
  });
}

async function run() {
  const { runSmsOverageBilling } = await import("@/lib/sms-overage-billing.server");
  return runSmsOverageBilling();
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
