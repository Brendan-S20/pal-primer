// A void after a full refund moves no money (#674).
//
// Nov 10 2026, the owner: "Allow Void after a refund". #698 and #750 had
// left a refunded invoice at `paid` with no Void. The spec in the issue:
// Void is offered only once the refund is the whole of what was paid; a
// partly refunded invoice is told to refund the rest first, and a direct RPC
// call is refused too; the void changes the record and nothing else (no
// Stripe call, paid_at and both amounts kept); the visit lines are released
// so the visit can be invoiced again once; revenue for the paid month and the
// refund month, receivables, payouts and fee reports read the same before and
// after; exports show the void as its own dated event.
//
// Here: the pure rule the page reads, the reports' arithmetic before and
// after a void, the migration and the server function as written, and the
// page's wiring. tests/sql/a-refunded-invoice-can-be-voided.proof.sql proves
// the database half against a real Postgres when one answers (CI's test job).
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { billedDay, billedInPeriod, invoiceDueCents, outstandingAsOf } from "@/lib/ar";
import { grossReceivedCents } from "@/lib/revenue";
import { revenueByService } from "@/lib/revenue-by-service";
import {
  invoiceRefundState,
  invoiceStatusChip,
  voidAfterRefund,
  voidedAfterRefund,
} from "@/lib/refund-outcome";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
const MIGRATION_PATH = "supabase/migrations/20261111010000_a-refunded-invoice-can-be-voided.sql";
const MIGRATION = read(MIGRATION_PATH);
const SERVER_FN = read("src/lib/invoice-void.functions.ts");
const PAGE = read("src/routes/_authenticated/invoices.$invoiceId.tsx");

// ── The invoice, before and after ───────────────────────────────────────────
//
// INV-1069's shape: $60 billed in October, paid the next day, refunded in
// full in November, and now voided. The refund trigger leaves
// amount_paid_cents at 0 and amount_refunded_cents at 6000; the void keeps
// both and paid_at, and sets status and voided_at.
const TZ = "America/New_York";
const refunded = {
  id: "16000000-0000-4000-8000-000000001069",
  status: "paid",
  total_cents: 6000,
  tax_cents: 0,
  credit_applied_cents: 0,
  amount_paid_cents: 0,
  amount_refunded_cents: 6000,
  deposit_for_invoice_id: null,
  issued_at: "2026-10-05T14:00:00Z",
  paid_at: "2026-10-06T14:00:00Z",
  voided_at: null as string | null,
  updated_at: "2026-11-01T14:00:00Z",
};
const voided = {
  ...refunded,
  status: "void",
  voided_at: "2026-11-10T19:30:00Z",
  updated_at: "2026-11-10T19:30:00Z",
};
const partly = { ...refunded, amount_paid_cents: 4000, amount_refunded_cents: 2000 };

describe("when Void is offered on a paid invoice", () => {
  it("is offered once the refund is the whole of what was paid (INV-1069)", () => {
    expect(voidAfterRefund(refunded)).toEqual({ offered: true });
  });

  it("is not offered on a partly refunded invoice, which is told to refund the rest first", () => {
    const r = voidAfterRefund(partly);
    expect(r.offered).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringMatching(/^Refund the rest/) });
  });

  it("is not offered, and says nothing, on a paid invoice nothing was refunded on", () => {
    expect(
      voidAfterRefund({ ...refunded, amount_paid_cents: 6000, amount_refunded_cents: 0 }),
    ).toEqual({
      offered: false,
      reason: null,
    });
  });

  it("has nothing to say about an open or void invoice: those have the ordinary Void, or none", () => {
    expect(voidAfterRefund({ status: "open", amount_refunded_cents: 6000 })).toEqual({
      offered: false,
      reason: null,
    });
    expect(voidAfterRefund(voided)).toEqual({ offered: false, reason: null });
  });

  it("reads the same refund state the badge reads", () => {
    expect(invoiceRefundState(refunded)).toBe("refunded");
    expect(invoiceRefundState(partly)).toBe("partly_refunded");
    // Once void, the chip says Void: the stored status, not a refund label.
    expect(invoiceStatusChip(voided)).toEqual({ status: "void" });
  });
});

describe("telling a void after a refund from an ordinary one", () => {
  it("is the paid date the void kept", () => {
    expect(voidedAfterRefund(voided)).toBe(true);
    expect(voidedAfterRefund({ status: "void", paid_at: null })).toBe(false);
    expect(voidedAfterRefund({ status: "void" })).toBe(false);
    expect(voidedAfterRefund(refunded)).toBe(false);
  });
});

