import { decryptSecret } from "@/lib/secret-encryption.server";
// Server-only resolver for the Twilio SUBACCOUNT provisioned for an org, used
// for the tenant<->client CONVERSATION channel only: manual staff↔client SMS,
// inbound replies, and the AI receptionist. Reads the service-role-only
// org_twilio_credentials table; the auth token never leaves the server.
//
// IMP-9: these used to be credentials the CUSTOMER pasted in (BYOK). They are
// now credentials HOUNDSTACK creates and owns, one subaccount per tenant under
// our 10DLC brand (Q-8). The read is unchanged — a subaccount has a SID and an
// auth token like any other account — but who is responsible for the secret
// flipped, which is why the encryption on that column matters more now, not
// less: one key protects a credential for every tenant rather than each tenant's
// own.
//
// Provisioning is BUILD-3 and sits in the carrier compliance queue, so no row
// exists yet and this returns null for every org today.
//
// OTP and automated notifications do NOT use this — they go out on the
// platform's own Twilio (see platformTwilioFrom / gateway mode in twilio.server).

export type TenantTwilio = {
  accountSid: string;
  authToken: string;
  from: string | null;
  messagingServiceSid: string | null;
};

/** The org's provisioned Twilio subaccount, or null when one hasn't been
 *  provisioned yet (which is every org until BUILD-3 clears 10DLC). */
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

/**
 * The platform's own SMS sender number for OTP + automated notifications.
 * Prefer a dedicated PLATFORM_SMS_FROM_NUMBER; callers may fall back to the
 * org's legacy sms_from_number when the platform number isn't configured.
 */
export function platformTwilioFrom(): string | null {
  return process.env.PLATFORM_SMS_FROM_NUMBER || null;
}
