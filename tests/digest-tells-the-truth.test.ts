import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDigestAlerts, formatCents, SKIP_RATE_ALERT_THRESHOLD } from "@/lib/digest-alerts";
import { summarizeAr } from "@/lib/ar";

// QA-P3. The weekly digest told an owner:
//
//     "10 overdue invoices totaling $2,725.00."
//
// Ten invoices really were overdue. They came to $2,550.00. The $2,725.00 was
// every OPEN invoice, including five that were not due yet — the count from
// one figure, the money from another.
//
// `summarizeAr` had returned both all along. The alert read `overdueCount`
// off it and then reached for `arOpenCents`.
//
// This is not a display bug. The sentence exists so an owner can decide who to
// chase, and the number is their sense of how big the problem is; inflating it
// by everything not yet due points them at customers who are not late. And it
// is EMAILED weekly, so the wrong figure left the building rather than merely
// appearing on a screen.
//
// It survived because `computeDigestMetrics` needs a database and a live org,
// so every string it produced was only ever checked by reading it. The
// sentences are pure now.

/** The live numbers from the QA run, as invoices. Five open-not-yet-due
 *  ($175.00) and ten overdue ($2,550.00) — $2,725.00 in total. */
const LEDGER = [
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `overdue-${i}`,
    client_id: "c",
    status: "open",
    total_cents: 255_000 / 10, // $255.00 each → $2,550.00
    credit_applied_cents: 0,
    due_on: "2026-07-15",
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `not-yet-${i}`,
    client_id: "c",
    status: "open",
    total_cents: 17_500 / 5, // $35.00 each → $175.00
    credit_applied_cents: 0,
    due_on: "2026-08-30",
  })),
] as never[];

describe("the two figures the alert confused", () => {
  const ar = summarizeAr(LEDGER, "2026-08-01");

  it("are genuinely different, which is why swapping them was invisible", () => {
    // Both are plausible money. Nothing about $2,725.00 looks wrong next to
    // "10 overdue invoices" unless you already know the answer.
    expect(ar.overdueCount).toBe(10);
    expect(ar.overdueCents).toBe(255_000);
    expect(ar.arOpenCents).toBe(272_500);
    expect(ar.openCount).toBe(15);
  });

  it("summarizeAr had both available the whole time", () => {
    // The fix was not new arithmetic. It was reading the field that was
    // already there.
    expect(ar).toHaveProperty("overdueCents");
    expect(ar).toHaveProperty("arOpenCents");
  });
});

describe("the receivables alert", () => {
  const ar = summarizeAr(LEDGER, "2026-08-01");

  it("quotes what the OVERDUE invoices come to", () => {
    const [alert] = buildDigestAlerts({
      overdueCount: ar.overdueCount,
      overdueCents: ar.overdueCents,
      complaintsCount: 0,
      visitsSkipped: 0,
      visitsCompleted: 0,
    });
    expect(alert).toBe("10 overdue invoices totaling $2,550.00.");
    expect(alert, "the whole open ledger is back in the sentence").not.toContain("2,725");
  });

  it("says nothing when nothing is overdue", () => {
    expect(
      buildDigestAlerts({
        overdueCount: 0,
        overdueCents: 0,
        complaintsCount: 0,
        visitsSkipped: 0,
        visitsCompleted: 10,
      }),
    ).toEqual([]);
  });

  it("reads correctly for a single invoice", () => {
    const [alert] = buildDigestAlerts({
      overdueCount: 1,
      overdueCents: 4_500,
      complaintsCount: 0,
      visitsSkipped: 0,
      visitsCompleted: 0,
    });
    // "1 overdue invoices" in a report to a business owner reads as a bug in
    // the product, whatever else is right about it.
    expect(alert).toBe("1 overdue invoice totaling $45.00.");
  });
});

