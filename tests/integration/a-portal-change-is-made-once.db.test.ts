/** A portal change is made once, however many times it is pressed (#730,
 *  review of #735, findings 1 and 3), against the real database with
 *  submissions IN PARALLEL: separate connections through PostgREST, so the
 *  row lock and the unique key index are what decide, not the order of a
 *  single session.
 *
 *  The late window is 336 hours (14 days) before the visit day, counted from
 *  the date the visit is ON when the change is asked for. Each case seeds its
 *  OWN visit at a date chosen for what it proves, and asserts the request's
 *  fee_cents before anything is done with it, so no case can pass on a fee
 *  that a previous case left behind or on a fee outside the window
 *  (re-review of 394fd5a: the shared visit had moved to +20, outside the
 *  window, and the "one fee row" assertion could not have held).
 *
 *   * +10 -> +11, six presses with ONE key at once: one request, one answer,
 *     fee 1000 (inside the window);
 *   * +5 -> +6, six presses with SIX keys at once: one change, fee 1000, and
 *     that fee begun six times at once is one fee row of 1000;
 *   * +30 -> +31, outside the window: fee 0, and beginning a fee makes none;
 *   * +12, approval on, six skips at once: one request waits, fee 1500; the
 *     office then moves the visit and the owner's approval is refused.
 *
 *  Local stack only; CI's database job builds the database from the
 *  migrations and runs this suite. Skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let token: string;
let clientId: string;
let propertyId: string;
const today = new Date().toISOString().slice(0, 10);
const shift = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const RESCHEDULE_FEE = 1000;
const CANCEL_FEE = 1500;
const WINDOW_HOURS = 336;

/** A visit of its own, on a plan of its own, so no case shares a date or a
 *  clash check with another. */
async function newVisit(offset: number): Promise<string> {
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
  return insertRow(org.admin, "visits", {
    organization_id: org.orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: org.serviceId,
    scheduled_on: shift(offset),
    status: "scheduled",
  });
}

function press(
  visitId: string,
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

async function requestsFor(visitId: string, where: Record<string, unknown> = {}) {
  let q = org.admin
    .from("portal_change_requests")
    .select("id, status, requested_date, kind, fee_cents")
    .eq("visit_id", visitId);
  for (const [k, v] of Object.entries(where)) q = q.eq(k, v as string);
  const { data, error } = await q;
  expect(error).toBeNull();
  return (data ?? []) as Array<{ id: string; status: string; fee_cents: number }>;
}

async function feeRows(requestId: string) {
  const { data, error } = await org.admin
    .from("portal_change_fee_charges")
    .select("id, amount_cents")
    .eq("request_id", requestId);
  expect(error).toBeNull();
  return (data ?? []) as Array<{ id: string; amount_cents: number }>;
}

describe.skipIf(!dbEnabled)("a portal change is made once, in parallel, in a real database", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Portal change once");
    token = randomUUID();
    clientId = await insertRow(org.admin, "clients", {
      organization_id: org.orgId,
      display_name: "Change Once Client",
      account_type: "residential",
      active: true,
      portal_token: token,
    });
    propertyId = await insertRow(org.admin, "properties", {
      organization_id: org.orgId,
      client_id: clientId,
      street: "1 Once St",
      city: "Austin",
      postal_code: "78701",
    });
    // The owner, signed in, chooses INSTANT and late fees for a 14-day window.
    const set = await org.owner.client.rpc("set_portal_change_settings", {
      _org: org.orgId,
      _policy: "instant",
      _autocharge: null,
      _rules: [
        {
          service_line: "dog_walking",
          cutoff_hours: 0,
          late_window_hours: WINDOW_HOURS,
          late_reschedule_fee_cents: RESCHEDULE_FEE,
          late_cancel_fee_cents: CANCEL_FEE,
        },
      ],
    });
    expect(set.error).toBeNull();
  }, 120_000);

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  it("+10 -> +11, six presses with one key at once: one request, one answer, the window's fee", async () => {
    const visitId = await newVisit(10);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => press(visitId, "reschedule", shift(11), key, RESCHEDULE_FEE)),
    );
    for (const r of results) expect(r.error).toBeNull();
    const ids = new Set(results.map((r) => (r.data as { request_id: string }).request_id));
    expect(ids.size).toBe(1);
    const made = await requestsFor(visitId);
    expect(made).toHaveLength(1);
    expect(made[0].fee_cents).toBe(RESCHEDULE_FEE);
  });

  it("+5 -> +6, six presses with six keys at once: one change, and its fee begun six times is one fee row", async () => {
    const visitId = await newVisit(5);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        press(visitId, "reschedule", shift(6), randomUUID(), RESCHEDULE_FEE),
      ),
    );
    const ok = results.filter((r) => !r.error);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((r) => r.error)) {
      expect(r.error!.message).toMatch(/This visit is already on that date/);
    }
    const made = await requestsFor(visitId);
    expect(made).toHaveLength(1);
    const requestId = (ok[0].data as { request_id: string }).request_id;
    expect(made[0].id).toBe(requestId);
    // The fee is asserted BEFORE it is begun: inside the window, the rule's.
    expect((ok[0].data as { fee_cents: number }).fee_cents).toBe(RESCHEDULE_FEE);
    expect(made[0].fee_cents).toBe(RESCHEDULE_FEE);

    const begun = await Promise.all(
      Array.from({ length: 6 }, () =>
        org.admin.rpc("begin_portal_change_fee", { _request_id: requestId }),
      ),
    );
    for (const b of begun) expect(b.error).toBeNull();
    const created = begun.filter((b) => (b.data as { created: boolean }).created);
    expect(created).toHaveLength(1);
    const fees = await feeRows(requestId);
    expect(fees).toHaveLength(1);
    expect(fees[0].amount_cents).toBe(RESCHEDULE_FEE);
  });

  it("+30 -> +31, outside the window: the change carries no fee, and no fee row is made", async () => {
    const visitId = await newVisit(30);
    const r = await press(visitId, "reschedule", shift(31), randomUUID(), null);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ status: "applied", fee_cents: 0 });
    const [made] = await requestsFor(visitId);
    expect(made.fee_cents).toBe(0);

    const begun = await org.admin.rpc("begin_portal_change_fee", { _request_id: made.id });
    expect(begun.error).toBeNull();
    expect(begun.data).toEqual({ charge: null, created: false });
    expect(await feeRows(made.id)).toHaveLength(0);
  });

  it("+12, approval on: six skips at once leave one request waiting, with the window's fee", async () => {
    const set = await org.owner.client.rpc("set_portal_change_settings", {
      _org: org.orgId,
      _policy: "approval",
      _autocharge: null,
      _rules: null,
    });
    expect(set.error).toBeNull();
    const visitId = await newVisit(12);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => press(visitId, "cancel", null, randomUUID(), CANCEL_FEE)),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    for (const r of results.filter((r) => r.error)) {
      expect(r.error!.message).toMatch(/already waiting/);
    }
    const pending = await requestsFor(visitId, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].fee_cents).toBe(CANCEL_FEE);

    // The office then moves the visit, and the owner's approval is refused.
    const moved = await org.admin
      .from("visits")
      .update({ scheduled_on: shift(40) })
      .eq("id", visitId);
    expect(moved.error).toBeNull();
    const decided = await org.owner.client.rpc("decide_portal_change_request", {
      _request_id: pending[0].id,
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
    // Nothing was charged for a change that was not made.
    expect(await feeRows(pending[0].id)).toHaveLength(0);
  });
});
