/** A text that had a Twilio SID was never counted (#1032, Rigel's review).
 *
 *  recordSmsSegments writes a text that has a SID with
 *  upsert(..., { onConflict: "twilio_sid" }). Postgres can only infer an
 *  ON CONFLICT target from a unique index with no WHERE clause, and the
 *  ledger's only uniqueness was PARTIAL (WHERE twilio_sid IS NOT NULL), so
 *  every such write failed with "no unique or exclusion constraint matching
 *  the ON CONFLICT specification". The function swallows errors by design, so
 *  zero rows landed, no overage was billed and the ceiling never tripped.
 *  Mocked unit tests cannot see this: it is Postgres refusing the statement.
 *
 *  These drive the app's own recordSmsSegments against real Postgres:
 *    - a text with a SID is counted;
 *    - the same SID recorded twice (a retried webhook) is counted once;
 *    - texts with no SID are each counted, however many there are.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);

// recordSmsSegments reaches the database through supabaseAdmin; point it at
// the same local stack the assertions read from.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: enabled ? createClient(URL!, SERVICE!, { auth: { persistSession: false } }) : {},
}));

import { recordSmsSegments } from "@/lib/sms-usage.server";

let admin: SupabaseClient;
let orgId: string;
const runId = Math.random().toString(36).slice(2, 10);

async function rowsFor(sid: string | null): Promise<number> {
  let q = admin
    .from("sms_usage_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (sid) q = q.eq("twilio_sid", sid);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

describe.skipIf(!enabled)("a text with a Twilio SID is counted once", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    const { data, error } = await admin
      .from("organizations")
      .insert({ name: `SMS sid ${runId}`, timezone: "UTC" })
      .select("id")
      .single();
    if (error) throw new Error(`insert organizations: ${error.message}`);
    orgId = (data as { id: string }).id;
  });

  const base = { direction: "outbound" as const, kind: "client_message" as const };

  it("writes a row for a text that has a SID", async () => {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    await recordSmsSegments({ ...base, orgId, body: "On my way!", twilioSid: sid, numSegments: 1 });
    expect(await rowsFor(sid)).toBe(1);
  });

  it("counts the same SID once when it is recorded twice", async () => {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    await recordSmsSegments({ ...base, orgId, body: "Hello", twilioSid: sid, numSegments: 1 });
    await recordSmsSegments({ ...base, orgId, body: "Hello", twilioSid: sid, numSegments: 1 });
    expect(await rowsFor(sid)).toBe(1);
  });

  it("counts every text that has no SID", async () => {
    const before = await rowsFor(null);
    await recordSmsSegments({ ...base, orgId, body: "one", twilioSid: null });
    await recordSmsSegments({ ...base, orgId, body: "two", twilioSid: null });
    expect(await rowsFor(null)).toBe(before + 2);
  });
});
