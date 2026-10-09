// Service-role access to the LOCAL database, for the half of a round trip a
// browser cannot assert.
//
// The behavioural specs drive the UI and then ask Postgres whether the write
// actually landed — an invoice row with status 'paid', a payments row whose
// raw_event says where it came from, a resolution note on a review item. A
// green page is not that proof: the page could be reading its own cache, and
// twice in this repo's history a page has looked right while the database
// disagreed (the trigger that silently overrode is_field_tech, the fixture
// whose timestamps every consumer parsed into Invalid Date).
//
// Same allowlist as seed.mjs and the proxy, for the same reason: this client
// holds the service-role key and some setup here DELETES rows, so it must be
// structurally impossible to aim it at anything that is not local. An
// allowlist rather than a denylist, because a denylist is wrong the first
// time somebody adds a host to it.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** The org seed.mjs builds. The name is duplicated from ORG_NAME there —
 *  importing it is impossible because seed.mjs RUNS the seed at import — and
 *  seed.mjs carries a pointer back here so the two copies move together. */
export const E2E_ORG_NAME = "E2E Demo Yard";

export function serviceDb(): SupabaseClient {
  if (!LOCAL.test(new URL(URL_).origin)) {
    throw new Error(
      `refusing a service-role client for ${URL_}; these specs delete and ` +
        `insert rows, so they only ever run against a local database`,
    );
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. `supabase status` prints it; " +
        "tests/e2e/run.sh exports it.",
    );
  }
  return createClient(URL_, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function e2eOrgId(db: SupabaseClient): Promise<string> {
  const { data, error } = await db
    .from("organizations")
    .select("id")
    .eq("name", E2E_ORG_NAME)
    .single();
  if (error || !data) {
    throw new Error(
      `could not find the seeded org "${E2E_ORG_NAME}" — did tests/e2e/seed.mjs run? (${error?.message})`,
    );
  }
  return data.id;
}

/**
 * Today, as the seeded business counts it: the date in the org's own time
 * zone, never the runner's and never UTC.
 *
 * Every page and server function decides "today" with `orgToday(tz)`. A spec
 * that decides it with `new Date().toISOString().slice(0, 10)` agrees with
 * them only while UTC and the org are on the same date — not from 19:00 to
 * midnight in Chicago, five hours of every day — and one that uses the
 * runner's local date disagrees for the hour after midnight Eastern. The
 * board spec found the second on 2026-10-02 (0 received, 1 expected, at
 * 12:08 a.m.); this is that fix, shared, so the next spec does not re-learn it.
 */
export async function businessToday(db: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await db
    .from("organizations")
    .select("timezone")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`reading the org's time zone: ${error.message}`);
  return new Date().toLocaleDateString("en-CA", {
    timeZone: (data?.timezone as string | null) ?? "America/Chicago",
  });
}
