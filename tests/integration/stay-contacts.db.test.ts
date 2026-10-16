// Real Postgres proof that confirming a stay warns about a missing emergency
// contact, vet or treatment limit and never refuses (#411 review, blocker
// 3). Skipped without TEST_SUPABASE_* env.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let serviceId: string;
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!dbEnabled)("what a stay is missing for an emergency", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Stay contacts");
    expect(
      (await org.admin.from("organizations").update({ service_lines: ["pet_sitting"] }).eq("id", org.orgId))
        .error,
    ).toBeNull();
    serviceId = await insertRow(org.admin, "services", {
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

  it("names the gaps, confirms anyway, and clears as the office fills them in", async () => {
    const clientId = await insertRow(org.admin, "clients", {
      organization_id: org.orgId,
      display_name: "Contacts client",
      account_type: "residential",
      active: true,
    });
    const propertyId = await insertRow(org.admin, "properties", {
      organization_id: org.orgId,
      client_id: clientId,
      street: "3 Vet Ln",
    });
    const petId = await insertRow(org.admin, "dogs", {
      organization_id: org.orgId,
      property_id: propertyId,
      name: "Luna",
      species: "cat",
      active: true,
    });
    const req = await org.admin.rpc("portal_request_stay", {
      _org_id: org.orgId,
      _client_id: clientId,
      _request_key: randomUUID(),
      _input: { propertyId, serviceId, startsOn: day(20), endsOn: day(22), petIds: [petId] },
    });
    expect(req.error).toBeNull();
    const stayId = req.data as string;

    const before = await org.owner.client.rpc("stay_contact_gaps", { _stay_id: stayId });
    expect(before.error).toBeNull();
    expect(before.data).toEqual(["emergency_contact", "vet", "treatment_limit"]);

    const confirmed = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
    expect(confirmed.error).toBeNull();

    expect(
      (
        await org.owner.client
          .from("clients")
          .update({
            emergency_contact_name: "Sam",
            emergency_contact_phone: "512-555-0100",
            emergency_contact_may_approve_vet: true,
            vet_treatment_limit_cents: 30000,
          })
          .eq("id", clientId)
      ).error,
    ).toBeNull();
    expect(
      (
        await org.owner.client
          .from("dogs")
          .update({ vet_clinic_name: "Eastside", vet_clinic_phone: "512-555-0199" })
          .eq("id", petId)
      ).error,
    ).toBeNull();
    expect((await org.owner.client.rpc("stay_contact_gaps", { _stay_id: stayId })).data).toEqual([]);

    // A sitter does not get the office's answer; they read the columns on the card.
    expect((await org.walker.client.rpc("stay_contact_gaps", { _stay_id: stayId })).data).toBeNull();
    expect((await org.anon.rpc("stay_contact_gaps", { _stay_id: stayId })).error).not.toBeNull();
  });

  it("refuses a negative limit or an overlong phone", async () => {
    const clientId = await insertRow(org.admin, "clients", {
      organization_id: org.orgId,
      display_name: "Limits client",
      account_type: "residential",
      active: true,
    });
    const neg = await org.admin.from("clients").update({ vet_treatment_limit_cents: -1 }).eq("id", clientId);
    expect(neg.error).not.toBeNull();
    const long = await org.admin
      .from("clients")
      .update({ emergency_contact_phone: "1".repeat(41) })
      .eq("id", clientId);
    expect(long.error).not.toBeNull();
  });
});