describe("the other alerts", () => {
  const base = {
    overdueCount: 0,
    overdueCents: 0,
    complaintsCount: 0,
    visitsSkipped: 0,
    visitsCompleted: 0,
  };

  it("counts complaints, and pluralizes them", () => {
    expect(buildDigestAlerts({ ...base, complaintsCount: 1 })[0]).toBe(
      "1 client complaint logged this week.",
    );
    expect(buildDigestAlerts({ ...base, complaintsCount: 3 })[0]).toBe(
      "3 client complaints logged this week.",
    );
  });

  it("raises a skip rate above the threshold", () => {
    // 3 of 20 = 15%.
    const [alert] = buildDigestAlerts({ ...base, visitsSkipped: 3, visitsCompleted: 17 });
    expect(alert).toBe("Skip rate is 15%, above the 10% threshold.");
  });

  it("stays quiet at or below the threshold", () => {
    // 2 of 20 = 10%, which is the threshold rather than above it.
    expect(buildDigestAlerts({ ...base, visitsSkipped: 2, visitsCompleted: 18 })).toEqual([]);
    expect(SKIP_RATE_ALERT_THRESHOLD).toBe(0.1);
  });

  it("does not report 100% for a week with no completed visits", () => {
    // Three skips and nothing completed is true and useless: it describes an
    // org that did not work that week, not one with a skip problem.
    expect(buildDigestAlerts({ ...base, visitsSkipped: 3, visitsCompleted: 0 })).toEqual([]);
  });

  it("reports everything wrong at once, in priority order", () => {
    const alerts = buildDigestAlerts({
      overdueCount: 2,
      overdueCents: 10_000,
      complaintsCount: 1,
      visitsSkipped: 5,
      visitsCompleted: 10,
    });
    expect(alerts).toHaveLength(3);
    // Money first — it is the one with a deadline attached.
    expect(alerts[0]).toContain("overdue");
    expect(alerts[1]).toContain("complaint");
    expect(alerts[2]).toContain("Skip rate");
  });
});

describe("formatCents", () => {
  it("renders whole dollars and cents", () => {
    expect(formatCents(255_000)).toBe("$2,550.00");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
  });

  it("survives a missing figure rather than printing NaN", () => {
    expect(formatCents(undefined as unknown as number)).toBe("$0.00");
  });
});

// ── the wiring ────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("the digest builds its alerts here and nowhere else", () => {
  const src = code(read("src/lib/digest.server.ts"));

  it("calls the shared builder", () => {
    expect(src).toMatch(/buildDigestAlerts\(\{/);
    expect(src, "the alert strings are being assembled inline again").not.toMatch(/alerts\.push\(/);
  });

  it("hands it the overdue total, not the open one", () => {
    const call = /buildDigestAlerts\(\{[\s\S]*?\}\)/.exec(src)?.[0] ?? "";
    expect(call, "buildDigestAlerts call not found").not.toBe("");
    expect(call).toMatch(/overdueCents/);
    expect(call, "openArCents is back in the alert").not.toMatch(/openArCents/);
  });

  it("carries both figures through to the commentary, separately labelled", () => {
    // The prompt said "Open A/R X across N overdue invoices", which told the
    // model that X was the overdue amount. There is no prompt since
    // 2026-10-03; the commentary is digest-insights.ts, so the rule is pinned
    // there now (and exercised in tests/digest-without-a-model.test.ts).
    const insights = code(read("src/lib/digest-insights.ts"));
    expect(insights).toMatch(/of which \$\{formatCents\(r\.overdueCents\)\} is overdue/);
    expect(src).toMatch(/overdueCents: number|overdueCents,/);
  });

  it("shows the overdue total next to Open A/R rather than instead of it", () => {
    // With the alert quoting one figure and the stat table the other, an owner
    // would otherwise have two numbers and no way to tell whether they
    // disagree.
    expect(src).toMatch(/Of which overdue/);
    expect(src).toMatch(/label: "Open A\/R"/);
  });
});
