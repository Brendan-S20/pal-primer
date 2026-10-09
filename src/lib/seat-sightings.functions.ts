import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * "I am using the app": records the caller's sighting for billing (a seat is
 * anybody who used their login this period -- see seat-rule.ts).
 *
 * The offline queue calls this after it replays a tech's work, so a day spent
 * in a dead zone is counted when it reaches the server. Everything else is
 * covered by getMyOrg, which records the same sighting on its own.
 *
 * Never fails the caller: a sighting that could not be recorded is retried by
 * the next getMyOrg, and replayed work must not be reported as failed over it.
 */
export const noteMySighting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { noteStaffSeen } = await import("@/lib/seat-sightings.server");
    // Forced past the per-isolate throttle: a replay is rare, and it is the
    // one moment we know for certain the work has just landed.
    const r = await noteStaffSeen(context.supabase, context.userId, { force: true });
    return { ok: true, stamped: !!r?.stamped };
  });
