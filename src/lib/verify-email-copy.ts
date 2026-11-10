// What the owner is told about verifying their email (#776).
//
// Signup queues a verification link (finish-signup.ts, sendEmailVerification)
// and used to say nothing about it. Setup step 6 then told the owner to "open
// the link we sent when you signed up": a promise about an email they were
// never told about, which may never have arrived. Both sides now say only
// what the app actually did.

/** Setup step 6, for an owner whose email is not verified yet. Leads with
 *  the send button beside it; claims no earlier send. */
export const SETUP_VERIFY_EMAIL_FIRST =
  "First, verify your email. Stripe cannot pay you until your address is confirmed. Send yourself a link, then open it from your inbox.";

/** The note at the end of signup, from whether queueing the link worked. */
export function signupVerifyNotice(email: string, sent: boolean): string {
  return sent
    ? `We sent a link to ${email} to verify your address. You need it before you can take payments. Payments can send another.`
    : `We could not send a link to verify ${email} yet. You need it before you can take payments, and Payments can send it.`;
}
