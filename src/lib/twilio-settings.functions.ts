import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { isEncrypted } from "@/lib/secret-encryption.server";

// Twilio settings after the BYOK retirement (IMP-9).
//
// setOrgTwilioSettings and clearOrgTwilioSettings are gone: a tenant no longer
// pastes their own Account SID and Auth Token. Texting runs on a per-tenant
// Twilio SUBACCOUNT under HoundStack's 10DLC brand (Q-8), which HoundStack
// provisions.
//
// org_twilio_credentials STAYS, and the read below stays with it. This is the
// difference from the AI side, where the equivalent table became dead: a
// subaccount still has its own SID and auth token, so the row is still real —
// it is simply written by us during provisioning rather than by the customer.
// If anything the encryption on that column matters more now, because the
// credential is one we are responsible for across every tenant.
//
// Provisioning is BUILD-3, which is in the 10DLC compliance queue. Until it
// clears, this reports honestly that conversational texting is not yet
// available rather than offering a form that leads nowhere.

export const getOrgTwilioSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("org_twilio_credentials")
      .select("account_sid, auth_token, token_last4, sms_from_number, messaging_service_sid, updated_at")
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!data) {
      return {
        configured: false,
        accountSid: null as string | null,
        tokenLast4: null as string | null,
        smsFromNumber: null as string | null,
        messagingServiceSid: null as string | null,
      };
    }
    // IMP-1: hint from its own column; the stored token is ciphertext now.
    const token: string = data.auth_token ?? "";
    return {
      configured: true,
      accountSid: (data.account_sid as string) ?? null,
      tokenLast4:
        (data.token_last4 as string | null) ??
        (!isEncrypted(token) && token.length >= 4 ? token.slice(-4) : null),
      smsFromNumber: (data.sms_from_number as string) ?? null,
      messagingServiceSid: (data.messaging_service_sid as string) ?? null,
    };
  });
