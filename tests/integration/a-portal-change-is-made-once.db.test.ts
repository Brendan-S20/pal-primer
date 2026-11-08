/** A portal change is made once, however many times it is pressed (#730,
 *  review of #735, findings 1 and 3), against the real database with
 *  submissions IN PARALLEL: separate connections through PostgREST, so the
 *  row lock and the unique key index are what decide, not the order of a
 *  single session.
 *
 *   * six presses carrying ONE key, at once: one request, one answer for all;
 *   * six presses with SIX keys for the same change, at once: one succeeds,
 *     the rest are refused (the visit is already on that day);
 *   * the fee for that change, begun six times at once: one fee row;
 *   * with approval on, six skips at once: one request waits;
 *   * the office then moves the visit, and the owner's approval is refused.
 *
 *  Local stack only; CI's database job builds the database from the
 *  migrations and runs this suite. Skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let token: string;
let visitId: string;
const today = new Date().toISOString().slice(0, 10);
const shift = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function press(
  kind: "reschedule" | "cancel",
  newDate: string | null,
  key: string,
  fee: number | null,
) {
  return org.admin.rpc("portal_request_visit_change", {
    _token: token,
    _visit_id: visitId,
    _kind: kind,
    _new_date: newDate,
    _reason: "",
    _accepted_fee_cents: fee,
    _idempotency_key: key,
  });
}

async function requestsFor(where: Record<string, unknown> = {}) {
  let q = org.admin
    .from("portal_change_requests")
    .select("id, status, requested_date, kind")
    .eq("visit_id", visitId);
  for (const [k, v] of Object.entries(where)) q = q.eq(k, v as string);
  const { data, error } = await q;
  expect(error).toBeNull();
  return data ?? [];
}

describe.skipIf(!dbEnabled)("a portal change is made once, in parallel, in a real database", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Portal change once");
    token = randomUUID();
    const clientId = await insertRow(org.admin, "clients", {
      organization_id: org.orgId,
      display_name: "Change Once Client",
      account_type: "residential",
      active: true,
      portal_token: token,
    });
    const propertyId = await insertRow(org.admin, "properties", {
      organization_id: org.orgId,
      client_id: clientId,
      street: "1 Once St",
      city: "Austin",
      postal_code: "78701",
    });
    const subscriptionId = await insertRow(org.admin, "subscriptions", {
      organization_id: org.orgId,
      client_id: clientId,
      property_id: propertyId,
      account_type: "residential",
      dog_count: 1,
      frequency: "one_time",
      price_cents: 2500,
      service_id: org.serviceId,
      status: "active",
      started_on: today,
    });
    visitId = await insertRow(org.admin, "visits", {
      organization_id: org.orgId,
      client_id: clientId,
      property_id: propertyId,
      subscription_id: subscriptionId,
      service_id: org.serviceId,
      scheduled_on: shift(10),
      status: "scheduled",
    });
    // The owner, signed in, chooses INSTANT and a late reschedule fee whose
    // window is already open for this visit.
    const set = await org.owner.client.rpc("set_portal_change_settings", {
      _org: org.orgId,
      _policy: "instant",
      _autocharge: null,
      _rules: [
        {
          service_line: "dog_walking",
          cutoff_hours: 0,
          late_window_hours: 336,
          late_reschedule_fee_cents: 1000,
          late_cancel_fee_cents: 1500,
        },
      ],
    });
    expect(set.error).toBeNull();
  }, 120_000);

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  it("six presses with one key, at once, make one request and get one answer", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => press("reschedule", shift(20), key, 1000)),
    );
    for (const r of results) expect(r.error).toBeNull();
    const ids = new Set(results.map((r) => (r.data as { request_id: string }).request_id));
    expect(ids.size).toBe(1);
    expect(await requestsFor({ requested_date: shift(20) })).toHaveLength(1);
  });

  it("six presses of the same change with six keys, at once: one is made, the rest are refused", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => press("reschedule", shift(22), randomUUID(), 1000)),
    );
    const ok = results.filter((r) => !r.error);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((r) => r.error)) {
      expect(r.error!.message).toMatch(/This visit is already on that date/);
    }
    const made = await requestsFor({ requested_date: shift(22) });
    expect(made).toHaveLength(1);

    // And its fee, begun six times at once, is one fee.
    const requestId = (ok[0].data as { request_id: string }).request_id;
    const begun = await Promise.all(
      Array.from({ length: 6 }, () =>
        org.admin.rpc("begin_portal_change_fee", { _request_id: requestId }),
      ),
    );
    for (const b of begun) expect(b.error).toBeNull();
    const { data: fees } = await org.admin
      .from("portal_change_fee_charges")
      .select("id")
      .eq("request_id", requestId);
    expect(fees).toHaveLength(1);
  });

  it("with approval on, six skips at once leave one request waiting", async () => {
    const set = await org.owner.client.rpc("set_portal_change_settings", {
      _org: org.orgId,
      _policy: "approval",
      _autocharge: null,
      _rules: null,
    });
    expect(set.error).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => press("cancel", null, randomUUID(), 1500)),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    for (const r of results.filter((r) => r.error)) {
      expect(r.error!.message).toMatch(/already waiting/);
    }
    expect(await requestsFor({ status: "pending" })).toHaveLength(1);
  });

  it("the office moves the visit, and the owner's approval of the waiting skip is refused", async () => {
    const [pending] = await requestsFor({ status: "pending" });
    const moved = await org.admin
      .from("visits")
      .update({ scheduled_on: shift(40) })
      .eq("id", visitId);
    expect(moved.error).toBeNull();
    const decided = await org.owner.client.rpc("decide_portal_change_request", {
      _request_id: pending.id,
      _approve: true,
      _note: null,
    });
    expect(decided.error?.message).toMatch(/^STALE_REQUEST:/);
    const { data: visit } = await org.admin
      .from("visits")
      .select("status, scheduled_on")
      .eq("id", visitId)
      .single();
    expect(visit).toEqual({ status: "scheduled", scheduled_on: shift(40) });
  });
});
