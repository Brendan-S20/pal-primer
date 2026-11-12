// The database half of invoicing a visit by hand (#605). See visit-invoicing.ts
// for why a hand-made invoice has to name the visits and add-ons it bills.
import type { SupabaseClient } from "@supabase/supabase-js";
import { invoiceNumberLabel } from "@/lib/invoice-labels";
import {
  addonLine,
  isBillableStatus,
  linesForVisit,
  liveInvoiceFor,
  visitInvoiceBlocker,
  type BillableVisit,
  type PendingAddon,
  type VisitInvoiceLine,
  type VisitLink,
} from "@/lib/visit-invoicing";

type Db = SupabaseClient<any>;

const VISIT_COLUMNS = `id, client_id, scheduled_on, status, skip_billable, skip_charge_cents,
  skip_reason_code, is_deepclean, deepclean_charge_cents, price_cents, client_package_id,
  subscriptions(price_cents, billing_cadence), services(name), properties(street)`;

function one<T>(x: T | T[] | null | undefined): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : (x ?? null);
}

function toBillable(r: any): BillableVisit & { client_id: string } {
  return {
    id: r.id,
    client_id: r.client_id,
    scheduled_on: r.scheduled_on,
    status: r.status,
    skip_billable: r.skip_billable,
    skip_charge_cents: r.skip_charge_cents,
    skip_reason_code: r.skip_reason_code,
    is_deepclean: r.is_deepclean,
    deepclean_charge_cents: r.deepclean_charge_cents,
    price_cents: r.price_cents,
    client_package_id: r.client_package_id,
    subscription: one(r.subscriptions),
    service_name: one<{ name: string | null }>(r.services)?.name ?? null,
    street: one<{ street: string | null }>(r.properties)?.street ?? null,
  };
}

/** Every invoice line that points at one of these visits, with its invoice. */
export async function loadVisitLinks(db: Db, visitIds: string[]): Promise<VisitLink[]> {
  const out: VisitLink[] = [];
  // In slices, so a client with years of visits does not overrun the URL.
  for (let i = 0; i < visitIds.length; i += 100) {
    const { data, error } = await db
      .from("invoice_line_items")
      .select("visit_id, invoices!inner(id, number, status)")
      .in("visit_id", visitIds.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[]) {
      out.push({
        visit_id: r.visit_id as string,
        invoice: one(r.invoices) as VisitLink["invoice"],
      });
    }
  }
  return out;
}

