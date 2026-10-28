// The invite email, extracted from users.functions.ts so more than one flow can
// send it.
//
// BUILD-6 needed it: provision_franchise_location writes org_invites rows in
// SQL and cannot send mail, so the franchise-location flow has to send the same
// email the teammate-invite flow does. Copying it would have given us two
// invite emails that drift — one saying "your role is assigned automatically",
// the other saying whatever the second author remembered.
//
// WHAT THE EMAIL IS AND IS NOT. It is a convenience, not the mechanism. Nobody
// clicks a token link to accept: ensureBootstrapped in auth.tsx calls
// accept_org_invite_for_current_user, which matches on the signed-in EMAIL
// ADDRESS against pending invites and joins that org *before* it would
// otherwise bootstrap a new one. So an invited person who never gets the mail
// and simply signs up at the app with the invited address still lands in the
// right organization with the right role.
//
// #568: the paragraph above held for an invited person who signed in, and
// not for one who signed UP. /auth sent a new address to /get-started without
// the token, and Get started built a business without asking about invites,
// so the invitee became the owner of an empty business. Get started now joins
// the invitation (by token, or by the email path), and bootstrapOrganization
// refuses an address with a pending invitation.
//
// That is why a send failure is logged rather than thrown — but callers should
// still tell the user which addresses failed, because "we emailed them" and "we
// tried to email them" are different promises.

import { appUrl } from "@/lib/app-origin";
export type InviteEmailResult = { email: string; sent: boolean };

/**
 * Best-effort. Returns whether the provider accepted it, so a caller can be
 * honest about which invitations actually went out.
 *
 * Returns false — not an error — when RESEND_API_KEY is unset, which is the
 * normal state in local development.
 */
export async function sendInviteEmail(
  orgName: string,
  email: string,
  role: string,
  // The invite's token. Optional so the franchise-provisioning caller, which
  // writes org_invites in SQL, can keep working without one.
  //
  // It exists because the note at the top of this file is no longer the whole
  // truth. Email-matching still works, but as of 20260825160000 it only accepts
  // an invitation OLDER than the account -- which is what stops an address
  // being claimed before it is invited. Somebody who already had an account
  // when they were invited therefore needs this link, and before now the email
  // carried no token at all to give them.
  token?: string,
): Promise<boolean> {
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) return false;
    // /invite/<token> names the business and the role before asking for
    // anything, then hands on to /auth?invite=, which keeps the token through
    // Get started and an OAuth round-trip (#568). Emails already sent with the
    // /auth?invite= link still work.
    const link = token ? appUrl(`/invite/${encodeURIComponent(token)}`) : appUrl("/auth");
    const label = role.replace(/_/g, " ");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${orgName} <noreply@notify.houndstack.com>`,
        to: [email],
        subject: `You've been invited to join ${orgName}`,
        html:
          `<p>You've been invited to join <strong>${orgName}</strong> on HoundStack as ${label}.</p>` +
          `<p>Create your account (or sign in) with <strong>${email}</strong> here: <a href="${link}">${link}</a>. Your role is assigned automatically on first sign-in.</p>`,
        text: `You've been invited to join ${orgName} on HoundStack. Sign up with ${email} at ${link}.`,
      }),
    });
    // The old copy of this ignored the response entirely and reported success
    // for a 4xx. A rejected address is exactly the case a caller needs to know
    // about, so it is no longer swallowed.
    if (!res.ok) {
      console.error("invite email rejected", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("invite email failed", (e as Error).message);
    return false;
  }
}
