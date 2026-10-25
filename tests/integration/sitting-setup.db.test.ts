import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { DB_SERVICE, DB_URL, dbEnabled, insertRow } from "../support/walk-db";

describe.skipIf(!dbEnabled)("a sitting business starts with its own catalog", () => {
  it("seeds prices once and never overwrites an owner's price", async () => {
    const db = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
    const orgId = await insertRow(db, "organizations", {
      name: "Sitting setup proof",
      slug: `sit-setup-${crypto.randomUUID()}`,
      service_lines: ["pet_sitting"],
    });
    try {
      const { data, error } = await db
        .from("services")
        .select("id,name,price_unit,base_price_cents,default_duration_min")
        .eq("organization_id", orgId)
        .eq("service_line", "pet_sitting")
        .order("name");
      expect(error).toBeNull();
      expect(
        data?.map(({ name, price_unit, base_price_cents, default_duration_min }) => ({
          name,
          price_unit,
          base_price_cents,
          default_duration_min,
        })),
      ).toEqual([
        { name: "Drop-in", price_unit: "visit", base_price_cents: 2500, default_duration_min: 30 },
        {
          name: "House sit",
          price_unit: "night",
          base_price_cents: 10000,
          default_duration_min: null,
        },
        {
          name: "Overnight stay",
          price_unit: "night",
          base_price_cents: 7500,
          default_duration_min: null,
        },
      ]);
      expect(
        (await db.from("services").update({ base_price_cents: 3200 }).eq("id", data![0].id)).error,
      ).toBeNull();
      expect(
        (
          await db
            .from("organizations")
            .update({ service_lines: ["pet_sitting"] })
            .eq("id", orgId)
        ).error,
      ).toBeNull();
      const repeated = await db
        .from("services")
        .select("base_price_cents")
        .eq("organization_id", orgId)
        .eq("service_line", "pet_sitting")
        .order("name");
      expect(repeated.data?.map((s) => s.base_price_cents)).toEqual([3200, 10000, 7500]);
    } finally {
      await db.from("organizations").delete().eq("id", orgId);
    }
  });
});
