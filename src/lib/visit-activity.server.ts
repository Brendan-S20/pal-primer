// The activity-log line a visit's start writes, wherever the start came from.
//
// One copy, two callers: startVisit (src/lib/my-day.functions.ts), with the
// tech's own client, and the lock screen's Start
// (src/lib/live-activity-action.server.ts), with the service role. The line
// is the same either way and says which it was, so the client's timeline
// reads "Started the visit scheduled for 2026-10-08 (from the lock screen)".
//
// Best-effort: the visit has already started when this runs, and a broken
// activity log must not fail the tech's tap. But never silently: a warning
// names the visit, so a log that stops working can be found.

type Client = { from: (table: string) => any };

export async function logVisitStarted(
  client: Client,
  input: { visitId: string; actorUserId: string; via?: "lock_screen" },
): Promise<void> {
  try {
    const { data: v } = await client
      .from("visits")
      .select("organization_id, client_id, property_id, scheduled_on")
      .eq("id", input.visitId)
      .single();
    if (!v) return;
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(client, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: input.actorUserId,
      kind: "visit.started",
      summary:
        input.via === "lock_screen"
          ? `Started the visit scheduled for ${v.scheduled_on} (from the lock screen)`
          : `Started the visit scheduled for ${v.scheduled_on}`,
      ...(input.via ? { meta: { via: input.via } } : {}),
    });
  } catch (e) {
    console.warn("visit.started activity log failed", input.visitId, e);
  }
}
