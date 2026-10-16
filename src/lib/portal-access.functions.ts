import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ACCESS_METHODS } from "@/lib/walk-access";

// "How we get in", from the client's side (#410). A dog walker goes inside,
// so a client with a walk plan can tell the business how: the way in, the
// lock box code, the door code and where a key is kept.
//
// The codes are WRITE-ONLY. Nothing here ever returns one: the portal is
// told "On file" or "Not set", and a client changes a code by typing a new
// one or removes it. A code read back over the portal would be a code anyone
// holding the link, or the phone, could read. The door code is stored in
// properties.gate_code, the column the walker's card already shows as the
// code at the entrance.
//
// Session rules as every portal call (portal-auth.server.ts): the read lets
// a staff preview look, the write refuses it. Every query is filtered by the
// session's own client and organization, so another client's property is
// "not found" whatever id is sent.

async function portalAuth() {
  return import("@/lib/portal-auth.server");
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export const PORTAL_CODE_MAX = 40;
export const KEY_LOCATION_MAX = 300;

/** What the portal is told about one property's access. No code, ever. */
export type PortalAccess = {
  propertyId: string;
  label: string | null;
  street: string | null;
  accessMethod: string | null;
  keyLocation: string | null;
  lockBoxSet: boolean;
  doorCodeSet: boolean;
};

type PropertyRow = {
  id: string;
  label: string | null;
  street: string | null;
  access_method: string | null;
  key_location: string | null;
  lock_box_code: string | null;
  gate_code: string | null;
};

/** The one place a property row becomes something the portal may see. */
export function portalAccessOf(p: PropertyRow): PortalAccess {
  return {
    propertyId: p.id,
    label: p.label,
    street: p.street,
    accessMethod: p.access_method,
    keyLocation: p.key_location,
    lockBoxSet: !!p.lock_box_code?.trim(),
    doorCodeSet: !!p.gate_code?.trim(),
  };
}

const PROPERTY_COLUMNS = "id, label, street, access_method, key_location, lock_box_code, gate_code";

/** The client's properties served by a live walking or sitting plan. */
async function homeServicePropertyIds(sb: any, clientId: string, orgId: string): Promise<string[]> {
  const { data } = await sb
    .from("subscriptions")
    .select("property_id, services!inner(service_line)")
    .eq("client_id", clientId)
    .eq("organization_id", orgId)
    .in("status", ["active", "paused"])
    .in("services.service_line", ["dog_walking", "pet_sitting"]);
  return [
    ...new Set(((data ?? []) as Array<{ property_id: string | null }>).map((r) => r.property_id)),
  ].filter((id): id is string => !!id);
}

export const portalGetAccess = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = await admin();
    const ids = await homeServicePropertyIds(sb, session.clientId, session.organizationId);
    if (ids.length === 0) return { properties: [] as PortalAccess[] };
    const { data: rows, error } = await sb
      .from("properties")
      .select(PROPERTY_COLUMNS)
      .eq("client_id", session.clientId)
      .eq("organization_id", session.organizationId)
      .is("archived_at", null)
      .in("id", ids)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { properties: ((rows ?? []) as PropertyRow[]).map(portalAccessOf) };
  });

/** A code: undefined leaves it alone, null removes it, a string replaces it. */
const codeField = z
  .string()
  .trim()
  .min(1, "Type the code, or remove it.")
  .max(PORTAL_CODE_MAX, `A code can be up to ${PORTAL_CODE_MAX} characters.`)
  .nullable()
  .optional();

export const portalUpdateAccessSchema = z.object({
  token: z.string().uuid(),
  propertyId: z.string().uuid(),
  accessMethod: z.enum(ACCESS_METHODS).nullable().optional(),
  keyLocation: z
    .string()
    .trim()
    .max(KEY_LOCATION_MAX, `Keep the key note under ${KEY_LOCATION_MAX} characters.`)
    .nullable()
    .optional(),
  lockBoxCode: codeField,
  doorCode: codeField,
});

/** The columns a change writes, and the words for the activity line. Pure,
 *  and never carries a code's value into the words. */
export function accessPatch(input: z.infer<typeof portalUpdateAccessSchema>): {
  patch: Record<string, string | null>;
  changed: string[];
} {
  const patch: Record<string, string | null> = {};
  const changed: string[] = [];
  if (input.accessMethod !== undefined) {
    patch.access_method = input.accessMethod;
    changed.push("the way in");
  }
  if (input.keyLocation !== undefined) {
    patch.key_location = input.keyLocation ? input.keyLocation : null;
    changed.push("where the key is");
  }
  if (input.lockBoxCode !== undefined) {
    patch.lock_box_code = input.lockBoxCode;
    changed.push(input.lockBoxCode === null ? "removed the lock box code" : "the lock box code");
  }
  if (input.doorCode !== undefined) {
    patch.gate_code = input.doorCode;
    changed.push(input.doorCode === null ? "removed the door code" : "the door code");
  }
  return { patch, changed };
}

export const portalUpdateAccess = createServerFn({ method: "POST" })
  .inputValidator((d) => portalUpdateAccessSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();

    // The client's own, live property, on a walk plan. Anything else is the
    // same refusal, so the answer says nothing about other clients' homes.
    const ids = await homeServicePropertyIds(sb, session.clientId, session.organizationId);
    if (!ids.includes(data.propertyId)) throw new Error("That address isn't on your account.");

    const { patch, changed } = accessPatch(data);
    if (changed.length === 0) throw new Error("Nothing to save.");

    const { data: rows, error } = await sb
      .from("properties")
      .update(patch)
      .eq("id", data.propertyId)
      .eq("client_id", session.clientId)
      .eq("organization_id", session.organizationId)
      .is("archived_at", null)
      .select(PROPERTY_COLUMNS);
    if (error) throw new Error("That couldn't be saved. Please try again.");
    const row = ((rows ?? []) as PropertyRow[])[0];
    if (!row) throw new Error("That address isn't on your account.");

    // The office sees that it changed and what, never the code itself.
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(sb, {
        orgId: session.organizationId,
        clientId: session.clientId,
        propertyId: data.propertyId,
        actorUserId: null,
        actorLabel: "Customer portal",
        kind: "property.access_updated",
        summary: `Client updated how we get in: ${changed.join(", ")}`,
        meta: { fields: Object.keys(patch) },
      });
    } catch (e) {
      console.error("access activity line failed", (e as Error).message);
    }
    return { access: portalAccessOf(row) };
  });
