// R2-25 (round-2 audit: walk-r2-10, uxqa-r2-10). "Accept signups online" is
// off for a new business, and public_services answers only when it is on, so
// the link was a bare quote form with no service picker: a walk-and-sit
// business's leads could not say which. And a visitor from an out-of-area ZIP
// was thanked and heard nothing, while the office saw "Outside your service
// area" on /leads.
//
// Plus RC3 on the same page: a business that runs no pet waste still held an
// active seeded "Pet waste removal", which the link listed, and bookingLine
// then spoke for pet waste ("Tell us about your property").
//
// The switch is untouched: with it off nothing is sold (instantStart stays
// false), the form only asks.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { linkServicesForLines, type PublicService } from "@/lib/public-services";
import { bookingLine } from "@/lib/booking-copy";
import { outOfAreaSentNote } from "@/lib/booking-page";
import { leadServiceAreas } from "@/lib/lead-service-area.server";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const pub = (
  id: string,
  service_line: PublicService["service_line"],
  name = id,
): PublicService => ({
  id,
  name,
  service_line,
  price_unit: "visit",
  base_price_cents: service_line === "pet_waste" ? null : 3000,
  extra_pet_cents: 0,
  default_duration_min: null,
});

describe("the link lists the business's own services", () => {
  const listed = [pub("sit", "pet_sitting"), pub("waste", "pet_waste"), pub("walk", "dog_walking")];

  it("leaves the seeded pet-waste service off a business that does not scoop", () => {
    const out = linkServicesForLines(listed, ["dog_walking", "pet_sitting"]);
    expect(out.map((s) => s.id)).toEqual(["walk", "sit"]);
    expect(bookingLine(out, null, ["dog_walking", "pet_sitting"])).toBe("dog_walking");
  });

  it("keeps it, first, for a business that does", () => {
    expect(linkServicesForLines(listed, ["pet_waste", "dog_walking"]).map((s) => s.id)).toEqual([
      "waste",
      "walk",
      "sit",
    ]);
  });

  it("orders by line and keeps the given order inside a line", () => {
    const two = [
      pub("b", "dog_walking", "60-minute walk"),
      pub("a", "dog_walking", "30-minute walk"),
    ];
    expect(linkServicesForLines(two, ["dog_walking"]).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("the form lookup lists services with the switch off, on public_services' terms", () => {
    const fns = read("src/lib/signup.functions.ts");
    expect(fns).toMatch(/enabled\s*\?\s*sb\.rpc\("public_services", \{ _slug: data\.slug \}\)/);
    expect(fns).toMatch(
      /\.eq\("organization_id", found\.id\)\s*\.eq\("active", true\)\s*\.or\("service_line\.eq\.pet_waste,base_price_cents\.not\.is\.null"\)/,
    );
    expect(fns).toMatch(
      /services = linkServicesForLines\(\s*publicServiceChoices\(svcRows, availability\),/,
    );
    // Selling still needs the switch.
    expect(fns).toMatch(/let instantStart = enabled;/);
  });
});

describe("an out-of-area visitor is told", () => {
  it("in words that do not ask again for what was just sent", () => {
    const s = outOfAreaSentNote("Summit Paws", "10001");
    expect(s).toMatch(/doesn't list 10001/);
    expect(s).toMatch(/have your request/);
    expect(s).not.toMatch(/Leave your details/);
  });

  it("the endpoint answers with the office's own verdict, and still saves the lead", () => {
    const api = read("src/routes/api/public/leads.ts");
    expect(api).toMatch(/leadServiceAreas\(supabaseAdmin, orgId, \[location\]\)/);
    expect(api).toMatch(/JSON\.stringify\(\{ ok: true, serviceArea \}\)/);
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/setSentOutside\(r\?\.serviceArea === "outside"\)/);
    expect(flow).toMatch(/outOfAreaSentNote\(formQ\.data\.name, form\.postal_code\)/);
  });

  it("/leads reads the same helper", () => {
    expect(read("src/lib/leads.functions.ts")).toMatch(/leadServiceAreas\(\s*context\.supabase,/);
  });
});

describe("leadServiceAreas", () => {
  const db = (zones: unknown[] | null, rpcError = false) => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: async () =>
          zones === null
            ? { data: null, error: { message: "boom" } }
            : { data: zones, error: null },
      };
      return q;
    },
    rpc: async () =>
      rpcError ? { data: null, error: { message: "no" } } : { data: [], error: null },
  });
  const zipZone = {
    id: "z1",
    priority: 0,
    account_type: "all",
    postal_prefix: null,
    zip_codes: ["80202", "80203"],
    geo_match_mode: "zip",
    boundary: null,
    center_latitude: null,
    center_longitude: null,
    radius_meters: null,
    drive_time_minutes: null,
    enabled: true,
  };

  it("inside and outside a ZIP-listed zone", async () => {
    const out = await leadServiceAreas(db([zipZone]), "org", [
      "Denver CO 80202",
      "New York NY 10001",
    ]);
    expect(out).toEqual(["inside", "outside"]);
  });

  it("a failed zone read is unknown, never outside", async () => {
    expect(await leadServiceAreas(db(null), "org", ["10001"])).toEqual(["unknown"]);
  });

  it("a zone that is off serves nobody new", async () => {
    const out = await leadServiceAreas(db([{ ...zipZone, enabled: false }]), "org", ["80202"]);
    expect(out[0]).not.toBe("inside");
  });
});
