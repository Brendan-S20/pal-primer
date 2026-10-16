// Stay emails use the existing queue, opt-outs and once-per-key send log.
import { addDays, stayDatesLabel } from "@/lib/stays";

async function sendStayNotice(stayId: string, kind: "confirmed" | "ending") {
  const { supabaseAdmin: sb } = await import("@/integrations/supabase/client.server");
  const { data: stay, error } = await sb
    .from("stays")
    .select(
      "id, organization_id, client_id, kind, status, starts_on, ends_on, deposit_cents, deposit_invoice_id, services(name), organizations(service_lines), clients(portal_token)",
    )
    .eq("id", stayId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !stay ||
    stay.status !== "confirmed" ||
    !stay.organizations?.service_lines?.includes("pet_sitting")
  )
    return;
  const { buildPortalLink } = await import("@/lib/portal-links.server");
  const portal = await buildPortalLink(stay.organization_id, stay.clients?.portal_token);
  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  return enqueueAppEmail({
    organizationId: stay.organization_id,
    clientId: stay.client_id,
    templateName: `stay-${kind}`,
    notifyKey: kind === "confirmed" ? "notify_email_stay_confirmed" : "notify_email_stay_ending",
    idempotencyKey: `stay-${kind}-${stay.id}`,
    oncePerKey: true,
    templateData: {
      serviceName: stay.services?.name ?? "Pet sitting",
      dates: stayDatesLabel(stay.kind as "drop_in" | "overnight", stay.starts_on, stay.ends_on),
      portalUrl: portal ? `${portal}/visits` : undefined,
      depositUrl:
        kind === "confirmed" && stay.deposit_invoice_id && portal
          ? `${portal}/pay/${stay.deposit_invoice_id}`
          : undefined,
    },
  });
}

/** Booking is already committed. A mail failure must not invite a rebooking. */
export async function notifyStayConfirmed(stayId: string): Promise<void> {
  try {
    const result = await sendStayNotice(stayId, "confirmed");
    if (result && !result.ok && ["render_failed", "enqueue_failed"].includes(result.reason ?? "")) {
      console.error("stay confirmation email failed", stayId, result.reason);
    }
  } catch (error) {
    console.error("stay confirmation email failed", stayId, error);
  }
}

/** today is supplied by nightly on the business's calendar. Retrying the
 *  job on that day queues at most one ending message per stay. */
export async function notifyStaysEnding(orgId: string, today: string): Promise<number> {
  const { supabaseAdmin: sb } = await import("@/integrations/supabase/client.server");
  const { data: org, error: orgError } = await sb
    .from("organizations")
    .select("service_lines, notify_email_stay_ending")
    .eq("id", orgId)
    .single();
  if (orgError) throw new Error(orgError.message);
  if (!org.service_lines?.includes("pet_sitting") || !org.notify_email_stay_ending) return 0;
  const { data: rows, error } = await sb
    .from("stays")
    .select("id")
    .eq("organization_id", orgId)
    .eq("status", "confirmed")
    .eq("ends_on", addDays(today, 1));
  if (error) throw new Error(error.message);
  let queued = 0;
  for (const stay of rows ?? []) {
    try {
      if ((await sendStayNotice(stay.id, "ending"))?.ok) queued++;
    } catch (error) {
      console.error("stay ending email failed", stay.id, error);
    }
  }
  return queued;
}
