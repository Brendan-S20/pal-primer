import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { encryptSecret, secretLast4, isEncrypted } from "@/lib/secret-encryption.server";

// BYOK Twilio for the tenant<->client conversation channel. The owner enters
// their own Twilio Account SID + Auth Token (+ optional Messaging Service SID)
// and a conversational sender number. Reads/writes go through the service-role
// client so the token never reaches RLS/browser; the status endpoint returns
// only a masked last-4.

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

export const setOrgTwilioSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        accountSid: z.string().trim().regex(/^AC[a-zA-Z0-9]{10,}$/, "Account SID looks like AC…"),
        authToken: z.string().trim().min(10).max(200),
        smsFromNumber: z
          .string()
          .trim()
          .regex(/^\+[1-9]\d{6,15}$/, "Must be an E.164 number, e.g. +15558675310")
          .or(z.literal(""))
          .optional(),
        messagingServiceSid: z
          .string()
          .trim()
          .regex(/^MG[a-zA-Z0-9]{10,}$/, "Messaging Service SID looks like MG…")
          .or(z.literal(""))
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    if (!data.smsFromNumber && !data.messagingServiceSid) {
      throw new Error("Enter a sender number or a Messaging Service SID.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Security (H1): a Twilio number belongs to exactly one org — reject if
    // another org already owns it, so a tenant can't blackhole a rival's inbound.
    if (data.smsFromNumber) {
      const { data: taken } = await (supabaseAdmin as any)
        .from("organizations").select("id").eq("sms_from_number", data.smsFromNumber).neq("id", orgId).maybeSingle();
      if (taken) throw new Error("That number is already in use by another account.");
    }
    const { error } = await (supabaseAdmin as any).from("org_twilio_credentials").upsert(
      {
        organization_id: orgId,
        account_sid: data.accountSid,
        // IMP-1: ciphertext at rest; throws rather than storing plaintext if
        // CREDENTIAL_ENCRYPTION_KEY is missing.
        auth_token: encryptSecret(data.authToken),
        token_last4: secretLast4(data.authToken),
        sms_from_number: data.smsFromNumber || null,
        messaging_service_sid: data.messagingServiceSid || null,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
    if (error) throw new Error(error.message);
    // Inbound SMS/voice routing matches organizations.sms_from_number == To, so
    // keep it in sync with the BYOK conversational number.
    if (data.smsFromNumber) {
      await (supabaseAdmin as any)
        .from("organizations")
        .update({ sms_from_number: data.smsFromNumber })
        .eq("id", orgId);
    }
    return { ok: true };
  });

export const clearOrgTwilioSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("org_twilio_credentials")
      .delete()
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
