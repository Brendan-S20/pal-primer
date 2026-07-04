import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

async function requireOwnerOrManager(supabase: any, userId: string): Promise<string> {
  const orgId = await resolveOrgId(supabase, userId);
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roles = (data ?? []).map((r: any) => r.role);
  if (!roles.some((r: string) => r === "owner" || r === "office_manager" || r === "admin")) {
    throw new Error("Not authorized");
  }
  return orgId;
}

/** Preview the current week's digest metrics + AI insights without sending. */
export const previewWeeklyDigest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await requireOwnerOrManager(context.supabase, context.userId);
    const { computeDigestMetrics, generateDigestInsights } = await import(
      "@/lib/digest.server"
    );
    const metrics = await computeDigestMetrics(orgId);
    if (!metrics) throw new Error("Organization not found");
    const insights = await generateDigestInsights(metrics);
    return { metrics, insights };
  });

/** Send the current week's digest now to the recipient on file (or a caller-supplied one). */
export const sendWeeklyDigestNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        recipientOverride: z.string().email().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    const orgId = await requireOwnerOrManager(context.supabase, context.userId);
    const { supabase } = context;
    const { data: org } = await supabase
      .from("organizations")
      .select("digest_recipient_email")
      .eq("id", orgId)
      .maybeSingle();

    const recipient =
      (data?.recipientOverride ?? (org as any)?.digest_recipient_email ?? "").trim();
    if (!recipient) {
      throw new Error(
        "No digest recipient configured. Set one in Settings → Notifications, or pass an email.",
      );
    }

    const { computeDigestMetrics, generateDigestInsights, sendDigestEmail } = await import(
      "@/lib/digest.server"
    );
    const metrics = await computeDigestMetrics(orgId);
    if (!metrics) throw new Error("Organization not found");
    const insights = await generateDigestInsights(metrics);
    const res = await sendDigestEmail({ orgId, recipient, metrics, insights });
    if (!res.ok) throw new Error(`Send failed: ${res.reason ?? "unknown"}`);
    return { ok: true, recipient, messageId: res.messageId };
  });

/** Update digest settings for the caller's org. */
export const updateDigestSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        enabled: z.boolean().optional(),
        recipientEmail: z.string().email().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const orgId = await requireOwnerOrManager(context.supabase, context.userId);
    const patch: Record<string, unknown> = {};
    if (typeof data.enabled === "boolean") patch.notify_email_weekly_digest = data.enabled;
    if (data.recipientEmail !== undefined)
      patch.digest_recipient_email = data.recipientEmail || null;
    if (!Object.keys(patch).length) return { ok: true };
    const { error } = await context.supabase
      .from("organizations")
      .update(patch as any)
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Load current digest settings for the caller's org. */
export const getDigestSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data } = await context.supabase
      .from("organizations")
      .select("notify_email_weekly_digest, digest_recipient_email, last_digest_sent_at")
      .eq("id", orgId)
      .maybeSingle();
    return {
      enabled: (data as any)?.notify_email_weekly_digest ?? true,
      recipientEmail: (data as any)?.digest_recipient_email ?? null,
      lastSentAt: (data as any)?.last_digest_sent_at ?? null,
    };
  });
