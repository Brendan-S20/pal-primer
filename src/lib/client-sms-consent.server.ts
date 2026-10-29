import { clientSmsConsentWording, type ClientSmsConsentWording } from "@/lib/client-sms-consent";

/** The consent wording for one business, read with the service role: its
 *  name, and the Terms and Privacy pages from its texting registration. Not
 *  secret, so any caller that may ask consent of this business's client may
 *  show it. */
export async function orgClientSmsConsentWording(orgId: string): Promise<ClientSmsConsentWording> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: org }, { data: reg }] = await Promise.all([
    (supabaseAdmin as any).from("organizations").select("name").eq("id", orgId).maybeSingle(),
    (supabaseAdmin as any)
      .from("org_texting_registrations")
      .select("dba, legal_name, terms_url, privacy_url")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);
  return clientSmsConsentWording({
    businessName: (org?.name as string | null) ?? "",
    termsUrl: (reg?.terms_url as string | null) ?? null,
    privacyUrl: (reg?.privacy_url as string | null) ?? null,
  });
}

/**
 * Text the client a confirmation that they are subscribed, naming the
 * business. Only when the business can already text and the client may be
 * texted (consent just recorded, not opted out, not paused). Best-effort: a
 * failed confirmation never undoes the consent.
 */
export async function sendOptInConfirmation(orgId: string, clientId: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { endCustomerSmsSender } = await import("@/lib/twilio-credentials.server");
    const sender = await endCustomerSmsSender(orgId);
    if (!sender) return;
    const { data: mayText } = await (supabaseAdmin as any).rpc("client_may_be_texted", {
      _client_id: clientId,
    });
    if (!mayText) return;
    const { data: c } = await (supabaseAdmin as any)
      .from("clients")
      .select("primary_phone, organization_id")
      .eq("id", clientId)
      .maybeSingle();
    if (!c?.primary_phone || c.organization_id !== orgId) return;
    const { optInConfirmationText } = await import("@/lib/client-sms-consent");
    const { sendTwilioSms } = await import("@/lib/twilio.server");
    const { brandedBody } = await import("@/lib/sms-brand");
    const body = brandedBody(sender.brand, optInConfirmationText(sender.brand));
    const res = await sendTwilioSms({
      to: c.primary_phone,
      body,
      from: sender.from ?? undefined,
      messagingServiceSid: sender.messagingServiceSid ?? undefined,
      credentials: sender.credentials,
    });
    await (supabaseAdmin as any).from("messages").insert({
      organization_id: orgId,
      client_id: clientId,
      direction: "outbound",
      body,
      from_number: sender.from,
      to_number: c.primary_phone,
      twilio_sid: res.sid,
      status: res.status || "sent",
    });
  } catch (e) {
    console.warn("opt-in confirmation text not sent", (e as Error).message);
  }
}