describe("the money reads the same before and after the void", () => {
  const october = { from: "2026-10-01", to: "2026-10-31" };
  const november = { from: "2026-11-01", to: "2026-11-30" };

  it("accrual revenue: the sale stays in the month it was billed, and is not billed in the void month", () => {
    expect(billedDay(voided, TZ)).toBe(billedDay(refunded, TZ));
    expect(billedDay(voided, TZ)).toBe("2026-10-05");
    for (const period of [october, november]) {
      expect(billedInPeriod([voided], period.from, period.to, TZ)).toEqual(
        billedInPeriod([refunded], period.from, period.to, TZ),
      );
    }
    expect(billedInPeriod([voided], october.from, october.to, TZ).billedCents).toBe(6000);
    expect(billedInPeriod([voided], november.from, november.to, TZ).billedCents).toBe(0);
    // An ordinary void is still never billed.
    expect(billedDay({ ...voided, paid_at: null }, TZ)).toBeNull();
  });

  it("revenue by service: the voided invoice's line stays in October", () => {
    const input = {
      lines: [
        {
          invoice_id: refunded.id,
          amount_cents: 6000,
          visit_id: "v1",
          subscription_id: null,
        },
      ],
      from: october.from,
      to: october.to,
      timezone: TZ,
      visitService: new Map([["v1", "svc"]]),
      subscriptionService: new Map(),
      serviceName: new Map([["svc", "Weekly scoop"]]),
    };
    const before = revenueByService({ ...input, invoices: [refunded] });
    const after = revenueByService({ ...input, invoices: [voided] });
    expect(after).toEqual(before);
    expect(after).toEqual([{ serviceId: "svc", name: "Weekly scoop", cents: 6000, lines: 1 }]);
  });

  it("receivables: nothing was owed before, nothing is owed after", () => {
    for (const day of ["2026-10-31", "2026-11-09", "2026-11-30"]) {
      expect(outstandingAsOf(voided, day, TZ)).toBe(outstandingAsOf(refunded, day, TZ));
      expect(outstandingAsOf(voided, day, TZ)).toBe(0);
    }
    expect(invoiceDueCents(voided)).toBe(invoiceDueCents(refunded));
  });

  it("cash revenue is read from the payment rows, which the void does not touch", () => {
    // The payment the webhook wrote: received, then refunded. Its status and
    // amounts are what cash income and the reversals ledger read, and the
    // proof shows the void leaves every payment row as it was.
    const payment = { amount_cents: 6000, tax_cents: 0, status: "refunded" };
    expect(grossReceivedCents([payment])).toBe(6000);
    expect(strip(MIGRATION)).not.toMatch(/UPDATE public\.payments/);
    expect(strip(MIGRATION)).not.toMatch(/review_items/);
  });

  it("the accountant pack lists the void as its own dated event with nothing written off", () => {
    const src = read("src/lib/cpa-reports.functions.ts");
    expect(src).toMatch(/label: "Voided after a full refund", amount: 0/);
    // The bridge counts the sale the way billedDay does, so the two sheets
    // cannot disagree about a void after a refund.
    expect(src).toMatch(/inv\.status !== "void" \|\| voidedAfterRefund\(inv\)/);
    // The revenue-by-service loader fetches the column the rule reads.
    expect(read("src/lib/revenue-by-service.functions.ts")).toMatch(
      /select\("id, status, issued_at, deposit_for_invoice_id, paid_at"\)/,
    );
  });
});

describe("the server function", () => {
  it("makes no Stripe call of any kind", () => {
    const code = SERVER_FN.replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/stripe/i);
    expect(code).not.toMatch(/invoice-reconcile/);
    expect(code).not.toMatch(/syncInvoicePaymentIntentAmount/);
    // Nothing that could reach Stripe is even imported.
    expect(code.match(/^import .*$/gm)?.join("\n")).not.toMatch(/stripe|reconcile|payments/i);
  });

  it("asks the same permission as Void, then the database function, then writes the audit entry", () => {
    expect(SERVER_FN).toMatch(
      /requirePermission\(context\.supabase, context\.userId, "manage_client_billing"\)/,
    );
    expect(SERVER_FN).toMatch(/rpc\("void_refunded_invoice", \{\s*_invoice_id: data\.id,?\s*\}\)/);
    expect(SERVER_FN).toMatch(/kind: "invoice\.voided"/);
    expect(SERVER_FN).toMatch(/No money moved/);
  });

  it("sends the client nothing", () => {
    expect(SERVER_FN).not.toMatch(/notifications|sendInvoiceEmail|sms|email/i);
  });

  it("refuses a stale version the way Void does (#655)", () => {
    expect(SERVER_FN).toMatch(/refuseIfChanged\(inv\.updated_at, data\.expectedVersion\)/);
  });
});

