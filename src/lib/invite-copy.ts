// What the invite page and the Team page say about an invitation
// (gaps-r2-03, -10, -14, R2-32). Pure, so the words are pinned by a test rather
// than found on a screen.

import { humanizeRole } from "@/lib/humanize";

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

// ── Who can be invited (R2-32) ───────────────────────────────────────────────
// createOrgInvite used to take any address: the inviter's own, a teammate who
// was already on the team, or one with a pending invite under another role,
// which it silently revoked and re-sent as the new role. These are the
// sentences for each case, and inviteDecision is the rule, so the server and
// the test read the same thing.

/** Refused: the address is the inviter's own. */
export function selfInviteRefusal(email: string): string {
  return `${email} is your own email address. You're already on this team, so there's no one to invite.`;
}

/** Refused: the address already belongs to somebody on this team. */
export function memberInviteRefusal(r: {
  email: string;
  role: string | null | undefined;
  active: boolean;
  callerIsOwner: boolean;
}): string {
  const as = r.role ? ` as ${humanizeRole(r.role)}` : "";
  if (!r.active) {
    const fix = r.callerIsOwner
      ? "Turn them back on in the list above instead."
      : "Ask an owner to turn them back on instead.";
    return `${r.email} is already on this team${as}, but turned off, so an invite would not let them in. ${fix}`;
  }
  const fix = r.callerIsOwner
    ? "To change their role, use the role menu next to their name above."
    : "To change their role, ask an owner.";
  return `${r.email} is already on this team${as}, so there's no one to invite. ${fix}`;
}

/** The question asked before a pending invite under a different role is
 *  replaced. Replacing revokes the old link, so it is never done silently. */
export function replaceInviteQuestion(
  email: string,
  currentRole: string,
  newRole: string,
): { title: string; description: string; confirmLabel: string; cancelLabel: string } {
  return {
    title: `There's already a pending invite for ${email} as ${humanizeRole(currentRole)}. Replace it with ${humanizeRole(newRole)}?`,
    description: `The link in the first invite stops working, and we send ${email} a new one as ${humanizeRole(newRole)}.`,
    confirmLabel: `Replace with ${humanizeRole(newRole)}`,
    cancelLabel: "Keep the first invite",
  };
}

export type InviteMember = {
  email: string | null | undefined;
  role: string | null | undefined;
  active: boolean | null | undefined;
};
export type PendingInvite = {
  id: string;
  email: string;
  role: string;
  created_at?: string | null;
};

export type InviteDecision =
  | { kind: "refuse"; message: string }
  | { kind: "resend"; invite: PendingInvite }
  | { kind: "ask"; invite: PendingInvite }
  | { kind: "create"; supersede: PendingInvite[] };

const sameAddress = (a: string | null | undefined, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What Send invite does for this address (R2-32). In order:
 *  - the inviter's own address, or anyone already on the team: refused;
 *  - a pending invite for it under the SAME role: that invite is resent
 *    (same link, 14 more days), not replaced;
 *  - a pending invite under a DIFFERENT role: ask first, and replace only
 *    when `replace` says the person answered yes;
 *  - otherwise a new invite.
 * Addresses compare without case, so Pat@x.com and pat@x.com are one person.
 */
export function inviteDecision(a: {
  email: string;
  role: string;
  callerEmail: string | null | undefined;
  callerIsOwner: boolean;
  members: InviteMember[];
  pending: PendingInvite[];
  replace: boolean;
}): InviteDecision {
  if (a.callerEmail && sameAddress(a.callerEmail, a.email)) {
    return { kind: "refuse", message: selfInviteRefusal(a.email) };
  }
  const member = a.members.find((m) => sameAddress(m.email, a.email));
  if (member) {
    return {
      kind: "refuse",
      message: memberInviteRefusal({
        email: a.email,
        role: member.role,
        active: member.active !== false,
        callerIsOwner: a.callerIsOwner,
      }),
    };
  }
  const pending = a.pending
    .filter((p) => sameAddress(p.email, a.email))
    .sort((x, y) => (y.created_at ?? "").localeCompare(x.created_at ?? ""));
  const latest = pending[0];
  if (!latest) return { kind: "create", supersede: [] };
  if (latest.role === a.role) return { kind: "resend", invite: latest };
  if (!a.replace) return { kind: "ask", invite: latest };
  return { kind: "create", supersede: pending };
}
