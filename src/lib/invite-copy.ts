// What the invite page and the Team page say about an invitation
// (gaps-r2-03, -10, -14). Pure, so the words are pinned by a test rather than
// found on a screen.

/** How long a teammate invitation works. org_invites.expires_at defaults to
 *  this (20260710190000_org-invites.sql); a resend renews it to the same. */
export const INVITE_LIFETIME_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The expiry a resent invitation gets: a full lifetime from now, and never
 *  earlier than it already had. Resend used to set now + 7 days, which cut a
 *  fresh 14-day invitation in half (gaps-r2-10). */
export function resentInviteExpiry(
  currentExpiresAt: string | null | undefined,
  now = Date.now(),
): string {
  const renewed = now + INVITE_LIFETIME_DAYS * DAY_MS;
  const current = currentExpiresAt ? new Date(currentExpiresAt).getTime() : Number.NaN;
  return new Date(Number.isFinite(current) ? Math.max(current, renewed) : renewed).toISOString();
}

export type InviteKind = "platform" | "staff";
export type InviteProblemReason = "not_found" | "expired" | "revoked" | "accepted";

/** The card title. A lookup that failed still knows which table the token was
 *  in, so a revoked or used teammate link is a "Team invitation", not a
 *  "Platform invite" (gaps-r2-14). A token found nowhere is just "Invitation". */
export function inviteTitle(kind: InviteKind | undefined): string {
  if (kind === "staff") return "Team invitation";
  if (kind === "platform") return "Platform invite";
  return "Invitation";
}

/** Why the link can't be used, and who to ask. */
export function inviteProblem(r: {
  kind?: InviteKind;
  reason?: InviteProblemReason;
  organization_name?: string | null;
  inviter_name?: string | null;
}): string {
  const what =
    r.reason === "expired"
      ? "This invite has expired."
      : r.reason === "revoked"
        ? "This invite was revoked."
        : r.reason === "accepted"
          ? "This invite has already been used."
          : "Invite not found.";
  if (r.kind !== "staff") return what;
  const business = r.organization_name?.trim();
  const who =
    r.inviter_name?.trim() ||
    (business ? `the owner of ${business}` : "the person who invited you");
  const at = business && r.inviter_name?.trim() ? ` at ${business}` : "";
  if (r.reason === "accepted") {
    return `${what} If that was you, sign in to open ${business ?? "the business"}. Otherwise ask ${who}${at} for a new link.`;
  }
  return `${what} Ask ${who}${at} for a new link.`;
}

/** Why a signed-in account can't accept, said before the button is pressed
 *  (gaps-r2-03). Mirrors the refusal in accept_org_invite_for_current_user. */
export function otherOrgReason(
  email: string | null | undefined,
  currentOrgName: string | null | undefined,
  invitingOrgName: string | null | undefined,
): string {
  const account = email ? `${email} already belongs to` : "This account already belongs to";
  const current = currentOrgName?.trim() || "another business";
  const inviting = invitingOrgName?.trim() || "this business";
  return `${account} ${current}, and an account can belong to one business. To join ${inviting}, ask them to send the invitation to a different email address, or leave ${current} first.`;
}

/** The toast after Send invite or Resend. "Sent" only when the provider took
 *  the email (#612); a resend says "Resent", not "Invite created" (gaps-r2-10). */
export function inviteSendToast(
  action: "created" | "resent",
  to: string,
  emailSent: boolean | undefined,
): { tone: "success" | "warning"; message: string } {
  if (action === "resent") {
    return emailSent
      ? {
          tone: "success",
          message: `Resent to ${to}. The link works for ${INVITE_LIFETIME_DAYS} more days.`,
        }
      : {
          tone: "warning",
          message: `Resent: the link works for ${INVITE_LIFETIME_DAYS} more days, but the email to ${to} did not go out. Copy the invite link and send it to them yourself.`,
        };
  }
  return emailSent
    ? { tone: "success", message: `Invite emailed to ${to}` }
    : {
        tone: "warning",
        message: `Invite created, but the email to ${to} did not go out. Copy the invite link and send it to them yourself.`,
      };
}
