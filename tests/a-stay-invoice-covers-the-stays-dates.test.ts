// gaps-r2-07: after an early return the stay invoice billed the right nights
// and still said the old period. The shape of the migration that makes an
// unpaid stay invoice's period follow the stay's dates. The round trip is in
// tests/integration/stay-changes.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = "20261102190000_a-stay-invoice-covers-the-stays-dates.sql";
const sql = readFileSync(join(ROOT, "supabase/migrations", FILE), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("a stay invoice covers the stay's dates", () => {
  it("runs on a change of either date, after the update", () => {
    expect(code).toMatch(
      /CREATE TRIGGER stays_invoice_period\s+AFTER UPDATE OF starts_on, ends_on ON public\.stays/,
    );
    expect(code).toContain("EXECUTE FUNCTION public.tg_stays_invoice_period()");
  });

  it("moves the period of a draft or open stay invoice only", () => {
    expect(code).toContain("period_start = NEW.starts_on");
    expect(code).toContain("period_end = NEW.ends_on");
    expect(code).toContain("i.id = NEW.invoice_id");
    expect(code).toContain("i.status IN ('draft', 'open')");
  });

  it("touches no money: no amount, line, credit or deposit", () => {
    for (const word of [
      "total_cents",
      "subtotal_cents",
      "tax_cents",
      "amount_cents",
      "invoice_line_items",
      "credit",
      "deposit",
      "restate_stay_billing",
      "change_stay",
      "invoice_stay",
    ])
      expect(code, word).not.toContain(word);
  });

  it("is not callable through the API", () => {
    expect(code).toContain(
      "REVOKE ALL ON FUNCTION public.tg_stays_invoice_period() FROM PUBLIC, anon, authenticated",
    );
  });

  it("asserts only what it establishes, so it replays on an empty database", () => {
    expect(code).not.toMatch(/cron\./);
    expect(code).not.toMatch(/count\(\*\)\s*[<>=]/i);
  });
});
