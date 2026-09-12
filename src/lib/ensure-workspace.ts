import { supabase } from "@/integrations/supabase/client";
import { bootstrapOrganization } from "@/lib/org.functions";

/**
 * The browser's own IANA zone, for the one moment it is worth asking.
 *
 * `organizations.timezone` is NOT NULL DEFAULT 'America/Chicago' and nothing
 * in signup has ever set it, so every workspace started in US Central and
 * stayed there until its owner found Settings -> Preferences. An operator in
 * Michigan was an hour out and one in California three, on every workday
 * window, every ETA, every "visits today" boundary and every month-to-date
 * cut.
 *
 * Undefined rather than a guess when it cannot be read: SSR has no Intl
 * locale to speak of, and the accessor can throw in a hardened browser. The
 * server treats a missing or unresolvable zone identically -- it drops it and
 * the column default stands -- so there is exactly one fallback and it is not
 * spelled here.
 */
function browserTimezone(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The signed-in user's shape, as much of it as the bootstrap needs. */
export type BootstrapUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, any> | null;
};

export type BootstrapOverrides = {
  /** Business name typed by the user, when the metadata captured at signup is
   *  missing or wrong. Falls back to the metadata when omitted. */
  orgName?: string;
  displayName?: string;
  /** Refuse to invent a business name, and say so instead.
   *
   *  Every route into a new organization EXCEPT /get-started arrives with no
   *  business name: an OAuth round-trip carries the provider's profile and
   *  nothing else, and a magic link carries less. The fallback below turned
   *  that into `${displayName}'s Organization` silently — a name printed on
   *  invoices, the customer portal and outbound email, that no settings screen
   *  could change. Meanwhile /get-started rejects placeholder names outright,
   *  so the careful path was the one that asked and the quiet path was the one
   *  that guessed.
   *
   *  Callers that can put a form in front of the person set this and route to
   *  /no-workspace on the sentinel. */
  requireOrgName?: boolean;
};

/** Returned instead of bootstrapping when `requireOrgName` is set and nothing
 *  in the session supplies a real business name. */
export const NEEDS_ORG_NAME = "needs-org-name" as const;

/**
 * If the user has no org membership yet (email-confirmation flow: bootstrap was
 * deferred from signup), create the org + owner role now using the metadata
 * captured at signup. Idempotent server-side via bootstrap_organization().
 *
 * Lifted out of /auth on 2026-08-20 so /no-workspace can run the same sequence.
 * Before that, this ran on exactly one trigger — a visit to /auth — and an
 * account that never came back stayed stranded forever. Nine accounts in
 * production have no organization and no membership; one of them signed up on
 * 2026-07-14, returned 48 minutes later, and still has no workspace. The order
 * below is the reason it must not be duplicated by hand: invite BEFORE
 * bootstrap. An invited account that bootstraps its own org can never accept
 * the invitation afterwards — accept_org_invite_for_current_user refuses a
 * second membership (BUG-18), and that refusal is permanent.
 *
 * @returns true when a brand-new org was just bootstrapped — that caller should
 *          route to /onboarding instead of the usual landing page.
 */
export async function ensureBootstrapped(
  user: BootstrapUser,
  overrides: BootstrapOverrides = {},
): Promise<boolean | typeof NEEDS_ORG_NAME> {
  const { data: existing } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) return false;

  // Platform admins have zero user_roles rows by design — they must never get
  // a tenant org auto-provisioned. (bootstrap_organization also guards this
  // server-side; the check here avoids a pointless org-create round trip.)
  const { data: isPlatform } = await supabase.rpc("is_platform_admin", { _user_id: user.id });
  if (isPlatform) return false;

  // Teammate invite (finding #40): if this email was invited to an existing
  // org, join THAT org with the invited role instead of bootstrapping a new
  // one. Idempotent server-side; returns null when there's no pending invite.
  // `?invite=<token>` comes from the link in the invitation email. It is the
  // route for somebody who already had an account when they were invited --
  // the email path now only accepts invitations older than the account, so a
  // pre-existing account has no other way in. Absent on an ordinary sign-in,
  // where the email path still handles it.
  const inviteToken =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("invite");
  const { data: invitedOrg } = await supabase.rpc(
    "accept_org_invite_for_current_user" as any,
    {
      _token: inviteToken,
    } as any,
  );
  if (invitedOrg) {
    // A new employee just joined — reconcile the org's Stripe seat count so
    // per-employee billing catches up immediately. Best-effort.
    try {
      const { resyncMySeats } = await import("@/lib/users.functions");
      await resyncMySeats();
    } catch (err) {
      console.error("seat resync after invite acceptance failed", err);
    }
    return false;
  }

  const md = user.user_metadata ?? {};
  const emailLocal = (user.email ?? "").split("@")[0] || "Owner";
  const displayName: string =
    (overrides.displayName && overrides.displayName.trim()) ||
    (typeof md.display_name === "string" && md.display_name.trim()) ||
    (typeof md.full_name === "string" && md.full_name.trim()) ||
    (typeof md.name === "string" && md.name.trim()) ||
    emailLocal;
  const typedOrgName =
    (overrides.orgName && overrides.orgName.trim()) ||
    (typeof md.org_name === "string" && md.org_name.trim()) ||
    null;
  // Nothing in the session names the business, and the caller can ask. Stop
  // here rather than minting an organization the owner cannot rename.
  if (!typedOrgName && overrides.requireOrgName) return NEEDS_ORG_NAME;
  const orgName: string = typedOrgName || `${displayName}'s Organization`;

  // OAuth signups round-trip through the provider, so referral/UTM attribution
  // from /sign-up rides localStorage (see signup-attribution.ts).
  const { readSignupAttribution, clearSignupAttribution } =
    await import("@/lib/signup-attribution");
  const attribution = readSignupAttribution();
  await bootstrapOrganization({
    data: {
      orgName,
      displayName,
      refCode: attribution.ref,
      utm: attribution.utm,
      promoCode: attribution.promo,
      timezone: browserTimezone(),
    },
  });
  clearSignupAttribution();
  // Get-started walkthrough stashes texting consent in user metadata when the
  // email-confirmation flow defers bootstrap — apply it now (best-effort).
  if (md.sms_consent === true && typeof md.phone === "string" && md.phone.trim()) {
    try {
      const { recordSmsConsent } = await import("@/lib/org.functions");
      const { SMS_CONSENT_TEXT } = await import("@/routes/get-started");
      await recordSmsConsent({ data: { phone: md.phone.trim(), consentText: SMS_CONSENT_TEXT } });
    } catch (err) {
      console.error("deferred sms consent record failed", err);
    }
  }
  return true;
}
