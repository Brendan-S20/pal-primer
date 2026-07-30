import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { REVIEW_KINDS, REVIEW_STATUSES, type ReviewKind, type ReviewStatus } from "@/lib/review-queue";

// BUILD-10 — reading and resolving review items.
//
// Owner decision on ownership: the ORG resolves its own items. The knowledge
// required to answer "did this visit actually happen" lives with the tenant, so
// resolving on their behalf would be precisely the silent guess guardrail 10.5
// forbids.
//
// Platform admins acting as themselves get read-across and no write. Support
// still works, because helping a tenant past an obstacle is done by
// impersonating them — and an impersonated session IS that tenant user, so the
// ordinary can_write_org policy lets it through with no special case. That is
// the better route anyway: the decision is attributed to the account it was
// made under and carries the impersonation marker into activity_log (BUG-14),
// so an admin resolving something while supporting a customer is visible in the
// record instead of looking like the customer did it.

export type ReviewItemRow = {
  id: string;
  kind: ReviewKind;
  subject_table: string;
  subject_id: string;
  reason: string;
  // Serializable across the server-fn boundary: `unknown` values are not, and
  // this crosses the wire. jsonb here only ever holds scalars.
  detail: Record<string, string | number | boolean | null>;
  status: ReviewStatus;
  detected_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  /** Denormalized for the list so a row is actionable without a second fetch. */
  client_name: string | null;
  scheduled_on: string | null;
};

export const listReviewItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // These items are about operational records, not money — view_client_directory
    // is the boundary that already governs "can you see the work". Resolving
    // needs more (see resolveReviewItem).
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let q = (supabaseAdmin as any)
      .from("review_items")
      .select("id, kind, subject_table, subject_id, reason, detail, status, detected_at, resolved_at, resolution_note")
      .eq("organization_id", orgId)
      .order("status", { ascending: true })
      .order("detected_at", { ascending: false })
      .limit(200);
    if (data.status !== "all") q = q.eq("status", data.status);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // Enrich visit-backed items with who and when, so the list is scannable.
    // One extra query rather than N — a review queue that takes a round-trip
    // per row to become readable is a review queue nobody opens twice.
    const visitIds = (rows ?? [])
      .filter((r: any) => r.subject_table === "visits")
      .map((r: any) => r.subject_id);
    const byVisit = new Map<string, { client_name: string | null; scheduled_on: string | null }>();
    if (visitIds.length) {
      const { data: visits } = await (supabaseAdmin as any)
        .from("visits")
        .select("id, scheduled_on, clients(display_name)")
        .in("id", visitIds);
      for (const v of visits ?? []) {
        byVisit.set(v.id, {
          client_name: v.clients?.display_name ?? null,
          scheduled_on: v.scheduled_on ?? null,
        });
      }
    }

    const items: ReviewItemRow[] = (rows ?? []).map((r: any) => ({
      ...r,
      client_name: byVisit.get(r.subject_id)?.client_name ?? null,
      scheduled_on: byVisit.get(r.subject_id)?.scheduled_on ?? null,
    }));

    const openCount = items.filter((i) => i.status === "open").length;
    return { items, openCount };
  });

export const resolveReviewItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        itemId: z.string().uuid(),
        status: z.enum(["resolved", "dismissed"]),
        // Required, not optional. A resolution with no account of what was
        // decided is the same silence this queue exists to end — the next
        // reader would learn only that someone made it go away.
        note: z.string().trim().min(3).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Deciding what happened to a visit is an operational judgement, so it sits
    // with the office roles rather than anyone who can read the directory.
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Scoped to the caller's org AND to status='open': two people clearing the
    // queue at once can't overwrite each other's note, and a second click is a
    // no-op rather than a silent re-resolution.
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("review_items")
      .update({
        status: data.status,
        resolution_note: data.note,
        resolved_at: new Date().toISOString(),
        resolved_by: context.userId,
      })
      .eq("id", data.itemId)
      .eq("organization_id", orgId)
      .eq("status", "open")
      .select("id, kind, subject_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) return { ok: true as const, alreadyDecided: true };

    // The decision is itself auditable. Someone asking later why a visit with
    // impossible timestamps was left alone should find the answer on the
    // client's timeline, not only in a table they'd have to know about.
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabaseAdmin, {
        orgId,
        actorUserId: context.userId,
        kind: "review.item_decided",
        summary: `Review item ${data.status}: ${data.note}`,
        meta: { review_item_id: updated.id, review_kind: updated.kind, visit_id: updated.subject_id },
      });
    } catch {
      /* audit is best-effort — never block the decision it describes */
    }

    return { ok: true as const, alreadyDecided: false };
  });

/** Open-item count for a nav badge. Cheap, and separate from the list so the
 *  badge doesn't pull 200 rows on every page. */
export const getReviewQueueCount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await (supabaseAdmin as any)
      .from("review_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("status", "open");
    return { openCount: count ?? 0 };
  });

export { REVIEW_KINDS, REVIEW_STATUSES };
