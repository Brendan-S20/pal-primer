import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { logActivity } from "@/lib/activity.server";

// Three separate note systems (client detail refactor):
//   office     — internal office notes, hidden from technicians by RLS
//   technician — instructions surfaced during visit execution
//   client     — visible to the client in portal/email/SMS
// Audience is fixed at creation: changing visibility after the fact is
// exactly the accidental-exposure mistake the spec calls out, so updates
// can only touch body and pinned.

const audienceSchema = z.enum(["office", "technician", "client"]);

export const listClientNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // RLS hides office notes from technicians; no extra filtering needed.
    const { data: rows, error } = await context.supabase
      .from("client_notes")
      .select("id, property_id, audience, body, pinned, created_by, created_at, updated_at")
      .eq("client_id", data.clientId)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { notes: rows ?? [] };
  });

export const createClientNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        propertyId: z.string().uuid().optional(),
        audience: audienceSchema,
        body: z.string().min(1).max(4000),
        pinned: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    const { data: row, error } = await supabase
      .from("client_notes")
      .insert({
        organization_id: client.organization_id,
        client_id: data.clientId,
        property_id: data.propertyId ?? null,
        audience: data.audience,
        body: data.body,
        pinned: !!data.pinned,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await logActivity(supabase, {
      orgId: client.organization_id,
      clientId: data.clientId,
      propertyId: data.propertyId ?? null,
      actorUserId: userId,
      kind: `note.created.${data.audience}`,
      summary:
        data.audience === "office"
          ? "Added an internal office note"
          : data.audience === "technician"
            ? "Added technician instructions"
            : "Added a client-visible note",
    });
    return { id: row.id as string };
  });

export const updateClientNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        body: z.string().min(1).max(4000).optional(),
        pinned: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: { body?: string; pinned?: boolean } = {};
    if (data.body !== undefined) patch.body = data.body;
    if (data.pinned !== undefined) patch.pinned = data.pinned;
    if (Object.keys(patch).length === 0) return { ok: true };

    const { data: rows, error } = await context.supabase
      .from("client_notes")
      .update(patch)
      .eq("id", data.id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) throw new Error("Note not found or you can't edit it");
    return { ok: true };
  });

export const deleteClientNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("client_notes")
      .delete()
      .eq("id", data.id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) throw new Error("Note not found or you can't delete it");
    return { ok: true };
  });
