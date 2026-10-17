import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { formatDay } from "@/lib/format";

// The customer portal's Training page. Same shape as portal.functions.ts:
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

/** Packages, lessons with scores, notes and homework, upcoming lessons and
 *  the packages for sale. `visible: false` for a client the page is not for. */
export const portalGetTraining = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const { loadPortalTraining } = await import("@/lib/training-portal.server");
    return loadPortalTraining(await admin(), session);
  });

/** Buy a package: the office's sale and invoice, then the existing pay page. */
export const portalBuyTrainingPackage = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token,
        servicePackageId: z.string().uuid(),
        dogId: z.string().uuid().optional(),
        /** One per tap on Buy, so a double tap is one sale. */
        requestId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const { buyPackageFromPortal } = await import("@/lib/training-portal.server");
    return buyPackageFromPortal(await admin(), session, {
      servicePackageId: data.servicePackageId,
      dogId: data.dogId,
      requestId: data.requestId,
    });
  });

/**
 * Ask for the next lesson from a package's balance. It lands in the office's
 * Concerns inbox as a request, like an extra visit, for the office to book.
 * The database refuses what cannot be booked (portal_request_training_lesson)
 * and returns the first request on a second tap; only the call that created
 * it tells the office.
 */
export const portalRequestTrainingLesson = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token,
        clientPackageId: z.string().uuid(),
        propertyId: z.string().uuid(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .nullable()
          .optional(),
        message: z.string().max(1000).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_request_training_lesson", {
      _token: data.token,
      _client_package_id: data.clientPackageId,
      _property_id: data.propertyId,
      _on: data.day,
      // The SQL function takes NULL for _at: no time asked for.
      _at: (data.time ?? null) as string,
      _message: data.message,
    });
    if (error) {
      const { lessonRequestRefusal } = await import("@/lib/training-portal");
      throw new Error(lessonRequestRefusal(error.message));
    }
    const row = ((rows ?? []) as Array<{ ticket_id: string; created: boolean }>)[0];
    if (!row?.ticket_id) throw new Error("That request couldn't be saved. Please try again.");
    if (!row.created) return { ticketId: row.ticket_id, alreadyAsked: true };

    const when = `${formatDay(data.day)}${data.time ? ` at ${data.time}` : ""}`;
    try {
      const { notifyOfficeOfConcern } = await import("@/lib/portal.functions");
      await notifyOfficeOfConcern(
        sb,
        data.token,
        "one_off_request",
        data.message,
        when,
        false,
        "Training lesson",
      );
    } catch (e) {
      console.error("lesson request office email failed", (e as Error).message);
    }
    try {
      const { data: cl } = await sb
        .from("clients")
        .select("display_name")
        .eq("id", session.clientId)
        .maybeSingle();
      const { notifyRoles } = await import("@/lib/notify-center.server");
      await notifyRoles(["owner", "office_manager"], {
        orgId: session.organizationId,
        type: "concern",
        title: `Training lesson requested: ${cl?.display_name ?? "a client"}`,
        body: `For ${when}${data.message ? `: ${data.message.slice(0, 120)}` : ""}`,
        link: "/concerns",
        eventKey: `training-request:${row.ticket_id}`,
      });
    } catch (e) {
      console.error("lesson request in-app notification failed", (e as Error).message);
    }
    return { ticketId: row.ticket_id, alreadyAsked: false };
  });