async function loadVisits(
  db: Db,
  orgId: string,
  filter: { ids: string[] } | { clientId: string },
): Promise<Array<BillableVisit & { client_id: string }>> {
  let q = db.from("visits").select(VISIT_COLUMNS).eq("organization_id", orgId);
  q =
    "ids" in filter
      ? q.in("id", filter.ids)
      : q.eq("client_id", filter.clientId).in("status", ["completed", "skipped"]);
  const { data, error } = await q.order("scheduled_on", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map(toBillable);
}

/** One visit as the invoicing rules read it, or null when it is not this
 *  org's. */
export async function loadBillableVisit(
  db: Db,
  orgId: string,
  visitId: string,
): Promise<(BillableVisit & { client_id: string }) | null> {
  const [v] = await loadVisits(db, orgId, { ids: [visitId] });
  return v ?? null;
}

async function loadPendingAddons(
  db: Db,
  orgId: string,
  clientId: string,
  ids?: string[],
): Promise<PendingAddon[]> {
  let q = db
    .from("addon_charges")
    .select("id, visit_id, description, occurred_on, quantity, amount_cents")
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .eq("status", "pending");
  if (ids) q = q.in("id", ids);
  const { data, error } = await q.order("occurred_on", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PendingAddon[];
}

const label = (inv: { id: string; number: number | null }) => invoiceNumberLabel(inv);

export type VisitInvoicing =
  | { state: "invoiced"; invoiceId: string; invoiceLabel: string }
  | { state: "ready"; totalCents: number; lines: VisitInvoiceLine[] }
  | { state: "blocked"; reason: string };

/** What the visit drawer shows: the invoice the visit is on, or what
 *  "Invoice this visit" would bill, or why it cannot. */
export async function visitInvoicing(
  db: Db,
  orgId: string,
  visitId: string,
): Promise<VisitInvoicing> {
  const [v] = await loadVisits(db, orgId, { ids: [visitId] });
  if (!v) throw new Error("Visit not found");
  const links = await loadVisitLinks(db, [v.id]);
  const on = liveInvoiceFor(v.id, links);
  if (on) return { state: "invoiced", invoiceId: on.id, invoiceLabel: label(on) };
  const blocker = visitInvoiceBlocker(v, links, label);
  if (blocker) return { state: "blocked", reason: blocker };
  const lines = linesForVisit(v, await loadPendingAddons(db, orgId, v.client_id));
  const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  if (totalCents <= 0) return { state: "blocked", reason: "This visit has nothing to bill." };
  return { state: "ready", totalCents, lines };
}

export type UninvoicedVisit = {
  visitId: string;
  scheduledOn: string;
  status: string;
  totalCents: number;
  lines: VisitInvoiceLine[];
};

/** A client's work that no live invoice covers yet: each billable visit with
 *  its lines, and the pending add-on charges not tied to one of those visits.
 *  This is what the New invoice dialog offers to attach. */
export async function uninvoicedWork(
  db: Db,
  orgId: string,
  clientId: string,
): Promise<{ visits: UninvoicedVisit[]; addons: VisitInvoiceLine[] }> {
  const all = (await loadVisits(db, orgId, { clientId })).filter(isBillableStatus);
  const links = await loadVisitLinks(
    db,
    all.map((v) => v.id),
  );
  const addons = await loadPendingAddons(db, orgId, clientId);
  const open = all.filter((v) => visitInvoiceBlocker(v, links, label) === null);
  const visits = open.map((v) => {
    const lines = linesForVisit(v, addons);
    return {
      visitId: v.id,
      scheduledOn: v.scheduled_on,
      status: v.status,
      totalCents: lines.reduce((s, l) => s + l.amountCents, 0),
      lines,
    };
  });
  const covered = new Set(open.map((v) => v.id));
  return {
    visits,
    addons: addons.filter((a) => !a.visit_id || !covered.has(a.visit_id)).map(addonLine),
  };
}

/** Refuse links a hand-made invoice may not make, before anything is written:
 *  a visit of another client, one that is not billable, one already on a live
 *  invoice, a prepaid or package visit; an add-on that is not this client's or
 *  is no longer pending; and the same visit or add-on on two lines. */
export async function checkInvoiceLinks(
  db: Db,
  orgId: string,
  clientId: string,
  items: Array<{ visitId?: string; addonChargeId?: string }>,
): Promise<void> {
  const visitIds = items.flatMap((i) => (i.visitId ? [i.visitId] : []));
  const addonIds = items.flatMap((i) => (i.addonChargeId ? [i.addonChargeId] : []));
  if (new Set(visitIds).size !== visitIds.length) {
    throw new Error("A visit can be on only one line of the invoice.");
  }
  if (new Set(addonIds).size !== addonIds.length) {
    throw new Error("An add-on can be on only one line of the invoice.");
  }
  if (visitIds.length) {
    const visits = await loadVisits(db, orgId, { ids: visitIds });
    const links = await loadVisitLinks(db, visitIds);
    for (const id of visitIds) {
      const v = visits.find((x) => x.id === id);
      if (!v || v.client_id !== clientId)
        throw new Error("A visit on this invoice is not this client's.");
      const blocker = visitInvoiceBlocker(v, links, label);
      if (blocker) throw new Error(`Visit on ${v.scheduled_on}: ${blocker}`);
    }
  }
  if (addonIds.length) {
    const pending = await loadPendingAddons(db, orgId, clientId, addonIds);
    if (pending.length !== addonIds.length) {
      throw new Error(
        "An add-on on this invoice has already been billed, or is not this client's.",
      );
    }
  }
}
