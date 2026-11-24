/** Two texts for one business at the same moment are both counted, and the
 *  bill counts the ledger, not the rollup (#1032 follow-up, Product review
 *  6030711620, M3; and S2).
 *
 *  tg_sms_usage_rollup recounts a month in an AFTER trigger. Before
 *  20261124120000, under READ COMMITTED, a send whose transaction was still
 *  open and a second send for the same business and month each summed
 *  without the other's row; the second waited on the period row, then wrote
 *  its own stale sum. Ledger 2, rollup 1. The migration makes the recount
 *  take a per-org, per-month advisory lock first, and claim_sms_overage
 *  recounts from the ledger inside the claim.
 *
 *  This drives it for real: transaction A inserts a send and holds its
 *  transaction open; transaction B inserts a second send meanwhile; A
 *  commits. On the merged trigger this reads ledger 2 / rollup 1 (reproduced
 *  against a scratch Postgres 16 when the fix was written). Two separate
 *  psql connections, because one connection cannot race itself.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env; the race needs
 *  TEST_SUPABASE_DB_URL and psql. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const DB_URL = process.env.TEST_SUPABASE_DB_URL;
const enabled = Boolean(URL && SERVICE);

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: enabled ? createClient(URL!, SERVICE!, { auth: { persistSession: false } }) : {},
}));

import { recordSmsSegments, twimlReplySid } from "@/lib/sms-usage.server";

let admin: SupabaseClient;
let orgId: string;
const runId = Math.random().toString(36).slice(2, 10);

function psql(sql: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("psql", [DB_URL!, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const insertEvent = (month: string, n = 1) =>
  `INSERT INTO public.sms_usage_events (organization_id, period_month, direction, kind, num_segments, encoding)
   VALUES ('${orgId}', '${month}', 'outbound', 'client_message', ${n}, 'GSM-7');`;

async function ledgerAndRollup(month: string): Promise<{ ledger: number; rollup: number }> {
  const { data: ev, error: e1 } = await admin
    .from("sms_usage_events")
    .select("num_segments")
    .eq("organization_id", orgId)
    .eq("period_month", month);
  if (e1) throw new Error(e1.message);
  const { data: p, error: e2 } = await admin
    .from("sms_usage_periods")
    .select("segments")
    .eq("organization_id", orgId)
    .eq("period_month", month)
    .maybeSingle();
  if (e2) throw new Error(e2.message);
  return {
    ledger: (ev ?? []).reduce((s, r: { num_segments: number }) => s + r.num_segments, 0),
    rollup: (p as { segments: number } | null)?.segments ?? 0,
  };
}

describe.skipIf(!enabled)("two texts at once are both counted", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    const { data, error } = await admin
      .from("organizations")
      .insert({ name: `QA TEST Texting Race ${runId}`, timezone: "UTC" })
      .select("id")
      .single();
    if (error) throw new Error(`insert organizations: ${error.message}`);
    orgId = (data as { id: string }).id;
  });

  it.skipIf(!DB_URL)(
    "a send that lands while another is still open is not lost from the month",
    async () => {
      const month = "2026-03-01";
      // A: insert, then keep the transaction open past B's insert.
      const a = psql(`BEGIN; ${insertEvent(month)} SELECT pg_sleep(2); COMMIT;`);
      await new Promise((r) => setTimeout(r, 600));
      // B: a second send for the same business and month, meanwhile.
      const b = psql(insertEvent(month));
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.status, ra.stderr).toBe(0);
      expect(rb.status, rb.stderr).toBe(0);
      expect(await ledgerAndRollup(month)).toEqual({ ledger: 2, rollup: 2 });
    },
    20_000,
  );

  it.skipIf(!DB_URL)(
    "the claim bills the ledger's count even when the rollup is stale",
    async () => {
      const month = "2026-04-01";
      // 1,500 counted through the trigger, then 1 more written with the
      // trigger held off: the rollup says 1,500 ($10), the ledger 1,501 ($20).
      const r = await psql(
        `${insertEvent(month, 1500)}
         BEGIN;
         ALTER TABLE public.sms_usage_events DISABLE TRIGGER sms_usage_rollup;
         ${insertEvent(month, 1)}
         ALTER TABLE public.sms_usage_events ENABLE TRIGGER sms_usage_rollup;
         COMMIT;`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(await ledgerAndRollup(month)).toEqual({ ledger: 1501, rollup: 1500 });

      const { data, error } = await admin.rpc("claim_sms_overage", {
        _org_id: orgId,
        _period_month: month,
        _can_charge: true,
      });
      expect(error).toBeNull();
      const claim = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
      expect(claim).toMatchObject({ outcome: "claimed", segments: 1501, blocks: 2, cents: 2000 });

      const { data: period } = await admin
        .from("sms_usage_periods")
        .select("segments, billed_segments, billed_blocks, billed_cents, billed_at")
        .eq("organization_id", orgId)
        .eq("period_month", month)
        .single();
      expect(period).toMatchObject({
        segments: 1501,
        billed_segments: 1501,
        billed_blocks: 2,
        billed_cents: 2000,
      });
      expect((period as { billed_at: string | null }).billed_at).toBeTruthy();

      // Claimed once: a second call changes nothing.
      const again = await admin.rpc("claim_sms_overage", {
        _org_id: orgId,
        _period_month: month,
        _can_charge: true,
      });
      expect(((again.data as Array<Record<string, unknown>>)[0] ?? {}).outcome).toBe(
        "already_billed",
      );
    },
    20_000,
  );

  it.skipIf(!DB_URL)("a signed-in user cannot run claim_sms_overage", () => {
    const run = (role: string) =>
      spawnSync(
        "psql",
        [
          DB_URL!,
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
          "-c",
          `BEGIN; SET LOCAL ROLE ${role}; SELECT count(*) FROM public.claim_sms_overage('${orgId}', '2026-01-01', false); ROLLBACK;`,
        ],
        { encoding: "utf8" },
      );
    for (const role of ["authenticated", "anon"]) {
      const r = run(role);
      expect(r.status, role).not.toBe(0);
      expect(r.stderr, role).toMatch(/permission denied for function claim_sms_overage/);
    }
  });

  // S2: a TwiML reply has no SID of its own. Keyed to the inbound SID it
  // answers, a retried webhook that records it twice counts it once.
  it("a TwiML reply recorded twice for one inbound text counts once", async () => {
    const inbound = `SM${randomUUID().replace(/-/g, "")}`;
    const key = twimlReplySid(inbound)!;
    const reply = {
      orgId,
      direction: "outbound" as const,
      kind: "stop_help" as const,
      body: "QA TEST: reply STOP to opt out",
    };
    await recordSmsSegments({ ...reply, twilioSid: key });
    await recordSmsSegments({ ...reply, twilioSid: key });
    const { count, error } = await admin
      .from("sms_usage_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("twilio_sid", key);
    expect(error).toBeNull();
    expect(count).toBe(1);
  });
});
