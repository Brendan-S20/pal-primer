import { decryptSecret } from "@/lib/secret-encryption.server";
import type { TwilioCredentials } from "@/lib/twilio.server";
// Server-only: who a text is sent AS.
//
// ── TWO SENDERS, AND WHICH MESSAGES MAY USE EACH ─────────────────────────
//
// HoundStack's toll-free number (PLATFORM_SMS_FROM_NUMBER, on the platform's
// own Twilio through the Lovable connector gateway) texts ACCOUNT HOLDERS
// only: the people who sign in to HoundStack. Verification codes, security
// alerts, billing notices to the business, support replies. That is what the
// toll-free verification filed on 2026-10-06 says the number is for, after
// Twilio rejected the first one, and it says in as many words that the number
// is "not used for marketing or to message account holders' own customers".
//
// A business's CLIENTS and LEADS (reminders, on my way, visit completed,
// review requests, dunning, portal sign-in codes, staff-to-client messages,
// the receptionist) are texted only from that business's OWN subaccount,
// through `endCustomerSmsSender`. With no subaccount, nothing is texted: the
// caller sends the email it already had, or records why it could not.
//
// Until 2026-10-06 every automated end-customer text preferred the platform
// number (`platformTwilioFrom() ?? org.sms_from_number`) and the manual one
// fell back to gateway mode, so the code said the opposite of the filing.
// tests/the-toll-free-number-texts-account-holders.test.ts keeps it from
// drifting back: nothing outside its allowlist may name the platform number
// or gateway mode.
//
// ── SUBACCOUNTS ───────────────────────────────────────────────────────────
//
// IMP-9: these used to be credentials the CUSTOMER pasted in (BYOK). They are
// now credentials HOUNDSTACK creates and owns, one subaccount per tenant under
// our 10DLC brand (Q-8). The read is unchanged (a subaccount has a SID and an
// auth token like any other account) but who is responsible for the secret
// flipped, which is why the encryption on that column matters more now, not
// less: one key protects a credential for every tenant rather than each tenant's
// own.
//
// Provisioning is BUILD-3 and sits in the carrier compliance queue, so no row
// exists yet and this returns null for every org today. Which means, today, no
// business's client is texted by anything in this codebase.

export type TenantTwilio = {
  accountSid: string;
  authToken: string;
  from: string | null;
  messagingServiceSid: string | null;
};

/** The org's provisioned Twilio subaccount, or null when one hasn't been
 *  provisioned yet (which is every org until BUILD-3 clears 10DLC). Also read
 *  by inbound webhook auth, which needs the token and nothing else. */
export async function resolveOrgTwilioConfig(orgId: string): Promise<TenantTwilio | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("org_twilio_credentials")
    .select("account_sid, auth_token, sms_from_number, messaging_service_sid")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!data?.account_sid || !data?.auth_token) return null;
  return {
    accountSid: data.account_sid,
    // IMP-1: decrypted only here, immediately before the outbound Twilio call.
    authToken: decryptSecret(data.auth_token as string),
    from: data.sms_from_number || null,
    messagingServiceSid: data.messaging_service_sid || null,
  };
}

/** Everything `sendTwilioSms` needs to text a business's client, all of it
 *  the business's own: its subaccount's credentials, and its subaccount's
 *  number or messaging service. */
export type EndCustomerSmsSender = {
  credentials: Extract<TwilioCredentials, { mode: "direct" }>;
  from: string | null;
  messagingServiceSid: string | null;
};

/**
 * The ONLY way to text a business's client or lead. Null when the business
 * has no subaccount, or has one with nothing to send from, and then the text
 * does not go: the caller falls back to email or says why.
 *
 * There is deliberately no fallback here. Not to the platform number, which
 * is filed as texting account holders only; not to gateway mode, which is the
 * platform's account; and not to `organizations.sms_from_number`, the legacy
 * per-org column, which is a number with no credentials of its own and would
 * have to be sent through one of those two to go anywhere.
 */
export async function endCustomerSmsSender(orgId: string): Promise<EndCustomerSmsSender | null> {
  const tenant = await resolveOrgTwilioConfig(orgId);
  if (
    !tenant ||
    !rowCanTextClients({
      account_sid: tenant.accountSid,
      auth_token: tenant.authToken,
      sms_from_number: tenant.from,
      messaging_service_sid: tenant.messagingServiceSid,
    })
  )
    return null;
  return {
    credentials: { mode: "direct", accountSid: tenant.accountSid, authToken: tenant.authToken },
    from: tenant.from,
    messagingServiceSid: tenant.messagingServiceSid,
  };
}

/** The rule `endCustomerSmsSender` applies, on the raw row: a subaccount with
 *  its credentials and something to send from. One predicate, so the switch
 *  the app draws (`orgCanTextClients`) and the sender that actually texts
 *  cannot disagree about which businesses can text. */
export function rowCanTextClients(
  row: {
    account_sid?: string | null;
    auth_token?: string | null;
    sms_from_number?: string | null;
    messaging_service_sid?: string | null;
  } | null,
): boolean {
  return Boolean(
    row?.account_sid && row?.auth_token && (row?.sms_from_number || row?.messaging_service_sid),
  );
}

/**
 * Whether this business can text its own clients: true exactly when
 * `endCustomerSmsSender(orgId)` would return a sender. Read from the same row
 * by the same rule, without decrypting the token, because the answer is a
 * yes or no and the screens that ask (Messages, the client page, Settings,
 * My Day) never need the secret.
 *
 * False for every business until per-business numbers clear carrier
 * registration. When a subaccount is provisioned for one, that business's
 * texting controls light up and nobody else's do.
 */
export async function orgCanTextClients(orgId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("org_twilio_credentials")
    .select("account_sid, auth_token, sms_from_number, messaging_service_sid")
    .eq("organization_id", orgId)
    .maybeSingle();
  return rowCanTextClients(data ?? null);
}

/**
 * HoundStack's toll-free number. It texts ACCOUNT HOLDERS and nobody else,
 * and the inbound webhook uses it to recognise a text sent TO it, which is
 * from an account holder or a stranger and is never a business's client.
 *
 * Never a sender for an end-customer message, and never with a fallback to an
 * org's number: tests/the-toll-free-number-texts-account-holders.test.ts
 * allowlists every call.
 */
export function platformAccountHolderFrom(): string | null {
  return process.env.PLATFORM_SMS_FROM_NUMBER || null;
}
