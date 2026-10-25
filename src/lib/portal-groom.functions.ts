import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { GROOM_WINDOW_KEYS } from "@/lib/groom-request";

// The customer portal's Grooming page. Same shape as portal.functions.ts:
// the session check first, then the service role, and every read and write
// scoped to the session's own client. portal-auth.server.ts and the admin
// client are imported inside handlers only (see portal.functions.ts).
async function portalAuth() {
  return import("@/lib/portal-auth.server");
}
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const token = z.string().uuid();

/** The client's pets, the business's grooms and add-ons with the office's
 *  size rules, and the client's groom requests. `visible: false` for a
 *  client whose business does not run mobile grooming. */
export const portalGetGrooming = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const { loadPortalGroom } = await import("@/lib/portal-groom.server");
    return loadPortalGroom(await admin(), session);
  });

/**
 * Ask for a groom. It lands in the office's Concerns inbox as a request; the
 * office picks the start time and the groomer and books it. The database
 * refuses what cannot be booked (portal_request_groom) and returns the first
 * request on a second tap.
 */
export const portalRequestGroom = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token,
        dogId: z.string().uuid(),
        serviceId: z.string().uuid(),
        addons: z
          .array(
            z.object({
              addonServiceId: z.string().uuid(),
              quantity: z.number().int().min(1).max(20),
            }),
          )
          .max(20)
          .refine((a) => new Set(a.map((x) => x.addonServiceId)).size === a.length, {
            message: "An add-on is listed twice.",
          }),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        window: z.enum(GROOM_WINDOW_KEYS as [string, ...string[]]),
        message: z.string().max(1000).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const { requestGroomFromPortal } = await import("@/lib/portal-groom.server");
    return requestGroomFromPortal(await admin(), session, data.token, {
      dogId: data.dogId,
      serviceId: data.serviceId,
      addons: data.addons,
      day: data.day,
      window: data.window as (typeof GROOM_WINDOW_KEYS)[number],
      message: data.message,
    });
  });