describe("the migration, read", () => {
  const code = strip(MIGRATION);

  it("adds released_at and rebuilds the visit index to ignore a released line, once", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS released_at timestamptz/);
    expect(code).toMatch(
      /CREATE UNIQUE INDEX invoice_line_items_visit_unique ON public\.invoice_line_items\(visit_id\)\s+WHERE visit_id IS NOT NULL AND released_at IS NULL/,
    );
    // Guarded on the predicate, so a second run leaves the index alone.
    expect(code).toMatch(
      /IF _def IS NULL OR _def NOT LIKE '%released_at IS NULL%' THEN\s+DROP INDEX IF EXISTS/,
    );
  });

  it("refuses a partly refunded invoice and an unrefunded one, and keeps the permission", () => {
    expect(code).toMatch(/IF _paid > 0 THEN\s+RAISE EXCEPTION 'Refund the rest first/);
    expect(code).toMatch(/IF _refunded <= 0 THEN\s+RAISE EXCEPTION 'This invoice was not refunded/);
    expect(code).toMatch(/IF _status <> 'paid' THEN\s+RAISE EXCEPTION 'Only a paid invoice/);
    expect(code).toMatch(/has_permission\(auth\.uid\(\), _org, 'manage_client_billing'\)/);
  });

  it("writes status and the void date and nothing about the money", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.void_refunded_invoice"));
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body).toMatch(/SET status = 'void',\s+voided_at = now\(\),\s+updated_at = now\(\)/);
    expect(body).not.toMatch(/paid_at =/);
    expect(body).not.toMatch(/amount_paid_cents =/);
    expect(body).not.toMatch(/amount_refunded_cents =/);
    expect(body).not.toMatch(/credit_applied_cents =/);
    expect(body).not.toMatch(/post_credit_entry/);
    // Releases the visit lines, and only those.
    expect(body).toMatch(
      /UPDATE public\.invoice_line_items\s+SET released_at = now\(\)\s+WHERE invoice_id = _invoice_id\s+AND visit_id IS NOT NULL\s+AND released_at IS NULL/,
    );
  });

  it("leaves void_invoice alone: an unpaid invoice is voided the way it was", () => {
    expect(code).not.toMatch(/FUNCTION public\.void_invoice\(/);
  });

  it("replays into an empty database and can be run twice", () => {
    expect(code).not.toMatch(/cron\./);
    expect(code).not.toMatch(/pg_get_functiondef/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.void_refunded_invoice/);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.void_refunded_invoice\(uuid\) FROM PUBLIC, anon/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.void_refunded_invoice\(uuid\) TO authenticated/,
    );
  });
});

describe("the page", () => {
  it("keeps the ordinary Void off a paid invoice and offers the refund void only when the rule says so", () => {
    expect(PAGE).toMatch(
      /invoice\.status !== "paid" && invoice\.status !== "void" && \(\s*<ConfirmButton\s+title="Void this invoice\?"/,
    );
    expect(PAGE).toMatch(
      /invoice\.status === "paid" && refundVoid\.offered && \(\s*<ConfirmButton/,
    );
    expect(PAGE).toMatch(/const refundVoid = voidAfterRefund\(invoice\)/);
    expect(PAGE).toMatch(/onConfirm=\{\(\) => voidRefundedM\.mutate\(\)\}/);
  });

  it("says to refund the rest first on a partly refunded invoice", () => {
    expect(PAGE).toMatch(
      /invoice\.status === "paid" && !refundVoid\.offered && refundVoid\.reason && \(\s*<p[^>]*>\{refundVoid\.reason\}<\/p>/,
    );
  });

  it("calls the record-only server function, not the one that cancels a PaymentIntent", () => {
    expect(PAGE).toMatch(/import \{ voidRefundedInvoice \} from "@\/lib\/invoice-void\.functions"/);
    expect(PAGE).toMatch(/const voidRefundedFn = useServerFn\(voidRefundedInvoice\)/);
    expect(PAGE).toMatch(/voidRefundedFn\(\{\s*data: \{\s*id: invoiceId,/);
  });

  it("still says the invoice was paid, then refunded, then voided", () => {
    expect(PAGE).toMatch(
      /invoice\.paid_at && \(invoice\.status === "paid" \|\| invoice\.status === "void"\) && \(/,
    );
    expect(PAGE).toMatch(/\(invoice\.amount_refunded_cents \?\? 0\) > 0 && \(/);
    expect(PAGE).toMatch(
      /voidedAt \? `Voided \$\{formatDay\(String\(voidedAt\), undefined, tz\)\}\. ` : ""/,
    );
  });

  it("tells the office no money moves before they confirm", () => {
    expect(PAGE).toMatch(/title="Void this refunded invoice\?"/);
    expect(PAGE).toMatch(/nothing is refunded, reversed or charged/);
  });
});

// ── The database half, when a database answers ─────────────────────────────

const PROOF = join(ROOT, "tests/sql/a-refunded-invoice-can-be-voided.proof.sql");
const DB_URL =
  process.env.VOID_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the void-after-refund proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set VOID_PROOF_DB_URL to run it.\n",
  );
}

describe.skipIf(!reachable)("a void after a full refund, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(join(ROOT, MIGRATION_PATH))).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("voids a fully refunded invoice, refuses the rest, releases the visit once, and leaves nothing behind", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${join(ROOT, MIGRATION_PATH)}`, "-f", PROOF],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Six groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(6);
    expect(out).toMatch(/ALL VOID-AFTER-REFUND PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Void Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
