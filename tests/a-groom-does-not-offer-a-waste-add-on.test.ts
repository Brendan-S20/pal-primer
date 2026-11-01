// Book a groom offered the pet waste add-ons (#640). Add-ons made before
// service lines had service_line null, and every groom picker read null as
// "offered with any service". The migration names those rows pet_waste and
// makes the column NOT NULL; the pickers offer only mobile_grooming add-ons.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const MIGRATION = "supabase/migrations/20261101090000_an-add-on-names-its-service-line.sql";

describe("a groom does not offer a pet waste add-on", () => {
  it("names every old add-on pet waste and refuses a null line from then on", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(
      /UPDATE public\.addon_services SET service_line = 'pet_waste' WHERE service_line IS NULL;/,
    );
    expect(sql).toMatch(/ALTER COLUMN service_line SET DEFAULT 'pet_waste'/);
    expect(sql).toMatch(/ALTER COLUMN service_line SET NOT NULL/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it("offers and accepts only add-ons marked for grooming, wherever a groom is booked", () => {
    for (const file of [
      "src/lib/groom-booking.functions.ts",
      "src/lib/portal-groom.server.ts",
      "src/lib/groom-booking.server.ts",
    ]) {
      const src = read(file);
      expect(src, file).not.toMatch(/!a\.service_line\s*\|\|/);
      expect(src, file).not.toMatch(/row\.service_line\s*&&/);
      expect(src, file).toMatch(/service_line [!=]== "mobile_grooming"/);
    }
  });

  it("has no 'any service line' choice and no null line on save", () => {
    expect(read("src/components/settings/AddonGroomFields.tsx")).not.toContain("Any service line");
    const fn = read("src/lib/addons.functions.ts");
    expect(fn).toContain("serviceLine: z.enum(SERVICE_LINES).optional()");
    expect(fn).not.toMatch(/serviceLine: z\.enum\(SERVICE_LINES\)\.nullable/);
  });

  it("does not call a one-off visit a clean", () => {
    const src = read("src/components/OneOffVisitDialog.tsx");
    expect(src).not.toMatch(/one-time\s+clean/);
    expect(src).toContain("A single visit on one date, billed like any other visit.");
  });
});
