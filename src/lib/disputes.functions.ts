import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  DISPUTE_KINDS,
  disputeKey,
  disputesFrom,
  summarizeDisputes,
  type Dispute,
} from "@/lib/disputes";

// BUILD-12 — the dispute queue's data.
//
// Everything reads the review-item ledger the Stripe webhook already writes.
// There is deliberately no `disputes` table: Stripe is the system of record,
// and a local copy would be one more thing that can disagree with the money.
// See disputes.ts for the state machine.
//
// All queries run on the CALLER's RLS-bound client. review_items, payments,
// invoices and clients are org-scoped and the caller is a member, so nothing
// here needs service-role.

export type DisputeRow = Dispute & {
  clientName: string;
  invoiceId: string | null;
  reason: string;
};

export type DisputeQueue = {
  disputes: DisputeRow[];
  totals: ReturnType<typeof summarizeDisputes>;
  /** Whether OPEN disputes are currently counted in analytics revenue. */
  includeOpenInAnalytics: boolean;
  timezone: string;
};

export const getDisputeQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DisputeQueue> => {
    const { supabase } = context;
    // Money visibility, matching /reports and the Dashboard KPIs. A dispute
    // exposes what a customer paid and what they clawed back.
    const { orgId } = await requirePermission(supabase, context.userId, "view_financials");

    const { orgTimezone } = await import("@/lib/revenue.server");
    const { orgLocalDay } = await import("@/lib/cpa-reports");
    const timezone = await orgTimezone(supabase, orgId);

    const { data: org } = await supabase
      .from("organizations")
      .select("disputes_in_analytics")
      .eq("id", orgId)
      .maybeSingle();

    // No date window: a dispute queue is a worklist, not a period report. An
    // open dispute from four months ago is the one most in need of attention,
    // and windowing it out is how it stops being anybody's problem.
    //
    // Paged, because PostgREST caps an un-ranged select at 1000 rows and says
    // nothing about it (BUG-23). A dispute is three or four rows over its life,
    // so an unpaged query starts losing disputes — and understating the money —
    // somewhere past ~300 of them, with no error anywhere.
    const { fetchAllPages } = await import("@/lib/supabase-paging.server");
    const items = await fetchAllPages<any>((a, b) =>
      supabase
        .from("review_items")
        .select("id, kind, subject_id, detected_at, detail, reason, dispute_ref")
        .eq("organization_id", orgId)
        .in("kind", [...DISPUTE_KINDS])
        .order("detected_at", { ascending: false })
        .order("id")
        .range(a, b),
    );

    const events = (items ?? []).map((r: any) => ({
      paymentId: (r.subject_id as string | null) ?? null,
      kind: r.kind as string,
      day: orgLocalDay(r.detected_at, timezone),
      amountCents: Number(r.detail?.amount_cents ?? 0),
      reason: r.reason as string,
      disputeId: (r.dispute_ref as string | null) ?? "",
    }));
    const disputes = disputesFrom(events);

    // Resolve the customer through payment → invoice → client. The payment is
    // usually older than the dispute, so this cannot be shortcut through a
    // recent-payments window.
    const paymentIds = disputes.map((d) => d.paymentId);
    const invoiceOfPayment = new Map<string, string>();
    for (let i = 0; i < paymentIds.length; i += 200) {
      const { data } = await supabase
        .from("payments")
        .select("id, invoice_id")
        .eq("organization_id", orgId)
        .in("id", paymentIds.slice(i, i + 200));
      for (const p of data ?? []) invoiceOfPayment.set(p.id, p.invoice_id);
    }
    const invoiceIds = [...new Set([...invoiceOfPayment.values()].filter(Boolean))];
    const clientOfInvoice = new Map<string, string>();
    for (let i = 0; i < invoiceIds.length; i += 200) {
      const { data } = await supabase
        .from("invoices")
        .select("id, client_id")
        .eq("organization_id", orgId)
        .in("id", invoiceIds.slice(i, i + 200));
      for (const inv of data ?? []) clientOfInvoice.set(inv.id, inv.client_id);
    }
    const clientIds = [...new Set([...clientOfInvoice.values()].filter(Boolean))];
    const clientName = new Map<string, string>();
    for (let i = 0; i < clientIds.length; i += 200) {
      const { data } = await supabase
        .from("clients")
        .select("id, display_name")
        .eq("organization_id", orgId)
        .in("id", clientIds.slice(i, i + 200));
      for (const c of data ?? []) clientName.set(c.id, c.display_name);
    }

    // Keyed on the DISPUTE, not the payment: a payment can carry more than one,
    // and keying on the payment showed the second dispute the first one's
    // reason — the wrong amount, against the wrong bank deadline.
    const openingReason = new Map(
      events
        .filter(
          (e) => e.kind === "payment_chargeback" || e.kind === "payment_dispute_inquiry",
        )
        .map((e) => [disputeKey(e.paymentId ?? "", e.disputeId), e.reason]),
    );

    return {
      disputes: disputes.map((d) => {
        const invoiceId = invoiceOfPayment.get(d.paymentId) ?? null;
        const cid = invoiceId ? clientOfInvoice.get(invoiceId) : undefined;
        return {
          ...d,
          invoiceId,
          // "Unknown customer" rather than dropping the row: a dispute we
          // cannot attribute is still money that left, and hiding it would
          // make the queue's total disagree with the bank.
          clientName: (cid && clientName.get(cid)) || "Unknown customer",
          reason: openingReason.get(disputeKey(d.paymentId, d.disputeId)) ?? "",
        };
      }),
      totals: summarizeDisputes(disputes),
      includeOpenInAnalytics: !!(org as { disputes_in_analytics?: boolean } | null)
        ?.disputes_in_analytics,
      timezone,
    };
  });

export const setDisputesInAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ include: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // A settings change, so the settings permission — deliberately NOT
    // view_financials, which lets someone read the number without being able
    // to change how everyone else sees it.
    const { orgId } = await requirePermission(supabase, context.userId, "manage_settings");
    // Through the helper so a zero-row update is an error rather than a
    // success toast over an unchanged setting — see org-write.server.
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(supabase, orgId, { disputes_in_analytics: data.include });
    return { ok: true as const };
  });
