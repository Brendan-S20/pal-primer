// Real Postgres proof that an overnight sitter's other visits that evening
// are found and only warned about (#411 review, item 7). Skipped without
// TEST_SUPABASE_* env. No production credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let nightService: string;
const shift = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 14 + n);
  return d.toISOString().slice(0, 10);
};

async function home(name: string) {
  const clientId = await insertRow(org.admin, "clients", {
    organization_id: org.orgId,
    display_name: name,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: `${name} St`,
    city: "Austin",
    postal_code: "78701",
  });
  const petId = await insertRow(org.admin, "dogs", {
    organization_id: org.orgId,
    property_id: propertyId,
    name: "Rex",
    active: true,
  });
  return { clientId, propertyId, petId };
}

/** A walk for `staffId` on `on` with the window earliest..latest. */
async function walk(staffId: string, on: string, earliest: string, latest: string) {
  const h = await home(`Walk ${earliest} ${randomUUID().slice(0, 4)}`);
  const subscriptionId = await insertRow(org.admin, "subscriptions", {
    organization_id: org.orgId,
    client_id: h.clientId,
    property_id: h.propertyId,
    account_type: "residential",
    dog_count: 1,
    frequency: "one_time",
    price_cents: 2500,
    service_id: org.serviceId,
    status: "active",
    started_on: on,
    earliest_time: earliest,
    latest_time: latest,
  });
  return insertRow(org.admin, "visits", {
    organization_id: org.orgId,
    client_id: h.clientId,
    property_id: h.propertyId,
    subscription_id: subscriptionId,
    service_id: org.serviceId,
    scheduled_on: on,
    status: "scheduled",
    assigned_staff_id: staffId,
  });
}

describe.skipIf(!dbEnabled)("an overnight sitter's other visits", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Stay clashes");
    expect(
      (
        await org.admin
          .from("organizations")
          .update({ service_lines: ["pet_sitting", "dog_walking"] })
          .eq("id", org.orgId)
      ).error,
    ).toBeNull();
    nightService = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Overnight care",
      service_line: "pet_sitting",
      price_unit: "night",
      base_price_cents: 6000,
    });
  });
  afterAll(async () => {
    await org?.cleanup();
  });

  it("warns about an evening or early walk for the overnight sitter, and nothing else", async () => {
    const sitter = org.walker.staffId!;
    // Daytime and another sitter's evening walk are fine.
    await walk(sitter, shift(0), "12:00", "13:00");
    await walk(org.otherWalker.staffId!, shift(0), "20:00", "21:00");
    const evening = await walk(sitter, shift(0), "18:00", "20:00");

    const h = await home("Overnight client");
    const req = await org.admin.rpc("portal_request_stay", {
      _org_id: org.orgId,
      _client_id: h.clientId,
      _request_key: randomUUID(),
      _input: {
        propertyId: h.propertyId,
        serviceId: nightService,
        startsOn: shift(0),
        endsOn: shift(2),
        petIds: [h.petId],
        arrivalEarliest: "19:00",
        arrivalLatest: "21:00",
      },
    });
    expect(req.error).toBeNull();
    const stayId = req.data as string;
    expect(
      (await org.admin.from("stays").update({ assigned_staff_id: sitter }).eq("id", stayId)).error,
    ).toBeNull();
    // Warns, never refuses: the stay confirms with the clash in place.
    const confirmed = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
    expect(confirmed.error).toBeNull();

    const first = await org.owner.client.rpc("stay_sitter_clashes", { _stay_id: stayId });
    expect(first.error).toBeNull();
    expect(first.data).toEqual([
      {
        sitter_name: "Walker walker",
        night_of: shift(0),
        arrival: "19:00:00",
        visit_on: shift(0),
        visit_earliest: "18:00:00",
        visit_latest: "20:00:00",
        client_name: expect.stringMatching(/^Walk 18:00/),
      },
    ]);

    // The morning after the last night, before 8 AM, is still the overnight.
    const early = await walk(sitter, shift(2), "07:00", "07:30");
    await walk(sitter, shift(2), "09:00", "10:00");
    const fromWalk = await org.owner.client.rpc("overnight_clashes", { _visit_ids: [early, evening] });
    expect(fromWalk.error).toBeNull();
    expect((fromWalk.data ?? []).map((c: any) => [c.night_of, c.visit_on, c.visit_earliest])).toEqual([
      [shift(0), shift(0), "18:00:00"],
      [shift(1), shift(2), "07:00:00"],
    ]);

    // Only the office gets an answer.
    expect((await org.walker.client.rpc("stay_sitter_clashes", { _stay_id: stayId })).data).toEqual([]);
    expect((await org.anon.rpc("overnight_clashes", { _visit_ids: [early] })).error).not.toBeNull();

    // Moving the walk to another sitter clears it.
    expect(
      (
        await org.admin
          .from("visits")
          .update({ assigned_staff_id: org.otherWalker.staffId })
          .in("id", [evening, early])
      ).error,
    ).toBeNull();
    expect((await org.owner.client.rpc("stay_sitter_clashes", { _stay_id: stayId })).data).toEqual([]);
  });
});
