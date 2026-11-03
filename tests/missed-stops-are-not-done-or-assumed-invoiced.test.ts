import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { describe, expect, it } from "vitest";
import { PaymentLine } from "@/components/my-day/StopFacts";
import { dayAtAGlance } from "@/lib/my-day-progress";
import { paymentMode, stopFactsFromRow, type StopFactsRow } from "@/lib/stop-facts";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const visits = (...statuses: string[]) => statuses.map((status, i) => ({ id: `v${i}`, status }));

describe("My Day completion progress", () => {
  it("keeps all eight stops in the denominator and reports three missed separately", () => {
    expect(
      dayAtAGlance(
        visits(
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
          "missed",
          "missed",
          "missed",
        ),
      ),
    ).toMatchObject({ completedCount: 5, missedCount: 3, skippedCount: 0, total: 8, pct: 63 });
  });

  it("never counts missed, skipped, canceled or unfinished visits as done", () => {
    // "canceled" is the status the database writes. A canceled visit is not
    // a stop at all, so it is out of the total too (gaps-r2-08).
    const result = dayAtAGlance(
      visits("missed", "skipped", "canceled", "scheduled", "in_progress"),
    );
    expect(result).toMatchObject({
      completedCount: 0,
      missedCount: 1,
      skippedCount: 1,
      total: 4,
      pct: 0,
    });
    expect(result.nextUp?.status).toBe("in_progress");
  });

  it("moves a missed visit to done only after completion, with the same total", () => {
    const day = visits("completed", "missed");
    expect(dayAtAGlance(day)).toMatchObject({
      completedCount: 1,
      missedCount: 1,
      total: 2,
      pct: 50,
    });
    day[1].status = "completed";
    expect(dayAtAGlance(day)).toMatchObject({
      completedCount: 2,
      missedCount: 0,
      total: 2,
      pct: 100,
    });
  });

  it("handles an empty day and an entirely missed day", () => {
    expect(dayAtAGlance([])).toMatchObject({ completedCount: 0, missedCount: 0, total: 0, pct: 0 });
    expect(dayAtAGlance(visits("missed", "missed"))).toMatchObject({
      completedCount: 0,
      missedCount: 2,
      total: 2,
      pct: 0,
      nextUp: undefined,
    });
  });

  it("shows the rule and missed count using translated UI copy", () => {
    const page = read("src/routes/_authenticated/my-day.tsx");
    expect(page).toContain('t("myDay.missedCount", { count: missedCount })');
    expect(page).toContain('t("myDay.progressRule")');
    for (const locale of [en, es, ar, zh]) {
      expect(locale.myDay.missedCount).toContain("{{count}}");
      expect(locale.myDay.progressRule.length).toBeGreaterThan(0);
    }
  });
});

const row: StopFactsRow = {
  visit_id: "missed-visit",
  dog_count: null,
  autopay: false,
  card_on_file: false,
  pays_cash_check: false,
  open_balance_cents: 9000,
  awaiting_cents: 0,
};

describe("a visit's Invoiced badge", () => {
  it.each([false, null, undefined])("requires a confirmed invoice line, received %s", (value) => {
    const facts = stopFactsFromRow({ ...row, has_invoice_line: value });
    expect(facts.hasInvoiceLine).toBe(false);
    // Another invoice on the customer's account is not evidence for this visit.
    expect(facts.openBalanceCents).toBe(9000);
    expect(paymentMode(facts)).toBeNull();
  });

  it("can show a real prepaid invoice even if the visit later became missed", () => {
    expect(paymentMode(stopFactsFromRow({ ...row, has_invoice_line: true }))).toBe("invoiced");
  });

  it("does not infer an invoice from an older cached day's payment facts", () => {
    const { hasInvoiceLine: _oldField, ...cached } = stopFactsFromRow(row);
    expect(paymentMode(cached)).toBeNull();
  });

  it.each(["en", "es", "ar", "zh"])("renders only the verified badge in %s", async (lng) => {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({
      resources: {
        en: { translation: en },
        es: { translation: es },
        ar: { translation: ar },
        zh: { translation: zh },
      },
      lng,
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
    const render = (hasInvoiceLine?: boolean) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(PaymentLine, { facts: { ...stopFactsFromRow(row), hasInvoiceLine } }),
        ),
      );
    expect(render(false)).not.toContain(i18n.t("pay.invoiced"));
    expect(render()).not.toContain(i18n.t("pay.invoiced"));
    expect(render(true)).toContain(i18n.t("pay.invoiced"));
  });
});

describe("the RPC supplies visit-specific invoice evidence", () => {
  const sql = read("supabase/migrations/20261012120000_a-missed-stop-was-labelled-invoiced.sql");

  it("requires a real line on this visit's client and organization, excluding void invoices", () => {
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM public\.invoice_line_items li\s+JOIN public\.invoices i ON i\.id = li\.invoice_id\s+WHERE li\.visit_id = a\.id\s+AND i\.organization_id = a\.organization_id\s+AND i\.client_id = a\.client_id\s+AND i\.status <> 'void'\s*\)/,
    );
    expect(sql).toContain("has_invoice_line boolean");
  });

  it("keeps the active assigned tech or authorized office scope and restricted execution grants", () => {
    expect(sql).toContain("v.id = ANY (_visit_ids)");
    expect(sql).toContain("auth.uid() IS NOT NULL");
    expect(sql).toContain("s.id = v.assigned_staff_id");
    expect(sql).toContain("s.user_id = auth.uid() AND s.active");
    expect(sql).toContain("s.organization_id = v.organization_id");
    expect(sql).toContain(
      "public.has_permission(auth.uid(), v.organization_id, 'view_client_directory')",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.my_day_stop_facts(uuid[]) FROM PUBLIC, anon;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.my_day_stop_facts(uuid[]) TO authenticated, service_role;",
    );
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });
});

describe("existing invoice generation excludes visits already marked missed", () => {
  // Later migrations splice pricing, descriptions and totals into these
  // generators. Their visit eligibility predicates are unchanged.
  const sql = read(
    "supabase/migrations/20260731210000_a-deep-clean-was-billed-as-an-ordinary-visit.sql",
  );

  it("limits postpaid counting and line creation to completed or explicitly billable skips", () => {
    const postpaid = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice"),
    );
    expect(
      postpaid.match(
        /AND \(v\.status = 'completed' OR \(v\.status = 'skipped' AND v\.skip_billable = true\)\)/g,
      ),
    ).toHaveLength(2);
  });

  it("limits office and portal prepaid invoices to scheduled visits", () => {
    const prepaid = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice"),
    );
    expect(prepaid.match(/AND v\.status = 'scheduled'/g)).toHaveLength(2);
    const portal = read(
      "supabase/migrations/20260701170254_904b67cd-ed43-49eb-af10-f98b1f3bf820.sql",
    );
    expect(portal).toContain("v.status='scheduled' AND li.id IS NULL");
  });
});
