// A holiday is not a closure (#411 review, item 6). The labels the owner
// reads and the shape of the migration. The database half is in
// tests/integration/stay-invoices.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holidayDateLabel, holidayNightLabel } from "@/lib/stays";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261024080800_a-holiday-is-not-a-closure.sql");

describe("which night a holiday prices", () => {
  it("the night that starts on the date", () => {
    expect(holidayDateLabel("2026-12-24")).toBe("Thu, Dec 24, 2026");
    expect(holidayNightLabel("2026-12-24")).toBe("Overnights: the night of Dec 24 into Dec 25");
    expect(holidayNightLabel("2026-12-31")).toBe("Overnights: the night of Dec 31 into Jan 1");
  });
});

describe("the migration", () => {
  it("bills from holiday_dates and never from blackout_dates", () => {
    const bill = sql.slice(sql.indexOf("FUNCTION public.stay_visit_bill"), sql.indexOf("$function$;"));
    expect(bill).toMatch(/public\.holiday_dates/);
    expect(bill).not.toMatch(/blackout_dates/);
    const invoice = sql.slice(sql.indexOf("FUNCTION public.invoice_stay"));
    expect(invoice).toMatch(/CROSS JOIN LATERAL public\.stay_visit_bill\(v\.id\) b/);
    expect(invoice.slice(0, invoice.indexOf("$check$"))).not.toMatch(/FROM public\.blackout_dates/);
  });

  it("copies only blackout dates that already have a stay visit", () => {
    expect(sql).toMatch(
      /INSERT INTO public\.holiday_dates[\s\S]*FROM public\.blackout_dates b[\s\S]*s\.stay_id IS NOT NULL[\s\S]*ON CONFLICT/,
    );
  });

  it("gives the table two-step sign-in", () => {
    expect(sql).toMatch(/SELECT public\.require_mfa_policy\('public\.holiday_dates'\);/);
  });
});

describe("Settings", () => {
  it("shows the holiday list to a sitting business on the services page", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/lines\.includes\("pet_sitting"\) && <HolidayDatesCard/);
    expect(page).not.toMatch(/Settings &gt; Blackouts/);
    const card = read("src/components/settings/HolidayDatesCard.tsx");
    expect(card).toMatch(/the night that starts on the date counts/);
  });

  it("writing a holiday date needs manage_pricing", () => {
    const fn = read("src/lib/holidays.functions.ts");
    expect(fn.match(/requirePermission\([^)]*"manage_pricing"\)/g)).toHaveLength(2);
  });
});
