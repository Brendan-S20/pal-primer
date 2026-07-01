import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMyDay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: staffRow, error: staffErr } = await supabase
      .from("staff")
      .select("id, organization_id, display_name, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (staffErr) throw new Error(staffErr.message);
    if (!staffRow) return { staff: null, visits: [] as any[] };

    const { data: visits, error } = await supabase
      .from("visits")
      .select(
        "id, organization_id, scheduled_on, status, sequence, started_at, completed_at, skip_reason, skip_reason_code, client_id, property_id, clients(display_name, primary_phone), properties(street, city, postal_code, gate_code, lock_box_code, key_location, parking_notes, access_notes, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes), zones(name), visit_photos(id, storage_path, kind)",
      )
      .eq("assigned_staff_id", staffRow.id)
      .eq("scheduled_on", data.day)
      .order("sequence", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);

    return { staff: staffRow, visits: visits ?? [] };
  });

export const startVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("start_visit", { _visit_id: data.visitId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const completeVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("complete_visit", { _visit_id: data.visitId });
    if (error) throw new Error(error.message);

    // Fire visit-completed email (best-effort)
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select("organization_id, client_id, scheduled_on, properties(street, city)")
        .eq("id", data.visitId)
        .single();
      if (v) {
        const prop: any = Array.isArray((v as any).properties) ? (v as any).properties[0] : (v as any).properties;
        const address = prop ? [prop.street, prop.city].filter(Boolean).join(", ") : undefined;
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: v.organization_id,
          clientId: v.client_id,
          templateName: "visit-completed",
          notifyKey: "notify_email_visit_completed",
          idempotencyKey: `visit-done-${data.visitId}`,
          templateData: {
            visitDate: v.scheduled_on,
            address,
          },
        });
      }
    } catch (e) {
      console.error("visit-completed email failed", e);
    }
    return { ok: true };
  });

export const skipVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        reason: z.string().min(1).max(500),
        code: z
          .enum([
            "client_cancelled_late",
            "gate_locked",
            "dog_outside",
            "weather",
            "our_fault",
            "access_blocked",
            "unsafe_conditions",
            "other",
          ])
          .default("other"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const recordVisitPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        storagePath: z.string().min(1),
        kind: z.enum(["completion", "before", "issue"]).default("completion"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("visits")
      .select("organization_id")
      .eq("id", data.visitId)
      .single();
    if (vErr) throw new Error(vErr.message);

    const { error } = await supabase.from("visit_photos").insert({
      visit_id: data.visitId,
      organization_id: v.organization_id,
      uploaded_by: userId,
      storage_path: data.storagePath,
      kind: data.kind,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
