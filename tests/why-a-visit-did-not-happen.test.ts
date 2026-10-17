// The customer could not find out why nobody came.
//
// The portal printed `Skipped: {skip_reason}` — the free-text field a
// technician types at the gate. `skipVisit` requires it, 1 to 500 characters,
// written by whoever was standing there, alongside a structured
// `skip_reason_code` from a fixed vocabulary. The office surfaces render the
// CODE (`skip_reason_code ?? skip_reason`); the customer got the rawest
// version in the product, with nothing marking it internal and nobody writing
// it thinking about a customer reading it.
//
// And the code — which is exactly the answer a customer wants — was not
// returned by the RPC at all, so the page had only the free text.

import { afterAll, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SKIP_REASON_CODES,
  CUSTOMER_SKIP_REASON_LABELS,
  customerSkipReason,
  officeSkipReason,
} from "../src/lib/skip-rules.functions";

const root = join(import.meta.dirname, "..");
afterAll(() => i18n.changeLanguage("en"));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SQL = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(root, "supabase/migrations", f), "utf8"))
  .join("\n");

const fn = () => {
  const at = SQL.lastIndexOf("CREATE OR REPLACE FUNCTION public.portal_list_recent_visits");
  return SQL.slice(at, SQL.indexOf("$function$;", at));
};

describe("a customer is told why, in a sentence somebody would say to them", () => {
  it("has customer wording for every reason the schedule can carry", () => {
    // A code with no customer phrasing renders as a bare identifier or as
    // nothing; both are worse than the internal label it replaced.
    for (const code of SKIP_REASON_CODES) {
      expect(CUSTOMER_SKIP_REASON_LABELS[code], `no customer wording for ${code}`).toBeTruthy();
    }
  });

  it("does not reuse the office's wording, which is about the customer not to them", () => {
    expect(CUSTOMER_SKIP_REASON_LABELS.our_fault).not.toBe("Our fault");
    expect(CUSTOMER_SKIP_REASON_LABELS.client_cancelled_late).not.toBe("Client canceled late");
    expect(CUSTOMER_SKIP_REASON_LABELS.customer_requested).not.toBe("Customer skipped via portal");
  });

  it("falls back rather than printing a code it does not know", () => {
    // The enum lives in the database; a value added there and not here must
    // not reach a customer's screen as `unsafe_conditions_v2`.
    expect(customerSkipReason("a_code_from_the_future")).toBe("Skipped");
    expect(customerSkipReason(null)).toBe("Skipped");
    expect(customerSkipReason(undefined)).toBe("Skipped");
    expect(customerSkipReason("gate_locked")).toBe(CUSTOMER_SKIP_REASON_LABELS.gate_locked);
  });
});

describe("office skip reasons", () => {
  it.each(["en", "es", "ar", "zh"])("uses the %s labels for every known code", async (language) => {
    await i18n.changeLanguage(language);
    for (const code of SKIP_REASON_CODES) {
      expect(officeSkipReason(code)).toBe(i18n.t(`skipReason.${code}`));
      expect(officeSkipReason(code)).not.toBe(code);
    }
  });

  it("keeps unknown codes readable", () => {
    expect(officeSkipReason("reason_from_newer_app")).toBe("Reason from newer app");
    expect(officeSkipReason(null)).toBe("");
  });
});

describe("the technician's own words stay between the technician and the office", () => {
  const ui = strip(read("src/lib/portal-ui.tsx"));

  it("renders the reason from the code", () => {
    expect(ui).toMatch(/customerSkipReason\(r\.skip_reason_code\)/);
  });

  it("shows free text only when the customer wrote it", () => {
    expect(ui).toMatch(/r\.skip_reason_code === "customer_requested" && r\.skip_reason/);
    // And never the bare unconditional version it replaced.
    expect(ui).not.toMatch(/\{r\.skip_reason && <>: \{r\.skip_reason\}<\/>\}/);
  });
});

describe("what a customer's visit list contains", () => {
  it("returns the reason code, which it never did", () => {
    expect(fn()).toMatch(/skip_reason_code text/);
    expect(fn()).toMatch(/v\.skip_reason_code::text/);
  });

  it("still shows completed and skipped visits, and not missed ones", () => {
    // A deliberate product decision, asserted so it is not lost to a later
    // edit: a `missed` visit is an operational state nobody has adjudicated
    // yet — weather, a forgotten close-out, or work that genuinely did not
    // happen — and there are 2,001 of them. Putting an unanswered question in
    // front of a customer is not transparency.
    expect(fn()).toMatch(/v\.status IN \('completed','skipped'\)/);
    expect(fn()).not.toMatch(/'missed'/);
  });

  it("asserts that filter in the migration rather than leaving it to be inferred", () => {
    const at = SQL.lastIndexOf("portal_list_recent_visits no longer restricts");
    expect(at, "the status filter is not asserted anywhere").toBeGreaterThan(-1);
  });
});
