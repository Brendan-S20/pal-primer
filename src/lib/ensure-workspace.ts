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

// ── The invite token ─────────────────────────────────────────────────────────
//
// `?invite=<token>` comes from the invitation link. Reading it only from the
// address bar lost it twice (#568): /auth handed a new email to /get-started
// without it, and an OAuth round-trip comes back to the site root with no
// query string at all. So the first page that sees it keeps a copy here, and
// whoever accepts it clears it.
const INVITE_KEY = "hs.pending-invite";
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Keep the token from the current URL, if there is one. */
export function rememberInviteToken(token?: string | null): void {
  const t =
    token ??
    (typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("invite"));
  if (!t) return;
  try {
    localStorage.setItem(INVITE_KEY, JSON.stringify({ token: t, at: Date.now() }));
  } catch {
    // Private mode or blocked storage: the URL still carries it on this page.
  }
}

/** The token in the URL, or the one kept from an earlier page today. */
export function pendingInviteToken(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("invite");
  if (fromUrl) return fromUrl;
  try {
    const raw = localStorage.getItem(INVITE_KEY);
    if (!raw) return null;
    const { token, at } = JSON.parse(raw) as { token?: string; at?: number };
    if (!token || typeof at !== "number" || Date.now() - at > INVITE_TTL_MS) {
      localStorage.removeItem(INVITE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function forgetInviteToken(): void {
  try {
    localStorage.removeItem(INVITE_KEY);
  } catch {
    // nothing to forget
  }
}

/**
 * Join the organization this account was invited to, if any.
 *
 * Uses the token when there is one (the only way in for an account that
 * existed before the invitation), otherwise the email path. Returns the
 * organization joined, or null when there was nothing to accept. Throws the
 * database's own refusal (already in another organization, a pending invite
 * that needs its link) so the caller can show it instead of building a
 * second business.
 */
/** An invitation the database (or the address on it) says this account
 *  cannot use. Its message is written for the person, and /auth shows it
 *  instead of carrying on to a business of their own. */
export class InviteRefusedError extends Error {
  name = "InviteRefusedError";
  /** Set when the invitation is fine and the account is the problem, so the
   *  person can sign out and come back to the same link. */
  constructor(
    message: string,
    readonly retryToken: string | null = null,
  ) {
    super(message);
  }
}

/** Why a token matched nothing, when the reason is one a person can act on:
 *  the invitation was sent to a different address than the one signed in. */
async function addressMismatch(token: string): Promise<string | null> {
  try {
    const [{ lookupInviteByToken }, { data }] = await Promise.all([
      import("@/lib/platform-onboarding.functions"),
      supabase.auth.getUser(),
    ]);
    const me = data.user?.email;
    const inv = await lookupInviteByToken({ data: { token } });
    if (!inv.ok || inv.kind !== "staff" || !inv.email || !me) return null;
    if (inv.email.toLowerCase() === me.toLowerCase()) return null;
    return `This invitation was sent to ${inv.email}, and you're signed in as ${me}. Sign out, then sign in or create an account with ${inv.email} to join.`;
  } catch {
    return null;
  }
}

export async function acceptPendingInvite(token = pendingInviteToken()): Promise<string | null> {
  const { data: invitedOrg, error } = await supabase.rpc(
    "accept_org_invite_for_current_user" as any,
    { _token: token } as any,
  );
  if (error) {
    // A refusal is final for this token (wrong account, already in another
    // business). Keeping it would replay the same refusal on every sign-in
    // for a day.
    if (token) forgetInviteToken();
    throw new InviteRefusedError(error.message);
  }
  if (!invitedOrg) {
    // A token that matched nothing is dropped. Signed in as somebody other
    // than the invited address (a Google account under another email), that
    // is said out loud: carrying on silently is how the invitee ends up
    // asked to name a business of their own (#568). Otherwise (expired,
    // revoked) the email path gets its turn: a newer invitation for this
    // address may still be waiting.
    if (token) {
      forgetInviteToken();
      const mismatch = await addressMismatch(token);
      if (mismatch) throw new InviteRefusedError(mismatch, token);
      return acceptPendingInvite(null);
    }
    return null;
  }
  forgetInviteToken();
  // A new employee just joined — reconcile the org's Stripe seat count so
  // per-employee billing catches up immediately. Best-effort.
  try {
    const { resyncMySeats } = await import("@/lib/users.functions");
    await resyncMySeats();
  } catch (err) {
    console.error("seat resync after invite acceptance failed", err);
  }
  return invitedOrg as string;
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
  // Two-step sign-in first. Until the code is entered the database hides this
  // person's roles (public.mfa_satisfied), so the lookup below would find
  // none and go on to build an owner who already has a business a SECOND
  // one. Nothing here is decided before the second step; the shell sends
  // them to /two-step, and an existing account needs no bootstrapping.
  const { needsSecondStep } = await import("@/lib/mfa");
  if (await needsSecondStep()) return false;

  const { data: existing } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) {
    // Already somebody's teammate, arriving through an invitation link. The
    // database either records the invite as used (same business) or says why
    // it cannot be (a different one); either way the person finds out here
    // instead of the invitation sitting pending forever.
    if (pendingInviteToken()) await acceptPendingInvite();
    return false;
  }

  // Platform admins have zero user_roles rows by design — they must never get
  // a tenant org auto-provisioned. (bootstrap_organization also guards this
  // server-side; the check here avoids a pointless org-create round trip.)
  const { data: isPlatform } = await supabase.rpc("is_platform_admin", { _user_id: user.id });
  if (isPlatform) return false;

  // Teammate invite (finding #40): if this email was invited to an existing
  // org, join THAT org with the invited role instead of bootstrapping a new
  // one. Idempotent server-side; returns null when there's no pending invite.
  if (await acceptPendingInvite()) return false;

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
