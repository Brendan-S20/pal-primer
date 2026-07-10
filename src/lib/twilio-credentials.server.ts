// Server-only resolver for an org's own Twilio account (BYOK), used for the
// tenant<->client CONVERSATION channel only: manual staff↔client SMS, inbound
// replies, and the AI receptionist. Reads the service-role-only
// org_twilio_credentials table; the auth token never leaves the server.
//
// OTP and automated notifications do NOT use this — they go out on the
// platform's own Twilio (see platformTwilioFrom / gateway mode in twilio.server).

export type TenantTwilio = {
  accountSid: string;
  authToken: string;
  from: string | null;
  messagingServiceSid: string | null;
};

/** The tenant's own Twilio account, or null if they haven't set up BYOK. */
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
    authToken: data.auth_token,
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
