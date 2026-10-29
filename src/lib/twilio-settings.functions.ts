import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { isEncrypted } from "@/lib/secret-encryption.server";
import { rowCanTextClients } from "@/lib/twilio-credentials.server";

// Twilio settings after the BYOK retirement (IMP-9).
//
// setOrgTwilioSettings and clearOrgTwilioSettings are gone: a tenant no longer
// pastes their own Account SID and Auth Token. Texting runs on one subaccount
// per business, registered in that business's own name (toll-free
// verification by default), which HoundStack provisions (#538).
//
// org_twilio_credentials STAYS, and the read below stays with it. This is the
// difference from the AI side, where the equivalent table became dead: a
// subaccount still has its own SID and auth token, so the row is still real.
// It is written by public.activate_org_texting when the business's toll-free
// verification is approved, never by the customer. If anything the encryption
// on that column matters more now, because the credential is one we are
// responsible for across every tenant.
//
// Settings → Texting reads lib/texting-registration.functions, which reports
// the registration's status as well. This read is the credential side only:
// whether the row can send, and the masked hint, never the token.

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
      // "Texting is active" only when the business can actually text, by the
      // rule the sender uses: a row with nothing to send from is not that.
      configured: rowCanTextClients(data),
      accountSid: (data.account_sid as string) ?? null,
      tokenLast4:
        (data.token_last4 as string | null) ??
        (!isEncrypted(token) && token.length >= 4 ? token.slice(-4) : null),
      smsFromNumber: (data.sms_from_number as string) ?? null,
      messagingServiceSid: (data.messaging_service_sid as string) ?? null,
    };
  });
