// Invoice a visit when it is completed (#859; #605 decision D2: invoice at
// completion).
//
// #615 shipped "Invoice this visit" and taught the billing run to leave a
// linked visit alone, but completing a visit still only froze its price and,
// for a prepaid plan, debited the balance (finalize_visit_completion). A
// postpaid client billed after each visit had no invoice until the nightly
// run, or until somebody found the button. This runs the same path the button
// runs, from both completions: the office's (completeVisitFromOffice) and the
// tech's (completeVisit).
//
// ONE INVOICE, HOWEVER MANY TIMES IT IS ASKED. A retry after a lost response,
// a double complete, or "Invoice this visit" clicked while the completion is
// still invoicing could each get past the "already invoiced?" check before the
// other's lines are committed: two transactions under READ COMMITTED cannot
// see each other. Two things in the database settle it:
//
//   - invoice_line_items_visit_unique: one line per visit, ever. The loser's
//     create_manual_invoice is one transaction, so its invoice row and the
//     number it took go with its line.
//   - a creation key derived from the visit, which invoices.creation_key holds
//     unique per org (#607). The loser waits on the winner's invoice row, hits
//     that constraint first, and create_manual_invoice hands back the winner's
//     id, so the button answers with the invoice rather than an error. The key
//     includes how many void invoices the visit has been on, so it can never
//     hand back a voided invoice as the answer.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { addDaysToDay } from "@/lib/reclean";
import { invoicesAtCompletion, voidedInvoiceCount } from "@/lib/visit-invoicing";

type Db = SupabaseClient;

/** A UUID (version 5 layout, SHA-1 name-based) that is the same for every
 *  attempt to invoice this visit in this generation, and different for
 *  anything else. */
export function visitInvoiceCreationKey(visitId: string, generation: number): string {
  const h = createHash("sha1")
    .update(`houndstack:visit-invoice:${visitId.toLowerCase()}:${generation}`)
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The creation key the next invoice for this visit should carry. */
export async function nextVisitInvoiceKey(db: Db, visitId: string): Promise<string> {
  const { loadVisitLinks } = await import("@/lib/visit-invoicing.server");
  const links = await loadVisitLinks(db, [visitId]);
  return visitInvoiceCreationKey(visitId, voidedInvoiceCount(visitId, links));
}

export type CompletionInvoice =
  { invoiced: true; invoiceId: string; totalCents: number } | { invoiced: false; reason: string };

/**
 * Invoice a just-completed visit when its client is billed after each visit
 * on a postpaid plan. Does nothing for a prepaid plan, a weekly or monthly
 * client, a package lesson, a visit already on a live invoice, or an org with
 * automatic invoicing turned off.
 *
 * `db` is the service-role client: a tech completes the visit, and a tech
 * holds no billing permission. Everything here is scoped by the visit's own
 * organization, read from the visit row, never from the caller.
 */
export async function invoiceVisitAtCompletion(
  db: Db,
  p: { visitId: string; actorUserId: string | null },
): Promise<CompletionInvoice> {
  const { data: row, error } = await db
    .from("visits")
    .select(
      "organization_id, client_id, scheduled_on, clients(billing_frequency, active), organizations(auto_invoice_enabled, invoice_grace_days, timezone)",
    )
    .eq("id", p.visitId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return { invoiced: false, reason: "visit not found" };
  const one = <T>(x: T | T[] | null | undefined): T | null =>
    Array.isArray(x) ? (x[0] ?? null) : (x ?? null);
  const v = row as unknown as {
    organization_id: string;
    client_id: string;
    scheduled_on: string;
    clients: unknown;
    organizations: unknown;
  };
  const client = one(
    v.clients as { billing_frequency: string | null; active: boolean | null } | null,
  );
  const org = one(
    v.organizations as {
      auto_invoice_enabled: boolean | null;
      invoice_grace_days: number | null;
      timezone: string | null;
    } | null,
  );
  const orgId = v.organization_id;

  const { loadBillableVisit, visitInvoicing } = await import("@/lib/visit-invoicing.server");
  const billable = await loadBillableVisit(db, orgId, p.visitId);
  if (!billable) return { invoiced: false, reason: "visit not found" };
  if (
    !invoicesAtCompletion(billable, {
      billingFrequency: client?.billing_frequency ?? null,
      clientActive: client?.active ?? null,
      autoInvoiceEnabled: org?.auto_invoice_enabled ?? null,
    })
  ) {
    return { invoiced: false, reason: "not billed after each visit" };
  }

  const state = await visitInvoicing(db, orgId, p.visitId);
  if (state.state === "invoiced") return { invoiced: false, reason: "already invoiced" };
  if (state.state === "blocked") return { invoiced: false, reason: state.reason };

  const creationKey = await nextVisitInvoiceKey(db, p.visitId);
  const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
  let made: Awaited<ReturnType<typeof insertManualInvoice>>;
  try {
    made = await insertManualInvoice(db, {
      orgId,
      userId: p.actorUserId,
      clientId: v.client_id,
      items: state.lines,
      notes: `Visit on ${v.scheduled_on}`,
      activityLabel: `invoice at completion for the visit on ${v.scheduled_on}`,
      period: { start: v.scheduled_on, end: v.scheduled_on },
      creationKey,
    });
  } catch (e) {
    // Somebody else billed it between the check above and this insert: the
    // button, another completion, or the run. invoice_line_items_visit_unique
    // allows one line per visit, so that is the invoice, and this is not a
    // failure. Anything else is.
    const { loadVisitLinks } = await import("@/lib/visit-invoicing.server");
    const links = await loadVisitLinks(db, [p.visitId]);
    if (links.some((l) => l.visit_id === p.visitId)) {
      return { invoiced: false, reason: "already invoiced" };
    }
    throw e;
  }

  // Emailed on the schedule the billing run's invoices are: after the org's
  // grace days, by the nightly auto-send, so the office can still fix or void
  // it first. Only stamped while nobody has sent it and nothing is stamped.
  const today = orgToday(org?.timezone || DEFAULT_ORG_TIMEZONE);
  const { error: sErr } = await db
    .from("invoices")
    .update({ send_after: addDaysToDay(today, org?.invoice_grace_days ?? 3) })
    .eq("id", made.invoiceId)
    .is("send_after", null)
    .is("sent_at", null);
  if (sErr) console.warn("invoice at completion: send_after not stamped", made.invoiceId, sErr);

  return { invoiced: true, invoiceId: made.invoiceId, totalCents: made.totalCents };
}

/** For the completion server functions: invoice the visit, and never let a
 *  failure here undo or fail a completion that has already happened. The
 *  nightly run still bills an after-each-visit visit nothing invoiced, and
 *  "Invoice this visit" stays on the visit as the fallback. */
export async function invoiceAtCompletionSafely(p: {
  visitId: string;
  actorUserId: string | null;
}): Promise<CompletionInvoice> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return await invoiceVisitAtCompletion(supabaseAdmin as unknown as Db, p);
  } catch (e) {
    console.warn("invoice at completion failed; the billing run will pick it up", p.visitId, e);
    return { invoiced: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
