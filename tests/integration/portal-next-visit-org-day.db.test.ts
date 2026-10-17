/**
 * The portal home keeps today's visit (#480).
 *
 * portal_get_client chose the next visit with `scheduled_on >= CURRENT_DATE`,
 * the UTC day. For an org behind UTC that skipped today's visit every evening.
 * 20261017090000 compares against the organization's day instead.
 *
 * Local stack only. Skipped without TEST_SUPABASE_* env (see run-db-tests.sh).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { orgToday } from "@/lib/org-day";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);

// UTC-12, the furthest zone behind UTC. The bug only bites west of UTC: there
// the org's today is the UTC yesterday, which `>= CURRENT_DATE` drops. Here
// that holds from 00:00 to 12:00 UTC, half of every day, the most any zone
// can give. A zone ahead of UTC such as Pacific/Kiritimati differs from UTC
// for longer, but its today is the UTC tomorrow, which the old code kept.
const TZ = "Etc/GMT+12";

const runId = Math.random().toString(36).slice(2, 8);
let admin: SupabaseClient;

let portalToken: string;
let todayVisitId: string;
let today: string;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as any).id as string;
}

describe.skipIf(!enabled)("the portal home keeps today's visit (#480)", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });

    const orgId = await ins("organizations", { name: `Org Day Test ${runId}`, timezone: TZ });
    const zoneId = await ins("zones", {
      organization_id: orgId,
      name: "Test Zone",
      base_price_cents: 2500,
    });
    const clientId = await ins("clients", {
      organization_id: orgId,
      display_name: "Org Day Client",
      account_type: "residential",
      active: true,
    });
    const propertyId = await ins("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Date Line Rd",
      city: "Austin",
      postal_code: "78701",
    });
    const subscriptionId = await ins("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      zone_id: zoneId,
      account_type: "residential",
      dog_count: 1,
      frequency: "weekly",
      price_cents: 2000,
      status: "active",
      started_on: "2026-01-01",
    });

    today = orgToday(TZ);
    todayVisitId = await ins("visits", {
      organization_id: orgId,
      subscription_id: subscriptionId,
      client_id: clientId,
      property_id: propertyId,
      zone_id: zoneId,
      scheduled_on: today,
    });

    const { data } = await admin.from("clients").select("portal_token").eq("id", clientId).single();
    portalToken = (data as any).portal_token;
  });

  it("returns the visit dated the org's today as the next visit", async () => {
    const { data, error } = await admin.rpc("portal_get_client", { _token: portalToken });
    expect(error).toBeNull();
    const row = (data as any[])?.[0];
    expect(row?.next_visit_id).toBe(todayVisitId);
    expect(row?.next_visit_on).toBe(today);
  });
});
