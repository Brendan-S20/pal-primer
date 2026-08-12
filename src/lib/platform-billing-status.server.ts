// One writer for `organizations.billing_status`, and a record of every change.
//
// ── THE BUG THIS EXISTS FOR ───────────────────────────────────────────────
//
// The platform Stripe webhook — the only thing on this system that hears from
// Stripe about a tenant's subscription — wrote `plan_status` and never
// `billing_status`. The word does not appear in
// `src/routes/api/public/hooks/platform-stripe.ts` at all.
//
// Almost everything that answers "is this tenant paying us" reads the OTHER
// column: `contributesRevenue` → `isPayingStatus(billing_status)` for MRR,
// `active_tenants` on the platform overview, and the status chip on
// /platform/tenants. So a tenant who subscribed and never opened Settings →
// Billing stayed `billing_status = 'free'` forever: absent from MRR, counted as
// a freemium prospect in the console, and shown to us as not paying while
// Stripe charged their card every month.
//
// The one thing that did write both columns is `refreshBillingStatus`, which
// runs when someone opens the billing page. That is why the split was
// survivable and why it was invisible: the tenants we looked at were the ones
// who had looked at their own billing.
//
// The brief already recorded this shape once, in BUG-32: "BUILD-7 set
// plan_status='trialing' but left billing_status, and /platform/tenants reads
// the latter, so every trial showed as 'Free'". Same two columns, same
// direction, a different writer.
//
// ── AND WHY IT ALSO WRITES AN AUDIT ROW ───────────────────────────────────
//
// `getPlatformOverview` computes "Converted this month" from
// `platform_admin_audit` rows whose action is `subscription_created` or
// `billing_status_change`, reading `after_json.billing_status`. Neither string
// has ever been written by anything — checked against the live table, which
// holds five distinct actions and neither of those. The query was not wrong;
// the event it reads was never emitted, so the KPI has read 0 since the day it
// shipped and would have kept reading 0 with a hundred conversions behind it.
//
// So the status change and the audit row are one operation here rather than two
// facts that can drift apart.
//
// ── WHAT IT DELIBERATELY WILL NOT DO ──────────────────────────────────────
//
// It will not overwrite `suspended`. That status is only ever set by a platform
// admin, with a reason, from `suspendTenant` — a tenant suspended for fraud
// whose card still works would otherwise be un-suspended by the next
// `invoice.paid`, silently, with the suspension reason still sitting in the
// row. `reactivateTenant` is the way back, and it is a person.
//
// It is also not used by the admin actions themselves. `suspendTenant`,
// `reactivateTenant`, `grantGracePeriod` and `setTenantStatus` already write an
// audit row naming exactly what the admin did, and an admin flipping a tenant
// to active is not evidence that anybody paid — counting it as a conversion
// would inflate the only number on that page that claims to measure sales.

// Type-only, so it is erased at compile time and this module still carries no
// server import into anything that pulls it in dynamically.
import type { supabaseAdmin as AdminClientValue } from "@/integrations/supabase/client.server";

type AdminClient = typeof AdminClientValue;

/** Statuses that mean the tenant is paying us. Mirrors PAYING_STATUSES in
 *  platform-metrics.ts, which is what MRR and the console read. */
const PAYING = ["active", "grace", "past_due"];

export type BillingStatusSource = "platform_webhook" | "billing_refresh";

export type BillingStatusChange = {
  /** True when the column was actually written. False when it already held
   *  this value, or when the write was refused. */
  changed: boolean;
  previous: string | null;
  next: string | null;
  /** Set when the write was refused, naming why. */
  refused?: "suspended";
};

/**
 * Move a tenant's `billing_status` and record the move.
 *
 * Reads the current value first, because "did this change" is the whole
 * question — a webhook redelivery must not file a second conversion, and
 * `customer.subscription.updated` fires for changes that have nothing to do
 * with status at all.
 */
export async function applyPlatformBillingStatus(
  supabaseAdmin: AdminClient,
  orgId: string,
  next: "active" | "past_due" | "canceled" | "free" | "trialing" | "grace",
  opts: {
    source: BillingStatusSource;
    /** The Stripe event or the signed-in user behind this, for the audit row.
     *  Null for a webhook: nobody in this system did it. */
    actorUserId?: string | null;
    /** Free-form context stored on the audit row — the event type, the
     *  subscription id. Read by nothing; present so the row can be explained
     *  a year later. */
    detail?: Record<string, unknown>;
  },
): Promise<BillingStatusChange> {
  const { data: before } = await supabaseAdmin
    .from("organizations")
    .select("billing_status")
    .eq("id", orgId)
    .maybeSingle();
  const previous: string | null =
    (before as { billing_status?: string } | null)?.billing_status ?? null;

  if (previous === "suspended") {
    return { changed: false, previous, next: previous, refused: "suspended" };
  }
  if (previous === next) return { changed: false, previous, next };

  const { error } = await supabaseAdmin
    .from("organizations")
    .update({ billing_status: next })
    .eq("id", orgId);
  if (error) throw new Error(error.message);

  // Best-effort, exactly like the `audit` helper in platform-tenant: the money
  // state is the fact that must be right, and losing the log entry must not
  // roll back a subscription activation.
  try {
    await supabaseAdmin.from("platform_admin_audit").insert({
      actor_user_id: opts.actorUserId ?? null,
      organization_id: orgId,
      action: "billing_status_change",
      before_json: { billing_status: previous },
      after_json: {
        billing_status: next,
        // `getPlatformOverview` reads after_json.billing_status and nothing
        // else; the rest is for a human reading the tenant's audit tab.
        source: opts.source,
        became_paying: PAYING.includes(next) && !PAYING.includes(previous ?? ""),
        ...(opts.detail ?? {}),
      },
    });
  } catch (e) {
    console.error("billing_status_change audit failed", { orgId, previous, next }, e);
  }

  return { changed: true, previous, next };
}
