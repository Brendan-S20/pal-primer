// Cash or a check a tech takes at a stop, and the office's answer to it.
//
// The tech RECORDS; the office CONFIRMS. Recording writes a field_collections
// row through record_field_collection, which refuses anything but the
// caller's own visit, a recent day, cash or a check, and an amount within the
// customer's open balance -- see the migration
// 20261002150000_the-cash-a-tech-took-had-nowhere-to-go.sql for why that is a
// table of its own and not a pending payment.
//
// Confirming with invoices is NOT in this file. It is bulkMarkInvoicesPaid
// with a `fieldCollectionId`, which claims the collection and then pays the
// invoices exactly the way the office's own Record payment does. What is here
// is the list the office reads, the two answers that move no money (confirm
// with nothing to apply, and reject), and the tech's record.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { invoiceDueCents } from "@/lib/ar";

export const FIELD_COLLECTION_METHODS = ["cash", "check"] as const;

export const recordFieldCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        amountCents: z.number().int().min(1).max(10_000_000),
        method: z.enum(FIELD_COLLECTION_METHODS),
        reference: z.string().trim().max(120).optional(),
        /** Minted on the device before the first attempt and carried by the
         *  queued action, so a replay of a request that landed is recognised. */
        clientKey: z.string().uuid(),
        /** When the money was handed over, for a REPLAYED action. The SQL
         *  bounds it; a phone clock is a hint. */
        collectedAt: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("record_field_collection", {
      _visit_id: data.visitId,
      _amount_cents: data.amountCents,
      _method: data.method,
      _reference: data.method === "check" ? data.reference || undefined : undefined,
      _client_key: data.clientKey,
      _collected_at: data.collectedAt ?? undefined,
    });
    if (error) throw new Error(error.message);
    // The owner and office managers are told, and their phones buzz. This was
    // an INSERT inside record_field_collection, whose rows never reached a
    // phone (20261004150000). Keyed on the collection, so the replay the
    // queue sends after a lost response tells nobody twice. Never throws.
    const { notifyFieldCollection } = await import("@/lib/field-notify.server");
    await notifyFieldCollection({ collectionId: id as string, actorUserId: context.userId });
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select("organization_id, client_id, property_id")
        .eq("id", data.visitId)
        .single();
      if (v) {
        const { logActivity } = await import("@/lib/activity.server");
        const { describeManualPayment } = await import("@/lib/manual-payments");
        await logActivity(context.supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: context.userId,
          kind: "field.collection_recorded",
          summary: `Collected $${(data.amountCents / 100).toFixed(2)} (${describeManualPayment(
            data.method,
            data.reference,
          )}) in the field, waiting for the office to confirm`,
        });
      }
    } catch (e) {
      // The collection is recorded; a lost activity line must not undo the tap.
      console.warn("field.collection_recorded activity log failed", data.visitId, e);
    }
    return { id: id as string };
  });

export type FieldCollectionRow = {
  id: string;
  client_id: string;
  visit_id: string | null;
  amount_cents: number;
  method: "cash" | "check";
  reference: string | null;
  collected_at: string;
  status: "awaiting_confirmation" | "confirmed" | "rejected";
  applied_cents: number;
  decided_at: string | null;
  decision_note: string | null;
  client_name: string;
  collected_by: string | null;
  /** Who in the office confirmed or rejected it, by their staff name. */
  decided_by: string | null;
  /** The customer's open invoices, oldest first, for an awaiting one. */
  open_invoices: {
    id: string;
    number: number | null;
    open_cents: number;
    period_end: string | null;
    due_on: string | null;
  }[];
};

/** What the office has waiting, and what it decided in the last two weeks. */
export const listFieldCollections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    const { data: rows, error } = await supabase
      .from("field_collections")
      .select(
        "id, client_id, visit_id, amount_cents, method, reference, collected_at, status, applied_cents, decided_at, decision_note, decided_by_user_id, clients(display_name), staff:collected_by_staff_id(display_name)",
      )
      .eq("organization_id", orgId)
      .or(`status.eq.awaiting_confirmation,decided_at.gte.${since}`)
      .order("collected_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const waitingClients = [
      ...new Set(
        (rows ?? []).filter((r) => r.status === "awaiting_confirmation").map((r) => r.client_id),
      ),
    ];
    const invoicesByClient = new Map<string, FieldCollectionRow["open_invoices"]>();
    if (waitingClients.length) {
      const { data: invs, error: iErr } = await supabase
        .from("invoices")
        .select(
          "id, client_id, number, total_cents, credit_applied_cents, amount_paid_cents, period_end, due_on",
        )
        .eq("organization_id", orgId)
        .eq("status", "open")
        .in("client_id", waitingClients)
        // Oldest first, in exactly the order confirm_field_collection applies
        // the money (20261015120000).
        .order("period_end", { ascending: true })
        .order("issued_at", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (iErr) throw new Error(iErr.message);
      for (const i of invs ?? []) {
        const list = invoicesByClient.get(i.client_id) ?? [];
        list.push({
          id: i.id,
          number: (i as { number?: number | null }).number ?? null,
          // The balance, net of credit and of anything already paid on it.
          open_cents: invoiceDueCents(i),
          period_end: i.period_end,
          due_on: i.due_on,
        });
        invoicesByClient.set(i.client_id, list);
      }
    }

    // Who decided, by name: the office's own answer to "who confirmed this
    // check", read from the staff list rather than auth.users.
    const deciders = [
      ...new Set((rows ?? []).map((r) => r.decided_by_user_id).filter((x): x is string => !!x)),
    ];
    const deciderName = new Map<string, string>();
    if (deciders.length) {
      const { data: people } = await supabase
        .from("staff")
        .select("user_id, display_name")
        .eq("organization_id", orgId)
        .in("user_id", deciders);
      for (const p of people ?? []) deciderName.set(p.user_id, p.display_name);
    }

    const one = <T>(x: T | T[] | null | undefined): T | null =>
      Array.isArray(x) ? (x[0] ?? null) : (x ?? null);
    const collections: FieldCollectionRow[] = (rows ?? []).map((r) => ({
      id: r.id,
      client_id: r.client_id,
      visit_id: r.visit_id,
      amount_cents: r.amount_cents,
      method: r.method as "cash" | "check",
      reference: r.reference,
      collected_at: r.collected_at,
      status: r.status as FieldCollectionRow["status"],
      applied_cents: r.applied_cents,
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      decided_by: r.decided_by_user_id ? (deciderName.get(r.decided_by_user_id) ?? null) : null,
      client_name: one(r.clients as { display_name: string } | null)?.display_name ?? "A customer",
      collected_by:
        one((r as { staff?: unknown }).staff as { display_name: string } | null)?.display_name ??
        null,
      open_invoices:
        r.status === "awaiting_confirmation" ? (invoicesByClient.get(r.client_id) ?? []) : [],
    }));
    return { collections };
  });

/** Received, and nothing to apply it to: the collection settles no whole open
 *  invoice. The invoice model has no partial payments, so it is confirmed as
 *  received and stays on the list as unapplied, rather than being forced onto
 *  an invoice it does not cover. */
export const confirmFieldCollectionUnapplied = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase.rpc("confirm_field_collection", {
      _collection_id: data.id,
      _invoice_ids: [],
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const rejectFieldCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ id: z.string().uuid(), note: z.string().trim().max(500).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase.rpc("reject_field_collection", {
      _collection_id: data.id,
      _note: data.note || undefined,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
