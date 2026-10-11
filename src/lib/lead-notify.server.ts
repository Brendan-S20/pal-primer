// The office is told about a new lead.
//
// Until this existed a quote request or an online signup landed in Leads and
// nobody heard about it: the notification type "lead" ("New website leads")
// has been in Settings → Notifications, mutable, since the notification centre
// was built, and nothing ever sent one. The owner learned about a new customer
// by happening to open Leads.
//
// Who hears: the owner, the office managers, and anyone else whose role holds
// `manage_leads`, the permission every Leads read and write is gated on
// (leads.functions.ts). The list is derived from the permission matrix rather
// than written out, so a role granted the permission later is told without a
// change here. Through notifyRoles, the one door every notification leaves by,
// which drops anybody who muted "lead" and (once #378 lands) anybody whose
// access is turned off.
//
// How: the bell, and a push to the phone (a lead is something to act on, so it
// is not one of the in-app-only types). Not an email: every email this app
// sends goes to a business's CLIENT, under the business's own per-email
// switches, and there is no per-person email preference for staff to honour.
// Not a text: texting waits on carrier registration.
//
// Once per lead. The event key is the lead's id, so the database's unique
// (recipient, event_key) index makes a second call for the same lead insert
// nothing and push nothing. The callers only call it when a lead row was
// actually INSERTED: a signup that re-uses the lead it wrote a minute ago
// (recordSignupLead) is not new, and a signup that pays later is the same
// lead being marked converted by the Stripe webhook, which says nothing.

import type { AppRole } from "@/hooks/useMyRole";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { LEAD_SOURCE } from "@/lib/new-customer-form";
import { frequencyLabel } from "@/lib/frequency-request";

export const LEAD_NOTICE_TYPE = "lead";

/** Every role that may work Leads, in the matrix's order. */
export function rolesThatWorkLeads(): AppRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as AppRole[]).filter((r) =>
    ROLE_PERMISSIONS[r].includes("manage_leads"),
  );
}

export type NewLead = {
  orgId: string;
  leadId: string;
  name: string;
  source: string;
  location?: string | null;
  dogCount?: number | null;
  frequency?: string | null;
  /** The service they asked about, when the business offers more than one
   *  (phase 5). The business's own name for it, as it reads on its page. */
  serviceName?: string | null;
};

/** What the bell and the lock screen say. A stranger's name and how they
 *  came in; the address, the yard and the service after it, as much as they
 *  gave. */
export function leadNotice(lead: Omit<NewLead, "orgId" | "leadId">): { title: string; body: string } {
  const name = lead.name.trim().slice(0, 80) || "Someone";
  const how =
    lead.source === LEAD_SOURCE.onlineSignup
      ? "Started signing up online"
      : lead.source === LEAD_SOURCE.doorSignup
        ? "Started signing up at the door"
        : "Asked for a quote";
  const parts = [how];
  const where = (lead.location ?? "").trim();
  if (where) parts.push(where.slice(0, 120));
  if (lead.dogCount != null && lead.dogCount > 0) {
    parts.push(`${lead.dogCount} dog${lead.dogCount === 1 ? "" : "s"}`);
  }
  const freq = (lead.frequency ?? "").trim();
  if (freq) parts.push(frequencyLabel(freq));
  const service = (lead.serviceName ?? "").trim();
  if (service) parts.push(service.slice(0, 80));
  return { title: `New lead: ${name}`, body: parts.join(" · ") };
}

/**
 * Tell the office. Best-effort: a notice that fails must never cost the
 * lead or the sale, so this never throws.
 */
export async function notifyOfficeOfNewLead(lead: NewLead): Promise<void> {
  try {
    const { notifyRoles } = await import("@/lib/notify-center.server");
    const { title, body } = leadNotice(lead);
    await notifyRoles(rolesThatWorkLeads(), {
      orgId: lead.orgId,
      type: LEAD_NOTICE_TYPE,
      title,
      body,
      link: "/leads",
      threadId: `lead:${lead.leadId}`,
      eventKey: `lead:${lead.leadId}`,
    });
  } catch (e) {
    console.error("new lead notification failed", lead.orgId, lead.leadId, e);
  }
}
